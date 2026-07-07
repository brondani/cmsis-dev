import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { parse, stringify } from "yaml";
import { WorkflowDefinition, WorkflowFollowUp } from "./types";

export const DEFAULT_WORKFLOW_CONFIG_PATH = ".cmsis-dev/workflows";
const LEGACY_DEFAULT_WORKFLOW_CONFIG_PATH = ".cmsis-dev/workflows.yml";
const WORKFLOW_SCHEMA_FILENAME = "workflow.schema.json";
const DEFAULT_OUTPUT_FOLLOW_UPS: readonly WorkflowFollowUp[] = ["openReasoning"];

type StarterWorkflowAssets = {
  workflows: WorkflowDefinition[];
  workflowFiles: Array<{ fileName: string; content: string }>;
  workflowsById: Map<string, WorkflowDefinition>;
};

export type WorkflowConfigSource = "installed" | "workspace";

export type WorkflowConfigFile = {
  uri: vscode.Uri;
  source: WorkflowConfigSource;
  workflowIds: string[];
};

let starterWorkflowAssetsPromise: Promise<StarterWorkflowAssets> | undefined;

function getBundledCmsisDevDir(): string {
  return path.resolve(__dirname, "..", ".cmsis-dev");
}

function getBundledWorkflowsDir(): string {
  return path.join(getBundledCmsisDevDir(), "workflows");
}

function getBundledWorkflowSchemaPath(): string {
  return path.join(getBundledCmsisDevDir(), WORKFLOW_SCHEMA_FILENAME);
}

async function getStarterWorkflowAssets(): Promise<StarterWorkflowAssets> {
  starterWorkflowAssetsPromise ??= loadStarterWorkflowAssets();
  return starterWorkflowAssetsPromise;
}

async function loadStarterWorkflowAssets(): Promise<StarterWorkflowAssets> {
  const workflowsDir = getBundledWorkflowsDir();
  const entries = (await fs.readdir(workflowsDir))
    .filter((entry) => isYamlPath(entry))
    .sort((left, right) => left.localeCompare(right));

  const workflowFiles = await Promise.all(
    entries.map(async (entry) => ({
      fileName: entry,
      content: await fs.readFile(path.join(workflowsDir, entry), "utf8")
    }))
  );

  const workflows = await readWorkflowDefinitionsFromDirectory(workflowsDir);
  const workflowsById = new Map(workflows.map((workflow) => [workflow.id, workflow] as const));

  return {
    workflows,
    workflowFiles,
    workflowsById
  };
}

export async function loadWorkflowDefinitions(): Promise<WorkflowDefinition[]> {
  const starterAssets = await getStarterWorkflowAssets();
  const workspaceWorkflowConfigUri = await resolveWorkspaceWorkflowConfigUri();
  const workspaceWorkflows =
    workspaceWorkflowConfigUri?.scheme === "file" ? await readWorkflowDefinitions(workspaceWorkflowConfigUri.fsPath) : [];

  return normalizeWorkflows(mergeWorkflowDefinitions(starterAssets.workflows, workspaceWorkflows));
}

export async function initializeWorkflowConfig(): Promise<vscode.Uri | undefined> {
  const workflowConfigUri = await getInitializationWorkflowConfigUri();
  if (!workflowConfigUri || workflowConfigUri.scheme !== "file") {
    vscode.window.showWarningMessage("Open a workspace folder before creating workflow overrides.");
    return undefined;
  }

  const absolutePath = workflowConfigUri.fsPath;
  const alreadyExists = await fileExists(absolutePath);
  if (isYamlPath(absolutePath)) {
    const createdUri = await initializeWorkflowConfigFile(absolutePath);
    const doc = await vscode.workspace.openTextDocument(createdUri);
    await vscode.window.showTextDocument(doc);
    if (!alreadyExists) {
      void vscode.window.showInformationMessage(`Workspace workflow overrides created at '${createdUri.fsPath}'.`);
    }
    return createdUri;
  }

  const createdUri = await initializeWorkflowConfigDirectory(absolutePath);
  await vscode.commands.executeCommand("revealInExplorer", createdUri);
  void vscode.window.showInformationMessage(
    alreadyExists
      ? `Workspace workflow overrides already available in '${createdUri.fsPath}'.`
      : `Workspace workflow overrides created in '${createdUri.fsPath}'.`
  );
  return createdUri;
}

export function getConfiguredWorkflowConfigPath(): string {
  return vscode.workspace.getConfiguration("cmsisDev").get<string>("workflowConfigPath", DEFAULT_WORKFLOW_CONFIG_PATH);
}

export function resolveBundledWorkflowConfigUri(): vscode.Uri {
  return vscode.Uri.file(getBundledWorkflowsDir());
}

export async function resolveWorkflowConfigUri(createIfMissing = false): Promise<vscode.Uri | undefined> {
  const workspaceWorkflowConfigUri = await resolveWorkspaceWorkflowConfigUri(createIfMissing);
  if (workspaceWorkflowConfigUri || createIfMissing) {
    return workspaceWorkflowConfigUri;
  }

  return resolveBundledWorkflowConfigUri();
}

export async function resolveWorkspaceWorkflowConfigUri(createIfMissing = false): Promise<vscode.Uri | undefined> {
  const configuredPath = getConfiguredWorkflowConfigPath();
  const workspaceFolders = getResolutionWorkspaceFolders();
  const workspaceFileBaseDir = getWorkspaceFileBaseDir();
  if (workspaceFolders.length === 0) {
    return undefined;
  }

  if (path.isAbsolute(configuredPath)) {
    const absoluteUri = vscode.Uri.file(configuredPath);
    if ((await fileExists(absoluteUri.fsPath)) || createIfMissing) {
      return absoluteUri;
    }
  }

  if (workspaceFileBaseDir) {
    const workspaceFileCandidate = path.join(workspaceFileBaseDir, configuredPath);
    if ((await fileExists(workspaceFileCandidate)) || createIfMissing) {
      return vscode.Uri.file(workspaceFileCandidate);
    }
  }

  for (const workspaceFolder of workspaceFolders) {
    const candidatePath = path.join(workspaceFolder.uri.fsPath, configuredPath);
    if (await fileExists(candidatePath)) {
      return vscode.Uri.file(candidatePath);
    }
  }

  // If default config path is used, support nested .cmsis-dev workflow directories and legacy single-file configs.
  if (configuredPath === DEFAULT_WORKFLOW_CONFIG_PATH) {
    for (const workspaceFolder of workspaceFolders) {
      const patterns = [
        { pattern: "**/.cmsis-dev/workflows/*.yml", asDirectory: true },
        { pattern: "**/.cmsis-dev/workflows/*.yaml", asDirectory: true },
        { pattern: "**/.cmsis-dev/workflows.yml", asDirectory: false }
      ];
      for (const candidate of patterns) {
        const matches = await vscode.workspace.findFiles(
          new vscode.RelativePattern(workspaceFolder, candidate.pattern),
          "**/{node_modules,.git,out}/**",
          1
        );
        if (matches.length > 0) {
          return candidate.asDirectory ? vscode.Uri.file(path.dirname(matches[0].fsPath)) : matches[0];
        }
      }
    }
  }

  if (createIfMissing) {
    const targetPath = workspaceFileBaseDir
      ? path.join(workspaceFileBaseDir, configuredPath)
      : path.join(workspaceFolders[0].uri.fsPath, configuredPath);
    return vscode.Uri.file(targetPath);
  }

  return undefined;
}

export async function listEffectiveWorkflowConfigFiles(): Promise<WorkflowConfigFile[]> {
  const starterFiles = await listWorkflowConfigFilesForPath(getBundledWorkflowsDir(), "installed");
  const workspaceWorkflowConfigUri = await resolveWorkspaceWorkflowConfigUri();
  const workspaceFiles =
    workspaceWorkflowConfigUri?.scheme === "file"
      ? await listWorkflowConfigFilesForPath(workspaceWorkflowConfigUri.fsPath, "workspace")
      : [];

  const overriddenWorkflowIds = new Set(workspaceFiles.flatMap((file) => file.workflowIds));
  const visibleStarterFiles = starterFiles.filter(
    (file) => file.workflowIds.length === 0 || file.workflowIds.some((workflowId) => !overriddenWorkflowIds.has(workflowId))
  );

  return [...workspaceFiles, ...visibleStarterFiles];
}

export async function resolveWorkflowRunsDirUri(createIfMissing = false): Promise<vscode.Uri | undefined> {
  const workflowConfigUri = await resolveWorkspaceWorkflowConfigUri(createIfMissing);
  const workspaceFileBaseDir = getWorkspaceFileBaseDir();
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const runsDirPath =
    workflowConfigUri?.scheme === "file"
      ? path.join(path.dirname(workflowConfigUri.fsPath), "runs")
      : workspaceFileBaseDir
        ? path.join(workspaceFileBaseDir, ".cmsis-dev", "runs")
      : workspaceFolder
        ? path.join(workspaceFolder.uri.fsPath, ".cmsis-dev", "runs")
        : undefined;

  if (!runsDirPath) {
    return undefined;
  }

  if (createIfMissing) {
    await fs.mkdir(runsDirPath, { recursive: true });
  }

  return vscode.Uri.file(runsDirPath);
}

function getResolutionWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length <= 1) {
    return folders;
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (!activeUri) {
    return folders;
  }

  const activeFolder = vscode.workspace.getWorkspaceFolder(activeUri);
  if (!activeFolder) {
    return folders;
  }

  return [activeFolder, ...folders.filter((folder) => folder.uri.toString() !== activeFolder.uri.toString())];
}

async function getInitializationWorkflowConfigUri(): Promise<vscode.Uri | undefined> {
  const configuredPath = getConfiguredWorkflowConfigPath();
  if (path.isAbsolute(configuredPath)) {
    return vscode.Uri.file(configuredPath);
  }

  const workspaceFileBaseDir = getWorkspaceFileBaseDir();
  if (workspaceFileBaseDir) {
    return vscode.Uri.file(path.join(workspaceFileBaseDir, configuredPath));
  }

  const targetWorkspaceFolder = await pickWorkspaceFolderForInitialization();
  if (!targetWorkspaceFolder) {
    return undefined;
  }

  return vscode.Uri.file(path.join(targetWorkspaceFolder.uri.fsPath, configuredPath));
}

async function pickWorkspaceFolderForInitialization(): Promise<vscode.WorkspaceFolder | undefined> {
  const workspaceFolders = getResolutionWorkspaceFolders();
  if (workspaceFolders.length === 0) {
    return undefined;
  }

  if (workspaceFolders.length === 1) {
    return workspaceFolders[0];
  }

  const selected = await vscode.window.showQuickPick(
    workspaceFolders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      folder
    })),
    {
      title: "Create Workflow Overrides",
      placeHolder: "Choose the workspace folder where the workflow overrides should be created"
    }
  );

  return selected?.folder;
}

function getWorkspaceFileBaseDir(): string | undefined {
  const workspaceFile = vscode.workspace.workspaceFile;
  if (!workspaceFile || workspaceFile.scheme !== "file") {
    return undefined;
  }

  return path.dirname(workspaceFile.fsPath);
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readWorkflowDefinitions(workflowConfigPath: string): Promise<WorkflowDefinition[]> {
  try {
    const stats = await fs.stat(workflowConfigPath);
    if (stats.isDirectory()) {
      return readWorkflowDefinitionsFromDirectory(workflowConfigPath);
    }

    return readWorkflowDefinitionsFromFile(workflowConfigPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showWarningMessage(`Failed to load workflow config '${workflowConfigPath}': ${message}`);
    return [];
  }
}

async function listWorkflowConfigFilesForPath(
  workflowConfigPath: string,
  source: WorkflowConfigSource
): Promise<WorkflowConfigFile[]> {
  try {
    const stats = await fs.stat(workflowConfigPath);
    if (stats.isDirectory()) {
      const entries = (await fs.readdir(workflowConfigPath))
        .filter((entry) => isYamlPath(entry))
        .sort((left, right) => left.localeCompare(right));

      return Promise.all(
        entries.map(async (entry) => {
          const uri = vscode.Uri.file(path.join(workflowConfigPath, entry));
          return {
            uri,
            source,
            workflowIds: await readWorkflowIdsFromFile(uri.fsPath)
          };
        })
      );
    }

    if (!isYamlPath(workflowConfigPath)) {
      return [];
    }

    return [
      {
        uri: vscode.Uri.file(workflowConfigPath),
        source,
        workflowIds: await readWorkflowIdsFromFile(workflowConfigPath)
      }
    ];
  } catch {
    return [];
  }
}

async function readWorkflowDefinitionsFromDirectory(workflowConfigDir: string): Promise<WorkflowDefinition[]> {
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(workflowConfigDir))
      .filter((entry) => isYamlPath(entry))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showWarningMessage(`Failed to read workflow config directory '${workflowConfigDir}': ${message}`);
    return [];
  }

  const loaded = await Promise.all(entries.map((entry) => readWorkflowDefinitionsFromFile(path.join(workflowConfigDir, entry))));
  return dedupeWorkflowDefinitions(loaded.flat(), workflowConfigDir);
}

async function readWorkflowDefinitionsFromFile(workflowConfigPath: string): Promise<WorkflowDefinition[]> {
  try {
    const raw = await fs.readFile(workflowConfigPath, "utf8");
    const parsed = parse(raw) as
      | { workflows?: WorkflowDefinition[]; workflow?: WorkflowDefinition }
      | WorkflowDefinition
      | undefined;

    if (!parsed) {
      return [];
    }

    if (Array.isArray((parsed as { workflows?: WorkflowDefinition[] }).workflows)) {
      return (parsed as { workflows: WorkflowDefinition[] }).workflows;
    }

    if ((parsed as { workflow?: WorkflowDefinition }).workflow) {
      return [(parsed as { workflow: WorkflowDefinition }).workflow];
    }

    if (isWorkflowDefinition(parsed)) {
      return [parsed];
    }

    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showWarningMessage(`Failed to parse workflow config '${workflowConfigPath}': ${message}`);
    return [];
  }
}

async function readWorkflowIdsFromFile(workflowConfigPath: string): Promise<string[]> {
  const workflows = await readWorkflowDefinitionsFromFile(workflowConfigPath);
  return workflows
    .map((workflow) => workflow.id)
    .filter((workflowId): workflowId is string => typeof workflowId === "string" && workflowId.trim().length > 0);
}

async function initializeWorkflowConfigFile(workflowConfigPath: string): Promise<vscode.Uri> {
  await fs.mkdir(path.dirname(workflowConfigPath), { recursive: true });
  await writeWorkflowSchemaFileForConfigPath(workflowConfigPath);

  const existing = await fileExists(workflowConfigPath);
  if (!existing) {
    const starterAssets = await getStarterWorkflowAssets();
    const content = {
      workflows: starterAssets.workflows
    };
    await fs.writeFile(workflowConfigPath, renderWorkflowConfigFile(content), "utf8");
  }

  return vscode.Uri.file(workflowConfigPath);
}

async function initializeWorkflowConfigDirectory(workflowConfigDir: string): Promise<vscode.Uri> {
  await fs.mkdir(workflowConfigDir, { recursive: true });
  await writeWorkflowSchemaFileForConfigPath(workflowConfigDir);

  const existingEntries = await fs.readdir(workflowConfigDir).catch(() => []);
  const existingWorkflowFiles = existingEntries.filter((entry) => isYamlPath(entry));
  if (existingWorkflowFiles.length === 0) {
    const starterAssets = await getStarterWorkflowAssets();
    await Promise.all(
      starterAssets.workflowFiles.map(async (workflowFile) => {
        const targetPath = path.join(workflowConfigDir, workflowFile.fileName);
        const content = workflowFile.content;
        await fs.writeFile(targetPath, content, "utf8");
      })
    );
  }

  return vscode.Uri.file(workflowConfigDir);
}

function renderWorkflowConfigFile(content: { workflows: WorkflowDefinition[] }): string {
  return `# yaml-language-server: $schema=./${WORKFLOW_SCHEMA_FILENAME}\n${stringify(content)}`;
}

async function writeWorkflowSchemaFileForConfigPath(targetPath: string): Promise<void> {
  const schemaDir = isYamlPath(targetPath) ? path.dirname(targetPath) : targetPath;
  const schemaPath = path.join(schemaDir, WORKFLOW_SCHEMA_FILENAME);
  const schemaContent = await fs.readFile(getBundledWorkflowSchemaPath(), "utf8");
  await fs.writeFile(schemaPath, schemaContent, "utf8");
}

function mergeWorkflowDefinitions(
  installedWorkflows: WorkflowDefinition[],
  workspaceWorkflows: WorkflowDefinition[]
): WorkflowDefinition[] {
  const merged = new Map<string, WorkflowDefinition>();

  for (const workflow of installedWorkflows) {
    if (!workflow.id || merged.has(workflow.id)) {
      continue;
    }

    merged.set(workflow.id, workflow);
  }

  for (const workflow of workspaceWorkflows) {
    if (!workflow.id) {
      continue;
    }

    merged.set(workflow.id, workflow);
  }

  return Array.from(merged.values());
}

function dedupeWorkflowDefinitions(workflows: WorkflowDefinition[], sourceLabel: string): WorkflowDefinition[] {
  const unique = new Map<string, WorkflowDefinition>();
  const duplicates = new Set<string>();

  for (const workflow of workflows) {
    if (!workflow.id) {
      continue;
    }

    if (unique.has(workflow.id)) {
      duplicates.add(workflow.id);
      continue;
    }

    unique.set(workflow.id, workflow);
  }

  if (duplicates.size > 0) {
    void vscode.window.showWarningMessage(
      `Duplicate workflow ids found in '${sourceLabel}': ${Array.from(duplicates).sort().join(", ")}. Keeping the first definition.`
    );
  }

  return Array.from(unique.values());
}

function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<WorkflowDefinition>;
  return typeof candidate.id === "string" && typeof candidate.title === "string";
}

function isYamlPath(targetPath: string): boolean {
  const extension = path.extname(targetPath).toLowerCase();
  return extension === ".yml" || extension === ".yaml";
}

async function normalizeWorkflows(workflows: WorkflowDefinition[]): Promise<WorkflowDefinition[]> {
  const starterAssets = await getStarterWorkflowAssets();
  const starterById = starterAssets.workflowsById;

  return workflows.map((workflow) => {
    if (workflow.id === "review-pr" || workflow.type === "review-pr") {
      const starter = starterById.get("review-pr");
      const hasPrContextInput = (workflow.inputs ?? []).some((input) => input.type === "github-pr-context");
      const inputs = hasPrContextInput
        ? workflow.inputs
        : [
            {
              id: "pr",
              label: "Pull Request",
              type: "github-pr-context" as const,
              required: true
            },
            ...(workflow.inputs ?? [])
          ];

      return {
        ...workflow,
        inputs,
        promptTemplate: workflow.promptTemplate?.trim() ? workflow.promptTemplate : starter?.promptTemplate,
        followUps: normalizeFollowUps(workflow.followUps, starter?.followUps ?? DEFAULT_OUTPUT_FOLLOW_UPS)
      };
    }

    if (workflow.id === "review-changes" || workflow.type === "review-changes") {
      const starter = starterById.get("review-changes");
      const hasLocalChangesInput = (workflow.inputs ?? []).some((input) => input.type === "git-local-changes-context");
      const inputs = hasLocalChangesInput
        ? workflow.inputs
        : [
            {
              id: "localChanges",
              label: "Repository",
              type: "git-local-changes-context" as const,
              required: true
            },
            ...(workflow.inputs ?? [])
          ];

      return {
        ...workflow,
        inputs,
        promptTemplate: workflow.promptTemplate?.trim() ? workflow.promptTemplate : starter?.promptTemplate,
        followUps: normalizeFollowUps(workflow.followUps, starter?.followUps ?? DEFAULT_OUTPUT_FOLLOW_UPS)
      };
    }

    if (workflow.id === "create-pr" || workflow.type === "create-pr") {
      const starter = starterById.get("create-pr");
      const hasLocalChangesInput = (workflow.inputs ?? []).some((input) => input.type === "git-local-changes-context");
      const inputs = hasLocalChangesInput
        ? workflow.inputs
        : [
            {
              id: "localChanges",
              label: "Repository",
              type: "git-local-changes-context" as const,
              required: true
            },
            ...(workflow.inputs ?? [])
          ];

      return {
        ...workflow,
        inputs,
        promptTemplate: workflow.promptTemplate?.trim() ? workflow.promptTemplate : starter?.promptTemplate,
        followUps: normalizeFollowUps(workflow.followUps, starter?.followUps ?? DEFAULT_OUTPUT_FOLLOW_UPS)
      };
    }

    if (workflow.id === "explain-issue" || workflow.type === "explain-issue") {
      const starter = starterById.get("explain-issue");
      const hasIssueContextInput = (workflow.inputs ?? []).some((input) => input.type === "github-issue-context");
      const inputs = hasIssueContextInput
        ? workflow.inputs
        : [
            {
              id: "issue",
              label: "GitHub Issue",
              type: "github-issue-context" as const,
              required: true
            },
            ...(workflow.inputs ?? [])
          ];

      return {
        ...workflow,
        inputs,
        promptTemplate: workflow.promptTemplate?.trim() ? workflow.promptTemplate : starter?.promptTemplate,
        followUps: normalizeFollowUps(workflow.followUps, starter?.followUps ?? DEFAULT_OUTPUT_FOLLOW_UPS)
      };
    }

    return {
      ...workflow,
      followUps: normalizeFollowUps(workflow.followUps, DEFAULT_OUTPUT_FOLLOW_UPS)
    };
  });
}

function normalizeFollowUps(
  followUps: WorkflowFollowUp[] | undefined,
  fallback: readonly WorkflowFollowUp[]
): WorkflowFollowUp[] {
  const allowed = new Set<WorkflowFollowUp>(["openReasoning", "openPr", "openIssue", "postComment", "submitPr"]);
  const normalized = Array.from(
    new Set((followUps ?? [...fallback]).filter((followUp) => allowed.has(followUp)))
  ) as WorkflowFollowUp[];
  return normalized.length > 0 ? normalized : [...fallback];
}
