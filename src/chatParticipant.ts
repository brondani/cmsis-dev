import * as path from "node:path";
import * as vscode from "vscode";
import { loadWorkflowDefinitions } from "./workflowConfig";
import { WorkflowDefinition } from "./types";
import { runPromptWorkflowInChat } from "./workflows/promptWorkflow";

const CHAT_PARTICIPANT_ID = "cmsis-dev.chat";

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
    return chooseWorkflow(workflows);
  }

  if (request.command) {
    return workflows.find((workflow) => workflow.id === request.command);
  }

  return undefined;
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
    "- `/plan-next-steps` to continue from a previous CMSIS-Dev result in chat.",
    "",
    "Anything after the slash command is appended as extra instructions for that workflow."
  ].join("\n");
}
