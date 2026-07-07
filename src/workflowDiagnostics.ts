import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { parseDocument } from "yaml";
import { z } from "zod";
import { resolveWorkflowConfigUri } from "./workflowConfig";

const workflowInputTypeSchema = z.enum(["text", "github-pr-context", "github-issue-context", "git-local-changes-context", "run-output-context"]);
const workflowFollowUpSchema = z.enum(["openReasoning", "openPr", "openIssue", "postComment", "submitPr"]);

const workflowInputSchema = z
  .object({
    id: z.string().min(1, "Input id is required."),
    label: z.string().min(1, "Input label is required."),
    type: workflowInputTypeSchema.optional(),
    placeholder: z.string().optional(),
    required: z.boolean().optional()
  })
  .strict();

const workflowSchema = z
  .object({
    id: z.string().min(1, "Workflow id is required."),
    title: z.string().min(1, "Workflow title is required."),
    description: z.string().min(1, "Workflow description is required."),
    type: z.string().min(1, "Workflow type is required."),
    inputs: z.array(workflowInputSchema).min(1, "At least one input is required."),
    promptTemplate: z.string().optional(),
    followUps: z.array(workflowFollowUpSchema).optional()
  })
  .strict();

const workflowDocumentSchema = z.union([
  workflowSchema,
  z
    .object({
      workflow: workflowSchema
    })
    .strict(),
  z
    .object({
      workflows: z.array(workflowSchema).min(1, "At least one workflow is required.")
    })
    .strict()
]);

export function createWorkflowDiagnosticCollection(): vscode.DiagnosticCollection {
  return vscode.languages.createDiagnosticCollection("cmsisDevWorkflows");
}

export async function refreshWorkflowDiagnostics(collection: vscode.DiagnosticCollection): Promise<void> {
  const workflowConfigUri = await resolveWorkflowConfigUri();
  collection.clear();

  if (!workflowConfigUri || workflowConfigUri.scheme !== "file") {
    return;
  }

  const targetUris = await listWorkflowDocumentUris(workflowConfigUri.fsPath);
  for (const uri of targetUris) {
    await validateWorkflowDocumentUri(uri, collection);
  }
}

export async function validateWorkflowTextDocument(
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
): Promise<void> {
  const workflowConfigUri = await resolveWorkflowConfigUri();
  if (!workflowConfigUri || workflowConfigUri.scheme !== "file" || document.uri.scheme !== "file") {
    collection.delete(document.uri);
    return;
  }

  if (!isWorkflowDocumentPath(document.uri.fsPath, workflowConfigUri.fsPath)) {
    collection.delete(document.uri);
    return;
  }

  validateWorkflowDocument(document, collection);
}

async function validateWorkflowDocumentUri(
  uri: vscode.Uri,
  collection: vscode.DiagnosticCollection
): Promise<void> {
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    validateWorkflowDocument(document, collection);
  } catch {
    collection.delete(uri);
  }
}

function validateWorkflowDocument(
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
): void {
  const diagnostics: vscode.Diagnostic[] = [];
  const parsed = parseDocument(document.getText(), {
    prettyErrors: false
  });

  for (const error of parsed.errors) {
    diagnostics.push(
      new vscode.Diagnostic(
        toRange(document, error.pos?.[0], error.pos?.[1]),
        error.message,
        vscode.DiagnosticSeverity.Error
      )
    );
  }

  for (const warning of parsed.warnings) {
    diagnostics.push(
      new vscode.Diagnostic(
        toRange(document, warning.pos?.[0], warning.pos?.[1]),
        warning.message,
        vscode.DiagnosticSeverity.Warning
      )
    );
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error)) {
    collection.set(document.uri, diagnostics);
    return;
  }

  const validation = workflowDocumentSchema.safeParse(parsed.toJS());
  if (!validation.success) {
    for (const issue of validation.error.issues) {
      diagnostics.push(
        new vscode.Diagnostic(
          findIssueRange(document, parsed, issue.path),
          issue.message,
          vscode.DiagnosticSeverity.Error
        )
      );
    }
  }

  collection.set(document.uri, diagnostics);
}

async function listWorkflowDocumentUris(workflowConfigPath: string): Promise<vscode.Uri[]> {
  try {
    const stats = await fs.stat(workflowConfigPath);
    if (stats.isDirectory()) {
      const entries = (await fs.readdir(workflowConfigPath))
        .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
        .sort((left, right) => left.localeCompare(right));
      return entries.map((entry) => vscode.Uri.file(path.join(workflowConfigPath, entry)));
    }

    if (workflowConfigPath.endsWith(".yml") || workflowConfigPath.endsWith(".yaml")) {
      return [vscode.Uri.file(workflowConfigPath)];
    }
  } catch {
    // Ignore missing or unreadable workflow config locations.
  }

  return [];
}

function isWorkflowDocumentPath(candidatePath: string, workflowConfigPath: string): boolean {
  const normalizedCandidate = path.normalize(candidatePath);
  const normalizedConfig = path.normalize(workflowConfigPath);

  if (normalizedCandidate === normalizedConfig) {
    return true;
  }

  if (!normalizedCandidate.endsWith(".yml") && !normalizedCandidate.endsWith(".yaml")) {
    return false;
  }

  return normalizedCandidate.startsWith(`${normalizedConfig}${path.sep}`);
}

function findIssueRange(document: vscode.TextDocument, parsed: ReturnType<typeof parseDocument>, issuePath: (string | number)[]): vscode.Range {
  const directNode = getNodeAtPath(parsed, issuePath);
  if (directNode?.range) {
    return toRange(document, directNode.range[0], directNode.range[1]);
  }

  const parentNode = issuePath.length > 0 ? getNodeAtPath(parsed, issuePath.slice(0, -1)) : undefined;
  if (parentNode?.range) {
    return toRange(document, parentNode.range[0], parentNode.range[1]);
  }

  return toRange(document, parsed.contents?.range?.[0], parsed.contents?.range?.[1]);
}

function getNodeAtPath(parsed: ReturnType<typeof parseDocument>, issuePath: (string | number)[]): { range?: [number, number, number?] } | undefined {
  try {
    return parsed.getIn(issuePath, true) as { range?: [number, number, number?] } | undefined;
  } catch {
    return undefined;
  }
}

function toRange(document: vscode.TextDocument, start: number | undefined, end: number | undefined): vscode.Range {
  const safeStart = typeof start === "number" && Number.isFinite(start) ? start : 0;
  const safeEnd = typeof end === "number" && Number.isFinite(end) ? end : safeStart;
  return new vscode.Range(document.positionAt(safeStart), document.positionAt(Math.max(safeStart, safeEnd)));
}
