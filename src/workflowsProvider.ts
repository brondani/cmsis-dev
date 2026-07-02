import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { listEffectiveWorkflowConfigFiles, WorkflowConfigSource } from "./workflowConfig";

class WorkflowFileItem extends vscode.TreeItem {
  readonly modifiedAt: number;

  constructor(
    public readonly uri: vscode.Uri,
    public readonly source: WorkflowConfigSource,
    modifiedAt: number
  ) {
    super(path.basename(uri.fsPath), vscode.TreeItemCollapsibleState.None);
    this.modifiedAt = modifiedAt;
    this.resourceUri = uri;
    this.description = `${source === "workspace" ? "workspace" : "installed"} | ${new Date(modifiedAt).toLocaleString()}`;
    this.tooltip = uri.fsPath;
    this.contextValue = "cmsisDev.workflowFile";
    this.command = {
      command: "vscode.open",
      title: "Open Workflow File",
      arguments: [uri, { preview: false }]
    };
  }
}

class WorkflowsPlaceholderItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
  }
}

type WorkflowsTreeItem = WorkflowFileItem | WorkflowsPlaceholderItem;

export class WorkflowsProvider implements vscode.TreeDataProvider<WorkflowsTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<WorkflowsTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private workflowFiles: WorkflowFileItem[] = [];

  async refresh(): Promise<void> {
    this.workflowFiles = await this.loadWorkflowFiles();
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: WorkflowsTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<WorkflowsTreeItem[]> {
    if (this.workflowFiles.length === 0) {
      this.workflowFiles = await this.loadWorkflowFiles();
    }

    return this.workflowFiles.length > 0 ? this.workflowFiles : [new WorkflowsPlaceholderItem("No workflow config files found")];
  }

  private async loadWorkflowFiles(): Promise<WorkflowFileItem[]> {
    const files = await listEffectiveWorkflowConfigFiles();
    const items = await Promise.all(
      files.map(async (file) => {
        const stat = await fs.stat(file.uri.fsPath);
        return new WorkflowFileItem(file.uri, file.source, stat.mtimeMs);
      })
    );

    return items;
  }
}
