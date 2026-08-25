import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  buildChatTraceFullDetailSections,
  ChatTraceDetailSection,
  extractChatTraceDetail,
  isChatTraceDetailSection
} from "./chatDiagnosticsDetails";
import { buildChatConversationTrace, ChatConversationTrace } from "./chatDiagnosticsTrace";
import { ChatConversationDiagnostic } from "./requestDiagnostics";

const openTraces = new Map<number, {
  panel: vscode.WebviewPanel;
  trace: string;
  conversation: ChatConversationDiagnostic;
}>();

export function openChatDiagnosticsTrace(conversation: ChatConversationDiagnostic): void {
  const trace = buildChatConversationTrace(conversation);
  const serializedTrace = JSON.stringify(trace);
  const existing = openTraces.get(conversation.id);
  if (existing) {
    existing.conversation = conversation;
    if (existing.trace !== serializedTrace) {
      existing.panel.webview.html = renderTraceHtml(existing.panel.webview, trace);
      existing.trace = serializedTrace;
    }
    existing.panel.title = `${conversation.topic ?? conversation.label} Trace`;
    existing.panel.reveal();
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    "cmsisDev.chatDiagnosticsTrace",
    `${conversation.topic ?? conversation.label} Trace`,
    vscode.ViewColumn.Active,
    { enableScripts: true }
  );
  const openedTrace = { panel, trace: serializedTrace, conversation };
  openTraces.set(conversation.id, openedTrace);
  panel.webview.html = renderTraceHtml(panel.webview, trace);

  const messageSubscription = panel.webview.onDidReceiveMessage(async (message: unknown) => {
    const panelMessage = readTracePanelMessage(message);
    if (!panelMessage) {
      return;
    }
    const diagnostic = openedTrace.conversation.requests.find((request) => request.id === panelMessage.requestId);
    if (!diagnostic) {
      return;
    }
    if (panelMessage.command === "openDiagnostic") {
      await vscode.commands.executeCommand("cmsisDev.openChatDiagnostic", diagnostic);
      return;
    }

    let content: unknown = {
      unavailable: "Full content is available only when request diagnostics are set to full."
    };
    if (diagnostic.fullDiagnosticsPath) {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(diagnostic.fullDiagnosticsPath));
        const storedDiagnostic = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
        const detail = extractChatTraceDetail(storedDiagnostic, panelMessage.section);
        content = panelMessage.section === "full"
          ? buildChatTraceFullDetailSections(detail.content)
          : detail.content;
      } catch (error) {
        content = {
          unavailable: error instanceof Error ? error.message : String(error)
        };
      }
    }
    await panel.webview.postMessage({
      command: "diagnosticDetails",
      requestId: diagnostic.id,
      section: panelMessage.section,
      content
    });
  });
  panel.onDidDispose(() => {
    openTraces.delete(conversation.id);
    messageSubscription.dispose();
  });
}

export function clearOpenChatDiagnosticsTraces(): void {
  for (const { panel } of openTraces.values()) {
    panel.dispose();
  }
  openTraces.clear();
}

export function renderTraceHtml(webview: Pick<vscode.Webview, "cspSource">, trace: ChatConversationTrace): string {
  const nonce = randomBytes(16).toString("base64");
  const serializedTrace = JSON.stringify(trace)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Chat diagnostics trace</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --conversation-time: var(--vscode-charts-purple);
      --internal-time: var(--vscode-descriptionForeground);
      --messages: var(--vscode-charts-blue);
      --tools: var(--vscode-charts-yellow);
      --input: var(--vscode-charts-blue);
      --output: var(--vscode-charts-green);
      --cached: var(--vscode-charts-yellow);
      --reasoning: var(--vscode-charts-orange);
      --danger: var(--vscode-charts-red);
      --rule: color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
      --muted-surface: color-mix(in srgb, var(--vscode-editor-foreground) 5%, transparent);
      --selected-surface: color-mix(in srgb, var(--vscode-focusBorder) 12%, transparent);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 28px clamp(18px, 4vw, 52px) 48px;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font: 13px/1.45 var(--vscode-font-family);
    }
    button { font: inherit; }
    .page { width: min(1240px, 100%); margin: 0 auto; }
    .eyebrow {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    h1 {
      margin: 5px 0 6px;
      font-size: clamp(22px, 3vw, 34px);
      line-height: 1.15;
      font-weight: 650;
      overflow-wrap: anywhere;
    }
    .subtitle { margin: 0; color: var(--vscode-descriptionForeground); }
    .summary {
      display: grid;
      grid-template-columns: repeat(5, minmax(100px, 1fr));
      margin: 24px 0 0;
      border-block: 1px solid var(--rule);
    }
    .metric { padding: 14px 14px 14px 0; min-width: 0; }
    .metric + .metric { padding-left: 14px; border-left: 1px solid var(--rule); }
    .metric-value { display: block; font-size: 18px; font-weight: 650; overflow-wrap: anywhere; }
    .metric-label { display: block; margin-top: 2px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .usage { margin-top: 24px; }
    .usage-scroll { overflow-x: auto; }
    .usage-table { width: 100%; min-width: 720px; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    .usage-table th, .usage-table td { padding: 8px 12px 8px 0; border-bottom: 1px solid var(--rule); text-align: right; vertical-align: top; }
    .usage-table th:first-child, .usage-table td:first-child { text-align: left; }
    .usage-table thead th { color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 500; }
    .usage-table tbody th { font-weight: 500; }
    .usage-table tbody tr:last-child { font-weight: 650; }
    .usage-table .partial { display: block; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 400; }
    .workspace {
      display: grid;
      grid-template-columns: minmax(460px, 1.45fr) minmax(290px, .75fr);
      gap: clamp(24px, 4vw, 52px);
      margin-top: 30px;
      align-items: start;
    }
    h2 { margin: 0 0 4px; font-size: 15px; font-weight: 650; }
    .section-note { margin: 0 0 17px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .timeline-head {
      display: grid;
      grid-template-columns: minmax(145px, .65fr) minmax(180px, 1.05fr) minmax(180px, 1fr);
      gap: 14px;
      padding: 0 10px 7px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      border-bottom: 1px solid var(--rule);
    }
    .request-row {
      width: 100%;
      display: grid;
      grid-template-columns: minmax(145px, .65fr) minmax(180px, 1.05fr) minmax(180px, 1fr);
      gap: 14px;
      align-items: center;
      padding: 11px 10px;
      border: 0;
      border-bottom: 1px solid var(--rule);
      color: inherit;
      background: transparent;
      text-align: left;
      cursor: pointer;
    }
    .request-row:hover { background: var(--muted-surface); }
    .request-row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .request-row.selected { background: var(--selected-surface); }
    .request-primary { min-width: 0; }
    .request-name { display: flex; align-items: center; gap: 7px; font-weight: 600; }
    .status-dot { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: var(--vscode-testing-iconPassed); }
    .status-dot.failed { background: var(--danger); }
    .status-dot.canceled { background: var(--vscode-descriptionForeground); }
    .request-meta { margin-top: 2px; color: var(--vscode-descriptionForeground); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .track {
      position: relative;
      height: 24px;
      overflow: hidden;
      border-inline: 1px solid var(--rule);
      background: repeating-linear-gradient(90deg, transparent 0, transparent calc(25% - 1px), var(--rule) 25%);
    }
    .bar {
      position: absolute;
      top: 5px;
      height: 14px;
      min-width: 4px;
      border-radius: 2px;
      background: var(--conversation-time);
    }
    .bar.background { background: var(--internal-time); opacity: .72; }
    .token-scale-head { display: grid; grid-template-columns: 1fr 18px 1fr; gap: 7px; }
    .token-scale-head span:first-child { text-align: right; }
    .token-profile { display: grid; grid-template-columns: 1fr 18px 1fr; gap: 7px; align-items: center; min-width: 0; }
    .token-axis { width: 1px; height: 28px; justify-self: center; background: var(--rule); }
    .token-lane { position: relative; height: 28px; min-width: 0; }
    .token-bar { position: absolute; top: 5px; height: 18px; min-width: 3px; border-radius: 2px; }
    .token-bar.input { right: 0; background: color-mix(in srgb, var(--input) 66%, transparent); }
    .token-bar.output { left: 0; background: color-mix(in srgb, var(--output) 78%, transparent); }
    .token-reasoning {
      position: absolute;
      inset: 0 auto 0 0;
      border-right: 1px solid var(--reasoning);
      border-radius: 2px 0 0 2px;
      background: repeating-linear-gradient(45deg, color-mix(in srgb, var(--reasoning) 85%, transparent) 0 3px, transparent 3px 6px);
    }
    .token-cache {
      position: absolute;
      inset: 0 0 0 auto;
      border-left: 1px solid color-mix(in srgb, var(--cached) 75%, var(--vscode-editor-background));
      border-radius: 0 2px 2px 0;
      background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--cached) 72%, transparent) 0 3px, transparent 3px 6px);
    }
    .token-value {
      position: absolute;
      top: 50%;
      z-index: 1;
      transform: translateY(-50%);
      color: var(--vscode-editor-foreground);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      text-shadow: 0 1px var(--vscode-editor-background), 0 -1px var(--vscode-editor-background), 1px 0 var(--vscode-editor-background), -1px 0 var(--vscode-editor-background);
    }
    .token-lane.input .token-value { right: 6px; }
    .token-lane.output .token-value { left: 6px; }
    .token-legend { display: flex; flex-wrap: wrap; gap: 7px 16px; margin: 10px 10px 0; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .time-legend { margin-top: 14px; }
    .token-legend-item { display: inline-flex; gap: 6px; align-items: center; }
    .legend-heading { font-weight: 600; color: var(--vscode-editor-foreground); }
    .time-swatch { width: 18px; height: 8px; border-radius: 1px; background: var(--conversation-time); }
    .time-swatch.internal { background: var(--internal-time); opacity: .72; }
    .token-legend-swatch { width: 18px; height: 8px; border-radius: 1px; background: var(--input); }
    .token-legend-swatch.output { background: var(--output); }
    .token-legend-swatch.cached { background: repeating-linear-gradient(135deg, var(--cached) 0 3px, transparent 3px 6px); }
    .token-legend-swatch.reasoning { background: repeating-linear-gradient(45deg, var(--reasoning) 0 3px, transparent 3px 6px); }
    .inspector { position: sticky; top: 24px; min-width: 0; }
    .inspector-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
    .kind { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .composition-bar { display: flex; height: 18px; margin: 17px 0 12px; overflow: hidden; border-radius: 2px; background: var(--muted-surface); }
    .segment { min-width: 0; height: 100%; }
    .segment.messages { background: var(--messages); }
    .segment.tools { background: var(--tools); }
    .legend { display: grid; min-width: 0; }
    .composition-detail { min-width: 0; border-bottom: 1px solid var(--rule); }
    .composition-detail:first-child { border-top: 1px solid var(--rule); }
    .legend-row { display: grid; grid-template-columns: 10px minmax(100px, 1fr) auto; gap: 8px; align-items: center; padding: 9px 2px; cursor: pointer; }
    .legend-row:hover { background: var(--muted-surface); }
    .legend-row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .legend-row::marker { content: ""; }
    .legend-label::after { content: "›"; display: inline-block; margin-left: 7px; color: var(--vscode-descriptionForeground); transform-origin: center; }
    .composition-detail[open] .legend-label::after { transform: rotate(90deg); }
    .swatch { width: 10px; height: 10px; border-radius: 2px; }
    .swatch.messages { background: var(--messages); }
    .swatch.tools { background: var(--tools); }
    .legend-value { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
    .detail-content { min-width: 0; margin: 0 2px 11px 20px; }
    .detail-note { margin: 0; color: var(--vscode-descriptionForeground); }
    .detail-json {
      max-height: 340px;
      max-width: 100%;
      margin: 0;
      padding: 10px;
      overflow: auto;
      border: 1px solid var(--rule);
      border-radius: 2px;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-textCodeBlock-background);
      font: 11px/1.45 var(--vscode-editor-font-family);
      white-space: pre;
      tab-size: 2;
    }
    .details { display: grid; grid-template-columns: 1fr auto; gap: 8px 18px; margin: 22px 0; padding-top: 17px; border-top: 1px solid var(--rule); }
    .details dt { color: var(--vscode-descriptionForeground); }
    .details dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
    .open-button {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 30px;
      padding: 5px 12px;
      border: 1px solid transparent;
      border-radius: 2px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer;
    }
    .open-button:hover { background: var(--vscode-button-hoverBackground); }
    .open-button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .open-icon { width: 12px; height: 14px; border: 1px solid currentColor; border-radius: 1px; position: relative; }
    .open-icon::after { content: ""; position: absolute; inset: 3px 2px auto; height: 1px; background: currentColor; box-shadow: 0 3px currentColor, 0 6px currentColor; }
    .full-diagnostic { margin-top: 44px; padding-top: 24px; border-top: 1px solid var(--rule); }
    .full-diagnostic-head { display: flex; justify-content: space-between; gap: 24px; align-items: end; margin-bottom: 20px; }
    .full-diagnostic-title { margin: 3px 0 3px; font-size: 20px; overflow-wrap: anywhere; }
    .full-diagnostic-meta { margin: 0; color: var(--vscode-descriptionForeground); }
    .full-sections { display: grid; }
    .full-section { min-width: 0; border-bottom: 1px solid var(--rule); }
    .full-section-summary { padding: 12px 2px; cursor: pointer; }
    .full-section-summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .full-section-title { font-size: 14px; font-weight: 650; }
    .full-section-description { display: block; margin: 3px 0 0 17px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .full-section .full-json { margin-bottom: 12px; }
    .full-json {
      max-height: 560px;
      width: 100%;
      margin: 0;
      padding: 13px;
      overflow: auto;
      border: 1px solid var(--rule);
      border-radius: 2px;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-textCodeBlock-background);
      font: 12px/1.5 var(--vscode-editor-font-family);
      white-space: pre;
      tab-size: 2;
    }
    .full-loading { padding: 24px 0; color: var(--vscode-descriptionForeground); }
    .empty { padding: 24px 0; color: var(--vscode-descriptionForeground); }
    @media (max-width: 860px) {
      body { padding-inline: 18px; }
      .summary { grid-template-columns: repeat(3, 1fr); }
      .metric:nth-child(4) { border-left: 0; }
      .metric:nth-child(n + 4) { border-top: 1px solid var(--rule); }
      .workspace { grid-template-columns: 1fr; }
      .inspector { position: static; }
      .full-diagnostic-head { align-items: start; flex-direction: column; }
    }
    @media (max-width: 590px) {
      .summary { grid-template-columns: repeat(2, 1fr); }
      .metric:nth-child(3), .metric:nth-child(5) { border-left: 0; }
      .metric:nth-child(3) { border-top: 1px solid var(--rule); }
      .metric:nth-child(4) { border-left: 1px solid var(--rule); }
      .timeline-head { display: none; }
      .request-row { grid-template-columns: minmax(120px, .8fr) minmax(130px, 1.2fr); }
      .request-row > .token-profile { grid-column: 1 / -1; }
      .token-value { font-size: 9px; }
    }
  </style>
</head>
<body>
  <main class="page">
    <header>
      <div class="eyebrow" id="trace-kind"></div>
      <h1 id="trace-title"></h1>
      <p class="subtitle" id="trace-subtitle"></p>
    </header>
    <section class="summary" id="summary" aria-label="Trace summary"></section>
    <section class="usage" aria-labelledby="usage-title">
      <h2 id="usage-title">Retained token usage</h2>
      <p class="section-note">Reported token totals across retained requests. Cached tokens are included in input; reasoning tokens are included in output.</p>
      <div class="usage-scroll">
        <table class="usage-table">
          <thead><tr><th scope="col">Purpose</th><th scope="col">Requests</th><th scope="col">Input</th><th scope="col">Cached within input</th><th scope="col">Output</th><th scope="col">Reasoning within output (when reported)</th></tr></thead>
          <tbody id="usage-rows"></tbody>
        </table>
      </div>
    </section>
    <div class="workspace">
      <section aria-labelledby="timeline-title">
        <h2 id="timeline-title">Request waterfall</h2>
        <p class="section-note" id="timeline-note"></p>
        <div class="timeline-head" aria-hidden="true">
          <span>Purpose</span>
          <span>Active time</span>
          <span class="token-scale-head"><span>Input</span><span></span><span>Output</span></span>
        </div>
        <div id="timeline"></div>
        <div class="token-legend time-legend" aria-label="Active time legend">
          <span class="legend-heading">Active time</span>
          <span class="token-legend-item"><span class="time-swatch"></span>Chat request</span>
          <span class="token-legend-item"><span class="time-swatch internal"></span>Internal request</span>
        </div>
        <div class="token-legend" aria-label="Token usage legend">
          <span class="legend-heading">Tokens</span>
          <span class="token-legend-item"><span class="token-legend-swatch"></span>Input</span>
          <span class="token-legend-item"><span class="token-legend-swatch cached"></span>Cached within input</span>
          <span class="token-legend-item"><span class="token-legend-swatch output"></span>Output</span>
          <span class="token-legend-item"><span class="token-legend-swatch reasoning"></span>Reasoning within output (when reported)</span>
        </div>
      </section>
      <aside class="inspector" aria-labelledby="inspector-title">
        <div class="inspector-head"><h2 id="inspector-title">Request composition</h2><span class="kind" id="request-kind"></span></div>
        <p class="section-note">Character share of the outgoing payload. Expand a category to inspect retained full details.</p>
        <div id="inspector"></div>
      </aside>
    </div>
    <section class="full-diagnostic" aria-labelledby="full-diagnostic-title">
      <div class="full-diagnostic-head">
        <div>
          <div class="eyebrow">Selected request</div>
          <h2 class="full-diagnostic-title" id="full-diagnostic-title"></h2>
          <p class="full-diagnostic-meta" id="full-diagnostic-meta"></p>
        </div>
      </div>
      <div id="full-diagnostic-content"></div>
    </section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const trace = ${serializedTrace};
    let selectedId = trace.requests.length > 0 ? trace.requests[trace.requests.length - 1].id : undefined;
    const detailCache = new Map();
    const pendingDetails = new Set();
    const peakInputTokens = Math.max(0, ...trace.requests.map(request => request.inputTokens).filter(value => value !== undefined));
    const peakOutputTokens = Math.max(0, ...trace.requests.map(request => request.outputTokens).filter(value => value !== undefined));

    const formatNumber = value => value === undefined ? "Unavailable" : new Intl.NumberFormat().format(value);
    const formatDuration = value => {
      if (value === undefined) return "Unavailable";
      if (value < 1000) return Math.round(value) + " ms";
      return (value / 1000).toFixed(value < 10000 ? 1 : 0) + " s";
    };
    const formatCharacters = value => value >= 1000 ? (value / 1000).toFixed(1) + "k chars" : value + " chars";
    const create = (tag, className, text) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    };

    document.getElementById("trace-kind").textContent = (trace.topic ? trace.label + " · " : "") + (trace.kind === "background" ? "Internal requests" : "Chat session trace");
    document.getElementById("trace-title").textContent = trace.topic || trace.label;
    document.getElementById("trace-subtitle").textContent = trace.kind === "background"
      ? "Internal provider requests without a correlated chat session."
      : "Provider requests, complete prompts, callable definitions, and responses retained for this chat session.";

    const metrics = [
      [trace.summary.requestCount, "Requests"],
      [formatDuration(trace.summary.activeDurationMs), "Active time"],
      [formatNumber(trace.summary.peakInputTokens), "Peak input (one request)"],
      [formatNumber(trace.summary.maximumToolCount), "Maximum callables"],
      [trace.summary.fullDetailsCount + " / " + trace.summary.requestCount, "Full details"]
    ];
    const summary = document.getElementById("summary");
    metrics.forEach(([value, label]) => {
      const metric = create("div", "metric");
      metric.append(create("span", "metric-value", String(value)), create("span", "metric-label", label));
      summary.append(metric);
    });

    const usageRows = document.getElementById("usage-rows");
    const usageGroups = [
      ["Chat requests", trace.summary.tokenUsage.chat],
      ["Internal requests", trace.summary.tokenUsage.internal],
      ["All retained", trace.summary.tokenUsage.all]
    ];
    const appendUsageCell = (row, value, missingCount) => {
      const cell = create("td", "", formatNumber(value) + (value !== undefined && missingCount > 0 ? "+" : ""));
      if (missingCount > 0) cell.append(create("span", "partial", missingCount + " missing"));
      row.append(cell);
    };
    usageGroups.forEach(([label, usage]) => {
      const row = create("tr");
      const heading = create("th", "", label);
      heading.scope = "row";
      row.append(heading, create("td", "", formatNumber(usage.requestCount)));
      appendUsageCell(row, usage.inputTokens, usage.inputMissingCount);
      appendUsageCell(row, usage.cachedTokens, usage.cachedMissingCount);
      appendUsageCell(row, usage.outputTokens, usage.outputMissingCount);
      appendUsageCell(row, usage.reasoningTokens, usage.reasoningMissingCount);
      usageRows.append(row);
    });

    document.getElementById("timeline-note").textContent = "Idle gaps are removed. Wall-clock elapsed: " + formatDuration(trace.summary.elapsedMs) + ". Token bars use separate input and output peaks.";

    function createTokenProfile(request) {
      const profile = create("div", "token-profile");
      profile.setAttribute("aria-label", "Token usage for request " + request.requestNumber);
      const inputLane = create("div", "token-lane input");
      if (request.inputTokens !== undefined) {
        const inputBar = create("div", "token-bar input");
        inputBar.style.width = (peakInputTokens > 0 ? (request.inputTokens / peakInputTokens) * 100 : 0) + "%";
        if (request.cachedTokens !== undefined && request.cachedTokens > 0 && request.inputTokens > 0) {
          const cached = Math.min(request.cachedTokens, request.inputTokens);
          const cache = create("div", "token-cache");
          cache.style.width = (cached / request.inputTokens) * 100 + "%";
          cache.title = formatNumber(cached) + " cached tokens · " + Math.round((cached / request.inputTokens) * 100) + "% of input";
          inputBar.append(cache);
        }
        inputBar.title = formatNumber(request.inputTokens) + " input tokens" + (request.cachedTokens === undefined ? "" : " · " + formatNumber(Math.min(request.cachedTokens, request.inputTokens)) + " cached");
        inputLane.append(inputBar, create("span", "token-value", formatNumber(request.inputTokens)));
      } else {
        inputLane.append(create("span", "token-value", "—"));
      }

      const outputLane = create("div", "token-lane output");
      if (request.outputTokens !== undefined) {
        const outputBar = create("div", "token-bar output");
        outputBar.style.width = (peakOutputTokens > 0 ? (request.outputTokens / peakOutputTokens) * 100 : 0) + "%";
        if (request.reasoningTokens !== undefined && request.reasoningTokens > 0 && request.outputTokens > 0) {
          const reasoning = Math.min(request.reasoningTokens, request.outputTokens);
          const reasoningBar = create("div", "token-reasoning");
          reasoningBar.style.width = (reasoning / request.outputTokens) * 100 + "%";
          reasoningBar.title = formatNumber(reasoning) + " reasoning tokens · " + Math.round((reasoning / request.outputTokens) * 100) + "% of output";
          outputBar.append(reasoningBar);
        }
        outputBar.title = formatNumber(request.outputTokens) + " output tokens · reasoning " + (request.reasoningTokens === undefined ? "unavailable" : formatNumber(request.reasoningTokens));
        outputLane.append(outputBar, create("span", "token-value", formatNumber(request.outputTokens)));
      } else {
        outputLane.append(create("span", "token-value", "—"));
      }
      profile.append(inputLane, create("span", "token-axis"), outputLane);
      return profile;
    }

    function renderTimeline() {
      const timeline = document.getElementById("timeline");
      timeline.replaceChildren();
      if (trace.requests.length === 0) {
        timeline.append(create("p", "empty", "No retained requests are available for this trace."));
        return;
      }
      trace.requests.forEach(request => {
        const row = create("button", "request-row" + (request.id === selectedId ? " selected" : ""));
        row.type = "button";
        row.setAttribute("aria-pressed", String(request.id === selectedId));
        row.setAttribute("aria-label", request.summary);
        row.addEventListener("click", () => {
          selectedId = request.id;
          renderTimeline();
          renderInspector();
          renderFullDiagnostic();
        });

        const primary = create("div", "request-primary");
        const name = create("div", "request-name");
        const status = create("span", "status-dot " + request.status);
        status.setAttribute("aria-hidden", "true");
        name.append(status, create("span", "", request.summary));
        primary.append(name, create("div", "request-meta", "Request " + request.requestNumber + " · " + request.model + (request.kind === "background" ? " · internal request" : "")));

        const track = create("div", "track");
        const bar = create("div", "bar " + request.kind);
        bar.style.left = request.offsetPercent + "%";
        bar.style.width = request.widthPercent + "%";
        bar.title = (request.kind === "background" ? "Internal request" : "Chat request") + " · active position +" + formatDuration(request.activeStartMs) + " · duration " + formatDuration(request.durationMs) + " · wall-clock start +" + formatDuration(request.relativeStartMs);
        track.append(bar);
        row.append(primary, track, createTokenProfile(request));
        timeline.append(row);
      });
    }

    function renderInspector() {
      const inspector = document.getElementById("inspector");
      inspector.replaceChildren();
      const request = trace.requests.find(candidate => candidate.id === selectedId);
      if (!request) {
        inspector.append(create("p", "empty", "Select a request to inspect its payload."));
        return;
      }
      document.getElementById("request-kind").textContent = request.kind === "background" ? "Internal request" : request.diagnosticsLevel;
      const bar = create("div", "composition-bar");
      bar.setAttribute("aria-label", "Request payload composition");
      request.composition.forEach(segment => {
        const element = create("div", "segment " + segment.key);
        element.style.width = segment.percent + "%";
        element.title = segment.label + ": " + Math.round(segment.percent) + "%";
        bar.append(element);
      });
      const legend = create("div", "legend");
      request.composition.forEach(segment => {
        const cacheKey = request.id + ":" + segment.key;
        const detail = create("details", "composition-detail");
        const row = create("summary", "legend-row");
        row.append(
          create("span", "swatch " + segment.key),
          create("span", "legend-label", segment.label),
          create("span", "legend-value", Math.round(segment.percent) + "% · " + formatCharacters(segment.characters))
        );
        const content = create("div", "detail-content");
        if (detailCache.has(cacheKey)) {
          const json = create("pre", "detail-json");
          json.textContent = JSON.stringify(detailCache.get(cacheKey), null, 2);
          content.append(json);
        } else {
          content.append(create("p", "detail-note", request.hasFullDetails ? "Expand to load retained content." : "Full content was not retained for this request."));
        }
        let loaded = detailCache.has(cacheKey);
        detail.addEventListener("toggle", () => {
          if (!detail.open || loaded) return;
          loaded = true;
          if (!request.hasFullDetails) return;
          content.replaceChildren(create("p", "detail-note", "Loading retained content…"));
          vscode.postMessage({ command: "loadDiagnosticDetails", requestId: request.id, section: segment.key });
        });
        detail.append(row, content);
        legend.append(detail);
      });
      const details = create("dl", "details");
      [
        ["Status", request.status],
        ["Duration", formatDuration(request.durationMs)],
        ["Input tokens", formatNumber(request.inputTokens)],
        ["Cached tokens", formatNumber(request.cachedTokens)],
        ["Output tokens", formatNumber(request.outputTokens)],
        ["Reasoning tokens", formatNumber(request.reasoningTokens)],
        ["Input items", formatNumber(request.inputItemCount)],
        ["Available callables", formatNumber(request.toolCount)]
      ].forEach(([label, value]) => details.append(create("dt", "", label), create("dd", "", String(value))));
      const open = create("button", "open-button");
      open.type = "button";
      open.append(create("span", "open-icon"), create("span", "", request.hasFullDetails ? "Open full diagnostic" : "Open metadata"));
      open.addEventListener("click", () => vscode.postMessage({ command: "openDiagnostic", requestId: request.id }));
      inspector.append(bar, legend, details, open);
    }

    function loadDetail(request, section) {
      const cacheKey = request.id + ":" + section;
      if (!request.hasFullDetails || detailCache.has(cacheKey) || pendingDetails.has(cacheKey)) return;
      pendingDetails.add(cacheKey);
      vscode.postMessage({ command: "loadDiagnosticDetails", requestId: request.id, section });
    }

    function renderFullDiagnostic() {
      const title = document.getElementById("full-diagnostic-title");
      const meta = document.getElementById("full-diagnostic-meta");
      const content = document.getElementById("full-diagnostic-content");
      content.replaceChildren();
      const request = trace.requests.find(candidate => candidate.id === selectedId);
      if (!request) {
        title.textContent = "No request selected";
        meta.textContent = "";
        content.append(create("p", "empty", "Select a request to inspect its complete diagnostic content."));
        return;
      }

      title.textContent = request.summary;
      meta.textContent = "Request " + request.requestNumber + " · " + request.model + " · " + request.status + (request.kind === "background" ? " · internal request" : " · chat session prompt");
      if (!request.hasFullDetails) {
        content.append(create("p", "empty", "Complete prompt, provider request, and response content was not retained for this metadata-only request."));
        return;
      }

      const cacheKey = request.id + ":full";
      const sections = detailCache.get(cacheKey);
      if (!Array.isArray(sections)) {
        content.append(create("p", "full-loading", "Loading complete request diagnostic…"));
        loadDetail(request, "full");
        return;
      }

      const sectionList = create("div", "full-sections");
      sections.forEach(section => {
        const detail = create("details", "full-section");
        const summary = create("summary", "full-section-summary");
        summary.append(
          create("span", "full-section-title", section.title),
          create("span", "full-section-description", section.description)
        );
        const json = create("pre", "full-json");
        json.textContent = JSON.stringify(section.content, null, 2);
        detail.append(summary, json);
        sectionList.append(detail);
      });
      content.append(sectionList);
    }

    renderTimeline();
    renderInspector();
    renderFullDiagnostic();

    window.addEventListener("message", event => {
      const message = event.data;
      if (!message || message.command !== "diagnosticDetails") return;
      const cacheKey = message.requestId + ":" + message.section;
      pendingDetails.delete(cacheKey);
      detailCache.set(cacheKey, message.content);
      if (message.requestId !== selectedId) return;
      if (message.section === "full") {
        renderFullDiagnostic();
        return;
      }
      const detail = [...document.querySelectorAll(".composition-detail")]
        .find(candidate => candidate.querySelector(".swatch")?.classList.contains(message.section));
      const content = detail?.querySelector(".detail-content");
      if (!content) return;
      const json = create("pre", "detail-json");
      json.textContent = JSON.stringify(message.content, null, 2);
      content.replaceChildren(json);
    });
  </script>
</body>
</html>`;
}

type TracePanelMessage =
  | { command: "openDiagnostic"; requestId: number }
  | { command: "loadDiagnosticDetails"; requestId: number; section: ChatTraceDetailSection };

function readTracePanelMessage(value: unknown): TracePanelMessage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const message = value as Record<string, unknown>;
  if (message.command === "openDiagnostic" && typeof message.requestId === "number") {
    return { command: "openDiagnostic", requestId: message.requestId };
  }
  if (message.command === "loadDiagnosticDetails" && typeof message.requestId === "number" &&
      isChatTraceDetailSection(message.section)) {
    return {
      command: "loadDiagnosticDetails",
      requestId: message.requestId,
      section: message.section
    };
  }
  return undefined;
}