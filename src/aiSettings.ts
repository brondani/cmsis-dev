import * as vscode from "vscode";
import { CMSIS_DEV_LANGUAGE_MODEL_VENDOR } from "./languageModelProvider";

const DEFAULT_LANGUAGE_MODEL_IDS = ["gpt-5.5", "gpt-5.4"] as const;

export async function resolveConfiguredLanguageModel(): Promise<vscode.LanguageModelChat | undefined> {
  const providerModels = await vscode.lm.selectChatModels({ vendor: CMSIS_DEV_LANGUAGE_MODEL_VENDOR });
  if (providerModels.length > 0) {
    const sortedProviderModels = [...providerModels].sort(compareLanguageModels);
    return sortedProviderModels[0];
  }

  return undefined;
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
