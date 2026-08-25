import * as vscode from "vscode";
import { ChatConversationDiagnostic, ChatDiagnosticsStore, ChatRequestDiagnostic } from "./requestDiagnostics";

export type ChatDiagnosticsTreeItem = ChatConversationItem | ChatRequestItem | ChatDiagnosticsPlaceholderItem;

export class ChatDiagnosticsProvider implements vscode.TreeDataProvider<ChatDiagnosticsTreeItem>, vscode.Disposable {
  private readonly changedEmitter = new vscode.EventEmitter<ChatDiagnosticsTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this.changedEmitter.event;
  private readonly storeSubscription: { dispose(): void };

  constructor(private readonly diagnostics: ChatDiagnosticsStore) {
    this.storeSubscription = diagnostics.onDidChange(() => this.refresh());
  }

  dispose(): void {
    this.storeSubscription.dispose();
    this.changedEmitter.dispose();
  }

  refresh(): void {
    this.changedEmitter.fire();
  }

  getTreeItem(element: ChatDiagnosticsTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ChatDiagnosticsTreeItem): vscode.ProviderResult<ChatDiagnosticsTreeItem[]> {
    if (element instanceof ChatConversationItem) {
      return element.conversation.requests.map((request) => new ChatRequestItem(request));
    }
    if (element) {
      return [];
    }

    const conversations = this.diagnostics.getConversations();
    return conversations.length > 0
      ? conversations.map((conversation) => new ChatConversationItem(conversation))
      : [new ChatDiagnosticsPlaceholderItem("No proxy chat diagnostics captured in this Extension Host.")];
  }
}

export class ChatConversationItem extends vscode.TreeItem {
  constructor(readonly conversation: ChatConversationDiagnostic) {
    super(conversation.topic ?? conversation.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${conversation.label} · ${conversation.requests.length} ${conversation.requests.length === 1 ? "request" : "requests"} · ${formatRelativeTime(conversation.latestRequestAt)}`;
    this.tooltip = [
      conversation.label,
      conversation.kind === "background"
        ? "Internal provider requests not associated with a traced chat session."
        : conversation.topic ? `Topic: ${conversation.topic}` : "Topic is shown only for full diagnostics.",
      `Requests: ${conversation.requests.length}`,
      `Last activity: ${new Date(conversation.latestRequestAt).toLocaleString()}`
    ].join("\n");
    this.iconPath = new vscode.ThemeIcon(conversation.kind === "background" ? "gear" : "comment-discussion");
    this.contextValue = "cmsisDev.chatConversation";
    this.command = {
      command: "cmsisDev.openChatDiagnosticsTrace",
      title: "Open Chat Session Trace",
      arguments: [conversation]
    };
  }
}

export class ChatRequestItem extends vscode.TreeItem {
  constructor(readonly diagnostic: ChatRequestDiagnostic) {
    const metadata = diagnostic.metadata;
    const status = readString(metadata.status, "completed");
    const model = readString(metadata.model, "Unknown model");
    const requestLabel = diagnostic.summary ?? (diagnostic.requestKind === "background" ? "Internal request" : "Chat session request");
    super(requestLabel, vscode.TreeItemCollapsibleState.None);
    this.description = `${model} · ${status}${diagnostic.requestKind === "background" ? " · internal request" : ""} · ${formatRequestDescription(metadata)}`;
    this.tooltip = formatRequestTooltip(diagnostic);
    this.iconPath = new vscode.ThemeIcon(status === "completed" ? "check" : status === "canceled" ? "circle-slash" : "error");
    this.contextValue = diagnostic.fullDiagnosticsPath
      ? "cmsisDev.chatDiagnostic.hasFullDetails"
      : "cmsisDev.chatDiagnostic";
    this.command = {
      command: "cmsisDev.openChatDiagnostic",
      title: "Open Chat Diagnostic",
      arguments: [diagnostic]
    };
  }
}

class ChatDiagnosticsPlaceholderItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("info");
  }
}

function formatRequestDescription(metadata: Record<string, unknown>): string {
  const duration = readNumber(metadata.durationMs);
  const inputTokens = readNumber(metadata.inputTokens);
  const outputTokens = readNumber(metadata.outputTokens);
  const tokenSummary = inputTokens === undefined && outputTokens === undefined
    ? "usage unavailable"
    : `${formatNumber(inputTokens)} in / ${formatNumber(outputTokens)} out`;
  return `${duration === undefined ? "duration unavailable" : `${formatDuration(duration)} · `}${tokenSummary}`;
}

function formatRequestTooltip(diagnostic: ChatRequestDiagnostic): string {
  const metadata = diagnostic.metadata;
  const breakdown = asRecord(metadata.inputBreakdown);
  return [
    `Request: ${readNumber(metadata.requestId) ?? diagnostic.id}`,
    `Kind: ${diagnostic.requestKind === "background" ? "Internal request" : "Chat session request"}`,
    `Status: ${readString(metadata.status, "unknown")}`,
    `Model: ${readString(metadata.model, "unknown")}`,
    `Started: ${readString(metadata.startedAt, "unknown")}`,
    `Duration: ${formatDuration(readNumber(metadata.durationMs) ?? 0)}`,
    `Input items: ${readNumber(breakdown?.inputItemCount) ?? 0}`,
    `Tools: ${readNumber(breakdown?.toolCount) ?? 0}`,
    diagnostic.fullDiagnosticsPath ? "Full diagnostics available." : "Metadata-only diagnostics."
  ].join("\n");
}

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : new Date(timestamp).toLocaleString();
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${milliseconds}ms` : `${(milliseconds / 1_000).toFixed(1)}s`;
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "?" : value.toLocaleString();
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}