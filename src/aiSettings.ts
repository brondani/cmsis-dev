import * as vscode from "vscode";
import { CMSIS_DEV_LANGUAGE_MODEL_VENDOR } from "./languageModelProvider";
import { formatReasoningEffortLabel, getConfiguredReasoningEffort } from "./reasoningEffort";

const DEFAULT_LANGUAGE_MODEL_IDS = ["gpt-5.5", "gpt-5.4"] as const;

export interface LanguageModelSelectorState {
  vendor?: string;
  family?: string;
  version?: string;
  id?: string;
}

export function getConfiguredLanguageModelSelector(): LanguageModelSelectorState | undefined {
  const raw = vscode.workspace.getConfiguration("cmsisDev").get<unknown>("languageModelSelector");
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const record = raw as Record<string, unknown>;
  const selector: LanguageModelSelectorState = {
    vendor: normalizeString(record.vendor),
    family: normalizeString(record.family),
    version: normalizeString(record.version),
    id: normalizeString(record.id)
  };

  return hasSelectorValues(selector) ? selector : undefined;
}

export async function updateConfiguredLanguageModelSelector(
  selector: LanguageModelSelectorState | undefined
): Promise<void> {
  await vscode.workspace
    .getConfiguration("cmsisDev")
    .update("languageModelSelector", selector && hasSelectorValues(selector) ? selector : undefined, getPreferredSettingsTarget());
}

export async function listAvailableLanguageModels(): Promise<vscode.LanguageModelChat[]> {
  const models = await vscode.lm.selectChatModels({ vendor: CMSIS_DEV_LANGUAGE_MODEL_VENDOR });
  return [...models].sort(compareLanguageModels);
}

export async function resolveConfiguredLanguageModel(): Promise<vscode.LanguageModelChat | undefined> {
  const selector = getConfiguredLanguageModelSelector();
  if (selector) {
    const matches = await vscode.lm.selectChatModels(selector);
    return matches[0];
  }

  const providerModels = await vscode.lm.selectChatModels({ vendor: CMSIS_DEV_LANGUAGE_MODEL_VENDOR });
  if (providerModels.length > 0) {
    const sortedProviderModels = [...providerModels].sort(compareLanguageModels);
    return sortedProviderModels[0];
  }

  return undefined;
}

export async function describeAiSettings(): Promise<string> {
  const reasoningEffort = getConfiguredReasoningEffort();
  const selector = getConfiguredLanguageModelSelector();
  const model = await resolveConfiguredLanguageModel();
  if (model) {
    return `${formatLanguageModelLabel(model)} | ${formatReasoningEffortLabel(reasoningEffort)}`;
  }

  if (selector) {
    return `${formatLanguageModelSelector(selector)} (unavailable) | ${formatReasoningEffortLabel(reasoningEffort)}`;
  }

  return `automatic | ${formatReasoningEffortLabel(reasoningEffort)}`;
}

export function getPreferredSettingsTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFile || (vscode.workspace.workspaceFolders?.length ?? 0) > 0
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

export function formatLanguageModelLabel(model: Pick<vscode.LanguageModelChat, "vendor" | "name" | "family" | "version" | "id">): string {
  const identity = `${model.vendor}/${model.name}`;
  return identity;
}

export function formatLanguageModelSelector(selector: LanguageModelSelectorState): string {
  const parts = [selector.vendor, selector.family, selector.version, selector.id].filter(Boolean);
  return parts.length > 0 ? parts.join(" | ") : "automatic";
}

function compareLanguageModels(left: vscode.LanguageModelChat, right: vscode.LanguageModelChat): number {
  const defaultModelDelta = compareDefaultModelPriority(left.id, right.id);
  if (defaultModelDelta !== 0) {
    return defaultModelDelta;
  }

  if (left.vendor === CMSIS_DEV_LANGUAGE_MODEL_VENDOR && right.vendor !== CMSIS_DEV_LANGUAGE_MODEL_VENDOR) {
    return -1;
  }

  if (left.vendor !== CMSIS_DEV_LANGUAGE_MODEL_VENDOR && right.vendor === CMSIS_DEV_LANGUAGE_MODEL_VENDOR) {
    return 1;
  }

  return formatLanguageModelLabel(left).localeCompare(formatLanguageModelLabel(right));
}

function hasSelectorValues(selector: LanguageModelSelectorState): boolean {
  return Boolean(selector.vendor || selector.family || selector.version || selector.id);
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function compareDefaultModelPriority(leftId: string, rightId: string): number {
  const leftIndex = DEFAULT_LANGUAGE_MODEL_IDS.indexOf(leftId as (typeof DEFAULT_LANGUAGE_MODEL_IDS)[number]);
  const rightIndex = DEFAULT_LANGUAGE_MODEL_IDS.indexOf(rightId as (typeof DEFAULT_LANGUAGE_MODEL_IDS)[number]);

  if (leftIndex === -1 && rightIndex === -1) {
    return 0;
  }
  if (leftIndex === -1) {
    return 1;
  }
  if (rightIndex === -1) {
    return -1;
  }

  return leftIndex - rightIndex;
}
