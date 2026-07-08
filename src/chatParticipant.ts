import * as path from "node:path";
import * as vscode from "vscode";
import { loadWorkflowDefinitions } from "./workflowConfig";
import { WorkflowDefinition } from "./types";
import { runPromptWorkflowInChat } from "./workflows/promptWorkflow";

const CHAT_PARTICIPANT_ID = "cmsis-dev.chat";
const CHAT_PARTICIPANT_NAME = "cmsisdev";
const STATIC_CHAT_COMMANDS = new Set(["review-pr", "review-changes", "create-pr", "explain-issue", "explain-ci-failure", "plan-next-steps"]);

let pendingWorkflowForChat: WorkflowDefinition | undefined;

export function registerCmsisDevChatParticipant(context: vscode.ExtensionContext): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant(CHAT_PARTICIPANT_ID, async (request, _chatContext, response, token) => {
    const workflow = await resolveWorkflowForChatRequest(request);
    if (!workflow) {
      response.markdown(buildHelpMarkdown());
      response.button({
        command: "cmsisDev.runAction",
        title: "Run from Actions"
      });
      return;
    }

    const additionalInstructions = request.prompt.trim();
    response.progress(`Running ${workflow.title}`);
    const execution = await runPromptWorkflowInChat(workflow, {
      additionalInstructions: additionalInstructions.length > 0 ? additionalInstructions : undefined,
      model: request.model,
      onStatus: (status) => response.progress(status)
    });

    if (!execution) {
      response.markdown(`Cancelled **${workflow.title}**.`);
      return;
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
  context.subscriptions.push(participant);
  return participant;
}

async function resolveWorkflowForChatRequest(request: vscode.ChatRequest): Promise<WorkflowDefinition | undefined> {
  const workflows = await loadWorkflowDefinitions();
  if (request.command === "run") {
    const pending = pendingWorkflowForChat;
    pendingWorkflowForChat = undefined;
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

export async function openWorkflowInChat(workflow: WorkflowDefinition): Promise<void> {
  const command = STATIC_CHAT_COMMANDS.has(workflow.id) ? workflow.id : "run";
  pendingWorkflowForChat = command === "run" ? workflow : undefined;
  await vscode.commands.executeCommand("workbench.action.chat.open", {
    query: `@${CHAT_PARTICIPANT_NAME} /${command}`,
    isPartialQuery: false
  });
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
    "- `/create-pr` to draft a pull request from local changes.",
    "- `/explain-issue` to summarize a GitHub issue.",
    "- `/explain-ci-failure` to explain why a GitHub workflow run is failing.",
    "- `/plan-next-steps` to continue from a previous CMSIS-Dev result in chat.",
    "",
    "Anything after the slash command is appended as extra instructions for that workflow."
  ].join("\n");
}
