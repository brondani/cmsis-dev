import * as cp from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { ActionsProvider } from "./actionsProvider";
import {
  CodexReasoningEffort,
  describeCodexSettings,
  getConfiguredCodexModel,
  getConfiguredCodexReasoningEffort,
  getPreferredSettingsTarget,
  listCodexModelCandidates,
  listCodexReasoningEffortCandidates
} from "./codexSettings";
import { getRelatedRunFilePaths, RunOutputItem, RunsProvider } from "./runsProvider";
import { clearGitHubToken, initializeSecretStorage, setGitHubToken } from "./secrets";
import { WorkflowDefinition } from "./types";
import { createWorkflowDiagnosticCollection, refreshWorkflowDiagnostics, validateWorkflowTextDocument } from "./workflowDiagnostics";
import { WorkflowsProvider } from "./workflowsProvider";
import {
  DEFAULT_WORKFLOW_CONFIG_PATH,
  getConfiguredWorkflowConfigPath,
  initializeWorkflowConfig,
  resolveWorkspaceWorkflowConfigUri,
  resolveWorkflowRunsDirUri
} from "./workflowConfig";
import {
  getActiveOutputFollowUpState,
  openCodexChatForActiveOutput,
  openIssueForActiveOutput,
  openPrForActiveOutput,
  openReasoningForActiveOutput,
  PromptWorkflowResult,
  postCommentForActiveOutput,
  runPromptWorkflow,
  submitPrForActiveOutput
} from "./workflows/promptWorkflow";

let mcpProcess: cp.ChildProcess | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initializeSecretStorage(context.secrets);
  const provider = new ActionsProvider();
  const actionsTreeView = vscode.window.createTreeView("cmsisDev.actions", {
    treeDataProvider: provider
  });
  const runsProvider = new RunsProvider();
  const runsTreeView = vscode.window.createTreeView("cmsisDev.runs", {
    treeDataProvider: runsProvider,
    canSelectMany: true
  });
  const workflowsProvider = new WorkflowsProvider();
  const workflowDiagnostics = createWorkflowDiagnosticCollection();
  const workflowWatchers = createWorkflowWatchers(getConfiguredWorkflowConfigPath());
  const runsWatcher = await createRunsWatcher(runsProvider);

  for (const workflowWatcher of workflowWatchers) {
    workflowWatcher.onDidCreate(() => {
      void provider.refresh();
      void runsProvider.refresh();
      void workflowsProvider.refresh();
      void refreshWorkflowDiagnostics(workflowDiagnostics);
    });
    workflowWatcher.onDidChange(() => {
      void provider.refresh();
      void runsProvider.refresh();
      void workflowsProvider.refresh();
      void refreshWorkflowDiagnostics(workflowDiagnostics);
    });
    workflowWatcher.onDidDelete(() => {
      void provider.refresh();
      void runsProvider.refresh();
      void workflowsProvider.refresh();
      void refreshWorkflowDiagnostics(workflowDiagnostics);
    });
  }

  context.subscriptions.push(
    workflowDiagnostics,
    ...workflowWatchers,
    ...(runsWatcher ? [runsWatcher] : []),
    vscode.workspace.onDidOpenTextDocument((document) => {
      void validateWorkflowTextDocument(document, workflowDiagnostics);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      void validateWorkflowTextDocument(event.document, workflowDiagnostics);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      void updateActiveOutputContexts(editor);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("cmsisDev.codexModel") || event.affectsConfiguration("cmsisDev.codexReasoningEffort")) {
        void updateActionsViewDescription(actionsTreeView);
      }
    }),
    actionsTreeView,
    vscode.window.registerTreeDataProvider("cmsisDev.workflows", workflowsProvider),
    runsTreeView,
    vscode.commands.registerCommand("cmsisDev.initializeWorkflows", async () => {
      await initializeWorkflowConfig();
      await provider.refresh();
      await workflowsProvider.refresh();
      await runsProvider.refresh();
    }),
    vscode.commands.registerCommand("cmsisDev.runAction", async (workflow?: WorkflowDefinition) => {
      const chosen = workflow ?? (await chooseWorkflow(provider));
      if (!chosen) {
        return;
      }
      await runWorkflowWithStatus(chosen);
      await runsProvider.refresh();
    }),
    vscode.commands.registerCommand("cmsisDev.refreshRuns", async () => {
      await runsProvider.refresh();
    }),
    vscode.commands.registerCommand(
      "cmsisDev.deleteRuns",
      async (item?: unknown, selectedItems?: readonly unknown[]) => {
        const targets = resolveRunDeletionTargets(item, selectedItems, runsTreeView.selection);
        if (targets.length === 0) {
          vscode.window.showWarningMessage("No run outputs selected for deletion.");
          return;
        }

        const detailLines = targets.slice(0, 8).map((target) => path.basename(target.uri.fsPath));
        if (targets.length > detailLines.length) {
          detailLines.push(`...and ${targets.length - detailLines.length} more`);
        }

        const confirmation = await vscode.window.showWarningMessage(
          targets.length === 1
            ? `Delete run output '${path.basename(targets[0].uri.fsPath)}' and its related files?`
            : `Delete ${targets.length} run outputs and their related files?`,
          {
            modal: true,
            detail: [
              "This removes the output file, its reasoning file, and its metadata file from disk.",
              ...detailLines
            ].join("\n")
          },
          "Delete"
        );
        if (confirmation !== "Delete") {
          return;
        }

        let deletedRuns = 0;
        const failedFiles: string[] = [];
        for (const target of targets) {
          let deletedAnyForRun = false;
          for (const relatedPath of getRelatedRunFilePaths(target.uri.fsPath)) {
            try {
              await fs.rm(relatedPath, { force: true });
              deletedAnyForRun = true;
            } catch {
              failedFiles.push(relatedPath);
            }
          }

          if (deletedAnyForRun) {
            deletedRuns += 1;
          }
        }

        await runsProvider.refresh();
        await updateActiveOutputContexts(vscode.window.activeTextEditor);

        if (failedFiles.length > 0) {
          vscode.window.showWarningMessage(
            `Deleted ${deletedRuns} run ${deletedRuns === 1 ? "output" : "outputs"}, but some related files could not be removed.`
          );
          return;
        }

        vscode.window.showInformationMessage(
          `Deleted ${deletedRuns} run ${deletedRuns === 1 ? "output" : "outputs"} and related files.`
        );
      }
    ),
    vscode.commands.registerCommand("cmsisDev.refreshWorkflows", async () => {
      await workflowsProvider.refresh();
    }),
    vscode.commands.registerCommand("cmsisDev.selectCodexModel", async () => {
      await selectCodexModel(actionsTreeView);
    }),
    vscode.commands.registerCommand("cmsisDev.selectCodexReasoningEffort", async () => {
      await selectCodexReasoningEffort(actionsTreeView);
    }),
    vscode.commands.registerCommand("cmsisDev.setGitHubToken", async () => {
      const token = await vscode.window.showInputBox({
        title: "Set GitHub Token",
        prompt: "Enter a GitHub personal access token with repo scope",
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim().length > 0 ? null : "Token cannot be empty")
      });

      if (!token) {
        return;
      }

      await setGitHubToken(token);
      vscode.window.showInformationMessage("CMSIS-Dev GitHub token saved in SecretStorage.");
    }),
    vscode.commands.registerCommand("cmsisDev.clearGitHubToken", async () => {
      await clearGitHubToken();
      vscode.window.showInformationMessage("CMSIS-Dev GitHub token removed from SecretStorage.");
    }),
    vscode.commands.registerCommand("cmsisDev.openReasoningForActiveOutput", async () => {
      await openReasoningForActiveOutput();
    }),
    vscode.commands.registerCommand("cmsisDev.postCommentForActiveOutput", async () => {
      await postCommentForActiveOutput();
    }),
    vscode.commands.registerCommand("cmsisDev.openPrForActiveOutput", async () => {
      await openPrForActiveOutput();
    }),
    vscode.commands.registerCommand("cmsisDev.openIssueForActiveOutput", async () => {
      await openIssueForActiveOutput();
    }),
    vscode.commands.registerCommand("cmsisDev.openCodexChatForActiveOutput", async () => {
      await openCodexChatForActiveOutput();
    }),
    vscode.commands.registerCommand("cmsisDev.submitPrForActiveOutput", async () => {
      await submitPrForActiveOutput();
    })
  );

  await provider.refresh();
  await updateActionsViewDescription(actionsTreeView);
  await workflowsProvider.refresh();
  await runsProvider.refresh();
  await refreshWorkflowDiagnostics(workflowDiagnostics);
  for (const document of vscode.workspace.textDocuments) {
    await validateWorkflowTextDocument(document, workflowDiagnostics);
  }
  await updateActiveOutputContexts(vscode.window.activeTextEditor);
  void startMcpServer(context);
}

function resolveRunDeletionTargets(
  item: unknown,
  selectedItems: readonly unknown[] | undefined,
  currentSelection: readonly unknown[]
): RunOutputItem[] {
  const clickedItem = isRunOutputItem(item) ? item : undefined;
  const candidates =
    selectedItems && selectedItems.length > 0
      ? selectedItems
      : clickedItem && currentSelection.some((selected) => isRunOutputItem(selected) && selected.uri.fsPath === clickedItem.uri.fsPath)
        ? currentSelection
        : clickedItem
          ? [clickedItem]
          : [...currentSelection];

  const unique = new Map<string, RunOutputItem>();
  for (const candidate of candidates) {
    if (!isRunOutputItem(candidate)) {
      continue;
    }

    unique.set(candidate.uri.fsPath.toLowerCase(), candidate);
  }

  return Array.from(unique.values());
}

function isRunOutputItem(value: unknown): value is RunOutputItem {
  if (!(value instanceof RunOutputItem)) {
    return false;
  }

  return value.uri instanceof vscode.Uri && typeof value.modifiedAt === "number";
}

export function deactivate(): void {
  if (mcpProcess && !mcpProcess.killed) {
    mcpProcess.kill();
  }
}

async function chooseWorkflow(provider: ActionsProvider): Promise<WorkflowDefinition | undefined> {
  await provider.refresh();
  const workflows = provider.getWorkflows();
  if (workflows.length === 0) {
    vscode.window.showInformationMessage("No workflows found. Check the bundled workflow files or create workspace overrides.");
    return undefined;
  }

  const pick = await vscode.window.showQuickPick(
    workflows.map((workflow) => ({
      label: workflow.title,
      description: workflow.id,
      detail: workflow.description,
      workflow
    })),
    { placeHolder: "Choose an AI Action" }
  );

  return pick?.workflow;
}

async function runWorkflow(
  workflow: WorkflowDefinition,
  onStatus?: (status: string) => void
): Promise<PromptWorkflowResult> {
  return runPromptWorkflow(workflow, { onStatus });
}

async function runWorkflowWithStatus(workflow: WorkflowDefinition): Promise<void> {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.name = "CMSIS-Dev AI Action";
  statusBar.text = `$(sync~spin) CMSIS-Dev: Running ${workflow.title}`;
  statusBar.show();
  let dismissAfterMs = 8000;

  try {
    const result = await runWorkflow(workflow, (status) => {
      statusBar.text = `$(sync~spin) CMSIS-Dev: ${status}`;
    });

    if (result.canceled) {
      statusBar.text = `$(circle-slash) CMSIS-Dev: Cancelled ${workflow.title}`;
      dismissAfterMs = 2500;
    } else {
      statusBar.text = result.handedOffToCodexChat
        ? `$(comment-discussion) CMSIS-Dev: Waiting in Codex Chat for ${workflow.title}`
        : `$(check) CMSIS-Dev: Completed ${workflow.title}`;
      dismissAfterMs = result.handedOffToCodexChat ? 30000 : 8000;
    }
  } catch (error) {
    statusBar.text = `$(error) CMSIS-Dev: Failed ${workflow.title}`;
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`AI action '${workflow.title}' failed: ${message}`);
    dismissAfterMs = 8000;
    throw error;
  } finally {
    setTimeout(() => {
      statusBar.hide();
      statusBar.dispose();
    }, dismissAfterMs);
  }
}

async function updateActionsViewDescription(actionsTreeView: vscode.TreeView<unknown>): Promise<void> {
  actionsTreeView.description = await describeCodexSettings();
}

async function selectCodexModel(actionsTreeView: vscode.TreeView<unknown>): Promise<void> {
  const configuredModel = getConfiguredCodexModel();
  const candidates = await listCodexModelCandidates();
  const quickPickItems: Array<vscode.QuickPickItem & { model?: string; custom?: boolean }> = [
    ...candidates.map((model) => ({
      label: model,
      description: model === configuredModel ? "Current selection" : undefined,
      model
    })),
    {
      label: "Custom...",
      description: configuredModel && !candidates.includes(configuredModel) ? configuredModel : undefined,
      detail: "Enter a model id manually.",
      custom: true
    }
  ];

  const selected = await vscode.window.showQuickPick(quickPickItems, {
    title: "Select Codex Model",
    placeHolder: "Choose the Codex model for CMSIS-Dev actions"
  });
  if (!selected) {
    return;
  }

  let nextValue: string | undefined;
  if (selected.custom) {
    const entered = await vscode.window.showInputBox({
      title: "Codex Model",
      prompt: "Enter the Codex model id to use for CMSIS-Dev actions",
      value: configuredModel ?? "",
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length > 0 ? null : "Model id cannot be empty")
    });
    if (!entered) {
      return;
    }

    nextValue = entered.trim();
  } else {
    nextValue = selected.model;
  }

  await vscode.workspace
    .getConfiguration("cmsisDev")
    .update("codexModel", nextValue ?? undefined, getPreferredSettingsTarget());
  await updateActionsViewDescription(actionsTreeView);
}

async function selectCodexReasoningEffort(actionsTreeView: vscode.TreeView<unknown>): Promise<void> {
  const configuredReasoning = getConfiguredCodexReasoningEffort();
  const candidates = await listCodexReasoningEffortCandidates();
  const quickPickItems: Array<vscode.QuickPickItem & { value?: CodexReasoningEffort; custom?: boolean }> = [
    ...candidates.map((value) => ({
      label: formatReasoningEffortLabel(value),
      description: value === configuredReasoning ? "Current selection" : undefined,
      detail: describeReasoningEffort(value),
      value
    })),
    {
      label: "Custom...",
      detail: "Enter a reasoning effort manually.",
      custom: true
    }
  ];

  const selected = await vscode.window.showQuickPick(quickPickItems, {
    title: "Select Codex Reasoning Effort",
    placeHolder: "Choose the reasoning effort for CMSIS-Dev actions"
  });
  if (!selected) {
    return;
  }

  let nextValue: string | undefined;
  if (selected.custom) {
    const entered = await vscode.window.showInputBox({
      title: "Codex Reasoning Effort",
      prompt: "Enter the reasoning effort to use for CMSIS-Dev actions",
      value: configuredReasoning ?? "",
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length > 0 ? null : "Reasoning effort cannot be empty")
    });
    if (!entered) {
      return;
    }

    nextValue = entered.trim();
  } else {
    nextValue = selected.value;
  }

  await vscode.workspace
    .getConfiguration("cmsisDev")
    .update("codexReasoningEffort", nextValue ?? undefined, getPreferredSettingsTarget());
  await updateActionsViewDescription(actionsTreeView);
}

function formatReasoningEffortLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
  }

  return value;
}

function describeReasoningEffort(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "low":
      return "Efficient reasoning with a modest latency increase.";
    case "medium":
      return "When quality and reliability matter, and the task involves planning, complex reasoning, and judgement.";
    case "high":
      return "Hard reasoning, complex debugging, deep planning, and high-value tasks where quality and intelligence matters more than latency.";
    case "xhigh":
      return "Deep research, asynchronous workflows and agentic tasks that require very long rollouts. ";
    default:
      return undefined;
  }
}

async function startMcpServer(context: vscode.ExtensionContext): Promise<void> {
  const serverScript = path.join(context.extensionPath, "out", "mcp", "server.js");
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspaceWorkflowConfigUri = await resolveWorkspaceWorkflowConfigUri();
  const runsDirUri = await resolveWorkflowRunsDirUri();

  mcpProcess = cp.spawn(process.execPath, [serverScript], {
    cwd: workspaceFolder?.uri.fsPath ?? context.extensionPath,
    env: {
      ...process.env,
      CMSIS_DEV_EXTENSION_PATH: context.extensionPath,
      CMSIS_DEV_WORKSPACE_WORKFLOW_CONFIG:
        workspaceWorkflowConfigUri?.scheme === "file" ? workspaceWorkflowConfigUri.fsPath : "",
      CMSIS_DEV_WORKFLOW_RUNS_DIR: runsDirUri?.scheme === "file" ? runsDirUri.fsPath : ""
    },
    stdio: "pipe",
    windowsHide: true
  });

  mcpProcess.on("error", (error) => {
    vscode.window.showWarningMessage(`CMSIS-Dev MCP server failed to start: ${error.message}`);
  });

  mcpProcess.stderr?.on("data", (chunk) => {
    const message = chunk.toString().trim();
    if (message.length > 0) {
      console.error(`[CMSIS-Dev MCP] ${message}`);
    }
  });

  context.subscriptions.push({
    dispose: () => {
      if (mcpProcess && !mcpProcess.killed) {
        mcpProcess.kill();
      }
    }
  });
}

async function createRunsWatcher(runsProvider: RunsProvider): Promise<vscode.FileSystemWatcher | undefined> {
  const runsDirUri = await resolveWorkflowRunsDirUri();
  if (!runsDirUri || runsDirUri.scheme !== "file") {
    return undefined;
  }

  const pattern = new vscode.RelativePattern(path.dirname(runsDirUri.fsPath), `${path.basename(runsDirUri.fsPath)}/**/*.md`);
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);

  watcher.onDidCreate(() => void runsProvider.refresh());
  watcher.onDidChange(() => void runsProvider.refresh());
  watcher.onDidDelete(() => void runsProvider.refresh());

  return watcher;
}

function createWorkflowWatchers(configuredWorkflowPath: string): vscode.FileSystemWatcher[] {
  const normalizedConfiguredPath = configuredWorkflowPath.replace(/\\/g, "/");
  const patterns =
    normalizedConfiguredPath === DEFAULT_WORKFLOW_CONFIG_PATH
      ? ["**/.cmsis-dev/workflows.yml", "**/.cmsis-dev/workflows/*.yml", "**/.cmsis-dev/workflows/*.yaml"]
      : normalizedConfiguredPath.endsWith(".yml") || normalizedConfiguredPath.endsWith(".yaml")
        ? [`**/${normalizedConfiguredPath}`]
        : [`**/${normalizedConfiguredPath}/*.yml`, `**/${normalizedConfiguredPath}/*.yaml`];

  return Array.from(new Set(patterns)).map((pattern) => vscode.workspace.createFileSystemWatcher(pattern));
}

async function updateActiveOutputContexts(editor: vscode.TextEditor | undefined): Promise<void> {
  const followUpState = await getActiveOutputFollowUpState(editor);
  await Promise.all([
    vscode.commands.executeCommand("setContext", "cmsisDev.activeOutput.canOpenReasoning", followUpState.canOpenReasoning),
    vscode.commands.executeCommand("setContext", "cmsisDev.activeOutput.canOpenPr", followUpState.canOpenPr),
    vscode.commands.executeCommand("setContext", "cmsisDev.activeOutput.canOpenIssue", followUpState.canOpenIssue),
    vscode.commands.executeCommand("setContext", "cmsisDev.activeOutput.canPostComment", followUpState.canPostComment),
    vscode.commands.executeCommand("setContext", "cmsisDev.activeOutput.canSubmitPr", followUpState.canSubmitPr),
    vscode.commands.executeCommand("setContext", "cmsisDev.activeOutput.canOpenCodexChat", followUpState.canOpenCodexChat)
  ]);
}
