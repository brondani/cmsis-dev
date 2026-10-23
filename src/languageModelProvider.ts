import * as path from "node:path";
import * as vscode from "vscode";
import {
  getConfiguredReasoningEffort,
  readReasoningEffortFromModelOptions
} from "./reasoningEffort";
import {
  clearLanguageModelProviderApiKey,
  getLanguageModelProviderApiKey,
  setLanguageModelProviderApiKey
} from "./secrets";
import {
  buildInputBreakdown,
  ChatDiagnosticsStore,
  collectRequestDiagnostics,
  RequestDiagnosticsLevel,
  selectStoredRequestDiagnosticsToDelete,
  stringifyDiagnostics
} from "./requestDiagnostics";

export const CMSIS_DEV_LANGUAGE_MODEL_VENDOR = "cmsis-dev-openai-proxy";
export const CMSIS_DEV_LANGUAGE_MODEL_PROVIDER_MANAGEMENT_COMMAND = "cmsisDev.configureIntegrations";

const DEFAULT_PROXY_BASE_URL = "https://openai-api-proxy.geo.arm.com/api/providers/openai/v1";
const DEFAULT_MAX_INPUT_TOKENS = 128000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16384;
const DEFAULT_MAX_DIAGNOSTICS_REQUESTS = 50;
const DEFAULT_MAX_DIAGNOSTICS_SESSIONS = 20;
const MODEL_ACCESS_CACHE_KEY = "cmsisDev.languageModelProvider.modelAccess";
const DEFAULT_VISIBLE_MODEL_IDS = new Set(["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"]);
const CHAT_DIAGNOSTICS_DIRECTORY = ".cmsis-dev/chat-diagnostics";
const CHAT_DIAGNOSTICS_INDEX = "conversations.json";

interface StoredModelAccessState {
  baseUrl: string;
  fetchedAt: number;
  permittedModelIds: string[];
  deniedModels: Array<{
    id: string;
    reason: string;
  }>;
}

interface CmsisDevLanguageModelInformation extends vscode.LanguageModelChatInformation {
  detail?: string;
  tooltip?: string;
}

interface OpenAiModelRecord {
  id?: string;
  object?: string;
  owned_by?: string;
  context_window?: number;
  max_context_tokens?: number;
  max_output_tokens?: number;
}

interface OpenAiModelsResponse {
  data?: OpenAiModelRecord[];
  error?: {
    message?: string;
  };
}

type OpenAiChatMessage =
  | {
      role: "user" | "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: {
          name: string;
          arguments: string;
        };
      }>;
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

type OpenAiResponsesInputItem =
  | {
      type: "message";
      role: "user" | "assistant" | "system" | "developer";
      content: string;
    }
  | {
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: string;
    };

interface OpenAiResponsesTool {
  type: "function";
  name: string;
  description: string;
  parameters: object;
}

interface OpenAiResponsesResponse {
  output?: Array<{
    type?: string;
    id?: string;
    role?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: Array<{
      type?: string;
      text?: string;
      refusal?: string;
    }>;
    summary?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: {
      cached_tokens?: number;
    };
    output_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
  error?: {
    message?: string;
  };
}

export class CmsisDevLanguageModelProvider
  implements vscode.LanguageModelChatProvider<CmsisDevLanguageModelInformation>, vscode.Disposable
{
  private readonly modelsChangedEmitter = new vscode.EventEmitter<void>();
  private readonly usageOutput = vscode.window.createOutputChannel("CMSIS-Dev Proxy Usage", { log: true });
  readonly chatDiagnostics = new ChatDiagnosticsStore(
    getConfiguredMaxDiagnosticsSessions(),
    getConfiguredMaxDiagnosticsRequests()
  );
  readonly onDidChangeLanguageModelChatInformation = this.modelsChangedEmitter.event;
  private requestSequence = 0;
  private modelCache:
    | {
        fetchedAt: number;
        models: CmsisDevLanguageModelInformation[];
      }
    | undefined;
  private readonly globalState: vscode.Memento;
  private readonly requestDiagnosticsUri: vscode.Uri;
  private readonly chatDiagnosticsDirectoryUri: vscode.Uri | undefined;
  private readonly chatDiagnosticsIndexUri: vscode.Uri | undefined;
  private chatDiagnosticsWrite = Promise.resolve();
  private diagnosticsGeneration = 0;
  private readonly pendingDiagnosticsFiles = new Set<string>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(context: vscode.ExtensionContext) {
    this.globalState = context.globalState;
    this.chatDiagnosticsDirectoryUri = resolveWorkspaceChatDiagnosticsDirectoryUri();
    this.chatDiagnosticsIndexUri = this.chatDiagnosticsDirectoryUri
      ? vscode.Uri.joinPath(this.chatDiagnosticsDirectoryUri, CHAT_DIAGNOSTICS_INDEX)
      : undefined;
    this.requestDiagnosticsUri = this.chatDiagnosticsDirectoryUri
      ? vscode.Uri.joinPath(this.chatDiagnosticsDirectoryUri, "requests")
      : vscode.Uri.joinPath(context.logUri, "proxy-requests");
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("cmsisDev.languageModelProvider.baseUrl") ||
          event.affectsConfiguration("cmsisDev.languageModelProvider.defaultMaxInputTokens") ||
          event.affectsConfiguration("cmsisDev.languageModelProvider.defaultMaxOutputTokens")
        ) {
          this.refresh();
        }
        if (
          event.affectsConfiguration("cmsisDev.languageModelProvider.maxDiagnosticsRequests") ||
          event.affectsConfiguration("cmsisDev.languageModelProvider.maxDiagnosticsSessions")
        ) {
          this.chatDiagnostics.setRetentionLimits(
            getConfiguredMaxDiagnosticsSessions(),
            getConfiguredMaxDiagnosticsRequests()
          );
          void this.persistChatDiagnosticsIndex();
          void this.trimStoredRequestDiagnostics().catch((error) => {
            if (!isFileNotFoundError(error)) {
              this.usageOutput.warn(`Failed to trim request diagnostics: ${describeProviderError(error)}`);
            }
          });
        }
      })
    );
  }

  dispose(): void {
    for (const disposable of this.subscriptions.splice(0)) {
      disposable.dispose();
    }
    this.usageOutput.dispose();
    this.modelsChangedEmitter.dispose();
  }

  refresh(): void {
    this.modelCache = undefined;
    this.modelsChangedEmitter.fire();
  }

  async initializeChatDiagnostics(): Promise<void> {
    if (this.chatDiagnosticsIndexUri) {
      try {
        const content = await vscode.workspace.fs.readFile(this.chatDiagnosticsIndexUri);
        const snapshot = JSON.parse(new TextDecoder().decode(content)) as unknown;
        if (!(await this.chatDiagnostics.restore(snapshot, this.requestDiagnosticsUri.fsPath))) {
          this.usageOutput.warn(`Ignored invalid chat diagnostics index: ${this.chatDiagnosticsIndexUri.fsPath}`);
        } else {
          await this.persistChatDiagnosticsIndex();
        }
      } catch (error) {
        if (!isFileNotFoundError(error)) {
          this.usageOutput.warn(`Failed to restore chat diagnostics: ${describeProviderError(error)}`);
        }
      }
    }
    try {
      await this.trimStoredRequestDiagnostics();
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        this.usageOutput.warn(`Failed to trim request diagnostics: ${describeProviderError(error)}`);
      }
    }
  }

  async clearChatDiagnostics(): Promise<void> {
    this.diagnosticsGeneration += 1;
    this.chatDiagnostics.clear();
    await this.enqueueChatDiagnosticsWrite(async () => {
      try {
        await vscode.workspace.fs.delete(this.chatDiagnosticsDirectoryUri ?? this.requestDiagnosticsUri, {
          recursive: true,
          useTrash: false
        });
      } catch (error) {
        if (!isFileNotFoundError(error)) {
          throw error;
        }
      }
    });
  }

  async clearModelAccessCache(): Promise<void> {
    await this.globalState.update(MODEL_ACCESS_CACHE_KEY, undefined);
    this.refresh();
  }

  async inspectModels(): Promise<CmsisDevLanguageModelInformation[]> {
    return this.getModels({ forceRefresh: true });
  }

  async refreshPermittedModels(): Promise<StoredModelAccessState> {
    const rawModels = await this.fetchRawModels();
    const baseUrl = getConfiguredLanguageModelProviderBaseUrl();

    const permittedModelIds: string[] = [];
    const deniedModels: Array<{ id: string; reason: string }> = [];

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "CMSIS-Dev: Validating language models",
        cancellable: false
      },
      async (progress) => {
        for (let index = 0; index < rawModels.length; index += 1) {
          const model = rawModels[index];
          progress.report({
            message: `${index + 1}/${rawModels.length}: ${model.id}`,
            increment: rawModels.length > 0 ? 100 / rawModels.length : undefined
          });

          try {
            await this.probeModelAccess(model);
            permittedModelIds.push(model.id);
          } catch (error) {
            deniedModels.push({
              id: model.id,
              reason: describeProviderError(error)
            });
          }
        }
      }
    );

    const state: StoredModelAccessState = {
      baseUrl,
      fetchedAt: Date.now(),
      permittedModelIds,
      deniedModels
    };
    await this.globalState.update(MODEL_ACCESS_CACHE_KEY, state);
    this.refresh();
    return state;
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken
  ): Promise<CmsisDevLanguageModelInformation[]> {
    if (!(await getLanguageModelProviderApiKey())) {
      return [];
    }

    try {
      return await this.getModels({ forceRefresh: false, token });
    } catch (error) {
      if (!options.silent) {
        console.warn(`[CMSIS-Dev] Failed to resolve language models: ${describeProviderError(error)}`);
      }
      return [];
    }
  }

  async provideLanguageModelChatResponse(
    model: CmsisDevLanguageModelInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const baseUrl = getConfiguredLanguageModelProviderBaseUrl();
    const diagnosticsLevel = getConfiguredRequestDiagnosticsLevel();
    const diagnosticsContext = diagnosticsLevel === "off"
      ? undefined
      : { requestId: ++this.requestSequence, startedAt: Date.now(), generation: this.diagnosticsGeneration };

    const apiKey = await getLanguageModelProviderApiKey();
    if (!apiKey) {
      throw new Error("CMSIS-Dev language model provider API key is not configured.");
    }

    const input = toOpenAiResponsesInput(messages);
    const payload: Record<string, unknown> = {
      model: model.id,
      input
    };
    const reasoningEffort = readReasoningEffortFromModelOptions(options.modelOptions) ?? getConfiguredReasoningEffort();
    if (reasoningEffort) {
      payload.reasoning = {
        effort: reasoningEffort
      };
    }

    const tools = toOpenAiResponsesTools(options.tools);
    if (tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = options.toolMode === vscode.LanguageModelChatToolMode.Required ? "required" : "auto";
    }
    const responseUrl = joinUrl(baseUrl, "responses");

    try {
      const response = await fetchJson<OpenAiResponsesResponse>(responseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }, token);

      if (diagnosticsContext) {
        await this.recordRequestDiagnostics(
          diagnosticsContext.generation,
          diagnosticsLevel,
          input,
          options.modelOptions,
          () => buildRequestDiagnosticsMetadata(
            diagnosticsContext,
            model.id,
            reasoningEffort,
            "completed",
            buildInputBreakdown(payload, input, tools),
            response.usage
          ),
          () => ({
            request: buildFullRequestDiagnostics(messages, options, responseUrl, payload),
            result: { response }
          })
        );
      }
      reportResponsesOutput(response, progress);
    } catch (error) {
      if (diagnosticsContext) {
        await this.recordRequestDiagnostics(
          diagnosticsContext.generation,
          diagnosticsLevel,
          input,
          options.modelOptions,
          () => buildRequestDiagnosticsMetadata(
            diagnosticsContext,
            model.id,
            reasoningEffort,
            token.isCancellationRequested ? "canceled" : "failed",
            buildInputBreakdown(payload, input, tools)
          ),
          () => ({
            request: buildFullRequestDiagnostics(messages, options, responseUrl, payload),
            result: { error: describeDiagnosticError(error) }
          })
        );
      }
      throw error;
    }
  }

  async provideTokenCount(
    _model: CmsisDevLanguageModelInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const normalized = typeof text === "string" ? text : serializeMessageContent(text.content);
    return Math.max(1, Math.ceil(normalized.length / 4));
  }

  private async getModels(options: {
    forceRefresh: boolean;
    token?: vscode.CancellationToken;
  }): Promise<CmsisDevLanguageModelInformation[]> {
    const cached = this.modelCache;
    if (!options.forceRefresh && cached && Date.now() - cached.fetchedAt < 60_000) {
      return cached.models;
    }

    const baseUrl = getConfiguredLanguageModelProviderBaseUrl();
    const apiKey = await getLanguageModelProviderApiKey();
    if (!apiKey) {
      return [];
    }

    const models = await this.fetchRawModels(options.token);
    const filteredModels = this.filterModelsByPermissionState(models, baseUrl);

    this.modelCache = {
      fetchedAt: Date.now(),
      models: filteredModels
    };
    return filteredModels;
  }

  private async fetchRawModels(token?: vscode.CancellationToken): Promise<CmsisDevLanguageModelInformation[]> {
    const baseUrl = getConfiguredLanguageModelProviderBaseUrl();
    const apiKey = await getLanguageModelProviderApiKey();
    if (!apiKey) {
      return [];
    }

    const response = await fetchJson<OpenAiModelsResponse>(
      joinUrl(baseUrl, "models"),
      {
        headers: {
          Authorization: `Bearer ${apiKey}`
        }
      },
      token
    );

    return (response.data ?? [])
      .map((model) => toLanguageModelInformation(model))
      .filter((model): model is CmsisDevLanguageModelInformation => Boolean(model))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private filterModelsByPermissionState(
    models: readonly CmsisDevLanguageModelInformation[],
    baseUrl: string
  ): CmsisDevLanguageModelInformation[] {
    const accessState = this.readModelAccessState();
    if (!accessState || accessState.baseUrl !== baseUrl) {
      return models.filter((model) => DEFAULT_VISIBLE_MODEL_IDS.has(model.id));
    }

    const permittedIds = new Set(accessState.permittedModelIds);
    return models.filter((model) => permittedIds.has(model.id) || DEFAULT_VISIBLE_MODEL_IDS.has(model.id));
  }

  private readModelAccessState(): StoredModelAccessState | undefined {
    const value = this.globalState.get<StoredModelAccessState>(MODEL_ACCESS_CACHE_KEY);
    if (!value || typeof value !== "object") {
      return undefined;
    }

    return value;
  }

  private async probeModelAccess(model: CmsisDevLanguageModelInformation): Promise<void> {
    const baseUrl = getConfiguredLanguageModelProviderBaseUrl();
    const apiKey = await getLanguageModelProviderApiKey();
    if (!apiKey) {
      throw new Error("CMSIS-Dev language model provider API key is not configured.");
    }

    await fetchJson<OpenAiResponsesResponse>(joinUrl(baseUrl, "responses"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
      model: model.id,
      input: "ping"
      })
    });
  }

  private async recordRequestDiagnostics(
    generation: number,
    level: RequestDiagnosticsLevel,
    input: readonly { type?: unknown; role?: unknown; content?: unknown }[],
    modelOptions: Record<string, unknown> | undefined,
    createMetadata: () => Record<string, unknown>,
    createFullDetails: () => Record<string, unknown>
  ): Promise<void> {
    if (generation !== this.diagnosticsGeneration) {
      return;
    }
    const diagnostics = collectRequestDiagnostics(level, createMetadata, createFullDetails);
    if (!diagnostics) {
      return;
    }

    let diagnosticsFile: string | undefined;
    if (diagnostics.fullDetails) {
      try {
        const file = await this.persistFullRequestDiagnostics({
          schemaVersion: 1,
          ...diagnostics.metadata,
          ...diagnostics.fullDetails
        });
        diagnosticsFile = file.fsPath;
        if (generation !== this.diagnosticsGeneration) {
          try {
            await vscode.workspace.fs.delete(file, { useTrash: false });
          } catch {
            // Clear may already have removed the diagnostics directory.
          }
          return;
        }
      } catch (error) {
        this.usageOutput.warn(`Failed to store full request diagnostics: ${describeProviderError(error)}`);
      }
    }

    this.usageOutput.info(JSON.stringify({
      ...diagnostics.metadata,
      diagnosticsLevel: level,
      ...(diagnosticsFile ? { diagnosticsFile } : {})
    }));
    this.chatDiagnostics.addRequest(input, diagnostics.metadata, level, diagnosticsFile, { modelOptions });
    await this.persistChatDiagnosticsIndex();
    try {
      await this.trimStoredRequestDiagnostics();
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        this.usageOutput.warn(`Failed to trim request diagnostics: ${describeProviderError(error)}`);
      }
    } finally {
      if (diagnosticsFile) {
        this.pendingDiagnosticsFiles.delete(diagnosticsFile);
        if (!this.chatDiagnosticsDirectoryUri) {
          await this.trimStoredRequestDiagnostics().catch((error) => {
            if (!isFileNotFoundError(error)) {
              this.usageOutput.warn(`Failed to trim request diagnostics: ${describeProviderError(error)}`);
            }
          });
        }
      }
    }
  }

  private async persistChatDiagnosticsIndex(): Promise<void> {
    if (!this.chatDiagnosticsDirectoryUri || !this.chatDiagnosticsIndexUri) {
      return;
    }
    await this.enqueueChatDiagnosticsWrite(async () => {
      try {
        await vscode.workspace.fs.createDirectory(this.chatDiagnosticsDirectoryUri!);
        const temporaryUri = vscode.Uri.joinPath(this.chatDiagnosticsDirectoryUri!, `${CHAT_DIAGNOSTICS_INDEX}.tmp`);
        const content = new TextEncoder().encode(`${stringifyDiagnostics(this.chatDiagnostics.createSnapshot())}\n`);
        await vscode.workspace.fs.writeFile(temporaryUri, content);
        await vscode.workspace.fs.rename(temporaryUri, this.chatDiagnosticsIndexUri!, { overwrite: true });
      } catch (error) {
        this.usageOutput.warn(`Failed to persist chat diagnostics index: ${describeProviderError(error)}`);
      }
    });
  }

  private async enqueueChatDiagnosticsWrite(operation: () => Promise<void>): Promise<void> {
    const pending = this.chatDiagnosticsWrite.then(operation, operation);
    this.chatDiagnosticsWrite = pending.catch(() => undefined);
    await pending;
  }

  private async persistFullRequestDiagnostics(record: Record<string, unknown>): Promise<vscode.Uri> {
    await vscode.workspace.fs.createDirectory(this.requestDiagnosticsUri);
    const timestamp = String(record.startedAt ?? new Date().toISOString()).replace(/[:.]/g, "-");
    const requestId = String(record.requestId ?? this.requestSequence).padStart(6, "0");
    const file = vscode.Uri.joinPath(this.requestDiagnosticsUri, `${timestamp}-request-${requestId}.json`);
    this.pendingDiagnosticsFiles.add(file.fsPath);
    try {
      await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(`${stringifyDiagnostics(record)}\n`));
    } catch (error) {
      this.pendingDiagnosticsFiles.delete(file.fsPath);
      throw error;
    }
    return file;
  }

  private async trimStoredRequestDiagnostics(): Promise<void> {
    const entries = await vscode.workspace.fs.readDirectory(this.requestDiagnosticsUri);
    const files = entries
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith(".json"))
      .map(([name]) => name);
    const retained = new Set(this.chatDiagnostics.getConversations()
      .flatMap((conversation) => conversation.requests.map((request) => request.fullDiagnosticsPath))
      .filter((path): path is string => Boolean(path))
      .map((path) => vscode.Uri.file(path).fsPath));
    for (const path of this.pendingDiagnosticsFiles) {
      retained.add(path);
    }
    const retainedFiles = this.chatDiagnosticsDirectoryUri
      ? new Set(files.filter((name) => retained.has(vscode.Uri.joinPath(this.requestDiagnosticsUri, name).fsPath)))
      : undefined;
    const eligibleFiles = retainedFiles
      ? files
      : files.filter((name) => !this.pendingDiagnosticsFiles.has(vscode.Uri.joinPath(this.requestDiagnosticsUri, name).fsPath));
    const excess = selectStoredRequestDiagnosticsToDelete(eligibleFiles, getConfiguredMaxDiagnosticsRequests(), retainedFiles);
    await Promise.all(excess.map((name) => vscode.workspace.fs.delete(vscode.Uri.joinPath(this.requestDiagnosticsUri, name))));
  }
}

export function registerCmsisDevLanguageModelProvider(
  context: vscode.ExtensionContext
): CmsisDevLanguageModelProvider {
  const provider = new CmsisDevLanguageModelProvider(context);
  context.subscriptions.push(
    provider,
    vscode.lm.registerLanguageModelChatProvider(CMSIS_DEV_LANGUAGE_MODEL_VENDOR, provider)
  );
  return provider;
}

export async function manageCmsisDevLanguageModelProvider(
  provider: CmsisDevLanguageModelProvider
): Promise<void> {
  const action = await vscode.window.showQuickPick(
    [
      {
        label: "Configure Proxy URL",
        detail: "Set the OpenAI-compatible base URL used for model discovery and chat requests.",
        value: "baseUrl"
      },
      {
        label: "Set API Key",
        detail: "Store the provider API key in VS Code SecretStorage.",
        value: "apiKey"
      },
      {
        label: "Clear API Key",
        detail: "Remove the stored provider API key from SecretStorage.",
        value: "clearApiKey"
      },
      {
        label: "Refresh Models",
        detail: "Fetch the current model catalog from the configured provider.",
        value: "refresh"
      }
    ],
    {
      title: "Manage CMSIS-Dev Language Model Provider",
      placeHolder: "Choose a provider management action"
    }
  );

  if (!action) {
    return;
  }

  switch (action.value) {
    case "baseUrl":
      await configureLanguageModelProviderBaseUrl();
      await provider.clearModelAccessCache();
      break;
    case "apiKey":
      await promptForLanguageModelProviderApiKey();
      await provider.clearModelAccessCache();
      break;
    case "clearApiKey":
      await clearLanguageModelProviderApiKey();
      await provider.clearModelAccessCache();
      vscode.window.showInformationMessage("CMSIS-Dev language model provider API key removed from SecretStorage.");
      break;
    case "refresh":
      await refreshCmsisDevLanguageModelProvider(provider);
      break;
    default:
      break;
  }
}

export async function refreshCmsisDevLanguageModelProvider(
  provider: CmsisDevLanguageModelProvider
): Promise<void> {
  try {
    const state = await provider.refreshPermittedModels();
    if (state.permittedModelIds.length === 0) {
      const showDetails = state.deniedModels.length > 0 ? "Show Hidden Models" : undefined;
      const selection = await vscode.window.showWarningMessage(
        "CMSIS-Dev language model provider did not find any permitted models for the Responses API. Check the proxy URL, API key, and model permissions.",
        ...(showDetails ? [showDetails] : [])
      );
      if (selection === "Show Hidden Models") {
        await openLanguageModelValidationReport(state);
      }
      return;
    }

    const deniedCount = state.deniedModels.length;
    const summary = `CMSIS-Dev language model provider exposed ${state.permittedModelIds.length} permitted model${
      state.permittedModelIds.length === 1 ? "" : "s"
    }${deniedCount > 0 ? ` and hid ${deniedCount} unavailable model${deniedCount === 1 ? "" : "s"}` : ""}.`;
    const showDetails = deniedCount > 0 ? "Show Hidden Models" : undefined;
    const selection = await vscode.window.showInformationMessage(summary, ...(showDetails ? [showDetails] : []));

    if (selection === "Show Hidden Models") {
      await openLanguageModelValidationReport(state);
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to refresh CMSIS-Dev language models: ${describeProviderError(error)}`);
  }
}

async function openLanguageModelValidationReport(state: StoredModelAccessState): Promise<void> {
  const lines = [
    "# CMSIS-Dev Language Model Provider Validation",
    "",
    `Base URL: ${state.baseUrl}`,
    `Validated: ${new Date(state.fetchedAt).toISOString()}`,
    "",
    "## Exposed Models",
    "",
    ...(state.permittedModelIds.length > 0 ? state.permittedModelIds.map((id) => `- ${id}`) : ["- None"])
  ];

  if (state.deniedModels.length > 0) {
    lines.push("", "## Hidden Models", "");
    for (const deniedModel of state.deniedModels) {
      lines.push(`- ${deniedModel.id}: ${deniedModel.reason}`);
    }
  }

  const document = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: `${lines.join("\n")}\n`
  });
  await vscode.window.showTextDocument(document, { preview: false });
}

export function getConfiguredLanguageModelProviderBaseUrl(): string {
  const value = vscode.workspace.getConfiguration("cmsisDev").get<string>("languageModelProvider.baseUrl", "").trim();
  return (value.length > 0 ? value : DEFAULT_PROXY_BASE_URL).replace(/\/+$/, "");
}

function getConfiguredDefaultMaxInputTokens(): number {
  const value = vscode.workspace.getConfiguration("cmsisDev").get<number>(
    "languageModelProvider.defaultMaxInputTokens",
    DEFAULT_MAX_INPUT_TOKENS
  );
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_INPUT_TOKENS;
}

function getConfiguredDefaultMaxOutputTokens(): number {
  const value = vscode.workspace.getConfiguration("cmsisDev").get<number>(
    "languageModelProvider.defaultMaxOutputTokens",
    DEFAULT_MAX_OUTPUT_TOKENS
  );
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_OUTPUT_TOKENS;
}

function getConfiguredRequestDiagnosticsLevel(): RequestDiagnosticsLevel {
  const value = vscode.workspace
    .getConfiguration("cmsisDev")
    .get<RequestDiagnosticsLevel>("languageModelProvider.requestDiagnostics", "metadata");
  return value === "off" || value === "full" ? value : "metadata";
}

function getConfiguredMaxDiagnosticsRequests(): number {
  return getConfiguredDiagnosticsLimit("maxDiagnosticsRequests", DEFAULT_MAX_DIAGNOSTICS_REQUESTS);
}

function getConfiguredMaxDiagnosticsSessions(): number {
  return getConfiguredDiagnosticsLimit("maxDiagnosticsSessions", DEFAULT_MAX_DIAGNOSTICS_SESSIONS);
}

function getConfiguredDiagnosticsLimit(setting: string, fallback: number): number {
  const value = vscode.workspace.getConfiguration("cmsisDev.languageModelProvider").get<number>(setting, fallback);
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function buildRequestDiagnosticsMetadata(
  context: { requestId: number; startedAt: number },
  model: string,
  reasoningEffort: string | undefined,
  status: "completed" | "canceled" | "failed",
  inputBreakdown: Record<string, unknown>,
  usage?: OpenAiResponsesResponse["usage"]
): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    requestId: context.requestId,
    model,
    reasoningEffort,
    startedAt: new Date(context.startedAt).toISOString(),
    durationMs: Date.now() - context.startedAt,
    status,
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    totalTokens: usage?.total_tokens,
    cachedTokens: usage?.input_tokens_details?.cached_tokens,
    reasoningTokens: usage?.output_tokens_details?.reasoning_tokens,
    authoritative: Boolean(usage),
    inputBreakdown
  };
}

async function configureLanguageModelProviderBaseUrl(): Promise<void> {
  const current = getConfiguredLanguageModelProviderBaseUrl();
  const nextValue = await vscode.window.showInputBox({
    title: "CMSIS-Dev Provider Base URL",
    prompt: "Enter the OpenAI-compatible v1 base URL for model discovery and chat completions.",
    value: current,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return "Base URL cannot be empty.";
      }

      try {
        const parsed = new URL(trimmed);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? null : "Base URL must be HTTP or HTTPS.";
      } catch {
        return "Enter a valid absolute URL.";
      }
    }
  });

  if (!nextValue) {
    return;
  }

  await vscode.workspace
    .getConfiguration("cmsisDev")
    .update("languageModelProvider.baseUrl", nextValue.trim().replace(/\/+$/, ""), getPreferredSettingsTarget());
  vscode.window.showInformationMessage("CMSIS-Dev language model provider base URL updated.");
}

async function promptForLanguageModelProviderApiKey(): Promise<void> {
  const token = await vscode.window.showInputBox({
    title: "CMSIS-Dev Provider API Key",
    prompt: "Enter the API key used for the CMSIS-Dev language model provider.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim().length > 0 ? null : "API key cannot be empty.")
  });

  if (!token) {
    return;
  }

  await setLanguageModelProviderApiKey(token);
  vscode.window.showInformationMessage("CMSIS-Dev language model provider API key saved in SecretStorage.");
}

async function fetchJson<T>(url: string, init: RequestInit, token?: vscode.CancellationToken): Promise<T> {
  const controller = new AbortController();
  const disposable = token?.onCancellationRequested(() => controller.abort());

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });

    const payload = (await response.json().catch(() => undefined)) as T | undefined;
    if (!response.ok) {
      const message = readErrorMessage(payload) || response.statusText || `HTTP ${response.status}`;
      throw new Error(message);
    }

    if (payload === undefined) {
      throw new Error("Provider returned an empty response body.");
    }

    return payload;
  } finally {
    disposable?.dispose();
  }
}

function joinUrl(baseUrl: string, pathSegment: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${pathSegment.replace(/^\/+/, "")}`;
}

function resolveWorkspaceChatDiagnosticsDirectoryUri(): vscode.Uri | undefined {
  const workspaceFolder = vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === "file");
  return workspaceFolder
    ? vscode.Uri.joinPath(workspaceFolder.uri, ...CHAT_DIAGNOSTICS_DIRECTORY.split("/"))
    : undefined;
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === "FileNotFound";
}

function toLanguageModelInformation(model: OpenAiModelRecord): CmsisDevLanguageModelInformation | undefined {
  const id = model.id?.trim();
  if (!id) {
    return undefined;
  }

  const dateMatch = id.match(/^(.*)-(\d{4}-\d{2}-\d{2})$/);
  const family = dateMatch?.[1] ?? id;
  const version = dateMatch?.[2] ?? "default";

  return {
    id,
    name: id,
    family,
    version,
    maxInputTokens: readPositiveInteger(model.context_window) ?? readPositiveInteger(model.max_context_tokens) ?? getConfiguredDefaultMaxInputTokens(),
    maxOutputTokens: readPositiveInteger(model.max_output_tokens) ?? getConfiguredDefaultMaxOutputTokens(),
    detail: model.owned_by,
    tooltip: model.owned_by ? `${id} (${model.owned_by})` : id,
    capabilities: {
      toolCalling: true,
      imageInput: false
    }
  };
}

function toOpenAiResponsesInput(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAiResponsesInputItem[] {
  const result: OpenAiResponsesInputItem[] = [];

  for (const message of messages) {
    const text = serializeMessageContent(message.content).trim();
    const toolCalls = message.content.filter(
      (part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart
    );
    const toolResults = message.content.filter(
      (part): part is vscode.LanguageModelToolResultPart => part instanceof vscode.LanguageModelToolResultPart
    );

    if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
      if (text.length > 0) {
        result.push({
          type: "message",
          role: "assistant",
          content: text
        });
      }

      for (const toolCall of toolCalls) {
        result.push({
          type: "function_call",
          call_id: toolCall.callId,
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.input ?? {})
        });
      }
      continue;
    }

    if (text.length > 0) {
      result.push({
        type: "message",
        role: "user",
        content: text
      });
    }

    for (const toolResult of toolResults) {
      result.push({
        type: "function_call_output",
        call_id: toolResult.callId,
        output: serializeToolResult(toolResult.content)
      });
    }
  }

  return result;
}

function toOpenAiResponsesTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined
): OpenAiResponsesTool[] {
  return (tools ?? []).map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema ?? {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  }));
}

function buildFullRequestDiagnostics(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  url: string,
  payload: Record<string, unknown>
): Record<string, unknown> {
  return {
    incoming: {
      messages: messages.map((message) => ({
        role: message.role === vscode.LanguageModelChatMessageRole.Assistant ? "assistant" : "user",
        name: message.name,
        content: message.content
      })),
      toolMode: options.toolMode === vscode.LanguageModelChatToolMode.Required ? "required" : "auto",
      tools: options.tools ?? [],
      modelOptions: options.modelOptions ?? {}
    },
    outgoing: {
      url,
      payload
    }
  };
}

function describeDiagnosticError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  return {
    value: error
  };
}

function reportResponsesOutput(
  response: OpenAiResponsesResponse,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>
): void {
  for (const item of response.output ?? []) {
    if (item.type === "message") {
      const text = normalizeResponsesMessageContent(item.content);
      if (text) {
        progress.report(new vscode.LanguageModelTextPart(text));
      }
      continue;
    }

    if (item.type === "function_call") {
      const callId = item.call_id?.trim();
      const name = item.name?.trim();
      if (!callId || !name) {
        continue;
      }

      progress.report(new vscode.LanguageModelToolCallPart(callId, name, parseJsonObject(item.arguments) ?? {}));
      continue;
    }
  }
}

function normalizeResponsesMessageContent(
  content:
    | Array<{
        type?: string;
        text?: string;
        refusal?: string;
      }>
    | undefined
): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (part?.type === "output_text") {
        return part.text ?? "";
      }

      if (part?.type === "refusal") {
        return part.refusal ?? "";
      }

      return "";
    })
    .join("")
    .trim();
}

function parseJsonObject(value: string | undefined): object | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as object) : undefined;
  } catch {
    return undefined;
  }
}

function serializeMessageContent(content: readonly (vscode.LanguageModelInputPart | unknown)[]): string {
  return content
    .map((part) => {
      if (part instanceof vscode.LanguageModelTextPart) {
        return part.value;
      }
      if (part instanceof vscode.LanguageModelDataPart) {
        return "[binary data omitted]";
      }
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function serializeToolResult(content: readonly (vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart | vscode.LanguageModelDataPart | unknown)[]): string {
  const serialized = content
    .map((part) => {
      if (part instanceof vscode.LanguageModelTextPart) {
        return part.value;
      }
      if (part instanceof vscode.LanguageModelPromptTsxPart) {
        return JSON.stringify(part.value);
      }
      if (part instanceof vscode.LanguageModelDataPart) {
        return "[binary data omitted]";
      }
      return typeof part === "string" ? part : JSON.stringify(part);
    })
    .filter((part) => typeof part === "string" && part.length > 0);

  return serialized.length > 0 ? serialized.join("\n\n") : "(empty tool result)";
}

function readErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const error = (payload as { error?: { message?: unknown } }).error;
  return error && typeof error.message === "string" ? error.message : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function describeProviderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getPreferredSettingsTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFile || (vscode.workspace.workspaceFolders?.length ?? 0) > 0
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}
