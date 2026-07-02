import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

export type CodexReasoningEffort = string;

const DEFAULT_REASONING_EFFORT: CodexReasoningEffort = "high";
const DEFAULT_REASONING_CANDIDATES = ["low", "medium", "high", "xhigh"];
const CODEX_MODEL_CANDIDATES = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];
const MAX_RECENT_SESSION_FILES = 12;

type CodexCliDefaults = {
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
};

export function getConfiguredCodexModel(): string | undefined {
  const value = vscode.workspace.getConfiguration("cmsisDev").get<string>("codexModel", "").trim();
  return value.length > 0 ? value : undefined;
}

export function getConfiguredCodexReasoningEffort(): CodexReasoningEffort | undefined {
  const value = vscode.workspace.getConfiguration("cmsisDev").get<string>("codexReasoningEffort", "").trim();
  return value.length > 0 ? value : undefined;
}

export async function resolveEffectiveCodexModel(): Promise<string> {
  return getConfiguredCodexModel() ?? (await readCodexCliDefaults()).model ?? "default";
}

export async function resolveEffectiveCodexReasoningEffort(): Promise<CodexReasoningEffort> {
  return getConfiguredCodexReasoningEffort() ?? (await readCodexCliDefaults()).reasoningEffort ?? DEFAULT_REASONING_EFFORT;
}

export async function describeCodexSettings(): Promise<string> {
  const model = await resolveEffectiveCodexModel();
  const reasoningEffort = await resolveEffectiveCodexReasoningEffort();
  return `${model} | ${reasoningEffort}`;
}

export async function listCodexModelCandidates(): Promise<string[]> {
  return [...CODEX_MODEL_CANDIDATES];
}

export async function listCodexReasoningEffortCandidates(): Promise<string[]> {
  const configured = getConfiguredCodexReasoningEffort();
  const defaults = await readCodexCliDefaults();
  const sessionState = await readRecentCodexSessionState();
  const merged = new Map<string, string>();

  for (const candidate of [
    configured,
    defaults.reasoningEffort,
    ...sessionState.reasoningEfforts,
    ...DEFAULT_REASONING_CANDIDATES
  ]) {
    addUniqueCandidate(merged, candidate);
  }

  return Array.from(merged.values());
}

export function getPreferredSettingsTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFile || (vscode.workspace.workspaceFolders?.length ?? 0) > 0
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

async function readCodexCliDefaults(): Promise<CodexCliDefaults> {
  try {
    const configPath = path.join(getCodexHome(), "config.toml");
    const raw = await fs.readFile(configPath, "utf8");

    const model = raw.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1]?.trim();
    const reasoningEffort = raw.match(/^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m)?.[1]?.trim();

    return {
      model: model && model.length > 0 ? model : undefined,
      reasoningEffort: normalizeCandidate(reasoningEffort)
    };
  } catch {
    return {};
  }
}

async function readRecentCodexSessionState(): Promise<{ reasoningEfforts: string[] }> {
  try {
    const sessionFiles = await listRecentSessionFiles(path.join(getCodexHome(), "sessions"), MAX_RECENT_SESSION_FILES);
    const reasoningEfforts = new Map<string, string>();

    for (const sessionFile of sessionFiles) {
      const raw = await fs.readFile(sessionFile, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.includes(`"type":"turn_context"`)) {
          continue;
        }

        try {
          const parsed = JSON.parse(line) as unknown;
          const payload = asRecord(asRecord(parsed)?.payload);
          if (!payload) {
            continue;
          }

          addUniqueCandidate(reasoningEfforts, readStringField(payload, "effort"));

          const collaborationMode = asRecord(payload.collaboration_mode);
          const settings = asRecord(collaborationMode?.settings);
          addUniqueCandidate(reasoningEfforts, readStringField(settings, "reasoning_effort"));
        } catch {
          // Ignore malformed or partial session log lines.
        }
      }
    }

    return {
      reasoningEfforts: Array.from(reasoningEfforts.values())
    };
  } catch {
    return {
      reasoningEfforts: []
    };
  }
}

function getCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

async function listRecentSessionFiles(sessionsRoot: string, limit: number): Promise<string[]> {
  const files: string[] = [];

  for (const year of await listDirectoryNamesDescending(sessionsRoot)) {
    if (files.length >= limit) {
      break;
    }

    const yearPath = path.join(sessionsRoot, year);
    for (const month of await listDirectoryNamesDescending(yearPath)) {
      if (files.length >= limit) {
        break;
      }

      const monthPath = path.join(yearPath, month);
      for (const day of await listDirectoryNamesDescending(monthPath)) {
        if (files.length >= limit) {
          break;
        }

        const dayPath = path.join(monthPath, day);
        const dayEntries = await fs.readdir(dayPath, { withFileTypes: true }).catch(() => []);
        const jsonlFiles = dayEntries
          .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl"))
          .map((entry) => entry.name)
          .sort((left, right) => right.localeCompare(left));

        for (const fileName of jsonlFiles) {
          files.push(path.join(dayPath, fileName));
          if (files.length >= limit) {
            break;
          }
        }
      }
    }
  }

  return files;
}

async function listDirectoryNamesDescending(rootPath: string): Promise<string[]> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
}

function addUniqueCandidate(target: Map<string, string>, candidate: string | undefined): void {
  const normalized = normalizeCandidate(candidate);
  if (!normalized) {
    return;
  }

  const key = normalized.toLowerCase();
  if (!target.has(key)) {
    target.set(key, normalized);
  }
}

function normalizeCandidate(candidate: string | undefined): string | undefined {
  const normalized = candidate?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readStringField(record: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = record?.[field];
  return typeof value === "string" ? normalizeCandidate(value) : undefined;
}
