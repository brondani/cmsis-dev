import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { resolveWorkflowRunsDirUri } from "./workflowConfig";

export class RunOutputItem extends vscode.TreeItem {
  readonly modifiedAt: number;

  constructor(
    public readonly uri: vscode.Uri,
    modifiedAt: number
  ) {
    super(path.basename(uri.fsPath), vscode.TreeItemCollapsibleState.None);
    this.modifiedAt = modifiedAt;
    this.resourceUri = uri;
    this.description = new Date(modifiedAt).toLocaleString();
    this.tooltip = uri.fsPath;
    this.contextValue = "cmsisDev.runOutput";
    this.command = {
      command: "vscode.open",
      title: "Open Run Output",
      arguments: [uri, { preview: true }]
    };
  }
}

class RunsPlaceholderItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
  }
}

type RunsTreeItem = RunOutputItem | RunsPlaceholderItem;

export function getRelatedRunFilePaths(outputPath: string): string[] {
  return [outputPath, `${outputPath}.reasoning.md`, `${outputPath}.meta.json`];
}

export class RunsProvider implements vscode.TreeDataProvider<RunsTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<RunsTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private outputs: RunOutputItem[] = [];

  async refresh(): Promise<void> {
    this.outputs = await this.loadOutputs();
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: RunsTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<RunsTreeItem[]> {
    if (this.outputs.length === 0) {
      this.outputs = await this.loadOutputs();
    }

    return this.outputs.length > 0 ? this.outputs : [new RunsPlaceholderItem("No generated outputs yet")];
  }

  private async loadOutputs(): Promise<RunOutputItem[]> {
    const runsDirUri = await resolveWorkflowRunsDirUri();
    if (!runsDirUri || runsDirUri.scheme !== "file") {
      return [];
    }

    try {
      const entries = await fs.readdir(runsDirUri.fsPath, { withFileTypes: true });
      const outputs = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.endsWith(".reasoning.md"))
          .map(async (entry) => {
            const outputUri = vscode.Uri.file(path.join(runsDirUri.fsPath, entry.name));
            const stat = await fs.stat(outputUri.fsPath);
            return new RunOutputItem(outputUri, stat.mtimeMs);
          })
      );

      return outputs.sort((left, right) => {
        const modifiedDelta = right.modifiedAt - left.modifiedAt;
        return modifiedDelta !== 0
          ? modifiedDelta
          : path.basename(left.uri.fsPath).localeCompare(path.basename(right.uri.fsPath));
      });
    } catch {
      return [];
    }
  }
}
