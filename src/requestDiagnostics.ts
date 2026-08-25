import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

export type RequestDiagnosticsLevel = "off" | "metadata" | "full";

export interface RequestDiagnosticsRecord {
  metadata: Record<string, unknown>;
  fullDetails?: Record<string, unknown>;
}

export interface ChatRequestDiagnostic {
  id: number;
  conversationId: number;
  conversationLabel: string;
  conversationTopic?: string;
  requestKind: ChatDiagnosticKind;
  summary?: string;
  metadata: Record<string, unknown>;
  diagnosticsLevel: RequestDiagnosticsLevel;
  fullDiagnosticsPath?: string;
}

export type ChatDiagnosticKind = "conversation" | "background";

export interface ChatConversationDiagnostic {
  id: number;
  label: string;
  topic?: string;
  conversationIdentityKey?: string;
  kind: ChatDiagnosticKind;
  latestRequestAt: number;
  requests: readonly ChatRequestDiagnostic[];
}

export interface ChatDiagnosticsSnapshot {
  schemaVersion: 2;
  conversations: Array<ChatConversationDiagnostic & { key: string }>;
}

export interface ChatDiagnosticsRequestContext {
  modelOptions?: Record<string, unknown>;
}

export function resolveChatRequestDiagnostic(value: unknown): ChatRequestDiagnostic | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const diagnostic = candidate.diagnostic ?? candidate;
  if (!diagnostic || typeof diagnostic !== "object") {
    return undefined;
  }
  const record = diagnostic as Record<string, unknown>;
  return typeof record.conversationLabel === "string" && isRecord(record.metadata)
    ? diagnostic as ChatRequestDiagnostic
    : undefined;
}

interface DiagnosticInputItem {
  type: string;
  role?: string;
}

interface DiagnosticToolDefinition {
  name: string;
}

interface ConversationInputItem {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  call_id?: unknown;
  name?: unknown;
}

export class ChatDiagnosticsStore {
  private readonly changedEmitter = new Set<() => void>();
  private readonly conversationsByKey = new Map<string, MutableChatConversationDiagnostic>();
  private readonly sessionKeyByTraceId = new Map<string, string>();
  private nextConversationId = 1;
  private nextConversationNumber = 1;
  private nextRequestId = 1;

  constructor(
    private maximumConversations = 20,
    private maximumRequests = 50
  ) {}

  setRetentionLimits(maximumConversations: number, maximumRequests: number): void {
    this.maximumConversations = maximumConversations;
    this.maximumRequests = maximumRequests;
    this.trimToLimits();
    this.fireChanged();
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.changedEmitter.add(listener);
    return {
      dispose: () => this.changedEmitter.delete(listener)
    };
  }

  addRequest(
    input: readonly ConversationInputItem[],
    metadata: Record<string, unknown>,
    diagnosticsLevel: RequestDiagnosticsLevel,
    fullDiagnosticsPath?: string,
    context?: ChatDiagnosticsRequestContext
  ): ChatRequestDiagnostic {
    const requestKind = isBackgroundRequest(input) ? "background" : "conversation";
    const traceId = readTraceId(context?.modelOptions);
    const conversationIdentityKey = readConversationIdentityKey(context?.modelOptions);
    const groupKind = requestKind === "background" && !traceId ? "background" : "conversation";
    const sessionKey = createChatSessionKey(input, groupKind);
    const inputFingerprints = createInputFingerprints(input);
    const tracedSessionKey = traceId ? this.sessionKeyByTraceId.get(traceId) : undefined;
    const hasTracedSession = tracedSessionKey !== undefined && this.conversationsByKey.has(tracedSessionKey);
    const isCompatibleKey = (candidate: string): boolean => {
      const existingIdentity = this.conversationsByKey.get(candidate)?.conversationIdentityKey;
      return !conversationIdentityKey || !existingIdentity || existingIdentity === conversationIdentityKey;
    };
    const compatibleTracedSessionKey = tracedSessionKey && isCompatibleKey(tracedSessionKey)
      ? tracedSessionKey : undefined;
    const userMessageCount = input.filter((item) => item.type === "message" && item.role === "user").length;
    const hasHistory = userMessageCount > 1 || input.some((item) => item.role === "assistant" ||
      item.type === "function_call" || item.type === "function_call_output");
    const historySessionKey = requestKind === "conversation" && hasHistory
      ? this.findHistorySessionKey(inputFingerprints, isCompatibleKey)
      : undefined;
    const identitySessionKey = conversationIdentityKey
      ? this.findConversationIdentitySessionKey(conversationIdentityKey)
      : undefined;
    if (identitySessionKey && tracedSessionKey && tracedSessionKey !== identitySessionKey) {
      const provisional = this.conversationsByKey.get(tracedSessionKey);
      const identified = this.conversationsByKey.get(identitySessionKey);
      if (provisional && identified && !provisional.conversationIdentityKey &&
          provisional.requests.every((request) => request.requestKind === "background")) {
        identified.latestRequestAt = Math.max(identified.latestRequestAt, provisional.latestRequestAt);
        identified.requests = [...identified.requests, ...provisional.requests]
          .sort((left, right) => left.id - right.id)
          .map((request) => ({
            ...request,
            conversationId: identified.id,
            conversationLabel: identified.label,
            conversationTopic: identified.topic
          }));
        this.conversationsByKey.delete(tracedSessionKey);
        for (const [mappedTraceId, mappedKey] of this.sessionKeyByTraceId) {
          if (mappedKey === tracedSessionKey) {
            this.sessionKeyByTraceId.set(mappedTraceId, identitySessionKey);
          }
        }
      }
    }
    const matchingKeys = requestKind === "conversation"
      ? [...this.conversationsByKey.keys()].filter((candidate) =>
        candidate === sessionKey || candidate.startsWith(`${sessionKey}:`))
      : [];
    const compatibleMatchingKeys = matchingKeys.filter(isCompatibleKey);
    let key = identitySessionKey ?? compatibleTracedSessionKey ?? historySessionKey ?? (requestKind === "background" && traceId
      ? hashConversationSeed(`trace:${traceId}`)
      : requestKind === "conversation" && matchingKeys.length > 0
        ? hasHistory && compatibleMatchingKeys.length === 1 ? compatibleMatchingKeys[0] : `${sessionKey}:${this.nextConversationId}`
        : sessionKey);
    if (tracedSessionKey && !hasTracedSession) {
      this.sessionKeyByTraceId.delete(traceId!);
      key = identitySessionKey ?? historySessionKey ?? (requestKind === "background" && traceId ? hashConversationSeed(`trace:${traceId}`)
        : compatibleMatchingKeys.length === 1 && hasHistory ? compatibleMatchingKeys[0] : `${sessionKey}:${this.nextConversationId}`);
    }
    let conversation = this.conversationsByKey.get(key);
    if (requestKind === "conversation" && traceId && key === compatibleTracedSessionKey && conversation && key !== sessionKey &&
      !key.startsWith(`${sessionKey}:`)) {
      this.conversationsByKey.delete(key);
      const newKey = matchingKeys.length > 0 ? `${sessionKey}:${conversation.id}` : sessionKey;
      this.conversationsByKey.set(newKey, conversation);
      for (const [mappedTraceId, mappedKey] of this.sessionKeyByTraceId) {
        if (mappedKey === key) {
          this.sessionKeyByTraceId.set(mappedTraceId, newKey);
        }
      }
      key = newKey;
    }
    if (!conversation) {
      const id = this.nextConversationId++;
      conversation = {
        id,
        label: groupKind === "background" ? "Internal requests" : `Chat session ${this.nextConversationNumber++}`,
        kind: groupKind,
        conversationIdentityKey,
        latestRequestAt: Date.now(),
        inputFingerprints: [],
        requests: []
      };
      this.conversationsByKey.set(key, conversation);
    }
    if (!conversation) {
      throw new Error("Chat diagnostics conversation was not created.");
    }
    if (conversationIdentityKey) {
      conversation.conversationIdentityKey = conversationIdentityKey;
    }
    conversation.inputFingerprints = inputFingerprints;
    if (traceId) {
      this.sessionKeyByTraceId.set(traceId, key);
    }

    if (diagnosticsLevel === "full" && requestKind === "conversation" &&
        (!conversation.topic || isInjectedContextTitle(conversation.topic))) {
      conversation.topic = extractConversationTopic(input) ?? conversation.topic;
    }
    conversation.latestRequestAt = Date.now();

    const request: ChatRequestDiagnostic = {
      id: this.nextRequestId++,
      conversationId: conversation.id,
      conversationLabel: conversation.label,
      conversationTopic: conversation.topic,
      requestKind,
      summary: diagnosticsLevel === "full"
        ? extractRequestSummary(input, requestKind, conversation.topic)
        : undefined,
      metadata,
      diagnosticsLevel,
      fullDiagnosticsPath
    };
    conversation.requests.push(request);
    this.trimToLimits();
    this.fireChanged();
    return request;
  }

  getConversations(): readonly ChatConversationDiagnostic[] {
    return [...this.conversationsByKey.values()]
      .sort((left, right) => right.latestRequestAt - left.latestRequestAt)
      .map((conversation) => ({
        id: conversation.id,
        label: conversation.label,
        topic: conversation.topic,
        conversationIdentityKey: conversation.conversationIdentityKey,
        kind: conversation.kind,
        latestRequestAt: conversation.latestRequestAt,
        requests: [...conversation.requests].reverse()
      }));
  }

  createSnapshot(): ChatDiagnosticsSnapshot {
    return {
      schemaVersion: 2,
      conversations: [...this.conversationsByKey.entries()].map(([key, conversation]) => ({
        key,
        id: conversation.id,
        label: conversation.label,
        topic: conversation.topic,
        conversationIdentityKey: conversation.conversationIdentityKey,
        kind: conversation.kind,
        latestRequestAt: conversation.latestRequestAt,
        requests: [...conversation.requests]
      }))
    };
  }

  async restore(snapshot: unknown, fullDiagnosticsDirectory?: string): Promise<boolean> {
    if (!isRecord(snapshot) || snapshot.schemaVersion !== 2 || !Array.isArray(snapshot.conversations)) {
      return false;
    }

    const restored = new Map<string, MutableChatConversationDiagnostic>();
    let maximumConversationId = 0;
    let maximumConversationNumber = 0;
    let maximumRequestId = 0;
    for (const value of snapshot.conversations) {
      if (!isStoredConversation(value)) {
        return false;
      }
      const label = value.kind === "background"
        ? "Internal requests"
        : normalizeChatSessionLabel(value.label);
      const topic = value.topic && !isInjectedContextTitle(value.topic) ? value.topic : undefined;
      const conversationIdentityKey = value.conversationIdentityKey ?? await findStoredConversationIdentityKey(
        value.requests,
        fullDiagnosticsDirectory
      );
      restored.set(value.key, {
        id: value.id,
        label,
        topic,
        conversationIdentityKey,
        kind: value.kind,
        latestRequestAt: value.latestRequestAt,
        inputFingerprints: [],
        requests: normalizeLegacyPromptSummaries(value.requests).map((request) => ({
          ...request,
          conversationId: value.id,
          conversationLabel: label,
          conversationTopic: topic,
          ...(fullDiagnosticsDirectory && !isPathWithinDirectory(request.fullDiagnosticsPath, fullDiagnosticsDirectory)
            ? { fullDiagnosticsPath: undefined }
            : {})
        }))
      });
      maximumConversationId = Math.max(maximumConversationId, value.id);
      const labelNumber = /^(?:Conversation|Chat session) (\d+)$/.exec(value.label)?.[1];
      maximumConversationNumber = Math.max(maximumConversationNumber, Number(labelNumber ?? 0));
      for (const request of value.requests) {
        maximumRequestId = Math.max(maximumRequestId, request.id);
      }
    }

    this.conversationsByKey.clear();
    this.sessionKeyByTraceId.clear();
    for (const [key, conversation] of restored) {
      this.conversationsByKey.set(key, conversation);
    }
    this.mergeConversationIdentityGroups();
    if (fullDiagnosticsDirectory) {
      await this.mergeTracedBackgroundRequests(fullDiagnosticsDirectory);
    }
    this.nextConversationId = maximumConversationId + 1;
    this.nextConversationNumber = maximumConversationNumber + 1;
    this.nextRequestId = maximumRequestId + 1;
    this.trimToLimits();
    this.fireChanged();
    return true;
  }

  clear(): void {
    if (this.conversationsByKey.size === 0) {
      return;
    }
    this.conversationsByKey.clear();
    this.sessionKeyByTraceId.clear();
    this.nextConversationId = 1;
    this.nextConversationNumber = 1;
    this.nextRequestId = 1;
    this.fireChanged();
  }

  private findHistorySessionKey(inputFingerprints: readonly string[], isCompatibleKey: (key: string) => boolean): string | undefined {
    let bestKey: string | undefined;
    let bestMatchLength = 0;
    let tied = false;
    for (const [key, conversation] of this.conversationsByKey) {
      if (conversation.kind !== "conversation" || !isCompatibleKey(key)) {
        continue;
      }
      const matchLength = longestContiguousMatch(conversation.inputFingerprints, inputFingerprints);
      if (matchLength > bestMatchLength) {
        bestKey = key;
        bestMatchLength = matchLength;
        tied = false;
      } else if (matchLength > 0 && matchLength === bestMatchLength) {
        tied = true;
      }
    }
    return bestMatchLength >= 2 && !tied ? bestKey : undefined;
  }

  private findConversationIdentitySessionKey(identityKey: string): string | undefined {
    for (const [key, conversation] of this.conversationsByKey) {
      if (conversation.conversationIdentityKey === identityKey) {
        return key;
      }
    }
    return undefined;
  }

  private mergeConversationIdentityGroups(): void {
    const keyByIdentity = new Map<string, string>();
    const oldestFirst = [...this.conversationsByKey.entries()]
      .sort((left, right) => left[1].id - right[1].id);
    for (const [key, conversation] of oldestFirst) {
      const identityKey = conversation.conversationIdentityKey;
      if (!identityKey) {
        continue;
      }
      const existingKey = keyByIdentity.get(identityKey);
      if (!existingKey) {
        keyByIdentity.set(identityKey, key);
        continue;
      }
      const existing = this.conversationsByKey.get(existingKey);
      if (!existing) {
        keyByIdentity.set(identityKey, key);
        continue;
      }
      existing.latestRequestAt = Math.max(existing.latestRequestAt, conversation.latestRequestAt);
      existing.topic ??= conversation.topic;
      existing.requests = [...existing.requests, ...conversation.requests]
        .sort((left, right) => left.id - right.id)
        .map((request) => ({
          ...request,
          conversationId: existing.id,
          conversationLabel: existing.label,
          conversationTopic: existing.topic
        }));
      this.conversationsByKey.delete(key);
    }
    this.trimToLimits();
  }

  private async mergeTracedBackgroundRequests(fullDiagnosticsDirectory: string): Promise<void> {
    const traces = new Map<string, string | undefined>();
    for (const conversation of this.conversationsByKey.values()) {
      if (!conversation.conversationIdentityKey) {
        continue;
      }
      for (const request of conversation.requests) {
        if (request.requestKind !== "conversation") {
          continue;
        }
        const options = await readStoredModelOptions(request, fullDiagnosticsDirectory);
        const traceId = readTraceId(options);
        if (!traceId || readConversationIdentityKey(options) !== conversation.conversationIdentityKey) {
          continue;
        }
        if (!traces.has(traceId)) {
          traces.set(traceId, conversation.conversationIdentityKey);
        } else if (traces.get(traceId) !== conversation.conversationIdentityKey) {
          traces.set(traceId, undefined);
        }
      }
    }
    for (const [key, conversation] of [...this.conversationsByKey]) {
      if (conversation.kind !== "conversation" || conversation.conversationIdentityKey ||
          !conversation.requests.every((request) => request.requestKind === "background")) {
        continue;
      }
      for (const request of [...conversation.requests]) {
        const traceId = readTraceId(await readStoredModelOptions(request, fullDiagnosticsDirectory));
        const identityKey = traceId ? traces.get(traceId) : undefined;
        const destinationKey = identityKey ? this.findConversationIdentitySessionKey(identityKey) : undefined;
        const destination = destinationKey ? this.conversationsByKey.get(destinationKey) : undefined;
        if (!destination) {
          continue;
        }
        destination.requests.push({
          ...request,
          conversationId: destination.id,
          conversationLabel: destination.label,
          conversationTopic: destination.topic
        });
        destination.requests.sort((left, right) => left.id - right.id);
        destination.latestRequestAt = Math.max(destination.latestRequestAt, conversation.latestRequestAt);
        conversation.requests = conversation.requests.filter((candidate) => candidate.id !== request.id);
      }
      if (conversation.requests.length === 0) {
        this.conversationsByKey.delete(key);
      }
    }
  }

  private trimToLimits(): void {
    const retained = [...this.conversationsByKey.entries()]
      .sort((left, right) =>
        right[1].latestRequestAt - left[1].latestRequestAt || right[1].id - left[1].id
      )
      .slice(0, Math.max(1, this.maximumConversations));
    this.conversationsByKey.clear();

    let remainingRequests = Math.max(1, this.maximumRequests);
    for (const [key, conversation] of retained) {
      const requests = conversation.requests.slice(-remainingRequests);
      if (requests.length === 0) {
        continue;
      }
      conversation.requests = requests;
      this.conversationsByKey.set(key, conversation);
      remainingRequests -= requests.length;
      if (remainingRequests === 0) {
        break;
      }
    }

    const retainedKeys = new Set(this.conversationsByKey.keys());
    for (const [traceId, key] of this.sessionKeyByTraceId) {
      if (!retainedKeys.has(key)) {
        this.sessionKeyByTraceId.delete(traceId);
      }
    }
  }

  private fireChanged(): void {
    for (const listener of this.changedEmitter) {
      listener();
    }
  }
}

interface MutableChatConversationDiagnostic {
  id: number;
  label: string;
  topic?: string;
  conversationIdentityKey?: string;
  kind: ChatDiagnosticKind;
  latestRequestAt: number;
  inputFingerprints: string[];
  requests: ChatRequestDiagnostic[];
}

function isStoredConversation(
  value: unknown
): value is ChatConversationDiagnostic & { key: string } {
  if (!isRecord(value) || typeof value.key !== "string" || !isPositiveInteger(value.id) ||
      typeof value.label !== "string" || typeof value.latestRequestAt !== "number" ||
      !isChatDiagnosticKind(value.kind) || !Array.isArray(value.requests) ||
      (value.topic !== undefined && typeof value.topic !== "string")) {
    return false;
  }
  return value.requests.every((request) => {
    const diagnostic = resolveChatRequestDiagnostic(request);
    return diagnostic !== undefined && isPositiveInteger(diagnostic.id) &&
      isPositiveInteger(diagnostic.conversationId) &&
      isChatDiagnosticKind(diagnostic.requestKind) &&
      (diagnostic.diagnosticsLevel === "metadata" || diagnostic.diagnosticsLevel === "full");
  });
}

function isChatDiagnosticKind(value: unknown): value is ChatDiagnosticKind {
  return value === "conversation" || value === "background";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPathWithinDirectory(candidate: unknown, directory: string): candidate is string {
  if (typeof candidate !== "string") {
    return false;
  }
  const relativePath = path.relative(path.resolve(directory), path.resolve(candidate));
  return relativePath !== "" && relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

export function collectRequestDiagnostics(
  level: RequestDiagnosticsLevel,
  createMetadata: () => Record<string, unknown>,
  createFullDetails: () => Record<string, unknown>
): RequestDiagnosticsRecord | undefined {
  if (level === "off") {
    return undefined;
  }

  return {
    metadata: createMetadata(),
    ...(level === "full" ? { fullDetails: createFullDetails() } : {})
  };
}

export function buildInputBreakdown(
  payload: Record<string, unknown>,
  input: readonly DiagnosticInputItem[],
  tools: readonly DiagnosticToolDefinition[]
): Record<string, unknown> {
  const inputItems = input.map((item, index) => ({
    index,
    type: item.type,
    ...(item.type === "message" ? { role: item.role } : {}),
    characters: JSON.stringify(item).length
  }));
  const toolDefinitions = tools
    .map((tool) => ({
      name: tool.name,
      characters: JSON.stringify(tool).length
    }))
    .sort((left, right) => right.characters - left.characters);
  const inputItemCharacters = inputItems.reduce((total, item) => total + item.characters, 0);
  const toolDefinitionCharacters = toolDefinitions.reduce((total, tool) => total + tool.characters, 0);
  const payloadCharacters = JSON.stringify(payload).length;
  const requestOverheadCharacters = Math.max(0, payloadCharacters - inputItemCharacters - toolDefinitionCharacters);

  return {
    payloadCharacters,
    inputItemCount: inputItems.length,
    inputItemCharacters,
    inputItems,
    toolCount: tools.length,
    toolDefinitionCharacters,
    largestToolDefinitions: toolDefinitions.slice(0, 10),
    omittedToolDefinitionCount: Math.max(0, toolDefinitions.length - 10),
    requestOverheadCharacters,
    characterHeuristicTokens: {
      inputItems: estimateTokensFromCharacters(inputItemCharacters),
      toolDefinitions: estimateTokensFromCharacters(toolDefinitionCharacters),
      requestOverhead: estimateTokensFromCharacters(requestOverheadCharacters),
      payload: estimateTokensFromCharacters(payloadCharacters)
    }
  };
}

export function selectStoredRequestDiagnosticsToDelete(
  fileNames: readonly string[],
  maximumFiles: number,
  retainedFileNames?: ReadonlySet<string>
): string[] {
  if (retainedFileNames) {
    return fileNames.filter((name) => !retainedFileNames.has(name));
  }
  return [...fileNames].sort()
    .slice(0, Math.max(0, fileNames.length - Math.max(0, maximumFiles)));
}

export function stringifyDiagnostics(value: unknown): string {
  const ancestors: object[] = [];
  return JSON.stringify(
    value,
    function (this: object, _key, item: unknown) {
      if (typeof item === "bigint") {
        return item.toString();
      }
      if (item && typeof item === "object") {
        while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
          ancestors.pop();
        }
        if (ancestors.includes(item)) {
          return "[circular]";
        }
        ancestors.push(item);
      }
      if (item instanceof Uint8Array) {
        return {
          type: "Uint8Array",
          byteLength: item.byteLength,
          data: Array.from(item)
        };
      }
      return item;
    },
    2
  );
}

function createChatSessionKey(
  input: readonly ConversationInputItem[],
  kind: ChatDiagnosticKind
): string {
  if (kind === "background") {
    return "background";
  }
  const initiatingUserMessage = findInitiatingUserMessage(input);
  const seed = initiatingUserMessage
    ? JSON.stringify({ role: initiatingUserMessage.role, content: initiatingUserMessage.content })
    : JSON.stringify(input);
  return hashConversationSeed(`prompt:${seed}`);
}

function createInputFingerprints(input: readonly ConversationInputItem[]): string[] {
  return input.map((item) => hashConversationSeed(stringifyDiagnostics(item)));
}

async function findStoredConversationIdentityKey(
  requests: readonly ChatRequestDiagnostic[],
  fullDiagnosticsDirectory: string | undefined
): Promise<string | undefined> {
  if (!fullDiagnosticsDirectory) {
    return undefined;
  }
  for (const request of requests) {
    const identityKey = readConversationIdentityKey(await readStoredModelOptions(request, fullDiagnosticsDirectory));
    if (identityKey) {
      return identityKey;
    }
  }
  return undefined;
}

async function readStoredModelOptions(
  request: ChatRequestDiagnostic,
  fullDiagnosticsDirectory: string
): Promise<Record<string, unknown> | undefined> {
  if (!request.fullDiagnosticsPath || !isPathWithinDirectory(request.fullDiagnosticsPath, fullDiagnosticsDirectory)) {
    return undefined;
  }
  try {
    const record = JSON.parse(await readFile(request.fullDiagnosticsPath, "utf8")) as unknown;
    return isRecord(record) && isRecord(record.request) &&
      isRecord(record.request.incoming) && isRecord(record.request.incoming.modelOptions)
      ? record.request.incoming.modelOptions : undefined;
  } catch {
    return undefined;
  }
}

function longestContiguousMatch(left: readonly string[], right: readonly string[]): number {
  let previous = new Array<number>(right.length + 1).fill(0);
  let longest = 0;
  for (const leftFingerprint of left) {
    const current = new Array<number>(right.length + 1).fill(0);
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      if (leftFingerprint === right[rightIndex]) {
        current[rightIndex + 1] = previous[rightIndex] + 1;
        longest = Math.max(longest, current[rightIndex + 1]);
      }
    }
    previous = current;
  }
  return longest;
}

function hashConversationSeed(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function normalizeChatSessionLabel(label: string): string {
  const legacyNumber = /^Conversation (\d+)$/.exec(label)?.[1];
  return legacyNumber ? `Chat session ${legacyNumber}` : label;
}

function normalizeLegacyPromptSummaries(requests: readonly ChatRequestDiagnostic[]): ChatRequestDiagnostic[] {
  let promptNumber = 0;
  let lastPromptTitle: string | undefined;
  let lastPromptWasFollowUp = false;
  return requests.map((request) => {
    const summary = request.summary;
    const initial = summary === "Initial chat session prompt" || summary?.startsWith("Initial prompt:");
    const followUp = summary?.startsWith("Follow-up prompt:");
    if (!initial && !followUp) {
      const numbered = /^Prompt #(\d+)(?:: (.*))?$/.exec(summary ?? "");
      if (numbered) {
        promptNumber = Math.max(promptNumber, Number(numbered[1]));
        lastPromptTitle = numbered[2];
      }
      return request;
    }
    const title = summary === "Initial chat session prompt" ? "" : summary!.slice(summary!.indexOf(":") + 1).trim();
    if (initial) {
      promptNumber = Math.max(1, promptNumber);
    } else if (!lastPromptWasFollowUp || title !== lastPromptTitle || promptNumber === 0) {
      promptNumber = Math.max(2, promptNumber + 1);
    }
    lastPromptTitle = title;
    lastPromptWasFollowUp = Boolean(followUp);
    return { ...request, summary: `Prompt #${promptNumber}${title ? `: ${title}` : ""}` };
  });
}

function readTraceId(modelOptions: Record<string, unknown> | undefined): string | undefined {
  const traceContext = isRecord(modelOptions?._otelTraceContext)
    ? modelOptions._otelTraceContext
    : undefined;
  const traceId = traceContext?.traceId;
  return typeof traceId === "string" && traceId.trim().length > 0 ? traceId.trim() : undefined;
}

function readConversationIdentityKey(modelOptions: Record<string, unknown> | undefined): string | undefined {
  const conversationId = modelOptions?._conversationId;
  return typeof conversationId === "string" && conversationId.trim().length > 0
    ? hashConversationSeed(`conversation:${conversationId.trim()}`)
    : undefined;
}

function isBackgroundRequest(input: readonly ConversationInputItem[]): boolean {
  const prompt = input
    .filter((item) => item.type === "message" && item.role === "user" && typeof item.content === "string")
    .map((item) => (item.content as string).replace(/\s+/g, " ").trim())
    .at(-1);
  if (!prompt) {
    return false;
  }
  return (
    prompt.startsWith("Please generate exactly 10 unique progress messages for the ") &&
    prompt.includes("Return only a JSON array of strings")
  ) || (
    /^You will be given \d+ groups of tools\./.test(prompt) &&
    prompt.includes("For each group, provide a name and summary")
  ) || (
    input.some((item) => item.type === "message" && item.role === "user" &&
      typeof item.content === "string" &&
      item.content.startsWith("You are an expert in crafting ultra-compact titles for chatbot conversations.")) &&
    prompt.startsWith("Please write a brief title for the following request:")
  );
}

function extractConversationTopic(input: readonly ConversationInputItem[]): string | undefined {
  const initialUserMessages: string[] = [];
  for (const item of input) {
    if (item.type !== "message" || item.role !== "user") {
      break;
    }
    if (typeof item.content === "string") {
      initialUserMessages.push(item.content);
    }
  }
  const candidates = initialUserMessages.length > 0
    ? initialUserMessages
    : input
      .filter((item) => item.type === "message" && item.role === "user" && typeof item.content === "string")
      .map((item) => item.content as string);
  for (const content of [...candidates].reverse()) {
    const title = createDescriptiveTitle(content);
    if (title) {
      return title;
    }
  }
  return candidates.some((content) => /<attachments(?:\s[^>]*)?>/i.test(content))
    ? "Attached content"
    : undefined;
}

function extractRequestSummary(
  input: readonly ConversationInputItem[],
  kind: ChatDiagnosticKind,
  conversationTopic: string | undefined
): string {
  if (kind === "background") {
    const prompt = input
      .filter((item) => item.type === "message" && item.role === "user" && typeof item.content === "string")
      .map((item) => item.content as string)
      .at(-1) ?? "";
    return prompt.startsWith("Please generate exactly 10 unique progress messages")
      ? "Generate progress messages"
      : "Summarize available tools";
  }

  let latestUserIndex = -1;
  input.forEach((item, index) => {
    if (item.type === "message" && item.role === "user") {
      latestUserIndex = index;
    }
  });
  let userTurnStart = latestUserIndex;
  while (userTurnStart > 0 && input[userTurnStart - 1].type === "message" && input[userTurnStart - 1].role === "user") {
    userTurnStart--;
  }
  const latestUserMessages = input.slice(userTurnStart, latestUserIndex + 1)
    .filter((item) => item.type === "message" && item.role === "user" && typeof item.content === "string");
  const latestUserTitle = [...latestUserMessages].reverse()
    .map((item) => createDescriptiveTitle(item.content as string))
    .find((title): title is string => Boolean(title))
    ?? (latestUserMessages.some((item) => /<attachments(?:\s[^>]*)?>/i.test(item.content as string))
      ? "Attached content"
      : undefined);
  const recentInput = input.slice(latestUserIndex + 1);
  let outputStart = 0;
  for (let index = recentInput.length - 1; index >= 0; index--) {
    if (recentInput[index].type === "function_call") {
      outputStart = index + 1;
      break;
    }
  }
  const toolOutputs = recentInput.slice(outputStart).filter((item) => item.type === "function_call_output");
  if (toolOutputs.length > 0) {
    const recentTools = [...new Set(toolOutputs.slice(-3).map((output) =>
      [...input].reverse().find((item) => item.type === "function_call" &&
        typeof output.call_id === "string" && item.call_id === output.call_id)?.name
    ).filter((name): name is string => typeof name === "string"))];
    return recentTools.length > 0
      ? `Tool continuation: Results from ${recentTools.join(", ")}`
      : "Tool continuation: Tool results returned";
  }

  let promptNumber = 0;
  let inUserTurn = false;
  for (const item of input) {
    if ((item.type === "message" && item.role === "assistant") ||
      item.type === "function_call" || item.type === "function_call_output") {
      inUserTurn = false;
    } else if (item.type === "message" && item.role === "user" && typeof item.content === "string") {
      if (!inUserTurn) {
        promptNumber++;
        inUserTurn = true;
      }
    }
  }
  const title = latestUserTitle ?? conversationTopic;
  return promptNumber > 0
    ? `Prompt #${promptNumber}${title ? `: ${title}` : ""}`
    : "Chat session continuation";
}

function createDescriptiveTitle(content: string): string | undefined {
  const withoutInjectedContext = content
    .replace(/<\/?userRequest>/gi, " ")
    .replace(/<(context|editorContext|environment_info|workspace_info|userMemory|sessionMemory|repoMemory|reminderInstructions)>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<attachments(?:\s[^>]*)?>[\s\S]*?<\/attachments\s*>/gi, " ")
    .replace(/^\s*#{1,6}\s*$/gm, " ")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!withoutInjectedContext) {
    return undefined;
  }
  const maximumLength = 96;
  return withoutInjectedContext.length > maximumLength
    ? `${withoutInjectedContext.slice(0, maximumLength - 3).trimEnd()}...`
    : withoutInjectedContext;
}

function findInitiatingUserMessage(
  input: readonly ConversationInputItem[]
): ConversationInputItem | undefined {
  let initiatingUserMessage: ConversationInputItem | undefined;
  for (const item of input) {
    if (item.type !== "message" || item.role !== "user") {
      break;
    }
    initiatingUserMessage = item;
  }
  return initiatingUserMessage ?? input.find((item) => item.type === "message" && item.role === "user");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function estimateTokensFromCharacters(characters: number): number {
  return Math.ceil(characters / 4);
}

function isInjectedContextTitle(value: string): boolean {
  return /^#?\s*<(context|environment_info|workspace_info|userMemory|sessionMemory|repoMemory|reminderInstructions)>/i.test(value.trim());
}