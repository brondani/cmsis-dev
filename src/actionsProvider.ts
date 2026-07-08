import * as vscode from "vscode";
import { WorkflowDefinition } from "./types";
import { loadWorkflowDefinitions } from "./workflowConfig";

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

export class ActionsProvider implements vscode.TreeDataProvider<ActionItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ActionItem | undefined | null | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private workflows: WorkflowDefinition[] = [];

  async refresh(): Promise<void> {
    this.workflows = await loadWorkflowDefinitions();
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: ActionItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<ActionItem[]> {
    if (this.workflows.length === 0) {
      this.workflows = await loadWorkflowDefinitions();
    }
    return this.workflows.map((workflow) => new ActionItem(workflow));
  }

  getWorkflows(): WorkflowDefinition[] {
    return this.workflows;
  }
}
