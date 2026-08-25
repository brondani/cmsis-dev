import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { resolveWorkflowRunsDirUri } from "./workflowConfig";
import { getOutputFollowUpStateForUri } from "./workflows/promptWorkflow";
export { getRelatedRunFilePaths } from "./runRetentionCore";

interface RunOutputMetadata {
  workflowId?: string;
  workflowTitle?: string;
  prContext?: {
    pr?: {
      number?: number;
    };
  };
  issueContext?: {
    issue?: {
      number?: number;
    };
  };
  localChangesContext?: {
    workspaceFolderName?: string;
    rootPath?: string;
  };
}

export class RunOutputItem extends vscode.TreeItem {
  readonly modifiedAt: number;

  constructor(
    public readonly uri: vscode.Uri,
    modifiedAt: number,
    label: string,
    contextValue: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.modifiedAt = modifiedAt;
    this.resourceUri = uri;
    this.description = new Date(modifiedAt).toLocaleString();
    this.tooltip = [
      path.basename(uri.fsPath),
      `Updated: ${new Date(modifiedAt).toLocaleString()}`,
      uri.fsPath
    ].join("\n");
    this.contextValue = contextValue;
    this.command = {
      command: "cmsisDev.openRunOutputPreview",
      title: "Open as Preview",
      arguments: [uri.fsPath]
    };
  }
}

class RunsPlaceholderItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
  }
}

type RunsTreeItem = RunOutputItem | RunsPlaceholderItem;

export class RunsProvider implements vscode.TreeDataProvider<RunsTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<RunsTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private outputs: RunOutputItem[] = [];

  async refresh(): Promise<void> {
    this.outputs = await this.loadOutputs();
    this.onDidChangeTreeDataEmitter.fire();
  }

  getParent(): vscode.ProviderResult<RunsTreeItem> {
    return undefined;
  }

  async revealableOutputForUri(uri: vscode.Uri): Promise<RunOutputItem | undefined> {
    await this.refresh();
    const targetPath = normalizeFilePath(uri.fsPath);
    return this.outputs.find((output) => normalizeFilePath(output.uri.fsPath) === targetPath);
  }

  getTreeItem(element: RunsTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<RunsTreeItem[]> {
    if (this.outputs.length === 0) {
      this.outputs = await this.loadOutputs();
    }

    return this.outputs.length > 0 ? this.outputs : [new RunsPlaceholderItem("No generated outputs yet")];
  }

  private async loadOutputs(): Promise<RunOutputItem[]> {
    const runsDirUri = await resolveWorkflowRunsDirUri();
    if (!runsDirUri || runsDirUri.scheme !== "file") {
      return [];
    }

    try {
      const entries = await fs.readdir(runsDirUri.fsPath, { withFileTypes: true });
      const outputs = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.endsWith(".reasoning.md"))
          .map(async (entry) => {
            const outputUri = vscode.Uri.file(path.join(runsDirUri.fsPath, entry.name));
            const stat = await fs.stat(outputUri.fsPath);
            const metadata = await readRunOutputMetadata(outputUri);
            const followUpState = await getOutputFollowUpStateForUri(outputUri);
            return new RunOutputItem(
              outputUri,
              stat.mtimeMs,
              getDisplayLabel(outputUri.fsPath, metadata),
              toRunOutputContextValue(followUpState, metadata)
            );
          })
      );

      outputs.sort((left, right) => {
        const modifiedDelta = right.modifiedAt - left.modifiedAt;
        return modifiedDelta !== 0
          ? modifiedDelta
          : path.basename(left.uri.fsPath).localeCompare(path.basename(right.uri.fsPath));
      });
      return outputs;
    } catch {
      return [];
    }
  }
}

function normalizeFilePath(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function readRunOutputMetadata(outputUri: vscode.Uri): Promise<RunOutputMetadata | undefined> {
  try {
    const raw = await fs.readFile(`${outputUri.fsPath}.meta.json`, "utf8");
    return JSON.parse(raw) as RunOutputMetadata;
  } catch {
    return undefined;
  }
}

function getDisplayLabel(fsPath: string, metadata?: RunOutputMetadata): string {
  return path.basename(fsPath);
}

function toRunOutputContextValue(followUpState: {
  canOpenReasoning: boolean;
  canOpenPr: boolean;
  canOpenIssue: boolean;
  canPostComment: boolean;
  canSubmitPr: boolean;
  canCommitChanges: boolean;
}, metadata?: RunOutputMetadata): string {
  const tokens = ["cmsisDev.runOutput"];
  if (followUpState.canOpenReasoning) {
    tokens.push("canOpenReasoning");
  }
  if (followUpState.canOpenPr) {
    tokens.push("canOpenPr");
  }
  if (followUpState.canOpenIssue) {
    tokens.push("canOpenIssue");
  }
  if (followUpState.canPostComment) {
    tokens.push("canPostComment");
  }
  if (followUpState.canSubmitPr) {
    tokens.push("canSubmitPr");
  }
  if (followUpState.canCommitChanges) {
    tokens.push("canCommitChanges");
  }
  if (
    metadata?.workflowId === "review-pr" ||
    metadata?.workflowId === "review-changes" ||
    metadata?.workflowId === "explain-issue" ||
    metadata?.workflowId === "explain-ci-failure"
  ) {
    tokens.push("canPlanNextSteps");
  }
  if (metadata?.workflowId === "plan-next-steps") {
    tokens.push("canAttachToChat");
  }
  return tokens.join(".");
}
