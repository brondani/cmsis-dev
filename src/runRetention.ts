import * as vscode from "vscode";
import { pruneRunFiles } from "./runRetentionCore";
import { resolveWorkflowRunsDirUri } from "./workflowConfig";

const pendingOutputs = new Set<string>();

export function beginRunWrite(outputPath: string): void {
  pendingOutputs.add(outputPath);
}

export function finishRunWrite(outputPath: string): void {
  pendingOutputs.delete(outputPath);
}

export async function pruneSavedRuns(): Promise<void> {
  const runsDirUri = await resolveWorkflowRunsDirUri();
  if (!runsDirUri || runsDirUri.scheme !== "file") {
    return;
  }

  const value = vscode.workspace.getConfiguration("cmsisDev").get<number>("maxRetainedRuns", 10);
  const limit = typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 10;
  try {
    await pruneRunFiles(runsDirUri.fsPath, limit, pendingOutputs);
  } catch (error) {
    console.error("CMSIS-Dev could not prune saved runs:", error);
  }
}