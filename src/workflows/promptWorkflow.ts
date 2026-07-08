import * as cp from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { formatLanguageModelLabel, resolveConfiguredLanguageModel } from "../aiSettings";
import {
  buildReasoningModelOptions,
  CmsisDevReasoningEffort,
  formatReasoningEffortLabel,
  getConfiguredReasoningEffort
} from "../reasoningEffort";
import {
  createPullRequest,
  getIssue,
  getIssueComments,
  getIssueReferences,
  getPullRequest,
  getPullRequestFiles,
  getWorkflowJobLog,
  getWorkflowRun,
  getWorkflowRunJobs,
  listOpenIssues,
  listOpenPullRequests,
  listFailedWorkflowRuns,
  parseWorkflowRunUrl,
  postPullRequestComment,
  resolveGitReposFromWorkspace
} from "../github";
import { getGitHubToken } from "../secrets";
import {
  IssueComment,
  IssueSummary,
  PullRequestFile,
  PullRequestSummary,
  WorkflowDefinition,
  WorkflowFollowUp,
  WorkflowInputDefinition
} from "../types";
import { resolveWorkflowRunsDirUri } from "../workflowConfig";

type ReviewEngine = "vscodeLm";

export interface PromptWorkflowOptions {
  onStatus?: (status: string) => void;
  presetRunOutputUri?: vscode.Uri;
}

export interface PromptWorkflowResult {
  engine?: ReviewEngine;
  generated: boolean;
  handedOffToChat: boolean;
  canceled?: boolean;
}

interface GeneratedReview {
  agentName: string;
  modelName: string;
  content: string;
  metrics: ActionMetrics;
}

interface ActionMetrics {
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  generationMs: number;
  promptTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  promptCharacters: number;
  outputCharacters: number;
}

interface SelectedPrContext {
  owner: string;
  repo: string;
  pr: PullRequestSummary;
  rootPath?: string;
  workspaceFolderName?: string;
}

interface SelectedIssueContext {
  owner: string;
  repo: string;
  issue: IssueSummary;
  rootPath?: string;
  workspaceFolderName?: string;
}

interface SelectedLocalChangesContext {
  rootPath: string;
  workspaceFolderName: string;
  owner?: string;
  repo?: string;
  currentBranch: string;
  defaultRef: string;
  defaultBranchName: string;
  changedFiles: number;
}

interface PullRequestDraft {
  title: string;
  body: string;
}

interface ResolvedInputs {
  values: Record<string, string>;
  prContext?: SelectedPrContext;
  issueContext?: SelectedIssueContext;
  localChangesContext?: SelectedLocalChangesContext;
  workflowRunContext?: SelectedWorkflowRunContext;
}

interface ActionOutputMetadata {
  workflowId: string;
  workflowTitle: string;
  followUps: WorkflowFollowUp[];
  pullRequestDraft?: PullRequestDraft;
  reasoningEffort?: CmsisDevReasoningEffort;
  engine: ReviewEngine;
  agentName: string;
  modelName: string;
  metrics: ActionMetrics;
  prompt: string;
  inputValues: Record<string, string>;
  generatedOutput?: string;
  outputFile: string;
  reasoningFile: string;
  prContext?: SelectedPrContext;
  issueContext?: SelectedIssueContext;
  localChangesContext?: SelectedLocalChangesContext;
}

interface SelectedRunOutputContext {
  outputFile: vscode.Uri;
  outputText: string;
  metadata: ActionOutputMetadata;
}

interface SelectedWorkflowRunContext {
  owner: string;
  repo: string;
  runId: number;
  run: Awaited<ReturnType<typeof getWorkflowRun>>;
  jobs: Awaited<ReturnType<typeof getWorkflowRunJobs>>;
  logs: string;
  rootPath?: string;
  workspaceFolderName?: string;
}

interface GenerationOptions {
  onStatus?: (status: string) => void;
  model?: vscode.LanguageModelChat;
}

export interface PromptWorkflowChatOptions {
  additionalInstructions?: string;
  model: vscode.LanguageModelChat;
  onStatus?: (status: string) => void;
  presetRunOutputUri?: vscode.Uri;
}

export interface ActiveOutputFollowUpState {
  canOpenReasoning: boolean;
  canOpenPr: boolean;
  canOpenIssue: boolean;
  canPostComment: boolean;
  canSubmitPr: boolean;
}

const DEFAULT_OUTPUT_FOLLOW_UPS: WorkflowFollowUp[] = ["openReasoning"];
const EMPTY_ACTIVE_OUTPUT_FOLLOW_UP_STATE: ActiveOutputFollowUpState = {
  canOpenReasoning: false,
  canOpenPr: false,
  canOpenIssue: false,
  canPostComment: false,
  canSubmitPr: false
};

export async function runPromptWorkflow(
  workflow: WorkflowDefinition,
  options: PromptWorkflowOptions = {}
): Promise<PromptWorkflowResult> {
  const reportStatus = (status: string): void => {
    options.onStatus?.(status);
  };

  reportStatus(`Collecting inputs for ${workflow.title}`);
  const token = await getGitHubToken();

  const promptTemplate = workflow.promptTemplate?.trim();
  if (!promptTemplate) {
    throw new Error(`Missing promptTemplate in workflow '${workflow.id}'.`);
  }

  const resolved = await collectInputValues(workflow, token, {
    presetRunOutputUri: options.presetRunOutputUri
  });
  if (!resolved) {
    return {
      generated: false,
      handedOffToChat: false,
      canceled: true
    };
  }

  const execution = await executeWorkflowGeneration(workflow, resolved, {
    onStatus: reportStatus
  });
  const { metadata, outputFile, reasoningFile, output } = execution;
  await writeOutputMetadata(outputFile, metadata);
  void vscode.commands.executeCommand("cmsisDev.refreshRuns");

  await vscode.env.clipboard.writeText(output);
  reportStatus(`${workflow.title} output saved`);

  const followUpState = getActiveOutputFollowUpStateFromMetadata(metadata);
  const actions: string[] = [];
  if (followUpState.canPostComment) {
    actions.push("Post Comment");
  }
  if (followUpState.canOpenPr) {
    actions.push("Open PR");
  }
  if (followUpState.canOpenIssue) {
    actions.push("Open Issue");
  }
  if (followUpState.canSubmitPr) {
    actions.push("Submit PR");
  }
  actions.push("Open Output");

  const action = await vscode.window.showInformationMessage(
    `AI action output copied and saved. Reasoning: ${reasoningFile.fsPath}`,
    ...actions
  );

  if (action === "Post Comment") {
    await postCommentFromMetadata(metadata);
  }

  if (action === "Open PR" && resolved.prContext) {
    await vscode.env.openExternal(vscode.Uri.parse(resolved.prContext.pr.htmlUrl));
  }

  if (action === "Open Issue" && resolved.issueContext) {
    await vscode.env.openExternal(vscode.Uri.parse(resolved.issueContext.issue.htmlUrl));
  }

  if (action === "Open Output") {
    const doc = await vscode.workspace.openTextDocument(outputFile);
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  if (action === "Submit PR") {
    await submitPullRequestFromMetadata(metadata);
  }

  return {
    engine: metadata.engine,
    generated: true,
    handedOffToChat: false
  };
}

export async function runPromptWorkflowInChat(
  workflow: WorkflowDefinition,
  options: PromptWorkflowChatOptions
): Promise<{ metadata: ActionOutputMetadata; outputFile: vscode.Uri; reasoningFile: vscode.Uri; output: string } | undefined> {
  const reportStatus = (status: string): void => {
    options.onStatus?.(status);
  };

  reportStatus(`Collecting inputs for ${workflow.title}`);
  const token = await getGitHubToken();
  const resolved = await collectInputValues(workflow, token, {
    presetRunOutputUri: options.presetRunOutputUri
  });
  if (!resolved) {
    return undefined;
  }

  const execution = await executeWorkflowGeneration(workflow, resolved, {
    additionalInstructions: options.additionalInstructions,
    model: options.model,
    onStatus: reportStatus
  });
  await writeOutputMetadata(execution.outputFile, execution.metadata);
  void vscode.commands.executeCommand("cmsisDev.refreshRuns");
  reportStatus(`${workflow.title} output saved`);
  return execution;
}

async function executeWorkflowGeneration(
  workflow: WorkflowDefinition,
  resolved: ResolvedInputs,
  options: {
    additionalInstructions?: string;
    model?: vscode.LanguageModelChat;
    onStatus?: (status: string) => void;
  } = {}
): Promise<{ metadata: ActionOutputMetadata; outputFile: vscode.Uri; reasoningFile: vscode.Uri; output: string }> {
  const workflowStartedAtMs = Date.now();
  const workflowStartedAt = new Date(workflowStartedAtMs).toISOString();
  const promptTemplate = workflow.promptTemplate?.trim();
  if (!promptTemplate) {
    throw new Error(`Missing promptTemplate in workflow '${workflow.id}'.`);
  }

  options.onStatus?.(`Preparing prompt for ${workflow.title}`);
  const prompt = buildWorkflowPrompt(promptTemplate, resolved.values, options.additionalInstructions);
  const followUps = resolveWorkflowFollowUps(workflow);
  const engine: ReviewEngine = "vscodeLm";
  const reasoningEffort = getConfiguredReasoningEffort();
  let pullRequestDraft: PullRequestDraft | undefined;

  const liveReasoningFile = await createTransientReasoningFile();
  const liveReasoningPayload: Record<string, unknown> = {
    timestamp: workflowStartedAt,
    status: "running",
    phase: "generating",
    workflowId: workflow.id,
    workflowTitle: workflow.title,
    followUps,
    pullRequestDraft,
    reasoningEffort,
    engine,
    metrics: {
      startedAt: workflowStartedAt,
      promptCharacters: prompt.length
    },
    prompt,
    inputValues: resolved.values,
    prContext: resolved.prContext,
    issueContext: resolved.issueContext,
    localChangesContext: resolved.localChangesContext,
    generatedOutput: undefined,
    outputFile: undefined
  };
  await updateReasoningFile(liveReasoningFile, liveReasoningPayload);

  liveReasoningPayload.phase = "vscode-lm";
  await updateReasoningFile(liveReasoningFile, liveReasoningPayload);
  options.onStatus?.(`Generating ${workflow.title} with the selected chat model`);

  const generated = await generateWithLanguageModel(prompt, {
    model: options.model,
    onStatus: options.onStatus
  });

  if (!generated) {
    liveReasoningPayload.phase = "failed";
    liveReasoningPayload.status = "failed";
    await updateReasoningFile(liveReasoningFile, liveReasoningPayload);
    throw new Error(`The review could not be generated for '${workflow.title}'. No output files were saved.`);
  }

  pullRequestDraft = workflow.id === "create-pr" || workflow.type === "create-pr" ? parsePullRequestDraft(generated.content) : undefined;

  options.onStatus?.(`Saving ${workflow.title} output`);
  const workflowCompletedAtMs = Date.now();
  const metrics: ActionMetrics = {
    ...generated.metrics,
    startedAt: workflowStartedAt,
    completedAt: new Date(workflowCompletedAtMs).toISOString(),
    elapsedMs: workflowCompletedAtMs - workflowStartedAtMs
  };
  const output = renderOutputWithExecutionInfo(
    workflow.id === "create-pr" || workflow.type === "create-pr"
      ? renderPullRequestDraftOutput(generated.content, pullRequestDraft)
      : generated.content,
    {
      agentName: generated.agentName,
      modelName: generated.modelName,
      reasoningEffort,
      metrics
    }
  );
  const outputFile = await writeOutputFile(
    workflow.id,
    output,
    resolved.prContext,
    resolved.issueContext,
    resolved.localChangesContext
  );
  const reasoningPayload: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    status: "completed",
    phase: "completed",
    workflowId: workflow.id,
    workflowTitle: workflow.title,
    followUps,
    pullRequestDraft,
    reasoningEffort,
    engine,
    agentName: generated.agentName,
    modelName: generated.modelName,
    metrics,
    prompt,
    inputValues: resolved.values,
    prContext: resolved.prContext,
    issueContext: resolved.issueContext,
    localChangesContext: resolved.localChangesContext,
    generatedOutput: output,
    outputFile: outputFile.fsPath
  };
  await updateReasoningFile(liveReasoningFile, reasoningPayload);
  const reasoningFile = await writeReasoningFile(outputFile, reasoningPayload);
  reasoningPayload.reasoningFile = reasoningFile.fsPath;
  await updateReasoningFile(liveReasoningFile, reasoningPayload);
  await updateReasoningFile(reasoningFile, reasoningPayload);

  const metadata: ActionOutputMetadata = {
    workflowId: workflow.id,
    workflowTitle: workflow.title,
    followUps,
    pullRequestDraft,
    reasoningEffort,
    engine,
    agentName: generated.agentName,
    modelName: generated.modelName,
    metrics,
    prompt,
    inputValues: resolved.values,
    generatedOutput: output,
    outputFile: outputFile.fsPath,
    reasoningFile: reasoningFile.fsPath,
    prContext: resolved.prContext,
    issueContext: resolved.issueContext,
    localChangesContext: resolved.localChangesContext
  };

  return {
    metadata,
    outputFile,
    reasoningFile,
    output
  };
}

export async function openReasoningForActiveOutput(): Promise<void> {
  const metadata = await getMetadataForActiveOutput();
  if (!metadata) {
    return;
  }

  if (!getActiveOutputFollowUpStateFromMetadata(metadata).canOpenReasoning) {
    vscode.window.showWarningMessage("Open Reasoning is not available for the active output file.");
    return;
  }

  await openReasoningFile(metadata.reasoningFile);
}

export async function openReasoningForOutputUri(outputUri: vscode.Uri): Promise<void> {
  const metadata = await getMetadataForOutputUri(outputUri, "No action metadata found for this run output.");
  if (!metadata) {
    return;
  }

  if (!getActiveOutputFollowUpStateFromMetadata(metadata).canOpenReasoning) {
    vscode.window.showWarningMessage("Open Reasoning is not available for this run output.");
    return;
  }

  await openReasoningFile(metadata.reasoningFile);
}

export async function postCommentForActiveOutput(): Promise<void> {
  const metadata = await getMetadataForActiveOutput();
  if (!metadata) {
    return;
  }

  if (!getActiveOutputFollowUpStateFromMetadata(metadata).canPostComment) {
    vscode.window.showWarningMessage("Post Comment is not available for the active output file.");
    return;
  }

  await postCommentFromMetadata(metadata);
}

export async function postCommentForOutputUri(outputUri: vscode.Uri): Promise<void> {
  const metadata = await getMetadataForOutputUri(outputUri, "No action metadata found for this run output.");
  if (!metadata) {
    return;
  }

  if (!getActiveOutputFollowUpStateFromMetadata(metadata).canPostComment) {
    vscode.window.showWarningMessage("Post Comment is not available for this run output.");
    return;
  }

  await postCommentFromMetadata(metadata);
}

export async function openPrForActiveOutput(): Promise<void> {
  const metadata = await getMetadataForActiveOutput();
  if (!metadata) {
    return;
  }

  if (!getActiveOutputFollowUpStateFromMetadata(metadata).canOpenPr) {
    vscode.window.showWarningMessage("Open PR is not available for the active output file.");
    return;
  }

  const prUrl = metadata.prContext?.pr.htmlUrl;
  if (!prUrl) {
    vscode.window.showWarningMessage("No PR context URL found for the active output file.");
    return;
  }

  await vscode.env.openExternal(vscode.Uri.parse(prUrl));
}

export async function openPrForOutputUri(outputUri: vscode.Uri): Promise<void> {
  const metadata = await getMetadataForOutputUri(outputUri, "No action metadata found for this run output.");
  if (!metadata) {
    return;
  }

  if (!getActiveOutputFollowUpStateFromMetadata(metadata).canOpenPr) {
    vscode.window.showWarningMessage("Open PR is not available for this run output.");
    return;
  }

  const prUrl = metadata.prContext?.pr.htmlUrl;
  if (!prUrl) {
    vscode.window.showWarningMessage("No PR context URL found for this run output.");
    return;
  }

  await vscode.env.openExternal(vscode.Uri.parse(prUrl));
}

export async function openIssueForActiveOutput(): Promise<void> {
  const metadata = await getMetadataForActiveOutput();
  if (!metadata) {
    return;
  }

  if (!getActiveOutputFollowUpStateFromMetadata(metadata).canOpenIssue) {
    vscode.window.showWarningMessage("Open Issue is not available for the active output file.");
    return;
  }

  const issueUrl = metadata.issueContext?.issue.htmlUrl;
  if (!issueUrl) {
    vscode.window.showWarningMessage("No issue context URL found for the active output file.");
    return;
  }

  await vscode.env.openExternal(vscode.Uri.parse(issueUrl));
}

export async function openIssueForOutputUri(outputUri: vscode.Uri): Promise<void> {
  const metadata = await getMetadataForOutputUri(outputUri, "No action metadata found for this run output.");
  if (!metadata) {
    return;
  }

  if (!getActiveOutputFollowUpStateFromMetadata(metadata).canOpenIssue) {
    vscode.window.showWarningMessage("Open Issue is not available for this run output.");
    return;
  }

  const issueUrl = metadata.issueContext?.issue.htmlUrl;
  if (!issueUrl) {
    vscode.window.showWarningMessage("No issue context URL found for this run output.");
    return;
  }

  await vscode.env.openExternal(vscode.Uri.parse(issueUrl));
}

export async function submitPrForActiveOutput(): Promise<void> {
  const metadata = await getMetadataForActiveOutput();
  if (!metadata) {
    return;
  }

  if (!getActiveOutputFollowUpStateFromMetadata(metadata).canSubmitPr) {
    vscode.window.showWarningMessage("Submit PR is not available for the active output file.");
    return;
  }

  await submitPullRequestFromMetadata(metadata);
}

export async function submitPrForOutputUri(outputUri: vscode.Uri): Promise<void> {
  const metadata = await getMetadataForOutputUri(outputUri, "No action metadata found for this run output.");
  if (!metadata) {
    return;
  }

  if (!getActiveOutputFollowUpStateFromMetadata(metadata).canSubmitPr) {
    vscode.window.showWarningMessage("Submit PR is not available for this run output.");
    return;
  }

  await submitPullRequestFromMetadata(metadata);
}

export async function getActiveOutputFollowUpState(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor
): Promise<ActiveOutputFollowUpState> {
  const uri = editor?.document.uri;
  if (!uri || uri.scheme !== "file") {
    return EMPTY_ACTIVE_OUTPUT_FOLLOW_UP_STATE;
  }

  const metadata = await readOutputMetadata(uri);
  return metadata ? getActiveOutputFollowUpStateFromMetadata(metadata) : EMPTY_ACTIVE_OUTPUT_FOLLOW_UP_STATE;
}

export async function getOutputFollowUpStateForUri(outputUri: vscode.Uri): Promise<ActiveOutputFollowUpState> {
  const metadata = await getMetadataForOutputUri(outputUri);
  return metadata ? getActiveOutputFollowUpStateFromMetadata(metadata) : EMPTY_ACTIVE_OUTPUT_FOLLOW_UP_STATE;
}

async function postCommentFromMetadata(metadata: ActionOutputMetadata): Promise<void> {
  const token = await getGitHubToken();
  if (!token) {
    const selection = await vscode.window.showWarningMessage(
      "Cannot post comment without a GitHub token.",
      "Configure Integrations"
    );
    if (selection === "Configure Integrations") {
      await vscode.commands.executeCommand("cmsisDev.configureIntegrations");
    }
    return;
  }

  const commentBody = await resolveOutputFileText(metadata);
  if (!metadata.prContext || !commentBody?.trim()) {
    vscode.window.showWarningMessage("This output file does not contain PR context and readable review text for posting.");
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Post the generated comment to ${metadata.prContext.owner}/${metadata.prContext.repo}#${metadata.prContext.pr.number}?`,
    { modal: true, detail: "This will publish the current generated output as a GitHub issue comment." },
    "Post Comment"
  );
  if (confirm !== "Post Comment") {
    return;
  }

  try {
    const result = await postPullRequestComment(
      metadata.prContext.owner,
      metadata.prContext.repo,
      metadata.prContext.pr.number,
      commentBody,
      { token }
    );
    const postedAction = await vscode.window.showInformationMessage("Comment posted to pull request.", "Open Comment");
    if (postedAction === "Open Comment" && result.htmlUrl) {
      await vscode.env.openExternal(vscode.Uri.parse(result.htmlUrl));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to post PR comment: ${message}`);
  }
}

async function submitPullRequestFromMetadata(metadata: ActionOutputMetadata): Promise<void> {
  const token = await getGitHubToken();
  if (!token) {
    const selection = await vscode.window.showWarningMessage(
      "Cannot submit a PR without a GitHub token.",
      "Configure Integrations"
    );
    if (selection === "Configure Integrations") {
      await vscode.commands.executeCommand("cmsisDev.configureIntegrations");
    }
    return;
  }

  const context = metadata.localChangesContext;
  if (!context?.owner || !context.repo) {
    vscode.window.showWarningMessage("This output file does not contain enough local repository context to submit a PR.");
    return;
  }

  const outputText = await resolveOutputFileText(metadata);
  const draft = outputText ? parsePullRequestDraftFromOutputFile(outputText) : undefined;
  if (!draft) {
    vscode.window.showWarningMessage(
      "Could not derive a PR title and body from the current output file. Keep the markdown title and body structure intact."
    );
    return;
  }

  let headBranch = (await runGitCommand(context.rootPath, ["branch", "--show-current"])).trim() || context.currentBranch;
  const mustCreateBranch =
    !headBranch || headBranch === "HEAD" || headBranch === "detached HEAD" || headBranch === context.defaultBranchName;
  if (mustCreateBranch) {
    headBranch = await generatePullRequestBranchName(context.rootPath, draft, context.defaultBranchName);
  }

  const confirm = await vscode.window.showWarningMessage(
    `Submit a draft pull request from ${headBranch} to ${context.defaultBranchName} for ${context.owner}/${context.repo}?`,
    {
      modal: true,
      detail: `If the branch is not published yet, CMSIS-Dev will push it to origin before creating the draft pull request.\n\nTitle: ${draft.title}`
    },
    "Submit PR"
  );
  if (confirm !== "Submit PR") {
    return;
  }

  try {
    const created = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "CMSIS-Dev: Submit PR",
        cancellable: false
      },
      async (progress) => {
        progress.report({ message: "Preparing branch" });
        const currentBranch = (await runGitCommand(context.rootPath, ["branch", "--show-current"])).trim();
        if (mustCreateBranch) {
          await runGitCommand(context.rootPath, ["checkout", "-b", headBranch]);
        } else {
          headBranch = currentBranch || headBranch;
        }

        progress.report({ message: "Checking upstream" });
        const upstream = (
          await tryRunGitCommand(context.rootPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        )?.trim();
        if (!upstream || !upstream.endsWith(`/${headBranch}`)) {
          progress.report({ message: "Pushing branch to origin" });
          await runGitCommand(context.rootPath, ["push", "-u", "origin", headBranch], {
            timeoutMs: 120000
          });
        }

        progress.report({ message: "Creating GitHub pull request" });
        return createPullRequest(
          context.owner!,
          context.repo!,
          {
            title: draft.title,
            body: draft.body,
            head: headBranch,
            base: context.defaultBranchName,
            draft: true
          },
          { token }
        );
      }
    );

    const action = await vscode.window.showInformationMessage(
      `Draft pull request created: #${created.number} ${created.title}`,
      "Open PR"
    );
    if (action === "Open PR") {
      await vscode.env.openExternal(vscode.Uri.parse(created.htmlUrl));
      return;
    }

    await vscode.env.openExternal(vscode.Uri.parse(created.htmlUrl));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to submit pull request: ${message}`);
  }
}

async function getMetadataForActiveOutput(): Promise<ActionOutputMetadata | undefined> {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (!activeUri || activeUri.scheme !== "file") {
    vscode.window.showWarningMessage("Open an AI action output file first.");
    return undefined;
  }

  const metadata = await readOutputMetadata(activeUri);
  if (!metadata) {
    vscode.window.showWarningMessage("No action metadata found for the active file.");
    return undefined;
  }

  return metadata;
}

async function getMetadataForOutputUri(
  outputUri: vscode.Uri,
  missingMetadataMessage?: string
): Promise<ActionOutputMetadata | undefined> {
  if (outputUri.scheme !== "file") {
    return undefined;
  }

  const metadata = await readOutputMetadata(outputUri);
  if (!metadata && missingMetadataMessage) {
    vscode.window.showWarningMessage(missingMetadataMessage);
  }

  return metadata;
}

async function openReasoningFile(reasoningFilePath: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(reasoningFilePath));
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function collectInputValues(
  workflow: WorkflowDefinition,
  token?: string,
  options: {
    presetRunOutputUri?: vscode.Uri;
  } = {}
): Promise<ResolvedInputs | undefined> {
  const values: Record<string, string> = {};
  let prContext: SelectedPrContext | undefined;
  let issueContext: SelectedIssueContext | undefined;
  let localChangesContext: SelectedLocalChangesContext | undefined;
  let workflowRunContext: SelectedWorkflowRunContext | undefined;

  for (const input of workflow.inputs ?? []) {
    if (input.type === "github-pr-context") {
      const selected = await selectPrContext(token, input);
      if (!selected) {
        return undefined;
      }

      prContext = selected;
      const files = await getPullRequestFiles(selected.owner, selected.repo, selected.pr.number, { token });
      const fileSections = formatFileSections(files);

      values[input.id] = `${selected.owner}/${selected.repo}#${selected.pr.number}`;
      values[`${input.id}_owner`] = selected.owner;
      values[`${input.id}_repo`] = selected.repo;
      values[`${input.id}_prNumber`] = String(selected.pr.number);
      values[`${input.id}_prTitle`] = selected.pr.title;
      values[`${input.id}_author`] = selected.pr.author;
      values[`${input.id}_headRef`] = selected.pr.headRef;
      values[`${input.id}_baseRef`] = selected.pr.baseRef;
      values[`${input.id}_prBody`] = selected.pr.body || "(No PR description provided)";
      values[`${input.id}_fileSections`] = fileSections;
      values[`${input.id}_prUrl`] = selected.pr.htmlUrl;
      if (selected.rootPath) {
        values[`${input.id}_repoPath`] = selected.rootPath;
        values.repoPath ??= selected.rootPath;
      }
      if (selected.workspaceFolderName) {
        values[`${input.id}_workspaceFolder`] = selected.workspaceFolderName;
        values.workspaceFolder ??= selected.workspaceFolderName;
      }

      values.owner ??= selected.owner;
      values.repo ??= selected.repo;
      values.prNumber ??= String(selected.pr.number);
      values.prTitle ??= selected.pr.title;
      values.author ??= selected.pr.author;
      values.headRef ??= selected.pr.headRef;
      values.baseRef ??= selected.pr.baseRef;
      values.prBody ??= selected.pr.body || "(No PR description provided)";
      values.fileSections ??= fileSections;
      values.prUrl ??= selected.pr.htmlUrl;
      continue;
    }

    if (input.type === "github-issue-context") {
      const selected = await selectIssueContext(token, input);
      if (!selected) {
        return undefined;
      }

      issueContext = selected;
      const comments = await getIssueComments(selected.owner, selected.repo, selected.issue.number, { token });
      const references = await getIssueReferences(selected.owner, selected.repo, selected.issue.number, { token });

      values[input.id] = `${selected.owner}/${selected.repo}#${selected.issue.number}`;
      values[`${input.id}_owner`] = selected.owner;
      values[`${input.id}_repo`] = selected.repo;
      values[`${input.id}_number`] = String(selected.issue.number);
      values[`${input.id}_title`] = selected.issue.title;
      values[`${input.id}_author`] = selected.issue.author;
      values[`${input.id}_body`] = selected.issue.body || "(No issue description provided)";
      values[`${input.id}_state`] = selected.issue.state;
      values[`${input.id}_labels`] = selected.issue.labels.length > 0 ? selected.issue.labels.join(", ") : "(No labels)";
      values[`${input.id}_assignees`] =
        selected.issue.assignees.length > 0 ? selected.issue.assignees.join(", ") : "(No assignees)";
      values[`${input.id}_commentsCount`] = String(selected.issue.commentsCount);
      values[`${input.id}_comments`] = formatIssueComments(comments);
      values[`${input.id}_linkedPrs`] = formatSimpleList(references.linkedPullRequests, "(No linked pull requests found)");
      values[`${input.id}_relatedIssues`] = formatSimpleList(references.relatedIssues, "(No related issues found)");
      values[`${input.id}_url`] = selected.issue.htmlUrl;
      if (selected.rootPath) {
        values[`${input.id}_repoPath`] = selected.rootPath;
        values.repoPath ??= selected.rootPath;
      }
      if (selected.workspaceFolderName) {
        values[`${input.id}_workspaceFolder`] = selected.workspaceFolderName;
        values.workspaceFolder ??= selected.workspaceFolderName;
      }

      values.owner ??= selected.owner;
      values.repo ??= selected.repo;
      values.issueNumber ??= String(selected.issue.number);
      values.issueTitle ??= selected.issue.title;
      values.issueAuthor ??= selected.issue.author;
      values.issueBody ??= selected.issue.body || "(No issue description provided)";
      values.issueState ??= selected.issue.state;
      values.issueLabels ??= selected.issue.labels.length > 0 ? selected.issue.labels.join(", ") : "(No labels)";
      values.issueAssignees ??=
        selected.issue.assignees.length > 0 ? selected.issue.assignees.join(", ") : "(No assignees)";
      values.issueCommentsCount ??= String(selected.issue.commentsCount);
      values.issueComments ??= formatIssueComments(comments);
      values.linkedPrs ??= formatSimpleList(references.linkedPullRequests, "(No linked pull requests found)");
      values.relatedIssues ??= formatSimpleList(references.relatedIssues, "(No related issues found)");
      values.issueUrl ??= selected.issue.htmlUrl;
      continue;
    }

    if (input.type === "github-workflow-run-context") {
      const selected = await selectWorkflowRunContext(token, input);
      if (!selected) {
        return undefined;
      }

      workflowRunContext = selected;
      values[input.id] = selected.run.htmlUrl;
      values[`${input.id}_owner`] = selected.owner;
      values[`${input.id}_repo`] = selected.repo;
      values[`${input.id}_runId`] = String(selected.runId);
      values[`${input.id}_runNumber`] = String(selected.run.runNumber);
      values[`${input.id}_title`] = selected.run.displayTitle;
      values[`${input.id}_event`] = selected.run.event;
      values[`${input.id}_status`] = selected.run.status;
      values[`${input.id}_conclusion`] = selected.run.conclusion || "(No conclusion)";
      values[`${input.id}_branch`] = selected.run.headBranch || "(Unknown branch)";
      values[`${input.id}_sha`] = selected.run.headSha || "(Unknown SHA)";
      values[`${input.id}_actor`] = selected.run.actor;
      values[`${input.id}_url`] = selected.run.htmlUrl;
      values[`${input.id}_failingJobsSummary`] = formatWorkflowRunJobs(selected.jobs);
      values[`${input.id}_logs`] = selected.logs;
      if (selected.rootPath) {
        values[`${input.id}_repoPath`] = selected.rootPath;
        values.repoPath ??= selected.rootPath;
      }
      if (selected.workspaceFolderName) {
        values[`${input.id}_workspaceFolder`] = selected.workspaceFolderName;
        values.workspaceFolder ??= selected.workspaceFolderName;
      }

      values.owner ??= selected.owner;
      values.repo ??= selected.repo;
      values.workflowRunId ??= String(selected.runId);
      values.workflowRunNumber ??= String(selected.run.runNumber);
      values.workflowRunTitle ??= selected.run.displayTitle;
      values.workflowRunEvent ??= selected.run.event;
      values.workflowRunStatus ??= selected.run.status;
      values.workflowRunConclusion ??= selected.run.conclusion || "(No conclusion)";
      values.workflowRunBranch ??= selected.run.headBranch || "(Unknown branch)";
      values.workflowRunSha ??= selected.run.headSha || "(Unknown SHA)";
      values.workflowRunActor ??= selected.run.actor;
      values.workflowRunUrl ??= selected.run.htmlUrl;
      values.failingJobsSummary ??= formatWorkflowRunJobs(selected.jobs);
      values.workflowRunLogs ??= selected.logs;
      continue;
    }

    if (input.type === "run-output-context") {
      const selected = await selectRunOutputContext(workflow, input, options.presetRunOutputUri);
      if (!selected) {
        return undefined;
      }

      values[input.id] = selected.outputFile.fsPath;
      values[`${input.id}_workflowId`] = selected.metadata.workflowId;
      values[`${input.id}_workflowTitle`] = selected.metadata.workflowTitle;
      values[`${input.id}_outputFile`] = selected.metadata.outputFile;
      values[`${input.id}_reasoningFile`] = selected.metadata.reasoningFile;
      values[`${input.id}_output`] = selected.outputText;

      values.sourceWorkflowId ??= selected.metadata.workflowId;
      values.sourceWorkflowTitle ??= selected.metadata.workflowTitle;
      values.sourceOutputFile ??= selected.metadata.outputFile;
      values.sourceReasoningFile ??= selected.metadata.reasoningFile;
      values.sourceOutput ??= selected.outputText;
      continue;
    }

    if (input.type === "git-local-changes-context") {
      const selected = await selectLocalChangesContext(input);
      if (!selected) {
        return undefined;
      }

      const collected = await collectLocalChangesValues(selected, input.id);
      if (!collected) {
        vscode.window.showInformationMessage(`No local changes found in ${path.basename(selected.rootPath)}.`);
        return undefined;
      }

      localChangesContext = collected.context;
      Object.assign(values, collected.values);
      continue;
    }

    const value = await vscode.window.showInputBox({
      title: workflow.title,
      prompt: input.label,
      placeHolder: input.placeholder,
      ignoreFocusOut: true,
      validateInput: (candidate) => {
        if (input.required && candidate.trim().length === 0) {
          return `${input.label} is required`;
        }
        return null;
      }
    });

    if (value === undefined) {
      return undefined;
    }

    values[input.id] = value;
  }

  return { values, prContext, issueContext, localChangesContext, workflowRunContext };
}

function renderPromptTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_full, key) => values[key] ?? "");
}

async function selectPrContext(token: string | undefined, input: WorkflowInputDefinition): Promise<SelectedPrContext | undefined> {
  const fromUrl = await vscode.window.showQuickPick(
    [
      { label: "Choose from open PRs", value: "list" },
      { label: "Paste PR URL", value: "url" }
    ],
    { placeHolder: input.label || "How should CMSIS-Dev select the pull request?" }
  );

  if (!fromUrl) {
    return undefined;
  }

  if (fromUrl.value === "url") {
    const url = await vscode.window.showInputBox({
      title: "PR URL",
      prompt: "Paste a GitHub PR URL (https://github.com/owner/repo/pull/123)",
      ignoreFocusOut: true,
      validateInput: (value) => (parsePrUrl(value) ? null : "Expected URL format: https://github.com/owner/repo/pull/123")
    });

    if (!url) {
      return undefined;
    }

    const parsed = parsePrUrl(url);
    if (!parsed) {
      return undefined;
    }

    const pr = await getPullRequest(parsed.owner, parsed.repo, parsed.number, { token });
    const workspaceRepo = await resolveWorkspaceRepoForRemote(parsed.owner, parsed.repo);
    return {
      owner: parsed.owner,
      repo: parsed.repo,
      pr,
      rootPath: workspaceRepo?.rootPath,
      workspaceFolderName: workspaceRepo?.workspaceFolderName
    };
  }

  const workspaceRepos = (await resolveGitReposFromWorkspace()).filter(
    (repo): repo is { rootPath: string; workspaceFolderName: string; owner: string; repo: string } => Boolean(repo.owner && repo.repo)
  );
  if (workspaceRepos.length === 0) {
    const manualRepo = await vscode.window.showInputBox({
      title: "Repository",
      prompt: "Enter owner/repo",
      placeHolder: "microsoft/vscode",
      validateInput: (value) => (parseRepo(value) ? null : "Expected format: owner/repo")
    });

    if (!manualRepo) {
      return undefined;
    }

    const repoInfo = parseRepo(manualRepo);
    if (!repoInfo) {
      return undefined;
    }

    const openPrs = await listOpenPullRequests(repoInfo.owner, repoInfo.repo, { token });
    if (openPrs.length === 0) {
      vscode.window.showInformationMessage("No open pull requests found for this repository.");
      return undefined;
    }

    const selectedPr = await vscode.window.showQuickPick(
      openPrs.map((pr) => ({
        label: `#${pr.number} ${pr.title}`,
        description: `${pr.headRef} -> ${pr.baseRef}`,
        detail: `@${pr.author}`,
        pr
      })),
      { placeHolder: "Select a pull request" }
    );

    if (!selectedPr) {
      return undefined;
    }

    const workspaceRepo = await resolveWorkspaceRepoForRemote(repoInfo.owner, repoInfo.repo);
    return {
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      pr: selectedPr.pr,
      rootPath: workspaceRepo?.rootPath,
      workspaceFolderName: workspaceRepo?.workspaceFolderName
    };
  }

  const uniqueRepos = new Map<string, Array<{ owner: string; repo: string; rootPath: string; workspaceFolderName: string }>>();
  for (const workspaceRepo of workspaceRepos) {
    const key = `${workspaceRepo.owner}/${workspaceRepo.repo}`.toLowerCase();
    const existing = uniqueRepos.get(key) ?? [];
    existing.push(workspaceRepo);
    uniqueRepos.set(key, existing);
  }

  const repoResults = await Promise.all(
    Array.from(uniqueRepos.values()).map(async (repoInfos) => {
      const [repoInfo] = repoInfos;
      const prs = await listOpenPullRequests(repoInfo.owner, repoInfo.repo, { token });
      return { repoInfos, prs };
    })
  );

  const quickPickItems = repoResults.flatMap(({ repoInfos, prs }) =>
    repoInfos.flatMap((repoInfo) =>
      prs.map((pr) => ({
        label: `#${pr.number} ${pr.title}`,
        description: `${repoInfo.owner}/${repoInfo.repo} (${repoInfo.workspaceFolderName})`,
        detail: `${pr.headRef} -> ${pr.baseRef} | @${pr.author} | ${repoInfo.rootPath}`,
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        pr,
        rootPath: repoInfo.rootPath,
        workspaceFolderName: repoInfo.workspaceFolderName
      }))
    )
  );

  if (quickPickItems.length === 0) {
    vscode.window.showInformationMessage("No open pull requests found in workspace repositories.");
    return undefined;
  }

  const selectedPr = await vscode.window.showQuickPick(quickPickItems, { placeHolder: "Select a pull request" });
  if (!selectedPr) {
    return undefined;
  }

  return {
    owner: selectedPr.owner,
    repo: selectedPr.repo,
    pr: selectedPr.pr,
    rootPath: selectedPr.rootPath,
    workspaceFolderName: selectedPr.workspaceFolderName
  };
}

async function selectIssueContext(token: string | undefined, input: WorkflowInputDefinition): Promise<SelectedIssueContext | undefined> {
  const source = await vscode.window.showQuickPick(
    [
      { label: "Choose from open issues", value: "list" },
      { label: "Paste issue URL", value: "url" }
    ],
    { placeHolder: input.label || "How should CMSIS-Dev select the issue?" }
  );

  if (!source) {
    return undefined;
  }

  if (source.value === "url") {
    const url = await vscode.window.showInputBox({
      title: "Issue URL",
      prompt: "Paste a GitHub issue URL (https://github.com/owner/repo/issues/123)",
      ignoreFocusOut: true,
      validateInput: (value) => (parseIssueUrl(value) ? null : "Expected URL format: https://github.com/owner/repo/issues/123")
    });

    if (!url) {
      return undefined;
    }

    const parsed = parseIssueUrl(url);
    if (!parsed) {
      return undefined;
    }

    const issue = await getIssue(parsed.owner, parsed.repo, parsed.number, { token });
    const workspaceRepo = await resolveWorkspaceRepoForRemote(parsed.owner, parsed.repo);
    return {
      owner: parsed.owner,
      repo: parsed.repo,
      issue,
      rootPath: workspaceRepo?.rootPath,
      workspaceFolderName: workspaceRepo?.workspaceFolderName
    };
  }

  const workspaceRepos = (await resolveGitReposFromWorkspace()).filter(
    (repo): repo is { rootPath: string; workspaceFolderName: string; owner: string; repo: string } => Boolean(repo.owner && repo.repo)
  );
  if (workspaceRepos.length === 0) {
    const manualRepo = await vscode.window.showInputBox({
      title: "Repository",
      prompt: "Enter owner/repo",
      placeHolder: "microsoft/vscode",
      validateInput: (value) => (parseRepo(value) ? null : "Expected format: owner/repo")
    });

    if (!manualRepo) {
      return undefined;
    }

    const repoInfo = parseRepo(manualRepo);
    if (!repoInfo) {
      return undefined;
    }

    const openIssues = await listOpenIssues(repoInfo.owner, repoInfo.repo, { token });
    if (openIssues.length === 0) {
      vscode.window.showInformationMessage("No open issues found for this repository.");
      return undefined;
    }

    const selectedIssue = await vscode.window.showQuickPick(
      openIssues.map((issue) => ({
        label: `#${issue.number} ${issue.title}`,
        description: `state: ${issue.state} | comments: ${issue.commentsCount}`,
        detail: `@${issue.author}${issue.labels.length > 0 ? ` | labels: ${issue.labels.join(", ")}` : ""}`,
        issue
      })),
      { placeHolder: "Select an issue" }
    );

    if (!selectedIssue) {
      return undefined;
    }

    const workspaceRepo = await resolveWorkspaceRepoForRemote(repoInfo.owner, repoInfo.repo);
    return {
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      issue: selectedIssue.issue,
      rootPath: workspaceRepo?.rootPath,
      workspaceFolderName: workspaceRepo?.workspaceFolderName
    };
  }

  const uniqueRepos = new Map<string, Array<{ owner: string; repo: string; rootPath: string; workspaceFolderName: string }>>();
  for (const workspaceRepo of workspaceRepos) {
    const key = `${workspaceRepo.owner}/${workspaceRepo.repo}`.toLowerCase();
    const existing = uniqueRepos.get(key) ?? [];
    existing.push(workspaceRepo);
    uniqueRepos.set(key, existing);
  }

  const repoResults = await Promise.all(
    Array.from(uniqueRepos.values()).map(async (repoInfos) => {
      const [repoInfo] = repoInfos;
      const issues = await listOpenIssues(repoInfo.owner, repoInfo.repo, { token });
      return { repoInfos, issues };
    })
  );

  const quickPickItems = repoResults.flatMap(({ repoInfos, issues }) =>
    repoInfos.flatMap((repoInfo) =>
      issues.map((issue) => ({
        label: `#${issue.number} ${issue.title}`,
        description: `${repoInfo.owner}/${repoInfo.repo} (${repoInfo.workspaceFolderName})`,
        detail: `@${issue.author} | state: ${issue.state} | comments: ${issue.commentsCount} | ${repoInfo.rootPath}`,
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        issue,
        rootPath: repoInfo.rootPath,
        workspaceFolderName: repoInfo.workspaceFolderName
      }))
    )
  );

  if (quickPickItems.length === 0) {
    vscode.window.showInformationMessage("No open issues found in workspace repositories.");
    return undefined;
  }

  const selectedIssue = await vscode.window.showQuickPick(quickPickItems, { placeHolder: "Select an issue" });
  if (!selectedIssue) {
    return undefined;
  }

  return {
    owner: selectedIssue.owner,
    repo: selectedIssue.repo,
    issue: selectedIssue.issue,
    rootPath: selectedIssue.rootPath,
    workspaceFolderName: selectedIssue.workspaceFolderName
  };
}

async function selectLocalChangesContext(input: WorkflowInputDefinition): Promise<{
  rootPath: string;
  workspaceFolderName: string;
  owner?: string;
  repo?: string;
} | undefined> {
  const repos = await resolveGitReposFromWorkspace();
  if (repos.length === 0) {
    vscode.window.showWarningMessage("No local git repositories were found in the current workspace.");
    return undefined;
  }

  if (repos.length === 1) {
    return repos[0];
  }

  const selected = await vscode.window.showQuickPick(
    repos.map((repo) => ({
      label: repo.owner && repo.repo ? `${repo.owner}/${repo.repo}` : path.basename(repo.rootPath),
      description: `${repo.workspaceFolderName} | ${repo.rootPath}`,
      detail: repo.owner && repo.repo ? repo.rootPath : "Local repository without detected GitHub origin",
      repo
    })),
    { placeHolder: input.label || "Select the repository whose local changes should be reviewed" }
  );

  return selected?.repo;
}

async function selectWorkflowRunContext(
  token: string | undefined,
  input: WorkflowInputDefinition
): Promise<SelectedWorkflowRunContext | undefined> {
  const source = await vscode.window.showQuickPick(
    [
      { label: "Choose from recent failed workflow runs", value: "list" },
      { label: "Paste workflow run URL", value: "url" }
    ],
    {
      placeHolder: input.label || "How should CMSIS-Dev select the workflow run?"
    }
  );

  if (!source) {
    return undefined;
  }

  let parsed: { owner: string; repo: string; runId: number } | undefined;

  if (source.value === "url") {
    const url = await vscode.window.showInputBox({
      title: "Workflow Run URL",
      prompt: input.label || "Paste a GitHub workflow run URL",
      placeHolder: "https://github.com/owner/repo/actions/runs/123456789",
      ignoreFocusOut: true,
      validateInput: (value) =>
        parseWorkflowRunUrl(value) ? null : "Expected format: https://github.com/owner/repo/actions/runs/123456789"
    });

    if (!url) {
      return undefined;
    }

    parsed = parseWorkflowRunUrl(url);
    if (!parsed) {
      return undefined;
    }
  } else {
    const workspaceRepos = (await resolveGitReposFromWorkspace()).filter(
      (repo): repo is { rootPath: string; workspaceFolderName: string; owner: string; repo: string } => Boolean(repo.owner && repo.repo)
    );

    if (workspaceRepos.length === 0) {
      vscode.window.showInformationMessage("No workspace repositories with a GitHub origin were found.");
      return undefined;
    }

    const uniqueRepos = new Map<string, Array<{ owner: string; repo: string; rootPath: string; workspaceFolderName: string }>>();
    for (const workspaceRepo of workspaceRepos) {
      const key = `${workspaceRepo.owner}/${workspaceRepo.repo}`.toLowerCase();
      const existing = uniqueRepos.get(key) ?? [];
      existing.push(workspaceRepo);
      uniqueRepos.set(key, existing);
    }

    const repoResults = await Promise.all(
      Array.from(uniqueRepos.values()).map(async (repoInfos) => {
        const [repoInfo] = repoInfos;
        const runs = await listFailedWorkflowRuns(repoInfo.owner, repoInfo.repo, { token });
        return { repoInfos, runs };
      })
    );

    const quickPickItems = repoResults.flatMap(({ repoInfos, runs }) =>
      repoInfos.flatMap((repoInfo) =>
        runs.map((run) => ({
          label: `${run.name} #${run.runNumber}`,
          description: `${repoInfo.owner}/${repoInfo.repo} (${repoInfo.workspaceFolderName})`,
          detail: `${run.conclusion || run.status} | ${run.headBranch || "(unknown branch)"} | ${run.displayTitle}`,
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          runId: run.id
        }))
      )
    );

    if (quickPickItems.length === 0) {
      vscode.window.showInformationMessage("No recent failed workflow runs were found in workspace repositories.");
      return undefined;
    }

    const selectedRun = await vscode.window.showQuickPick(quickPickItems, {
      placeHolder: "Select a failed workflow run"
    });
    if (!selectedRun) {
      return undefined;
    }

    parsed = {
      owner: selectedRun.owner,
      repo: selectedRun.repo,
      runId: selectedRun.runId
    };
  }

  const run = await getWorkflowRun(parsed.owner, parsed.repo, parsed.runId, { token });
  const jobs = await getWorkflowRunJobs(parsed.owner, parsed.repo, parsed.runId, { token });
  const failingJobs = jobs.filter((job) => job.conclusion && job.conclusion !== "success" && job.conclusion !== "skipped");
  const jobsForLogs = failingJobs.length > 0 ? failingJobs.slice(0, 3) : jobs.slice(0, 2);
  const logSections = await Promise.all(
    jobsForLogs.map(async (job) => {
      try {
        const log = await getWorkflowJobLog(parsed.owner, parsed.repo, job.id, { token });
        return `Job: ${job.name}\nConclusion: ${job.conclusion || "(unknown)"}\nLog excerpt:\n${tailText(log, 8_000)}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Job: ${job.name}\nConclusion: ${job.conclusion || "(unknown)"}\nLog excerpt unavailable: ${message}`;
      }
    })
  );

  const workspaceRepo = await resolveWorkspaceRepoForRemote(parsed.owner, parsed.repo);
  return {
    owner: parsed.owner,
    repo: parsed.repo,
    runId: parsed.runId,
    run,
    jobs,
    logs: truncateForPrompt(logSections.join("\n\n---\n\n"), 16_000),
    rootPath: workspaceRepo?.rootPath,
    workspaceFolderName: workspaceRepo?.workspaceFolderName
  };
}

async function selectRunOutputContext(
  workflow: Pick<WorkflowDefinition, "id" | "title">,
  input: WorkflowInputDefinition,
  presetRunOutputUri?: vscode.Uri
): Promise<SelectedRunOutputContext | undefined> {
  const runsDirUri = await resolveWorkflowRunsDirUri();
  if (!runsDirUri || runsDirUri.scheme !== "file") {
    vscode.window.showWarningMessage("No CMSIS-Dev runs directory is available in this workspace yet.");
    return undefined;
  }

  const allowedWorkflowIds = resolveAllowedSourceWorkflowIds(workflow.id);

  if (presetRunOutputUri?.scheme === "file") {
    const metadata = await readOutputMetadata(presetRunOutputUri);
    if (!metadata) {
      vscode.window.showWarningMessage("No action metadata found for the selected run output.");
      return undefined;
    }

    if (allowedWorkflowIds && !allowedWorkflowIds.includes(metadata.workflowId)) {
      vscode.window.showWarningMessage(`'${workflow.title}' cannot use '${metadata.workflowTitle}' as its input.`);
      return undefined;
    }

    const outputText = await resolveOutputFileText(metadata);
    if (!outputText?.trim()) {
      vscode.window.showWarningMessage("The selected CMSIS-Dev run output could not be read.");
      return undefined;
    }

    return {
      outputFile: presetRunOutputUri,
      outputText: truncateRunOutputForPrompt(outputText),
      metadata
    };
  }

  let entries: string[] = [];
  try {
    entries = (await fs.readdir(runsDirUri.fsPath))
      .filter((entry) => entry.endsWith(".md") && !entry.endsWith(".reasoning.md"))
      .sort((left, right) => right.localeCompare(left));
  } catch {
    // Keep empty fallback.
  }

  const candidates: Array<{
    label: string;
    description: string;
    detail: string;
    outputFile: vscode.Uri;
    metadata: ActionOutputMetadata;
  }> = [];

  for (const entry of entries) {
    const outputFile = vscode.Uri.file(path.join(runsDirUri.fsPath, entry));
    const metadata = await readOutputMetadata(outputFile);
    if (!metadata) {
      continue;
    }
    if (allowedWorkflowIds && !allowedWorkflowIds.includes(metadata.workflowId)) {
      continue;
    }

    candidates.push({
      label: formatRunOutputLabel(outputFile.fsPath, metadata),
      description: metadata.workflowId,
      detail: outputFile.fsPath,
      outputFile,
      metadata
    });
  }

  if (candidates.length === 0) {
    const constraintText = allowedWorkflowIds?.length
      ? ` compatible with '${workflow.title}'`
      : "";
    vscode.window.showWarningMessage(`No previous CMSIS-Dev run outputs${constraintText} were found.`);
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(candidates, {
    title: input.label || "Choose Previous CMSIS-Dev Run",
    placeHolder: "Select the previous CMSIS-Dev result to use as context"
  });
  if (!selected) {
    return undefined;
  }

  const outputText = await resolveOutputFileText(selected.metadata);
  if (!outputText?.trim()) {
    vscode.window.showWarningMessage("The selected CMSIS-Dev run output could not be read.");
    return undefined;
  }

  return {
    outputFile: selected.outputFile,
    outputText: truncateRunOutputForPrompt(outputText),
    metadata: selected.metadata
  };
}

async function collectLocalChangesValues(selected: {
  rootPath: string;
  workspaceFolderName: string;
  owner?: string;
  repo?: string;
}, inputId: string): Promise<{ context: SelectedLocalChangesContext; values: Record<string, string> } | undefined> {
  const defaultRef = await resolveDefaultBranchRef(selected.rootPath);
  if (!defaultRef) {
    throw new Error(`Could not resolve the default branch for repository '${selected.rootPath}'.`);
  }

  const currentBranch = (await runGitCommand(selected.rootPath, ["branch", "--show-current"])).trim() || "detached HEAD";
  const changedEntries = await getTrackedDiffEntries(selected.rootPath, defaultRef.ref);

  if (changedEntries.length === 0) {
    return undefined;
  }

  const fileSections = await formatLocalChangeSections(selected.rootPath, defaultRef.ref, changedEntries);
  const latestLocalReview = await findLatestLocalReviewSummary(selected.rootPath);
  const pullRequestTemplates = await readPullRequestTemplates(selected.rootPath);
  const changedFilesList = changedEntries.map((entry) => entry.displayPath);
  const uniqueChangedFiles = Array.from(new Set(changedFilesList));
  const values: Record<string, string> = {
    [inputId]: selected.rootPath,
    [`${inputId}_repoPath`]: selected.rootPath,
    [`${inputId}_workspaceFolder`]: selected.workspaceFolderName,
    [`${inputId}_currentBranch`]: currentBranch,
    [`${inputId}_defaultBranch`]: defaultRef.shortName,
    [`${inputId}_compareRef`]: defaultRef.ref,
    [`${inputId}_changedFiles`]: formatSimpleList(uniqueChangedFiles, "(No changed files found)"),
    [`${inputId}_changedFilesCount`]: String(uniqueChangedFiles.length),
    [`${inputId}_fileSections`]: fileSections,
    [`${inputId}_latestLocalReview`]: latestLocalReview,
    [`${inputId}_pullRequestTemplates`]: pullRequestTemplates
  };

  values.repoPath ??= selected.rootPath;
  values.workspaceFolder ??= selected.workspaceFolderName;
  values.currentBranch ??= currentBranch;
  values.defaultBranch ??= defaultRef.shortName;
  values.compareRef ??= defaultRef.ref;
  values.changedFiles ??= formatSimpleList(uniqueChangedFiles, "(No changed files found)");
  values.changedFilesCount ??= String(uniqueChangedFiles.length);
  values.fileSections ??= fileSections;
  values.latestLocalReview ??= latestLocalReview;
  values.pullRequestTemplates ??= pullRequestTemplates;
  if (selected.owner) {
    values.owner ??= selected.owner;
  }
  if (selected.repo) {
    values.repo ??= selected.repo;
  }

  return {
    context: {
      rootPath: selected.rootPath,
      workspaceFolderName: selected.workspaceFolderName,
      owner: selected.owner,
      repo: selected.repo,
      currentBranch,
      defaultRef: defaultRef.ref,
      defaultBranchName: defaultRef.shortName,
      changedFiles: uniqueChangedFiles.length
    },
    values
  };
}

function parsePrUrl(url: string): { owner: string; repo: string; number: number } | undefined {
  const match = url.trim().match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/i);
  if (!match) {
    return undefined;
  }

  return {
    owner: match[1],
    repo: match[2],
    number: Number.parseInt(match[3], 10)
  };
}

function parseIssueUrl(url: string): { owner: string; repo: string; number: number } | undefined {
  const match = url.trim().match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:\/.*)?$/i);
  if (!match) {
    return undefined;
  }

  return {
    owner: match[1],
    repo: match[2],
    number: Number.parseInt(match[3], 10)
  };
}

function parseRepo(input: string): { owner: string; repo: string } | undefined {
  const match = input.trim().match(/^([^/]+)\/([^/]+)$/);
  if (!match) {
    return undefined;
  }

  return { owner: match[1], repo: match[2] };
}

function formatFileSections(files: PullRequestFile[]): string {
  return files
    .map((file) => {
      const patch = (file.patch ?? "(No textual diff available)").slice(0, 4000);
      return `File: ${file.filename}\nStatus: ${file.status}, +${file.additions} -${file.deletions}\nPatch:\n${patch}`;
    })
    .join("\n\n---\n\n");
}

function formatIssueComments(comments: IssueComment[]): string {
  if (comments.length === 0) {
    return "(No issue comments available)";
  }

  return comments
    .map((comment) => {
      const body = (comment.body || "(No comment body)").slice(0, 4000);
      return `Comment by @${comment.author}${comment.createdAt ? ` on ${comment.createdAt}` : ""}:\n${body}`;
    })
    .join("\n\n---\n\n");
}

function formatSimpleList(items: string[], emptyText: string): string {
  if (items.length === 0) {
    return emptyText;
  }

  return items.map((item) => `- ${item}`).join("\n");
}

function formatWorkflowRunJobs(
  jobs: Array<{
    name: string;
    status: string;
    conclusion: string;
    steps: Array<{ name: string; conclusion: string }>;
  }>
): string {
  if (jobs.length === 0) {
    return "(No workflow jobs found)";
  }

  return jobs
    .map((job) => {
      const failingSteps = job.steps.filter((step) => step.conclusion && step.conclusion !== "success" && step.conclusion !== "skipped");
      const failingStepSummary =
        failingSteps.length > 0
          ? ` | failing steps: ${failingSteps.map((step) => step.name).join(", ")}`
          : "";
      return `- ${job.name} [status: ${job.status || "unknown"}, conclusion: ${job.conclusion || "unknown"}]${failingStepSummary}`;
    })
    .join("\n");
}

function resolveAllowedSourceWorkflowIds(workflowId: string): readonly string[] | undefined {
  if (workflowId === "plan-next-steps") {
    return ["review-pr", "review-changes", "explain-issue", "explain-ci-failure"];
  }

  return undefined;
}

function formatRunOutputLabel(
  outputPath: string,
  metadata: Pick<ActionOutputMetadata, "workflowTitle" | "prContext" | "issueContext" | "localChangesContext">
): string {
  const workflowTitle = metadata.workflowTitle?.trim();
  const prNumber = metadata.prContext?.pr.number;
  if (workflowTitle && typeof prNumber === "number") {
    return `${workflowTitle} #${prNumber}`;
  }

  const issueNumber = metadata.issueContext?.issue.number;
  if (workflowTitle && typeof issueNumber === "number") {
    return `${workflowTitle} #${issueNumber}`;
  }

  if (workflowTitle) {
    const workspaceFolderName = metadata.localChangesContext?.workspaceFolderName?.trim();
    if (workspaceFolderName) {
      return `${workflowTitle} ${workspaceFolderName}`;
    }

    const rootPath = metadata.localChangesContext?.rootPath?.trim();
    if (rootPath) {
      return `${workflowTitle} ${path.basename(rootPath)}`;
    }

    return workflowTitle;
  }

  return path.basename(outputPath).replace(/-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?=\.md$)/, "");
}

function truncateRunOutputForPrompt(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 12_000) {
    return trimmed;
  }

  return `${trimmed.slice(0, 12_000)}\n\n[Truncated by CMSIS-Dev for chat context.]`;
}

function tailText(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `[Truncated to last ${maxLength} characters]\n${normalized.slice(-maxLength)}`;
}

function truncateForPrompt(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}\n\n[Truncated by CMSIS-Dev for prompt size.]`;
}

async function readPullRequestTemplates(repoRoot: string): Promise<string> {
  const templatePaths = [
    path.join(repoRoot, ".github", "pull_request_template.md"),
    path.join(repoRoot, ".github", "PULL_REQUEST_TEMPLATE.md"),
    path.join(repoRoot, "pull_request_template.md"),
    path.join(repoRoot, "PULL_REQUEST_TEMPLATE.md")
  ];
  const templatesDir = path.join(repoRoot, ".github", "PULL_REQUEST_TEMPLATE");

  try {
    const entries = await fs.readdir(templatesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        templatePaths.push(path.join(templatesDir, entry.name));
      }
    }
  } catch {
    // No template directory found.
  }

  const sections: string[] = [];
  for (const templatePath of Array.from(new Set(templatePaths))) {
    try {
      const content = (await fs.readFile(templatePath, "utf8")).trim();
      if (!content) {
        continue;
      }

      sections.push(`Template: ${path.relative(repoRoot, templatePath)}\n${content.slice(0, 6000)}`);
    } catch {
      // Skip missing or unreadable template files.
    }
  }

  return sections.length > 0 ? sections.join("\n\n---\n\n") : "(No pull request templates found)";
}

async function findLatestLocalReviewSummary(repoRoot: string): Promise<string> {
  const runsDirUri = await resolveWorkflowRunsDirUri();
  if (!runsDirUri || runsDirUri.scheme !== "file") {
    return "(No previous local review found)";
  }

  let metadataFiles: string[] = [];
  try {
    const entries = await fs.readdir(runsDirUri.fsPath, { withFileTypes: true });
    metadataFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".meta.json"))
      .map((entry) => path.join(runsDirUri.fsPath, entry.name));
  } catch {
    return "(No previous local review found)";
  }

  const matches: Array<{ modifiedAt: number; output: string }> = [];
  for (const metadataPath of metadataFiles) {
    try {
      const raw = await fs.readFile(metadataPath, "utf8");
      const metadata = JSON.parse(raw) as ActionOutputMetadata;
      if (metadata.workflowId !== "review-changes") {
        continue;
      }
      if (metadata.localChangesContext?.rootPath !== repoRoot) {
        continue;
      }
      if (!metadata.generatedOutput) {
        continue;
      }

      const stat = await fs.stat(metadataPath);
      matches.push({
        modifiedAt: stat.mtimeMs,
        output: metadata.generatedOutput.slice(0, 8000)
      });
    } catch {
      // Skip malformed metadata.
    }
  }

  if (matches.length === 0) {
    return "(No previous local review found)";
  }

  matches.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return matches[0].output;
}

async function resolveDefaultBranchRef(repoRoot: string): Promise<{ ref: string; shortName: string } | undefined> {
  const originHead = (await tryRunGitCommand(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]))?.trim();
  if (originHead) {
    const shortName = originHead.replace(/^origin\//, "");
    return { ref: originHead, shortName };
  }

  const fallbackRefs = [
    { ref: "refs/remotes/origin/main", shortName: "main" },
    { ref: "refs/remotes/origin/master", shortName: "master" },
    { ref: "refs/remotes/origin/develop", shortName: "develop" },
    { ref: "refs/remotes/origin/dev", shortName: "dev" },
    { ref: "refs/remotes/origin/trunk", shortName: "trunk" },
    { ref: "refs/heads/main", shortName: "main" },
    { ref: "refs/heads/master", shortName: "master" },
    { ref: "refs/heads/develop", shortName: "develop" },
    { ref: "refs/heads/dev", shortName: "dev" },
    { ref: "refs/heads/trunk", shortName: "trunk" }
  ];

  for (const candidate of fallbackRefs) {
    const resolved = await tryRunGitCommand(repoRoot, ["rev-parse", "--verify", candidate.ref]);
    if (resolved?.trim()) {
      return candidate;
    }
  }

  const remoteCandidates = await listBranchRefCandidates(repoRoot, "refs/remotes/origin", "remote");
  if (remoteCandidates.length === 1) {
    return remoteCandidates[0];
  }

  const localCandidates = await listBranchRefCandidates(repoRoot, "refs/heads", "local");
  if (localCandidates.length === 1) {
    return localCandidates[0];
  }

  const quickPickCandidates = dedupeBranchRefCandidates([...remoteCandidates, ...localCandidates]);
  if (quickPickCandidates.length > 0) {
    const selected = await vscode.window.showQuickPick(
      quickPickCandidates.map((candidate) => ({
        label: candidate.shortName,
        description: candidate.source === "remote" ? "origin" : "local",
        detail: candidate.ref,
        candidate
      })),
      {
        title: "Select Base Branch",
        placeHolder: `Choose the branch to compare local changes against for ${path.basename(repoRoot)}`
      }
    );

    return selected?.candidate;
  }

  return undefined;
}

async function listBranchRefCandidates(
  repoRoot: string,
  refPrefix: string,
  source: "remote" | "local"
): Promise<Array<{ ref: string; shortName: string; source: "remote" | "local" }>> {
  const raw = await tryRunGitCommand(repoRoot, ["for-each-ref", "--format=%(refname)", refPrefix]);
  if (!raw) {
    return [];
  }

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((ref) => ref !== "refs/remotes/origin/HEAD")
    .map((ref) => ({
      ref,
      shortName: ref.replace(/^refs\/remotes\/origin\//, "").replace(/^refs\/heads\//, ""),
      source
    }));
}

function dedupeBranchRefCandidates(
  candidates: Array<{ ref: string; shortName: string; source: "remote" | "local" }>
): Array<{ ref: string; shortName: string; source: "remote" | "local" }> {
  const priority = (candidate: { shortName: string; source: "remote" | "local" }): number => {
    const preferredNames = ["main", "master", "develop", "dev", "trunk"];
    const nameIndex = preferredNames.indexOf(candidate.shortName);
    const sourceWeight = candidate.source === "remote" ? 0 : 10;
    return sourceWeight + (nameIndex >= 0 ? nameIndex : preferredNames.length + 1);
  };

  return candidates
    .slice()
    .sort((left, right) => {
      const leftPriority = priority(left);
      const rightPriority = priority(right);
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      return left.shortName.localeCompare(right.shortName);
    })
    .filter((candidate, index, all) => {
      const firstIndex = all.findIndex(
        (entry) => entry.shortName === candidate.shortName && entry.source === candidate.source
      );
      return firstIndex === index;
    });
}

async function getTrackedDiffEntries(
  repoRoot: string,
  defaultRef: string
): Promise<Array<{ status: string; displayPath: string; pathSpec: string }>> {
  const raw = await runGitCommand(repoRoot, ["diff", "--no-ext-diff", "--find-renames", "--name-status", defaultRef]);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const status = parts[0] ?? "M";
      if (status.startsWith("R") || status.startsWith("C")) {
        const fromPath = parts[1] ?? "";
        const toPath = parts[2] ?? fromPath;
        return {
          status,
          displayPath: `${fromPath} -> ${toPath}`,
          pathSpec: toPath
        };
      }

      return {
        status,
        displayPath: parts[1] ?? parts[0],
        pathSpec: parts[1] ?? parts[0]
      };
    });
}

async function formatLocalChangeSections(
  repoRoot: string,
  defaultRef: string,
  changedEntries: Array<{ status: string; displayPath: string; pathSpec: string }>
): Promise<string> {
  const trackedSections = await Promise.all(
    changedEntries.map(async (entry) => {
      const patch = (
        await runGitCommand(repoRoot, ["diff", "--no-ext-diff", "--find-renames", "--unified=3", defaultRef, "--", entry.pathSpec])
      ).trim();
      const displayPatch = patch.length > 0 ? patch.slice(0, 4000) : "(No textual diff available)";
      return `File: ${entry.displayPath}\nStatus: ${entry.status}\nPatch:\n${displayPatch}`;
    })
  );

  return trackedSections.join("\n\n---\n\n");
}

async function runGitCommand(
  repoRoot: string,
  args: string[],
  options: {
    timeoutMs?: number;
  } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile(
      "git",
      args,
      {
        cwd: repoRoot,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        timeout: options.timeoutMs,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never"
        }
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message).trim() || `git ${args.join(" ")} failed`));
          return;
        }

        resolve(stdout);
      }
    );
  });
}

async function tryRunGitCommand(repoRoot: string, args: string[]): Promise<string | undefined> {
  try {
    return await runGitCommand(repoRoot, args);
  } catch {
    return undefined;
  }
}

function buildWorkflowPrompt(template: string, values: Record<string, string>, additionalInstructions?: string): string {
  const prompt = renderPromptTemplate(template, values);
  const extra = additionalInstructions?.trim();
  if (!extra) {
    return prompt;
  }

  return [prompt.trimEnd(), "", "Additional user instructions:", extra].join("\n");
}

async function generateWithLanguageModel(
  prompt: string,
  options: GenerationOptions = {}
): Promise<GeneratedReview | undefined> {
  return tryGenerateWithVsCodeLm(prompt, options);
}

async function tryGenerateWithVsCodeLm(prompt: string, options: GenerationOptions = {}): Promise<GeneratedReview | undefined> {
  const generationStartedAtMs = Date.now();
  const generationStartedAt = new Date(generationStartedAtMs).toISOString();
  const model = options.model ?? (await resolveConfiguredLanguageModel());
  if (!model) {
    throw new Error("No VS Code chat model is available for CMSIS-Dev. Select a model in Chat or configure a provider in the Language Models view.");
  }

  const modelLabel = formatLanguageModelLabel(model);
  const reasoningEffort = getConfiguredReasoningEffort();
  options.onStatus?.(
    reasoningEffort ? `Requesting ${modelLabel} | ${formatReasoningEffortLabel(reasoningEffort)}` : `Requesting ${modelLabel}`
  );

  try {
    const promptTokens = await countLanguageModelTokens(model, prompt);
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)],
      {
        justification: "CMSIS-Dev needs a language model to run repository workflows such as reviews, issue explanations, and PR drafts.",
        modelOptions: buildReasoningModelOptions(reasoningEffort)
      }
    );

    let content = "";
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        content += part.value;
      }
    }

    const normalized = content.trim();
    const generationCompletedAtMs = Date.now();
    const outputTokens = normalized ? await countLanguageModelTokens(model, normalized) : undefined;
    const metrics: ActionMetrics = {
      startedAt: generationStartedAt,
      completedAt: new Date(generationCompletedAtMs).toISOString(),
      elapsedMs: generationCompletedAtMs - generationStartedAtMs,
      generationMs: generationCompletedAtMs - generationStartedAtMs,
      promptTokens,
      outputTokens,
      totalTokens:
        typeof promptTokens === "number" || typeof outputTokens === "number"
          ? (promptTokens ?? 0) + (outputTokens ?? 0)
          : undefined,
      promptCharacters: prompt.length,
      outputCharacters: normalized.length
    };
    return normalized
      ? {
          agentName: "VS Code Chat",
          modelName: modelLabel,
          content: normalized,
          metrics
        }
      : undefined;
  } catch (error) {
    throw new Error(describeLanguageModelError(error));
  }
}

async function countLanguageModelTokens(model: vscode.LanguageModelChat, text: string): Promise<number | undefined> {
  try {
    return await model.countTokens(text);
  } catch {
    return undefined;
  }
}

function describeLanguageModelError(error: unknown): string {
  if (error instanceof vscode.LanguageModelError) {
    switch (error.code) {
      case "NoPermissions":
        return "VS Code denied CMSIS-Dev access to the selected language model. Run the action again and accept the permission prompt.";
      case "NotFound":
        return "The configured VS Code language model is no longer available. Choose another model in CMSIS-Dev settings.";
      case "Blocked":
        return "The selected VS Code language model is currently blocked or out of quota.";
      default:
        return error.message;
    }
  }

  return error instanceof Error ? error.message : String(error);
}

async function writeOutputFile(
  workflowId: string,
  content: string,
  prContext?: SelectedPrContext,
  issueContext?: SelectedIssueContext,
  localChangesContext?: SelectedLocalChangesContext
): Promise<vscode.Uri> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    const contextSuffix = prContext
      ? `${prContext.pr.number}`
      : issueContext
        ? `${issueContext.issue.number}`
        : localChangesContext
          ? path.basename(localChangesContext.rootPath)
          : "output";
    const untitledName = `${workflowId}-${contextSuffix}.md`;
    const untitled = vscode.Uri.parse(`untitled:${untitledName}`);
    const doc = await vscode.workspace.openTextDocument(untitled);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    await editor.edit((editBuilder) => {
      editBuilder.insert(new vscode.Position(0, 0), content);
    });
    return untitled;
  }

  const runsDirUri = await resolveWorkflowRunsDirUri(true);
  const targetDir = runsDirUri?.scheme === "file" ? runsDirUri.fsPath : path.join(workspaceFolder.uri.fsPath, ".cmsis-dev", "runs");
  await fs.mkdir(targetDir, { recursive: true });
  const timestamp = formatCompactTimestamp(new Date());
  const contextSegment = prContext
    ? `-${prContext.pr.number}`
    : issueContext
      ? `-${issueContext.issue.number}`
      : localChangesContext
        ? `-${path.basename(localChangesContext.rootPath)}`
        : "";
  const targetFile = path.join(targetDir, `${workflowId}${contextSegment}-${timestamp}.md`);
  await fs.writeFile(targetFile, content, "utf8");
  return vscode.Uri.file(targetFile);
}

function formatCompactTimestamp(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  const hours = String(value.getUTCHours()).padStart(2, "0");
  const minutes = String(value.getUTCMinutes()).padStart(2, "0");
  const seconds = String(value.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}_${hours}${minutes}${seconds}Z`;
}

async function writeReasoningFile(outputFile: vscode.Uri, payload: Record<string, unknown>): Promise<vscode.Uri> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder || outputFile.scheme !== "file") {
    const liveReasoningFile = await createTransientReasoningFile();
    await updateReasoningFile(liveReasoningFile, payload);
    return liveReasoningFile;
  }

  const reasoningPath = `${outputFile.fsPath}.reasoning.md`;
  await fs.writeFile(reasoningPath, renderReasoningMarkdown(payload), "utf8");
  return vscode.Uri.file(reasoningPath);
}

async function createTransientReasoningFile(): Promise<vscode.Uri> {
  const tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "cmsis-dev-"));
  const filePath = path.join(tempBaseDir, "action-reasoning.md");
  await fs.writeFile(filePath, "# AI Action Reasoning\n", "utf8");
  return vscode.Uri.file(filePath);
}

async function updateReasoningFile(reasoningFile: vscode.Uri, payload: Record<string, unknown>): Promise<void> {
  if (reasoningFile.scheme !== "file") {
    return;
  }

  await fs.writeFile(reasoningFile.fsPath, renderReasoningMarkdown(payload), "utf8");
}

async function writeOutputMetadata(outputFile: vscode.Uri, metadata: ActionOutputMetadata): Promise<void> {
  if (outputFile.scheme !== "file") {
    return;
  }

  const metadataPath = `${outputFile.fsPath}.meta.json`;
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function readOutputMetadata(outputUri: vscode.Uri): Promise<ActionOutputMetadata | undefined> {
  if (outputUri.scheme !== "file") {
    return undefined;
  }

  const metadataPath = `${outputUri.fsPath}.meta.json`;
  try {
    const raw = await fs.readFile(metadataPath, "utf8");
    return JSON.parse(raw) as ActionOutputMetadata;
  } catch {
    return undefined;
  }
}

async function resolveOutputFileText(metadata: Pick<ActionOutputMetadata, "outputFile">): Promise<string | undefined> {
  const outputPath = metadata.outputFile?.trim();
  if (!outputPath) {
    return undefined;
  }

  const openDocument = vscode.workspace.textDocuments.find(
    (document) => document.uri.scheme === "file" && isSameFilePath(document.uri.fsPath, outputPath)
  );
  if (openDocument) {
    return openDocument.getText();
  }

  try {
    return await fs.readFile(outputPath, "utf8");
  } catch {
    return undefined;
  }
}

function resolveWorkflowFollowUps(workflow: Pick<WorkflowDefinition, "id" | "type" | "followUps">): WorkflowFollowUp[] {
  const configured = normalizeFollowUps(workflow.followUps);
  if (configured.length > 0) {
    return configured;
  }

  return [...DEFAULT_OUTPUT_FOLLOW_UPS];
}

function normalizeFollowUps(followUps: readonly WorkflowFollowUp[] | undefined): WorkflowFollowUp[] {
  const allowed = new Set<WorkflowFollowUp>(["openReasoning", "openPr", "openIssue", "postComment", "submitPr"]);
  return Array.from(new Set((followUps ?? []).filter((followUp) => allowed.has(followUp)))) as WorkflowFollowUp[];
}

function resolveMetadataFollowUps(
  metadata: Pick<ActionOutputMetadata, "workflowId" | "followUps" | "prContext" | "issueContext" | "pullRequestDraft">
): WorkflowFollowUp[] {
  const configured = normalizeFollowUps(metadata.followUps);
  if (configured.length > 0) {
    return configured;
  }

  return [...DEFAULT_OUTPUT_FOLLOW_UPS];
}

function getActiveOutputFollowUpStateFromMetadata(metadata: ActionOutputMetadata): ActiveOutputFollowUpState {
  const followUps = resolveMetadataFollowUps(metadata);
  return {
    canOpenReasoning: followUps.includes("openReasoning") && Boolean(metadata.reasoningFile),
    canOpenPr: followUps.includes("openPr") && Boolean(metadata.prContext?.pr.htmlUrl),
    canOpenIssue: followUps.includes("openIssue") && Boolean(metadata.issueContext?.issue.htmlUrl),
    canPostComment: followUps.includes("postComment") && Boolean(metadata.prContext) && Boolean(metadata.outputFile),
    canSubmitPr:
      followUps.includes("submitPr") &&
      Boolean(metadata.outputFile) &&
      Boolean(metadata.localChangesContext?.rootPath) &&
      Boolean(metadata.localChangesContext?.owner) &&
      Boolean(metadata.localChangesContext?.repo)
  };
}

async function resolveWorkspaceRepoForRemote(
  owner: string,
  repo: string
): Promise<{ rootPath: string; workspaceFolderName: string } | undefined> {
  const matches = (await resolveGitReposFromWorkspace()).filter(
    (workspaceRepo) =>
      workspaceRepo.owner?.toLowerCase() === owner.toLowerCase() && workspaceRepo.repo?.toLowerCase() === repo.toLowerCase()
  );

  if (matches.length === 0) {
    return undefined;
  }

  if (matches.length === 1) {
    return {
      rootPath: matches[0].rootPath,
      workspaceFolderName: matches[0].workspaceFolderName
    };
  }

  const selected = await vscode.window.showQuickPick(
    matches.map((workspaceRepo) => ({
      label: `${owner}/${repo}`,
      description: `${workspaceRepo.workspaceFolderName} | ${workspaceRepo.rootPath}`,
      repo: workspaceRepo
    })),
    {
      placeHolder: `Select the local workspace repository for ${owner}/${repo}`
    }
  );

  if (!selected) {
    return undefined;
  }

  return {
    rootPath: selected.repo.rootPath,
    workspaceFolderName: selected.repo.workspaceFolderName
  };
}


function parsePullRequestDraft(content: string): PullRequestDraft | undefined {
  const normalized = content.trim();
  if (!normalized) {
    return undefined;
  }

  const match = normalized.match(/^Title:\s*(.+?)\r?\n\r?\nBody:\s*([\s\S]+)$/i);
  if (!match) {
    return undefined;
  }

  const title = match[1].trim();
  const body = match[2].trim();
  if (!title || !body) {
    return undefined;
  }

  return { title, body };
}

function parsePullRequestDraftFromOutputFile(content: string): PullRequestDraft | undefined {
  const direct = parsePullRequestDraft(content);
  if (direct) {
    return direct;
  }

  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return undefined;
  }

  const lines = normalized.split("\n");
  let index = 0;
  while (index < lines.length && lines[index].startsWith(">")) {
    index += 1;
  }
  while (index < lines.length && lines[index].trim().length === 0) {
    index += 1;
  }

  const bodyWithoutPreamble = lines.slice(index).join("\n").trim();
  if (!bodyWithoutPreamble) {
    return undefined;
  }

  const markdownMatch = bodyWithoutPreamble.match(/^#\s+(.+?)\n+([\s\S]+)$/);
  if (!markdownMatch) {
    return undefined;
  }

  const title = markdownMatch[1].trim();
  const body = markdownMatch[2].trim();
  if (!title || !body) {
    return undefined;
  }

  return { title, body };
}

function renderPullRequestDraftOutput(content: string, draft: PullRequestDraft | undefined): string {
  if (!draft) {
    return content.trim();
  }

  return [`# ${draft.title}`, "", draft.body].join("\n").trim();
}

function isSameFilePath(left: string, right: string): boolean {
  return path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();
}

async function generatePullRequestBranchName(
  repoRoot: string,
  draft: PullRequestDraft,
  defaultBranchName: string
): Promise<string> {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "if",
    "in",
    "into",
    "is",
    "it",
    "of",
    "on",
    "or",
    "that",
    "the",
    "this",
    "to",
    "update",
    "with"
  ]);
  const source = `${draft.title}\n${draft.body}`;
  const tokens = source
    .toLowerCase()
    .replace(/[`*_#:[\]().,!?/\\]+/g, " ")
    .split(/[\s-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => /^[a-z0-9]+$/.test(token))
    .filter((token) => !stopWords.has(token));
  const uniqueTokens = Array.from(new Set(tokens));
  const selectedTokens = uniqueTokens.slice(0, 4);
  const baseName = selectedTokens.length > 0 ? selectedTokens.join("-") : "change-set";
  const sanitizedBaseName = sanitizeBranchName(baseName);
  const candidateBaseName =
    sanitizedBaseName && sanitizedBaseName !== defaultBranchName ? sanitizedBaseName : "change-set";

  return ensureUniqueBranchName(repoRoot, candidateBaseName);
}

function sanitizeBranchName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9/-]+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

async function ensureUniqueBranchName(repoRoot: string, baseName: string): Promise<string> {
  const normalizedBaseName = sanitizeBranchName(baseName) || "change-set";
  const existingRefs = new Set(
    (
      await Promise.all([
        tryRunGitCommand(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
        tryRunGitCommand(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"])
      ])
    )
      .flatMap((raw) => (raw ?? "").split(/\r?\n/))
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^origin\//, ""))
  );

  if (!existingRefs.has(normalizedBaseName)) {
    return normalizedBaseName;
  }

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${normalizedBaseName}-${suffix}`;
    if (!existingRefs.has(candidate)) {
      return candidate;
    }
  }

  return `${normalizedBaseName}-${Date.now()}`;
}

function renderReasoningMarkdown(payload: Record<string, unknown>): string {
  const lines: string[] = ["# AI Action Reasoning", ""];
  const appendField = (label: string, value: unknown): void => {
    if (value === undefined || value === null || value === "") {
      return;
    }

    lines.push(`- **${label}:** ${String(value)}`);
  };

  appendField("Timestamp", payload.timestamp);
  appendField("Status", payload.status);
  appendField("Phase", payload.phase);
  appendField("Workflow ID", payload.workflowId);
  appendField("Workflow Title", payload.workflowTitle);
  appendField("Engine", payload.engine);
  appendField("Agent", payload.agentName);
  appendField("Model", payload.modelName);
  appendField("Reasoning Effort", payload.reasoningEffort);
  appendField("Output File", payload.outputFile);
  appendField("Reasoning File", payload.reasoningFile);

  const metrics = payload.metrics;
  if (metrics !== undefined) {
    lines.push("");
    lines.push("## Metrics");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(metrics, null, 2));
    lines.push("```");
  }

  const prompt = typeof payload.prompt === "string" ? payload.prompt : undefined;
  if (prompt) {
    lines.push("");
    lines.push("## Prompt");
    lines.push("");
    lines.push("```text");
    lines.push(prompt);
    lines.push("```");
  }

  const inputValues = payload.inputValues;
  if (inputValues !== undefined) {
    lines.push("");
    lines.push("## Input Values");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(inputValues, null, 2));
    lines.push("```");
  }

  const prContext = payload.prContext;
  if (prContext !== undefined) {
    lines.push("");
    lines.push("## PR Context");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(prContext, null, 2));
    lines.push("```");
  }

  const issueContext = payload.issueContext;
  if (issueContext !== undefined) {
    lines.push("");
    lines.push("## Issue Context");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(issueContext, null, 2));
    lines.push("```");
  }

  const localChangesContext = payload.localChangesContext;
  if (localChangesContext !== undefined) {
    lines.push("");
    lines.push("## Local Changes Context");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(localChangesContext, null, 2));
    lines.push("```");
  }

  const pullRequestDraft = payload.pullRequestDraft;
  if (pullRequestDraft !== undefined) {
    lines.push("");
    lines.push("## Pull Request Draft");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(pullRequestDraft, null, 2));
    lines.push("```");
  }

  const generatedOutput = typeof payload.generatedOutput === "string" ? payload.generatedOutput : undefined;
  if (generatedOutput) {
    lines.push("");
    lines.push("## Generated Output");
    lines.push("");
    lines.push("```markdown");
    lines.push(generatedOutput);
    lines.push("```");
  }

  return `${lines.join("\n")}\n`;
}

function renderOutputWithExecutionInfo(
  content: string,
  details: { agentName: string; modelName: string; reasoningEffort?: CmsisDevReasoningEffort; metrics?: ActionMetrics }
): string {
  return [
    `> Interface: **${details.agentName}**`,
    `> Model: **${details.modelName}**`,
    ...(details.reasoningEffort ? [`> Reasoning Effort: **${details.reasoningEffort}**`] : []),
    ...(details.metrics ? [`> Metrics: ${formatActionMetricsSummary(details.metrics)}`] : []),
    "",
    content.trim()
  ].join("\n");
}

function formatActionMetricsSummary(metrics: ActionMetrics): string {
  const parts = [formatDuration(metrics.elapsedMs)];
  if (typeof metrics.promptTokens === "number") {
    parts.push(`${formatInteger(metrics.promptTokens)} input tokens`);
  }
  if (typeof metrics.outputTokens === "number") {
    parts.push(`${formatInteger(metrics.outputTokens)} output tokens`);
  }
  if (typeof metrics.totalTokens === "number") {
    parts.push(`${formatInteger(metrics.totalTokens)} total tokens`);
  }
  return parts.join(" | ");
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "unknown duration";
  }

  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }

  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}
