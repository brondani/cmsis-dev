import * as cp from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  resolveEffectiveCodexModel,
  resolveEffectiveCodexReasoningEffort
} from "../codexSettings";
import {
  createPullRequest,
  getIssue,
  getIssueComments,
  getIssueReferences,
  getPullRequest,
  getPullRequestFiles,
  listOpenIssues,
  listOpenPullRequests,
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

type ReviewEngine = "codex";

export interface PromptWorkflowOptions {
  onStatus?: (status: string) => void;
}

export interface PromptWorkflowResult {
  engine?: ReviewEngine;
  generated: boolean;
  handedOffToCodexChat: boolean;
  canceled?: boolean;
}

interface GeneratedReview {
  agentName: string;
  modelName: string;
  content: string;
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
}

interface ActionOutputMetadata {
  workflowId: string;
  workflowTitle: string;
  followUps: WorkflowFollowUp[];
  openCodexChatPrompt?: string;
  pullRequestDraft?: PullRequestDraft;
  engine: ReviewEngine;
  agentName: string;
  modelName: string;
  prompt: string;
  inputValues: Record<string, string>;
  generatedOutput?: string;
  outputFile: string;
  reasoningFile: string;
  prContext?: SelectedPrContext;
  issueContext?: SelectedIssueContext;
  localChangesContext?: SelectedLocalChangesContext;
}

interface CodexCliOptions {
  onEvent?: (event: Record<string, unknown>) => void | Promise<void>;
  onStatus?: (status: string) => void;
}

export interface ActiveOutputFollowUpState {
  canOpenReasoning: boolean;
  canOpenPr: boolean;
  canOpenIssue: boolean;
  canPostComment: boolean;
  canSubmitPr: boolean;
  canOpenCodexChat: boolean;
}

const DEFAULT_OUTPUT_FOLLOW_UPS: WorkflowFollowUp[] = ["openReasoning"];
const LEGACY_PR_OUTPUT_FOLLOW_UPS: WorkflowFollowUp[] = ["openReasoning", "openPr", "postComment", "openCodexChat"];
const LEGACY_CREATE_PR_OUTPUT_FOLLOW_UPS: WorkflowFollowUp[] = ["openReasoning", "submitPr"];
const LEGACY_REVIEW_LOCAL_OUTPUT_FOLLOW_UPS: WorkflowFollowUp[] = ["openReasoning", "openCodexChat"];
const LEGACY_ISSUE_OUTPUT_FOLLOW_UPS: WorkflowFollowUp[] = ["openReasoning", "openIssue", "openCodexChat"];
const EMPTY_ACTIVE_OUTPUT_FOLLOW_UP_STATE: ActiveOutputFollowUpState = {
  canOpenReasoning: false,
  canOpenPr: false,
  canOpenIssue: false,
  canPostComment: false,
  canSubmitPr: false,
  canOpenCodexChat: false
};

const CODEX_FOCUS_COMMANDS = ["chatgpt.openSidebar"];
const CODEX_NEW_THREAD_COMMANDS = ["chatgpt.newChat", "chatgpt.newCodexPanel"];
const CODEX_ADD_FILE_COMMAND = "chatgpt.addFileToThread";

interface CodexChatLaunchResult {
  focused: boolean;
  createdThread: boolean;
  commands: string[];
}

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

  const resolved = await collectInputValues(workflow, token);
  if (!resolved) {
    return {
      generated: false,
      handedOffToCodexChat: false,
      canceled: true
    };
  }

  reportStatus(`Preparing prompt for ${workflow.title}`);
  const prompt = renderPromptTemplate(promptTemplate, resolved.values);
  const openCodexChatPrompt = workflow.openCodexChatPromptTemplate?.trim()
    ? renderPromptTemplate(workflow.openCodexChatPromptTemplate, resolved.values)
    : undefined;
  const engine: ReviewEngine = "codex";
  const followUps = resolveWorkflowFollowUps(workflow);
  let pullRequestDraft: PullRequestDraft | undefined;

  const liveReasoningFile = await createTransientReasoningFile();
  const liveReasoningPayload: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    status: "running",
    phase: "generating",
    workflowId: workflow.id,
    workflowTitle: workflow.title,
    followUps,
    openCodexChatPrompt,
    pullRequestDraft,
    engine,
    prompt,
    inputValues: resolved.values,
    prContext: resolved.prContext,
    issueContext: resolved.issueContext,
    localChangesContext: resolved.localChangesContext,
    generatedOutput: undefined,
    outputFile: undefined
  };
  await updateReasoningFile(liveReasoningFile, liveReasoningPayload);

  liveReasoningPayload.phase = "codex-cli";
  liveReasoningPayload.status = "running";
  await updateReasoningFile(liveReasoningFile, liveReasoningPayload);
  reportStatus(`Generating ${workflow.title} with Codex CLI`);
  const generated = await tryGenerateWithCodexCli(prompt, {
    onStatus: reportStatus,
    onEvent: async (event) => {
      liveReasoningPayload.codexCliEvent = event;
      await updateReasoningFile(liveReasoningFile, liveReasoningPayload);
    }
  });

  if (!generated) {
    liveReasoningPayload.phase = "failed";
    liveReasoningPayload.status = "failed";
    await updateReasoningFile(liveReasoningFile, liveReasoningPayload);
    throw new Error(`The review could not be generated for '${workflow.title}'. No output files were saved.`);
  }

  pullRequestDraft = workflow.id === "create-pr" || workflow.type === "create-pr" ? parsePullRequestDraft(generated.content) : undefined;

  reportStatus(`Saving ${workflow.title} output`);
  const output = renderOutputWithExecutionInfo(
    workflow.id === "create-pr" || workflow.type === "create-pr"
      ? renderPullRequestDraftOutput(generated.content, pullRequestDraft)
      : generated.content,
    {
      agentName: generated.agentName,
      modelName: generated.modelName
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
    openCodexChatPrompt,
    pullRequestDraft,
    engine,
    agentName: generated.agentName,
    modelName: generated.modelName,
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
    openCodexChatPrompt,
    pullRequestDraft,
    engine,
    agentName: generated.agentName,
    modelName: generated.modelName,
    prompt,
    inputValues: resolved.values,
    generatedOutput: output,
    outputFile: outputFile.fsPath,
    reasoningFile: reasoningFile.fsPath,
    prContext: resolved.prContext,
    issueContext: resolved.issueContext,
    localChangesContext: resolved.localChangesContext
  };
  await writeOutputMetadata(outputFile, metadata);
  void vscode.commands.executeCommand("cmsisDev.refreshRuns");

  await vscode.env.clipboard.writeText(output);

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
  if (followUpState.canOpenCodexChat) {
    actions.push("Open in Codex Chat");
  }
  if (followUpState.canSubmitPr) {
    actions.push("Submit PR");
  }
  actions.push("Open Output");
  if (followUpState.canOpenReasoning) {
    actions.push("Open Reasoning");
  }

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

  if (action === "Open in Codex Chat") {
    await openCodexChatFromMetadata(metadata);
  }

  if (action === "Submit PR") {
    await submitPullRequestFromMetadata(metadata);
  }

  if (action === "Open Reasoning") {
    await openReasoningFile(reasoningFile.fsPath);
  }

  return {
    engine,
    generated: true,
    handedOffToCodexChat: false
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

export async function openCodexChatForActiveOutput(): Promise<void> {
  const metadata = await getMetadataForActiveOutput();
  if (!metadata) {
    return;
  }

  if (!getActiveOutputFollowUpStateFromMetadata(metadata).canOpenCodexChat) {
    vscode.window.showWarningMessage("Open in Codex Chat is not available for the active output file.");
    return;
  }

  await openCodexChatFromMetadata(metadata);
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

async function openCodexChatFromMetadata(metadata: ActionOutputMetadata): Promise<void> {
  const starterPrompt = buildCodexChatStarterPrompt(metadata);
  if (!starterPrompt) {
    vscode.window.showWarningMessage("No Codex starter prompt is available for this output file.");
    return;
  }

  const launchResult = await openNewCodexChatBestEffort();
  const codexContextFile = metadata.reasoningFile || metadata.outputFile;
  const attachedFiles = await attachFilesToCodexThreadBestEffort(codexContextFile ? [codexContextFile] : []);
  await vscode.env.clipboard.writeText(starterPrompt);

  const statusParts: string[] = [];
  if (launchResult.createdThread) {
    statusParts.push("Opened a fresh Codex chat thread.");
  } else if (launchResult.focused) {
    statusParts.push("Focused Codex Chat, but could not create a fresh thread automatically.");
  } else {
    statusParts.push("Could not open Codex Chat automatically.");
  }
  statusParts.push(
    attachedFiles.length > 0
      ? `Attached ${attachedFiles.join(" and ")} to the thread.`
      : "Could not attach files to the thread automatically."
  );
  statusParts.push("Starter prompt copied to clipboard. Paste and send it in Codex Chat.");
  await vscode.window.showInformationMessage(statusParts.join(" "));
}

async function postCommentFromMetadata(metadata: ActionOutputMetadata): Promise<void> {
  const token = await getGitHubToken();
  if (!token) {
    vscode.window.showWarningMessage("Cannot post comment without a GitHub token. Run 'CMSIS-Dev: Set GitHub Token'.");
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
    vscode.window.showWarningMessage("Cannot submit a PR without a GitHub token. Run 'CMSIS-Dev: Set GitHub Token'.");
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

async function openReasoningFile(reasoningFilePath: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(reasoningFilePath));
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function collectInputValues(workflow: WorkflowDefinition, token?: string): Promise<ResolvedInputs | undefined> {
  const values: Record<string, string> = {};
  let prContext: SelectedPrContext | undefined;
  let issueContext: SelectedIssueContext | undefined;
  let localChangesContext: SelectedLocalChangesContext | undefined;

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

  return { values, prContext, issueContext, localChangesContext };
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
  const untrackedFiles = await getUntrackedFiles(selected.rootPath);

  if (changedEntries.length === 0 && untrackedFiles.length === 0) {
    return undefined;
  }

  const fileSections = await formatLocalChangeSections(selected.rootPath, defaultRef.ref, changedEntries, untrackedFiles);
  const latestLocalReview = await findLatestLocalReviewSummary(selected.rootPath);
  const pullRequestTemplates = await readPullRequestTemplates(selected.rootPath);
  const changedFilesList = [
    ...changedEntries.map((entry) => entry.displayPath),
    ...untrackedFiles
  ];
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

async function getUntrackedFiles(repoRoot: string): Promise<string[]> {
  const raw = await runGitCommand(repoRoot, ["ls-files", "--others", "--exclude-standard"]);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function formatLocalChangeSections(
  repoRoot: string,
  defaultRef: string,
  changedEntries: Array<{ status: string; displayPath: string; pathSpec: string }>,
  untrackedFiles: string[]
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

  const untrackedSections = await Promise.all(
    untrackedFiles.map(async (filePath) => {
      const absolutePath = path.join(repoRoot, filePath);
      let content = "(Binary or unreadable untracked file)";
      try {
        const buffer = await fs.readFile(absolutePath);
        content = buffer.includes(0) ? "(Binary untracked file)" : buffer.toString("utf8").slice(0, 4000);
      } catch {
        // Keep fallback text.
      }

      return `File: ${filePath}\nStatus: ??\nPatch:\n${content}`;
    })
  );

  return [...trackedSections, ...untrackedSections].join("\n\n---\n\n");
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

async function tryGenerateWithCodexCli(prompt: string, options: CodexCliOptions = {}): Promise<GeneratedReview | undefined> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const cwd = workspaceFolder?.uri.fsPath ?? process.cwd();
  const cliExecutable =
    vscode.workspace.getConfiguration("chatgpt").get<string>("cliExecutable")?.trim() || "codex";
  const configuredModel = await resolveEffectiveCodexModel();
  const configuredReasoningEffort = await resolveEffectiveCodexReasoningEffort();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cmsis-dev-codex-cli-"));
  const outputPath = path.join(tempDir, "last-message.md");

  return new Promise<GeneratedReview | undefined>((resolve) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;

    const finish = async (value: GeneratedReview | undefined): Promise<void> => {
      if (settled) {
        return;
      }

      settled = true;
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      resolve(value);
    };

    const child = cp.spawn(
      cliExecutable,
      [
        "exec",
        ...(configuredModel !== "default" ? ["--model", configuredModel] : []),
        "--config",
        `model_reasoning_effort="${configuredReasoningEffort}"`,
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--output-last-message",
        outputPath,
        "-"
      ],
      {
        cwd,
        env: process.env,
        windowsHide: true
      }
    );

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const handleStdoutChunk = (chunk: string): void => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("{")) {
          continue;
        }

        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          void Promise.resolve(options.onEvent?.(event));

          const eventType = typeof event.type === "string" ? event.type : "";
          if (eventType === "thread.started") {
            options.onStatus?.("Codex CLI thread started");
          } else if (eventType === "turn.started") {
            options.onStatus?.("Codex CLI is reviewing");
          } else if (eventType === "turn.completed") {
            options.onStatus?.("Codex CLI completed review");
          }
        } catch {
          // Ignore malformed output lines.
        }
      }
    };

    child.stdout.on("data", handleStdoutChunk);
    child.stderr.on("data", (chunk: string) => {
      stderrBuffer += chunk;
    });

    child.on("error", async () => {
      await finish(undefined);
    });

    child.on("close", async (code) => {
      if (stdoutBuffer.trim().startsWith("{")) {
        handleStdoutChunk("\n");
      }

      if (code !== 0) {
        console.warn(`[CMSIS-Dev] Codex CLI exited with code ${code ?? "unknown"}${stderrBuffer ? `: ${stderrBuffer}` : ""}`);
        await finish(undefined);
        return;
      }

      try {
        const output = (await fs.readFile(outputPath, "utf8")).trim();
        await finish(
          output
            ? {
                agentName: "Codex CLI",
                modelName: configuredModel,
                content: output
              }
            : undefined
        );
      } catch {
        await finish(undefined);
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
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
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
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

  if (workflow.id === "review-pr" || workflow.type === "review-pr") {
    return [...LEGACY_PR_OUTPUT_FOLLOW_UPS];
  }

  if (workflow.id === "review-changes" || workflow.type === "review-changes") {
    return [...LEGACY_REVIEW_LOCAL_OUTPUT_FOLLOW_UPS];
  }

  if (workflow.id === "create-pr" || workflow.type === "create-pr") {
    return [...LEGACY_CREATE_PR_OUTPUT_FOLLOW_UPS];
  }

  if (workflow.id === "explain-issue" || workflow.type === "explain-issue") {
    return [...LEGACY_ISSUE_OUTPUT_FOLLOW_UPS];
  }

  return [...DEFAULT_OUTPUT_FOLLOW_UPS];
}

function normalizeFollowUps(followUps: readonly WorkflowFollowUp[] | undefined): WorkflowFollowUp[] {
  const allowed = new Set<WorkflowFollowUp>(["openReasoning", "openPr", "openIssue", "postComment", "submitPr", "openCodexChat"]);
  return Array.from(new Set((followUps ?? []).filter((followUp) => allowed.has(followUp))));
}

function resolveMetadataFollowUps(
  metadata: Pick<ActionOutputMetadata, "workflowId" | "followUps" | "prContext" | "issueContext" | "pullRequestDraft">
): WorkflowFollowUp[] {
  const configured = normalizeFollowUps(metadata.followUps);
  if (configured.length > 0) {
    return configured;
  }

  if (metadata.prContext) {
    return [...LEGACY_PR_OUTPUT_FOLLOW_UPS];
  }

  if (metadata.workflowId === "review-changes") {
    return [...LEGACY_REVIEW_LOCAL_OUTPUT_FOLLOW_UPS];
  }

  if (metadata.pullRequestDraft) {
    return [...LEGACY_CREATE_PR_OUTPUT_FOLLOW_UPS];
  }

  if (metadata.issueContext) {
    return [...LEGACY_ISSUE_OUTPUT_FOLLOW_UPS];
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
      Boolean(metadata.localChangesContext?.repo),
    canOpenCodexChat:
      followUps.includes("openCodexChat") &&
      Boolean(metadata.reasoningFile || metadata.outputFile) &&
      Boolean(buildCodexChatStarterPrompt(metadata))
  };
}

function buildCodexChatStarterPrompt(metadata: ActionOutputMetadata): string | undefined {
  const configuredPrompt = metadata.openCodexChatPrompt?.trim();
  if (configuredPrompt) {
    return appendWorkspaceRepoContext(configuredPrompt, metadata);
  }

  if (
    metadata.workflowId === "review-pr" ||
    metadata.workflowId === "review-changes" ||
    metadata.prContext ||
    (metadata.localChangesContext && !metadata.pullRequestDraft)
  ) {
    return appendWorkspaceRepoContext(
      [
      "Use the attached CMSIS-Dev reasoning file as the source of truth.",
      "It contains the generated review plus the workflow context that produced it.",
      "Identify the concrete review suggestions worth implementing in this workspace.",
      "Start with a short plan, then implement the accepted changes.",
      "If any finding is unclear, unsupported, or too risky, explain that before editing."
      ].join("\n"),
      metadata
    );
  }

  if (metadata.workflowId === "explain-issue" || metadata.issueContext) {
    return appendWorkspaceRepoContext(
      [
      "Use the attached CMSIS-Dev reasoning file as context.",
      "It contains the generated issue explanation plus the workflow context that produced it.",
      "Ask the smallest set of concrete follow-up questions needed to resolve the open questions or missing information.",
      "Group related questions together and avoid repeating facts already established in the attached explanation.",
      "If some missing information can be inferred from the local repo, investigate that first before asking."
      ].join("\n"),
      metadata
    );
  }

  return undefined;
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

function appendWorkspaceRepoContext(prompt: string, metadata: ActionOutputMetadata): string {
  const repoRoot =
    metadata.localChangesContext?.rootPath ?? metadata.prContext?.rootPath ?? metadata.issueContext?.rootPath;
  const workspaceFolderName =
    metadata.localChangesContext?.workspaceFolderName ??
    metadata.prContext?.workspaceFolderName ??
    metadata.issueContext?.workspaceFolderName;

  if (!repoRoot) {
    return prompt;
  }

  const lines = [prompt.trimEnd(), "", "Local workspace repo for this workflow:"];
  if (workspaceFolderName) {
    lines.push(`- Workspace folder: ${workspaceFolderName}`);
  }
  lines.push(`- Repo root: ${repoRoot}`);
  lines.push("- Paths mentioned in the attached reasoning are relative to this repo root.");
  return lines.join("\n");
}
async function openNewCodexChatBestEffort(): Promise<CodexChatLaunchResult> {
  const availableCommands = new Set(await vscode.commands.getCommands(true));
  const result: CodexChatLaunchResult = {
    focused: false,
    createdThread: false,
    commands: []
  };

  const createdImmediately = await tryExecuteFirstAvailableCommand(CODEX_NEW_THREAD_COMMANDS, availableCommands, result, 250);
  if (!createdImmediately) {
    await tryExecuteFirstAvailableCommand(CODEX_FOCUS_COMMANDS, availableCommands, result, 150);
    await tryExecuteFirstAvailableCommand(CODEX_NEW_THREAD_COMMANDS, availableCommands, result, 250);
  }

  if (result.createdThread && !result.focused) {
    await tryExecuteFirstAvailableCommand(CODEX_FOCUS_COMMANDS, availableCommands, result, 150);
  }

  return result;
}

async function tryExecuteFirstAvailableCommand(
  commands: readonly string[],
  availableCommands: ReadonlySet<string>,
  result: CodexChatLaunchResult,
  waitMs: number
): Promise<boolean> {
  for (const command of commands) {
    if (!availableCommands.has(command)) {
      continue;
    }

    try {
      await vscode.commands.executeCommand(command);
      result.commands.push(command);
      if (CODEX_FOCUS_COMMANDS.includes(command)) {
        result.focused = true;
      }
      if (CODEX_NEW_THREAD_COMMANDS.includes(command)) {
        result.createdThread = true;
      }
      await delay(waitMs);
      return true;
    } catch {
      // Try the next available command.
    }
  }

  return false;
}

async function attachFilesToCodexThreadBestEffort(filePaths: string[]): Promise<string[]> {
  const availableCommands = new Set(await vscode.commands.getCommands(true));
  if (!availableCommands.has(CODEX_ADD_FILE_COMMAND)) {
    return [];
  }

  const originalEditor = vscode.window.activeTextEditor;
  const attached: string[] = [];

  try {
    for (const filePath of Array.from(new Set(filePaths)).filter(Boolean)) {
      const attachedLabel = await attachSingleFileToCodexThread(filePath);
      if (attachedLabel) {
        attached.push(attachedLabel);
      }
    }
  } finally {
    if (originalEditor) {
      await vscode.window.showTextDocument(originalEditor.document, {
        preview: false,
        preserveFocus: true,
        viewColumn: originalEditor.viewColumn
      });
    }
  }

  return attached;
}

async function attachSingleFileToCodexThread(filePath: string): Promise<string | undefined> {
  try {
    await vscode.commands.executeCommand(CODEX_ADD_FILE_COMMAND, vscode.Uri.file(filePath));
    await delay(100);
    return path.basename(filePath);
  } catch {
    return undefined;
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
  appendField("Output File", payload.outputFile);
  appendField("Reasoning File", payload.reasoningFile);

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

  const codexCliEvent = payload.codexCliEvent;
  if (codexCliEvent !== undefined) {
    lines.push("");
    lines.push("## Latest Codex CLI Event");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(codexCliEvent, null, 2));
    lines.push("```");
  }

  return `${lines.join("\n")}\n`;
}

function renderOutputWithExecutionInfo(
  content: string,
  details: { agentName: string; modelName: string }
): string {
  return [
    `> AI agent: **${details.agentName}**`,
    `> Model: **${details.modelName}**`,
    "",
    content.trim()
  ].join("\n");
}
