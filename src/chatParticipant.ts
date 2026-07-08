import * as path from "node:path";
import * as vscode from "vscode";
import { loadWorkflowDefinitions } from "./workflowConfig";
import { WorkflowDefinition } from "./types";
import { populateGitScmInput, runPromptWorkflowInChat } from "./workflows/promptWorkflow";

const CHAT_PARTICIPANT_ID = "cmsis-dev.chat";
const CHAT_PARTICIPANT_NAME = "cmsisdev";
const STATIC_CHAT_COMMANDS = new Set([
  "review-pr",
  "review-changes",
  "create-pr",
  "commit-message",
  "explain-issue",
  "explain-ci-failure",
  "plan-next-steps"
]);

type PendingChatRun = {
  workflow: WorkflowDefinition;
  presetRunOutputUri?: vscode.Uri;
  populateScmCommitInput?: boolean;
};

let pendingChatRun: PendingChatRun | undefined;

export function registerCmsisDevChatParticipant(context: vscode.ExtensionContext): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant(CHAT_PARTICIPANT_ID, async (request, _chatContext, response, token) => {
    const workflow = await resolveWorkflowForChatRequest(request);
    if (!workflow) {
      const prompt = request.prompt.trim();
      if (prompt) {
        await runFreeformChatPrompt(prompt, request.model, response, token);
        return;
      }

      response.markdown(buildHelpMarkdown());
      response.button({
        command: "cmsisDev.runActionInChat",
        title: "Run AI Action in Chat"
      });
      return;
    }

    const pendingOptions = consumePendingChatRun(workflow.id);
    const additionalInstructions = request.prompt.trim();
    response.progress(`Running ${workflow.title}`);
    const execution = await runPromptWorkflowInChat(workflow, {
      additionalInstructions: additionalInstructions.length > 0 ? additionalInstructions : undefined,
      model: request.model,
      onStatus: (status) => response.progress(status),
      presetRunOutputUri: pendingOptions?.presetRunOutputUri
    });

    if (!execution) {
      response.markdown(`Cancelled **${workflow.title}**.`);
      return;
    }

    if (pendingOptions?.populateScmCommitInput) {
      const commitMessage = formatCommitMessageForScmInput(execution.metadata.commitDraft);
      if (commitMessage) {
        const populated = await populateGitScmInput(commitMessage, execution.metadata.localChangesContext?.rootPath);
        if (populated) {
          response.markdown("Generated commit message inserted into the Source Control input box.");
        } else {
          response.markdown("Generated commit message, but could not find a matching Git Source Control input box.");
        }
      }
    }

    response.markdown(execution.output);
    response.reference(execution.outputFile);
    response.button({
      command: "cmsisDev.openRunOutputPreview",
      title: `Open ${path.basename(execution.outputFile.fsPath)}`,
      arguments: [execution.outputFile.fsPath]
    });
  });

  participant.iconPath = new vscode.ThemeIcon("hubot");
  return participant;
}

async function runFreeformChatPrompt(
  prompt: string,
  model: vscode.LanguageModelChat,
  response: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<void> {
  response.progress("Sending prompt to the selected chat model");
  const modelResponse = await model.sendRequest(
    [vscode.LanguageModelChatMessage.User(prompt)],
    {
      justification: "CMSIS-Dev forwards freeform participant prompts to the selected chat model."
    },
    token
  );

  let hasContent = false;
  for await (const part of modelResponse.stream) {
    if (part instanceof vscode.LanguageModelTextPart) {
      hasContent = true;
      response.markdown(part.value);
    }
  }

  if (!hasContent) {
    response.markdown("No response was generated.");
  }
}

async function resolveWorkflowForChatRequest(request: vscode.ChatRequest): Promise<WorkflowDefinition | undefined> {
  const workflows = await loadWorkflowDefinitions();
  if (request.command === "run") {
    const pending = pendingChatRun?.workflow;
    if (pending) {
      return workflows.find((workflow) => workflow.id === pending.id) ?? pending;
    }

    return chooseWorkflow(workflows);
  }

  if (request.command) {
    return workflows.find((workflow) => workflow.id === request.command);
  }

  return undefined;
}

export async function openWorkflowInChat(
  workflow: WorkflowDefinition,
  options: { presetRunOutputUri?: vscode.Uri; populateScmCommitInput?: boolean } = {}
): Promise<void> {
  const command = STATIC_CHAT_COMMANDS.has(workflow.id) ? workflow.id : "run";
  pendingChatRun = {
    workflow,
    presetRunOutputUri: options.presetRunOutputUri,
    populateScmCommitInput: options.populateScmCommitInput
  };
  await vscode.commands.executeCommand("workbench.action.chat.open", {
    query: `@${CHAT_PARTICIPANT_NAME} /${command}`,
    isPartialQuery: false
  });
}

function consumePendingChatRun(workflowId: string): Omit<PendingChatRun, "workflow"> | undefined {
  if (pendingChatRun?.workflow.id !== workflowId) {
    return undefined;
  }

  const pendingOptions = {
    presetRunOutputUri: pendingChatRun.presetRunOutputUri,
    populateScmCommitInput: pendingChatRun.populateScmCommitInput
  };
  pendingChatRun = undefined;
  return pendingOptions;
}

function formatCommitMessageForScmInput(draft: { subject: string; body?: string } | undefined): string | undefined {
  const subject = draft?.subject.trim();
  if (!subject) {
    return undefined;
  }

  const body = draft?.body?.trim();
  return body ? `${subject}\n\n${body}` : subject;
}

async function chooseWorkflow(workflows: WorkflowDefinition[]): Promise<WorkflowDefinition | undefined> {
  const selected = await vscode.window.showQuickPick(
    workflows.map((workflow) => ({
      label: workflow.title,
      description: workflow.id,
      detail: workflow.description,
      workflow
    })),
    {
      placeHolder: "Choose a CMSIS-Dev workflow to run in chat"
    }
  );
  return selected?.workflow;
}

function buildHelpMarkdown(): string {
  return [
    "Use `@cmsisdev` with one of these commands:",
    "",
    "- `/run` to pick any workflow interactively.",
    "- `/review-pr` to review a pull request.",
    "- `/review-changes` to review local changes.",
    "- `/create-pr` to draft a pull request from committed branch changes.",
    "- `/explain-issue` to summarize a GitHub issue.",
    "- `/explain-ci-failure` to explain why a GitHub workflow run is failing.",
    "- `/plan-next-steps` to continue from a previous CMSIS-Dev result in chat.",
    "",
    "Anything after the slash command is appended as extra instructions for that workflow."
  ].join("\n");
}
