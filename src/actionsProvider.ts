import * as vscode from "vscode";
import { WorkflowDefinition } from "./types";
import { loadWorkflowDefinitions } from "./workflowConfig";

class AudioTranscriptionActionItem extends vscode.TreeItem {
  constructor() {
    super("Transcribe Audio", vscode.TreeItemCollapsibleState.None);
    this.description = "Create a diarized transcript and executive summary";
    this.contextValue = "cmsisDev.audioTranscriptionAction";
    this.command = {
      command: "cmsisDev.transcribeAudio",
      title: "Transcribe Audio"
    };
  }
}

type ActionTreeItem = ActionItem | AudioTranscriptionActionItem;

export class ActionItem extends vscode.TreeItem {
  constructor(public readonly workflow: WorkflowDefinition) {
    super(workflow.title, vscode.TreeItemCollapsibleState.None);
    this.description = workflow.description;
    this.contextValue = "cmsisDev.action";
    this.command = {
      command: "cmsisDev.runActionInChat",
      title: "Run AI Action in Chat",
      arguments: [workflow]
    };
  }
}

export class ActionsProvider implements vscode.TreeDataProvider<ActionTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ActionTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private workflows: WorkflowDefinition[] = [];

  async refresh(): Promise<void> {
    this.workflows = await loadWorkflowDefinitions();
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: ActionTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<ActionTreeItem[]> {
    if (this.workflows.length === 0) {
      this.workflows = await loadWorkflowDefinitions();
    }
    return [new AudioTranscriptionActionItem(), ...this.workflows.map((workflow) => new ActionItem(workflow))];
  }

  getWorkflows(): WorkflowDefinition[] {
    return this.workflows;
  }
}
