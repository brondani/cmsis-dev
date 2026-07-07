import * as vscode from "vscode";

export type CmsisDevReasoningEffort = "low" | "medium" | "high" | "xhigh";

export const CMSIS_DEV_REASONING_EFFORTS: readonly CmsisDevReasoningEffort[] = ["low", "medium", "high", "xhigh"];

type ModelOptionsRecord = { readonly [name: string]: any } | { [name: string]: any } | undefined;

export function getConfiguredReasoningEffort(): CmsisDevReasoningEffort | undefined {
  return normalizeReasoningEffort(vscode.workspace.getConfiguration("cmsisDev").get<string>("reasoningEffort", ""));
}

export async function updateConfiguredReasoningEffort(
  effort: CmsisDevReasoningEffort | undefined
): Promise<void> {
  await vscode.workspace
    .getConfiguration("cmsisDev")
    .update("reasoningEffort", effort ?? "", getPreferredSettingsTarget());
}

export function formatReasoningEffortLabel(effort: CmsisDevReasoningEffort | undefined): string {
  return effort ? `reasoning: ${effort}` : "reasoning: default";
}

export function buildReasoningModelOptions(
  effort: CmsisDevReasoningEffort | undefined
): { reasoning: { effort: CmsisDevReasoningEffort } } | undefined {
  return effort ? { reasoning: { effort } } : undefined;
}

export function readReasoningEffortFromModelOptions(modelOptions: ModelOptionsRecord): CmsisDevReasoningEffort | undefined {
  return normalizeReasoningEffort(modelOptions?.reasoning?.effort);
}

function normalizeReasoningEffort(value: unknown): CmsisDevReasoningEffort | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return CMSIS_DEV_REASONING_EFFORTS.find((candidate) => candidate === normalized);
}

function getPreferredSettingsTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFile || (vscode.workspace.workspaceFolders?.length ?? 0) > 0
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}
