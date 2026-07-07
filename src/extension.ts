import * as cp from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { ActionsProvider } from "./actionsProvider";
import {
  describeAiSettings,
  formatLanguageModelLabel,
  getConfiguredLanguageModelSelector,
  listAvailableLanguageModels,
  updateConfiguredLanguageModelSelector
} from "./aiSettings";
import { registerCmsisDevChatParticipant } from "./chatParticipant";
import {
  manageCmsisDevLanguageModelProvider,
  refreshCmsisDevLanguageModelProvider,
  registerCmsisDevLanguageModelProvider
} from "./languageModelProvider";
import { getRelatedRunFilePaths, RunOutputItem, RunsProvider } from "./runsProvider";
import { clearGitHubToken, getGitHubToken, initializeSecretStorage, setGitHubToken } from "./secrets";
import { WorkflowDefinition } from "./types";
import { createWorkflowDiagnosticCollection, refreshWorkflowDiagnostics, validateWorkflowTextDocument } from "./workflowDiagnostics";
import { WorkflowsProvider } from "./workflowsProvider";
import {
  DEFAULT_WORKFLOW_CONFIG_PATH,
  getConfiguredWorkflowConfigPath,
  initializeWorkflowConfig,
  loadWorkflowDefinitions,
  resolveWorkspaceWorkflowConfigUri,
  resolveWorkflowRunsDirUri
} from "./workflowConfig";
import {
  getActiveOutputFollowUpState,
  openIssueForActiveOutput,
  openIssueForOutputUri,
  openPrForActiveOutput,
  openPrForOutputUri,
  openReasoningForActiveOutput,
  openReasoningForOutputUri,
  PromptWorkflowResult,
  postCommentForActiveOutput,
  postCommentForOutputUri,
  runPromptWorkflow,
  submitPrForActiveOutput,
  submitPrForOutputUri
} from "./workflows/promptWorkflow";
import {
  CMSIS_DEV_REASONING_EFFORTS,
  formatReasoningEffortLabel,
  getConfiguredReasoningEffort,
  updateConfiguredReasoningEffort
} from "./reasoningEffort";

let mcpProcess: cp.ChildProcess | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initializeSecretStorage(context.secrets);
  const languageModelProvider = registerCmsisDevLanguageModelProvider(context);
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
      if (
        event.affectsConfiguration("cmsisDev.languageModelSelector") ||
        event.affectsConfiguration("cmsisDev.languageModelProvider.baseUrl") ||
        event.affectsConfiguration("cmsisDev.reasoningEffort")
      ) {
        void updateActionsViewDescription(actionsTreeView);
      }
    }),
    actionsTreeView,
    vscode.window.registerTreeDataProvider("cmsisDev.workflows", workflowsProvider),
    runsTreeView,
    registerCmsisDevChatParticipant(context),
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
    vscode.commands.registerCommand("cmsisDev.planNextStepsForRunOutput", async (item?: unknown) => {
      const targetUri = resolveRunOutputUri(item);
      if (!targetUri) {
        return;
      }
      const workflow = await resolveWorkflowById("plan-next-steps");
      if (!workflow) {
        vscode.window.showWarningMessage("The 'Plan Next Steps' workflow is not available.");
        return;
      }
      await runWorkflowWithStatus(workflow, { presetRunOutputUri: targetUri });
      await runsProvider.refresh();
    }),
    vscode.commands.registerCommand("cmsisDev.attachRunOutputToChat", async (item?: unknown) => {
      const targetUri = resolveRunOutputUri(item);
      if (!targetUri) {
        return;
      }
      const document = await vscode.workspace.openTextDocument(targetUri);
      await vscode.window.showTextDocument(document, { preview: true, preserveFocus: true });

      for (const command of ["workbench.panel.chat.view.copilot.focus", "workbench.action.chat.open"]) {
        try {
          await vscode.commands.executeCommand(command);
          break;
        } catch {
          // Try the next chat-opening command.
        }
      }
    }),
    vscode.commands.registerCommand("cmsisDev.refreshRuns", async () => {
      await runsProvider.refresh();
    }),
    vscode.commands.registerCommand("cmsisDev.openRunOutputPreview", async (uri: unknown) => {
      const targetUri = toFileUri(uri);
      if (!targetUri) {
        vscode.window.showWarningMessage("Could not resolve the selected run output path.");
        return;
      }
      const document = await vscode.workspace.openTextDocument(targetUri);
      await vscode.window.showTextDocument(document, {
        preview: true,
        preserveFocus: false
      });
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
    vscode.commands.registerCommand("cmsisDev.selectLanguageModel", async () => {
      await selectLanguageModel(actionsTreeView);
    }),
    vscode.commands.registerCommand("cmsisDev.selectReasoningEffort", async () => {
      await selectReasoningEffort(actionsTreeView);
    }),
    vscode.commands.registerCommand("cmsisDev.configureIntegrations", async () => {
      await configureIntegrations(languageModelProvider, actionsTreeView);
    }),
    vscode.commands.registerCommand("cmsisDev.manageLanguageModelProvider", async () => {
      await manageCmsisDevLanguageModelProvider(languageModelProvider);
      await updateActionsViewDescription(actionsTreeView);
    }),
    vscode.commands.registerCommand("cmsisDev.manageGitHubToken", async () => {
      await manageGitHubToken();
    }),
    vscode.commands.registerCommand("cmsisDev.refreshLanguageModelProvider", async () => {
      await refreshCmsisDevLanguageModelProvider(languageModelProvider);
      await updateActionsViewDescription(actionsTreeView);
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
    vscode.commands.registerCommand("cmsisDev.openReasoningForActiveOutput", async (item?: unknown) => {
      const targetUri = resolveRunOutputUri(item);
      await (targetUri ? openReasoningForOutputUri(targetUri) : openReasoningForActiveOutput());
    }),
    vscode.commands.registerCommand("cmsisDev.postCommentForActiveOutput", async (item?: unknown) => {
      const targetUri = resolveRunOutputUri(item);
      await (targetUri ? postCommentForOutputUri(targetUri) : postCommentForActiveOutput());
    }),
    vscode.commands.registerCommand("cmsisDev.openPrForActiveOutput", async (item?: unknown) => {
      const targetUri = resolveRunOutputUri(item);
      await (targetUri ? openPrForOutputUri(targetUri) : openPrForActiveOutput());
    }),
    vscode.commands.registerCommand("cmsisDev.openIssueForActiveOutput", async (item?: unknown) => {
      const targetUri = resolveRunOutputUri(item);
      await (targetUri ? openIssueForOutputUri(targetUri) : openIssueForActiveOutput());
    }),
    vscode.commands.registerCommand("cmsisDev.submitPrForActiveOutput", async (item?: unknown) => {
      const targetUri = resolveRunOutputUri(item);
      await (targetUri ? submitPrForOutputUri(targetUri) : submitPrForActiveOutput());
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

function resolveRunOutputUri(value: unknown): vscode.Uri | undefined {
  if (isRunOutputItem(value)) {
    return value.uri;
  }

  return toFileUri(value);
}

function toFileUri(value: unknown): vscode.Uri | undefined {
  if (value instanceof vscode.Uri) {
    return value.scheme === "file" ? value : undefined;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return vscode.Uri.file(value);
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.fsPath === "string" && record.fsPath.trim().length > 0) {
      return vscode.Uri.file(record.fsPath);
    }

    if (typeof record.path === "string" && typeof record.scheme === "string" && record.scheme === "file") {
      return vscode.Uri.from({
        scheme: "file",
        authority: typeof record.authority === "string" ? record.authority : "",
        path: record.path,
        query: typeof record.query === "string" ? record.query : "",
        fragment: typeof record.fragment === "string" ? record.fragment : ""
      });
    }
  }

  return undefined;
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

async function resolveWorkflowById(workflowId: string): Promise<WorkflowDefinition | undefined> {
  const workflows = await loadWorkflowDefinitions();
  return workflows.find((workflow) => workflow.id === workflowId);
}

async function runWorkflow(
  workflow: WorkflowDefinition,
  options: {
    onStatus?: (status: string) => void;
    presetRunOutputUri?: vscode.Uri;
  } = {}
): Promise<PromptWorkflowResult> {
  return runPromptWorkflow(workflow, options);
}

async function runWorkflowWithStatus(
  workflow: WorkflowDefinition,
  options: {
    presetRunOutputUri?: vscode.Uri;
  } = {}
): Promise<void> {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.name = "CMSIS-Dev AI Action";
  statusBar.text = `$(sync~spin) CMSIS-Dev: Running ${workflow.title}`;
  statusBar.show();
  let dismissAfterMs = 8000;

  try {
    const result = await runWorkflow(workflow, {
      onStatus: (status) => {
        statusBar.text = `$(sync~spin) CMSIS-Dev: ${status}`;
      },
      presetRunOutputUri: options.presetRunOutputUri
    });

    if (result.canceled) {
      statusBar.text = `$(circle-slash) CMSIS-Dev: Cancelled ${workflow.title}`;
      dismissAfterMs = 2500;
    } else {
      statusBar.text = result.handedOffToChat
        ? `$(comment-discussion) CMSIS-Dev: Waiting in Chat for ${workflow.title}`
        : `$(check) CMSIS-Dev: Completed ${workflow.title}`;
      dismissAfterMs = result.handedOffToChat ? 30000 : 8000;
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
  actionsTreeView.description = await describeAiSettings();
}

async function selectLanguageModel(actionsTreeView: vscode.TreeView<unknown>): Promise<void> {
  const configuredSelector = getConfiguredLanguageModelSelector();
  const availableModels = await listAvailableLanguageModels();
  const selected = await vscode.window.showQuickPick(
    [
      {
        label: "Automatic",
        description: !configuredSelector ? "Current selection" : undefined,
        detail: "Use the first available VS Code chat model.",
        selector: undefined
      },
      ...availableModels.map((model) => ({
        label: model.name,
        description:
          configuredSelector &&
          configuredSelector.vendor === model.vendor &&
          configuredSelector.family === model.family &&
          configuredSelector.version === model.version &&
          configuredSelector.id === model.id
            ? "Current selection"
            : undefined,
        detail: formatLanguageModelLabel(model),
        selector: {
          vendor: model.vendor,
          family: model.family,
          version: model.version,
          id: model.id
        }
      }))
    ],
    {
      title: "Select VS Code Language Model",
      placeHolder:
        availableModels.length > 0
          ? "Choose the chat model for CMSIS-Dev actions"
          : "No VS Code chat models are currently available"
    }
  );
  if (!selected) {
    return;
  }

  await updateConfiguredLanguageModelSelector(selected.selector);
  await updateActionsViewDescription(actionsTreeView);
}

async function selectReasoningEffort(actionsTreeView: vscode.TreeView<unknown>): Promise<void> {
  const configuredEffort = getConfiguredReasoningEffort();
  const selected = await vscode.window.showQuickPick(
    [
      {
        label: "Default",
        description: !configuredEffort ? "Current selection" : undefined,
        detail: "Do not send a CMSIS-Dev reasoning.effort override.",
        effort: undefined
      },
      ...CMSIS_DEV_REASONING_EFFORTS.map((effort) => ({
        label: effort,
        description: configuredEffort === effort ? "Current selection" : undefined,
        detail: formatReasoningEffortLabel(effort),
        effort
      }))
    ],
    {
      title: "Select CMSIS-Dev Reasoning Effort",
      placeHolder: "Choose the default reasoning.effort CMSIS-Dev should send for supported models"
    }
  );
  if (!selected) {
    return;
  }

  await updateConfiguredReasoningEffort(selected.effort);
  await updateActionsViewDescription(actionsTreeView);
}

async function manageGitHubToken(): Promise<void> {
  const hasToken = Boolean(await getGitHubToken());
  const action = await vscode.window.showQuickPick(
    [
      {
        label: "Set GitHub Token",
        detail: "Store a GitHub personal access token in SecretStorage.",
        value: "set"
      },
      {
        label: "Clear GitHub Token",
        detail: hasToken ? "Remove the stored GitHub token from SecretStorage." : "No GitHub token is currently stored.",
        value: "clear"
      }
    ],
    {
      title: "Manage GitHub Token",
      placeHolder: "Choose a GitHub token action"
    }
  );

  if (!action) {
    return;
  }

  if (action.value === "set") {
    await vscode.commands.executeCommand("cmsisDev.setGitHubToken");
    return;
  }

  if (!hasToken) {
    vscode.window.showInformationMessage("No CMSIS-Dev GitHub token is currently stored.");
    return;
  }

  await vscode.commands.executeCommand("cmsisDev.clearGitHubToken");
}

async function configureIntegrations(
  languageModelProvider: ReturnType<typeof registerCmsisDevLanguageModelProvider>,
  actionsTreeView: vscode.TreeView<unknown>
): Promise<void> {
  const hasGitHubToken = Boolean(await getGitHubToken());
  const selected = await vscode.window.showQuickPick(
    [
      {
        label: "Language Model Provider",
        detail: "Configure the CMSIS-Dev OpenAI-compatible provider URL, API key, and model validation.",
        action: "provider"
      },
      {
        label: hasGitHubToken ? "GitHub Token" : "GitHub Token (Setup Recommended)",
        detail: hasGitHubToken
          ? "Set or clear the GitHub token used for PR and issue workflows."
          : "Configure the GitHub token used for PR and issue workflows.",
        action: "github"
      }
    ],
    {
      title: "Configure CMSIS-Dev Integrations",
      placeHolder: "Choose what you want to configure"
    }
  );

  if (!selected) {
    return;
  }

  if (selected.action === "provider") {
    await manageCmsisDevLanguageModelProvider(languageModelProvider);
    await updateActionsViewDescription(actionsTreeView);
    return;
  }

  await manageGitHubToken();
}

async function startMcpServer(context: vscode.ExtensionContext): Promise<void> {
  const serverScript = path.join(context.extensionPath, "out", "mcp", "server.js");
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspaceWorkflowConfigUri = await resolveWorkspaceWorkflowConfigUri();
  const runsDirUri = await resolveWorkflowRunsDirUri();

  mcpProcess = cp.spawn(process.execPath, ["--enable-source-maps", serverScript], {
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
    vscode.commands.executeCommand("setContext", "cmsisDev.activeOutput.canSubmitPr", followUpState.canSubmitPr)
  ]);
}
