import * as path from "node:path";
import * as vscode from "vscode";
import { loadWorkflowDefinitions } from "./workflowConfig";
import { WorkflowDefinition } from "./types";
import { runAudioTranscription } from "./workflows/audioTranscription";
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
    if (request.command === "transcribe-audio") {
      response.progress("Transcribing audio");
      const outputFile = await runAudioTranscription(context.globalStorageUri.fsPath);
      if (outputFile) {
        response.markdown(`Audio transcription saved to **${path.basename(outputFile.fsPath)}**.`);
        response.reference(outputFile);
        response.button({
          command: "cmsisDev.openRunOutputPreview",
          title: `Open ${path.basename(outputFile.fsPath)}`,
          arguments: [outputFile.fsPath]
        });
      } else {
        response.markdown("Audio transcription was not saved.");
      }
      return;
    }

    const workflow = await resolveWorkflowForChatRequest(request);
    if (!workflow) {
      const freeformPrompt = request.command ? "" : request.prompt.trim();
      if (freeformPrompt) {
        response.markdown("Opening a normal Chat request with your prompt.");
        await vscode.commands.executeCommand("workbench.action.chat.open", {
          query: freeformPrompt,
          isPartialQuery: false
        });
        return;
      }

      response.markdown(buildHelpMarkdown());
      response.button({
        command: "cmsisDev.runActionInChat",
        title: "Run AI Action in Chat"
      });
      response.button({
        command: "workbench.action.openChat",
        title: "New Chat"
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
    "- `/transcribe-audio` to transcribe a workspace audio or video recording.",
    "",
    "For prompt workflows, text after the slash command is appended as extra instructions."
  ].join("\n");
}
