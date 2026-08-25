export type ChatTraceDetailSection = "full" | "messages" | "tools";

export interface ChatTraceFullDetailSection {
  key: "metadata" | "incoming" | "outgoing" | "result";
  title: string;
  description: string;
  content: unknown;
}

export interface ChatTraceDetailResult {
  section: ChatTraceDetailSection;
  content: unknown;
}

export function extractChatTraceDetail(
  diagnostic: unknown,
  section: ChatTraceDetailSection
): ChatTraceDetailResult {
  const record = asRecord(diagnostic);
  if (section === "full") {
    return { section, content: diagnostic };
  }
  const request = asRecord(record?.request) ?? record;
  const outgoing = asRecord(request?.outgoing);
  const payload = asRecord(outgoing?.payload);
  if (!payload) {
    return {
      section,
      content: { unavailable: "The stored diagnostic does not contain an outgoing request payload." }
    };
  }

  if (section === "messages") {
    return { section, content: payload.input ?? [] };
  }
  return { section, content: payload.tools ?? [] };
}

export function buildChatTraceFullDetailSections(diagnostic: unknown): ChatTraceFullDetailSection[] {
  const record = asRecord(diagnostic);
  if (!record) {
    return [{
      key: "metadata",
      title: "Stored diagnostic",
      description: "Complete retained content for this request.",
      content: diagnostic
    }];
  }

  const request = asRecord(record.request);
  const metadata = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "request" && key !== "result"));
  return [
    {
      key: "metadata",
      title: "Request identity and measurements",
      description: "Request number, model, status, timing, token usage, and payload measurements.",
      content: metadata
    },
    {
      key: "incoming",
      title: "Prompt and chat session input",
      description: "Complete messages, callable declarations, callable mode, and model options received from VS Code.",
      content: request?.incoming ?? { unavailable: "No incoming request content was retained." }
    },
    {
      key: "outgoing",
      title: "Provider request",
      description: "Exact URL and payload sent to the language model provider.",
      content: request?.outgoing ?? { unavailable: "No outgoing provider request was retained." }
    },
    {
      key: "result",
      title: "Provider response or error",
      description: "Complete response returned by the provider, or the recorded request error.",
      content: record.result ?? { unavailable: "No provider result was retained." }
    }
  ];
}

export function isChatTraceDetailSection(value: unknown): value is ChatTraceDetailSection {
  return value === "full" || value === "messages" || value === "tools";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}