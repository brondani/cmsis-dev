import { ChatConversationDiagnostic, ChatRequestDiagnostic } from "./requestDiagnostics";

export interface ChatTraceCompositionSegment {
  key: "messages" | "tools";
  label: string;
  characters: number;
  percent: number;
}

export interface ChatTraceRequest {
  id: number;
  requestNumber: number;
  summary: string;
  kind: ChatRequestDiagnostic["requestKind"];
  model: string;
  status: string;
  startedAt?: number;
  relativeStartMs: number;
  activeStartMs: number;
  durationMs?: number;
  offsetPercent: number;
  widthPercent: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  inputItemCount: number;
  toolCount: number;
  payloadCharacters: number;
  composition: readonly ChatTraceCompositionSegment[];
  diagnosticsLevel: ChatRequestDiagnostic["diagnosticsLevel"];
  hasFullDetails: boolean;
}

export interface ChatTraceTokenUsage {
  requestCount: number;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  inputMissingCount: number;
  cachedMissingCount: number;
  outputMissingCount: number;
  reasoningMissingCount: number;
}

export interface ChatConversationTrace {
  id: number;
  label: string;
  topic?: string;
  kind: ChatConversationDiagnostic["kind"];
  summary: {
    requestCount: number;
    backgroundRequestCount: number;
    elapsedMs: number;
    activeDurationMs: number;
    peakInputTokens?: number;
    totalOutputTokens?: number;
    tokenUsage: {
      all: ChatTraceTokenUsage;
      chat: ChatTraceTokenUsage;
      internal: ChatTraceTokenUsage;
    };
    maximumToolCount: number;
    fullDetailsCount: number;
  };
  requests: readonly ChatTraceRequest[];
}

export function buildChatConversationTrace(conversation: ChatConversationDiagnostic): ChatConversationTrace {
  const ordered = [...conversation.requests]
    .map((request) => ({ request, startedAt: readTimestamp(request.metadata.startedAt) }))
    .sort((left, right) =>
      (left.startedAt ?? Number.MAX_SAFE_INTEGER) - (right.startedAt ?? Number.MAX_SAFE_INTEGER) ||
      left.request.id - right.request.id
    );
  const knownStarts = ordered
    .map((entry) => entry.startedAt)
    .filter((value): value is number => value !== undefined);
  const traceStart = knownStarts.length > 0 ? Math.min(...knownStarts) : 0;
  const traceEnd = ordered.reduce((maximum, entry) => {
    const start = entry.startedAt ?? traceStart;
    return Math.max(maximum, start + (readNumber(entry.request.metadata.durationMs) ?? 0));
  }, traceStart);
  const elapsedMs = Math.max(0, traceEnd - traceStart);
  const activeDurationMs = ordered.reduce(
    (total, entry) => total + Math.max(0, readNumber(entry.request.metadata.durationMs) ?? 0),
    0
  );

  let activeStartMs = 0;
  const requests = ordered.map(({ request, startedAt }) => {
    const durationMs = readNumber(request.metadata.durationMs);
    const relativeStartMs = startedAt === undefined ? 0 : Math.max(0, startedAt - traceStart);
    const requestActiveStartMs = activeStartMs;
    activeStartMs += Math.max(0, durationMs ?? 0);
    return {
      id: request.id,
      requestNumber: readNumber(request.metadata.requestId) ?? request.id,
      summary: readRequestSummary(request),
      kind: request.requestKind,
      model: readString(request.metadata.model, "Unknown model"),
      status: readString(request.metadata.status, "unknown"),
      startedAt,
      relativeStartMs,
      activeStartMs: requestActiveStartMs,
      durationMs,
      offsetPercent: activeDurationMs > 0 ? clampPercent((requestActiveStartMs / activeDurationMs) * 100) : 0,
      widthPercent: activeDurationMs > 0 && durationMs !== undefined
        ? clampPercent((durationMs / activeDurationMs) * 100)
        : 0,
      inputTokens: readNumber(request.metadata.inputTokens),
      outputTokens: readNumber(request.metadata.outputTokens),
      cachedTokens: readNumber(request.metadata.cachedTokens),
      reasoningTokens: readNumber(request.metadata.reasoningTokens),
      ...readInputBreakdown(request.metadata.inputBreakdown),
      diagnosticsLevel: request.diagnosticsLevel,
      hasFullDetails: Boolean(request.fullDiagnosticsPath)
    } satisfies ChatTraceRequest;
  });

  return {
    id: conversation.id,
    label: conversation.label,
    topic: conversation.topic,
    kind: conversation.kind,
    summary: {
      requestCount: requests.length,
      backgroundRequestCount: requests.filter((request) => request.kind === "background").length,
      elapsedMs,
      activeDurationMs,
      peakInputTokens: maximumDefined(requests.map((request) => request.inputTokens)),
      totalOutputTokens: sumDefined(requests.map((request) => request.outputTokens)),
      tokenUsage: {
        all: summarizeTokenUsage(requests),
        chat: summarizeTokenUsage(requests.filter((request) => request.kind === "conversation")),
        internal: summarizeTokenUsage(requests.filter((request) => request.kind === "background"))
      },
      maximumToolCount: Math.max(0, ...requests.map((request) => request.toolCount)),
      fullDetailsCount: requests.filter((request) => request.hasFullDetails).length
    },
    requests
  };
}

function summarizeTokenUsage(requests: readonly ChatTraceRequest[]): ChatTraceTokenUsage {
  return {
    requestCount: requests.length,
    inputTokens: sumDefined(requests.map((request) => request.inputTokens)),
    cachedTokens: sumDefined(requests.map((request) => request.cachedTokens)),
    outputTokens: sumDefined(requests.map((request) => request.outputTokens)),
    reasoningTokens: sumDefined(requests.map((request) => request.reasoningTokens)),
    inputMissingCount: requests.filter((request) => request.inputTokens === undefined).length,
    cachedMissingCount: requests.filter((request) => request.cachedTokens === undefined).length,
    outputMissingCount: requests.filter((request) => request.outputTokens === undefined).length,
    reasoningMissingCount: requests.filter((request) => request.reasoningTokens === undefined).length
  };
}

function readInputBreakdown(value: unknown): Pick<ChatTraceRequest,
  "inputItemCount" | "toolCount" | "payloadCharacters" | "composition"> {
  const breakdown = asRecord(value);
  const messages = readNumber(breakdown?.inputItemCharacters) ?? 0;
  const tools = readNumber(breakdown?.toolDefinitionCharacters) ?? 0;
  const overhead = readNumber(breakdown?.requestOverheadCharacters) ?? 0;
  const payloadCharacters = readNumber(breakdown?.payloadCharacters) ?? messages + tools + overhead;
  const compositionTotal = Math.max(1, payloadCharacters);
  return {
    inputItemCount: readNumber(breakdown?.inputItemCount) ?? 0,
    toolCount: readNumber(breakdown?.toolCount) ?? 0,
    payloadCharacters,
    composition: [
      { key: "messages", label: "Messages", characters: messages, percent: (messages / compositionTotal) * 100 },
      { key: "tools", label: "Callable definitions", characters: tools, percent: (tools / compositionTotal) * 100 }
    ]
  };
}

function readTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function maximumDefined(values: readonly (number | undefined)[]): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length > 0 ? Math.max(...defined) : undefined;
}

function sumDefined(values: readonly (number | undefined)[]): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length > 0 ? defined.reduce((total, value) => total + value, 0) : undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readRequestSummary(request: ChatRequestDiagnostic): string {
  if (request.summary) {
    return request.summary;
  }
  if (request.requestKind === "background") {
    return "Internal request";
  }
  const breakdown = asRecord(request.metadata.inputBreakdown);
  const inputItems = Array.isArray(breakdown?.inputItems) ? breakdown.inputItems : [];
  const itemTypes = inputItems
    .map((item) => asRecord(item)?.type)
    .filter((type): type is string => typeof type === "string");
  if (itemTypes.includes("function_call_output")) {
    return "Continue after tool results";
  }
  if (itemTypes.includes("function_call")) {
    return "Continue tool-calling turn";
  }
  return "Chat session request";
}