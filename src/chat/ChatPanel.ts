import * as path from "path";
import * as vscode from "vscode";
import { getConfig, resolveBrandIconUri } from "../config";
import { AgentOrchestrator } from "../agent/orchestrator";
import { checkHealth } from "../ollama/client";

/**
 * Host for Blossom chat tabs in the editor area.
 * Each blossom.openChat click opens a new tab in the existing Blossom group
 * (same column), instead of focusing/replacing the current tab or splitting away.
 */
export class BlossomChatPanel {
  public static readonly viewType = "blossom.chatPanel";

  private static nextTab = 1;
  private readonly sessions = new Set<BlossomChatSession>();

  constructor(private readonly context: vscode.ExtensionContext) {
    const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("blossom.ui")) {
        for (const session of this.sessions) {
          session.applyBranding({ reloadHtml: false });
        }
      }
    });
    context.subscriptions.push(configListener);
  }

  /** Open a new Blossom chat tab (editor title button / command). */
  reveal(): void {
    this.openNewChat();
  }

  openNewChat(): void {
    const tabIndex = BlossomChatPanel.nextTab++;
    const column = this.pickColumn();
    const session = new BlossomChatSession(
      this.context,
      tabIndex,
      column,
      () => {
        this.sessions.delete(session);
      }
    );
    this.sessions.add(session);
  }

  /** Prefer the column of a visible Blossom tab so the new one stacks as a sibling tab. */
  private pickColumn(): vscode.ViewColumn {
    for (const session of this.sessions) {
      if (session.visible && session.viewColumn != null) {
        return session.viewColumn;
      }
    }
    for (const session of this.sessions) {
      if (session.viewColumn != null) {
        return session.viewColumn;
      }
    }
    return vscode.ViewColumn.Beside;
  }
}

/** One Blossom chat editor tab (own history / orchestrator). */
class BlossomChatSession {
  readonly panel: vscode.WebviewPanel;
  private readonly orchestrator: AgentOrchestrator;
  private readonly tabIndex: number;
  /** Short label from the first user ask — shown as the editor tab title. */
  private topicSummary: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    tabIndex: number,
    column: vscode.ViewColumn,
    onDispose: () => void
  ) {
    this.tabIndex = tabIndex;
    this.orchestrator = new AgentOrchestrator(context);

    const icon = resolveBrandIconUri(this.context.extensionUri);
    const roots = this.webviewRoots(icon);

    this.panel = vscode.window.createWebviewPanel(
      BlossomChatPanel.viewType,
      this.tabTitle(),
      { viewColumn: column, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: roots,
      }
    );

    this.applyBranding({ reloadHtml: true });

    this.panel.webview.onDidReceiveMessage(
      async (msg) => {
        await this.onMessage(msg);
      },
      undefined,
      this.context.subscriptions
    );

    this.panel.onDidDispose(
      () => {
        this.orchestrator.cancel();
        onDispose();
      },
      undefined,
      this.context.subscriptions
    );

    void this.postHealth();
  }

  get visible(): boolean {
    return this.panel.visible;
  }

  get viewColumn(): vscode.ViewColumn | undefined {
    return this.panel.viewColumn;
  }

  private tabTitle(): string {
    if (this.topicSummary) {
      return this.topicSummary;
    }
    const name = getConfig().ui.displayName;
    return this.tabIndex <= 1 ? name : `${name} (${this.tabIndex})`;
  }

  private setTopicFromAsk(text: string): void {
    if (this.topicSummary) {
      return;
    }
    const summary = summarizeAskForTab(text);
    if (!summary) {
      return;
    }
    this.topicSummary = summary;
    this.panel.title = this.tabTitle();
  }

  private clearTopic(): void {
    this.topicSummary = undefined;
    this.panel.title = this.tabTitle();
  }

  private webviewRoots(icon: vscode.Uri): vscode.Uri[] {
    const roots: vscode.Uri[] = [
      vscode.Uri.joinPath(this.context.extensionUri, "media"),
    ];
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      roots.push(folder.uri);
    }
    try {
      roots.push(vscode.Uri.file(path.dirname(icon.fsPath)));
    } catch {
      // ignore
    }
    return roots;
  }

  applyBranding(opts?: { reloadHtml?: boolean }): void {
    const icon = resolveBrandIconUri(this.context.extensionUri);
    this.panel.title = this.tabTitle();
    this.panel.iconPath = { light: icon, dark: icon };
    if (opts?.reloadHtml) {
      this.panel.webview.html = this.getHtml(this.panel.webview);
      void this.postHealth();
    }
  }

  private async postHealth(opts?: { announce?: boolean }): Promise<void> {
    if (opts?.announce) {
      this.post({ type: "health", ok: false, detail: "Pinging…", pending: true });
    }
    const health = await checkHealth();
    const stamp = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    this.post({
      type: "health",
      ok: health.ok,
      detail: `${health.detail} · ${stamp}`,
      pending: false,
    });
    if (opts?.announce) {
      void vscode.window.setStatusBarMessage(
        `Blossom: ${health.ok ? "backend OK" : "backend unreachable"} — ${health.detail}`,
        4000
      );
    }
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(msg: {
    type: string;
    text?: string;
    editId?: string;
    command?: string;
    enabled?: boolean;
  }): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.postHealth();
        this.post({
          type: "autoApply",
          enabled: this.orchestrator.getAutoApply(),
        });
        break;
      case "chat": {
        const text = (msg.text ?? "").trim();
        if (!text) {
          return;
        }
        this.setTopicFromAsk(text);
        this.post({ type: "assistantStart" });
        await this.orchestrator.handleUserMessage(text, {
          onStatus: (s) => this.post({ type: "status", text: s }),
          onMode: (mode, model, source) =>
            this.post({ type: "mode", mode, model, source }),
          onToken: (delta) => this.post({ type: "token", text: delta }),
          onThought: (thought) =>
            this.post({
              type: "thought",
              step: thought.step,
              message: thought.message,
            }),
          onTool: (name, detail) => this.post({ type: "tool", name, detail }),
          onPendingEdit: (edit) =>
            this.post({
              type: "pendingEdit",
              id: edit.id,
              path: edit.relativePath,
              preview:
                edit.kind === "delete"
                  ? "(delete this file)"
                  : edit.newContent.slice(0, 4000),
              isNew: edit.kind !== "delete" && !edit.oldContent,
              isDelete: edit.kind === "delete",
            }),
          onEditApplied: (id, path) => {
            this.orchestrator.noteFileApplied(path, true);
            this.post({ type: "editApplied", id, path, auto: true });
          },
          onCodingSummary: (summary) =>
            this.post({
              type: "codingSummary",
              backend: summary.backend,
              created: summary.created,
              updated: summary.updated,
              deleted: summary.deleted ?? [],
              autoApplied: summary.autoApplied,
              modelNotes: summary.modelNotes ?? [],
            }),
          onDone: (finalText) => {
            this.post({
              type: "autoApply",
              enabled: this.orchestrator.getAutoApply(),
            });
            this.post({ type: "assistantDone", text: finalText });
          },
          onError: (message) => this.post({ type: "error", text: message }),
        });
        break;
      }
      case "cancel":
        this.orchestrator.cancel();
        this.post({ type: "status", text: "Cancelled" });
        break;
      case "clear":
        this.orchestrator.cancel();
        this.orchestrator.clearHistory();
        this.clearTopic();
        this.post({ type: "cleared" });
        this.post({
          type: "autoApply",
          enabled: this.orchestrator.getAutoApply(),
        });
        break;
      case "applyEdit":
        if (msg.editId) {
          try {
            const path = await this.orchestrator.applyEdit(msg.editId);
            this.orchestrator.noteFileApplied(path, false);
            this.post({ type: "editApplied", id: msg.editId, path });
            void vscode.window.showInformationMessage(`Applied: ${path}`);
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            this.post({ type: "error", text: m });
          }
        }
        break;
      case "rejectEdit":
        if (msg.editId) {
          await this.orchestrator.rejectEdit(msg.editId);
          this.post({ type: "editRejected", id: msg.editId });
        }
        break;
      case "setMode":
        break;
      case "setAutoApply": {
        this.orchestrator.setAutoApply(!!msg.enabled);
        this.post({
          type: "autoApply",
          enabled: this.orchestrator.getAutoApply(),
        });
        this.post({
          type: "status",
          text: msg.enabled
            ? "Auto-apply on for this session."
            : "Auto-apply off for this session.",
        });
        break;
      }
      case "checkHealth":
        await this.postHealth({ announce: true });
        break;
      default:
        break;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const displayName = getConfig().ui.displayName;
    const iconFile = resolveBrandIconUri(this.context.extensionUri);
    const iconUri = webview.asWebviewUri(iconFile);
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: file:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(displayName)}</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --border: var(--vscode-panel-border, rgba(127,127,127,.35));
      --accent: var(--vscode-button-background);
      --accent-fg: var(--vscode-button-foreground);
      --card: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      --user: color-mix(in srgb, var(--accent) 22%, transparent);
      --assistant: color-mix(in srgb, var(--fg) 8%, transparent);
      --danger: var(--vscode-errorForeground);
      --ok: var(--vscode-testing-iconPassed, #3fae5a);
    }
    * { box-sizing: border-box; }
    html, body {
      height: 100%;
      margin: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--fg);
      background: var(--bg);
    }
    body {
      display: flex;
      flex-direction: column;
      padding: 12px;
      gap: 8px;
    }
    header {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .brand-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .brand-row img {
      width: 28px;
      height: 28px;
      border-radius: 6px;
    }
    .brand-spacer { flex: 1; }
    .busy-row {
      display: none;
      align-items: center;
      gap: 8px;
      min-height: 18px;
      margin-top: 8px;
      padding: 6px 2px 4px;
      color: var(--muted);
      font-size: 0.85em;
      flex-shrink: 0;
    }
    .busy-row.on {
      display: flex;
    }
    .spinner {
      width: 14px;
      height: 14px;
      border: 2px solid color-mix(in srgb, var(--fg) 22%, transparent);
      border-top-color: var(--accent);
      border-radius: 50%;
      flex-shrink: 0;
      animation: blossom-spin 0.7s linear infinite;
    }
    @keyframes blossom-spin {
      to { transform: rotate(360deg); }
    }
    .brand {
      font-size: 1.15rem;
      font-weight: 650;
      letter-spacing: 0.02em;
    }
    .meta {
      color: var(--muted);
      font-size: 0.85em;
      line-height: 1.35;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    button, .chip {
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--fg);
      border-radius: 6px;
      padding: 4px 10px;
      cursor: pointer;
      font: inherit;
    }
    button.primary {
      background: var(--accent);
      color: var(--accent-fg);
      border-color: transparent;
    }
    button:disabled { opacity: 0.5; cursor: default; }
    .chip.active {
      outline: 1px solid var(--accent);
      background: color-mix(in srgb, var(--accent) 25%, transparent);
    }
    #messages {
      flex: 1;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 4px 2px 12px;
    }
    .msg {
      padding: 8px 10px;
      border-radius: 8px;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.4;
      border: 1px solid var(--border);
    }
    .msg.user { background: var(--user); }
    .msg.assistant { background: var(--assistant); }
    .msg.assistant.rich {
      white-space: normal;
      background: transparent;
      border: none;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .msg.system { color: var(--muted); border-style: dashed; font-size: 0.9em; }
    .msg.error { color: var(--danger); }
    .reply-section, .code-box {
      border: 1px solid var(--border);
      border-radius: 4px;
      overflow: hidden;
      background: var(--card);
    }
    .reply-eyebrow {
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--muted);
      margin: 0;
    }
    .reply-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .reply-group-body {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-left: 10px;
      border-left: 2px solid color-mix(in srgb, var(--fg) 16%, transparent);
    }
    .file-action {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--card);
      font-size: 0.9em;
    }
    .file-action.delete {
      border-color: color-mix(in srgb, var(--danger) 40%, var(--border));
      background: color-mix(in srgb, var(--danger) 8%, var(--card));
    }
    .file-action-label {
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--danger);
      flex-shrink: 0;
    }
    .file-action-path {
      font-family: var(--vscode-editor-font-family, monospace);
      font-weight: 600;
    }
    .reply-section-hd, .code-box-hd {
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      padding: 6px 10px;
      border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, var(--fg) 7%, var(--card));
      color: var(--muted);
    }
    .code-box-hd {
      display: flex;
      align-items: baseline;
      gap: 8px;
      text-transform: none;
      letter-spacing: 0.01em;
      font-size: 0.82rem;
      font-weight: 600;
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--fg);
    }
    .code-box-hd .lang {
      margin-left: auto;
      font-size: 0.72rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--muted);
      font-family: var(--vscode-font-family);
    }
    .reply-section-bd {
      padding: 8px 12px 10px;
    }
    .reply-section-bd p {
      margin: 0 0 6px;
    }
    .reply-section-bd p:last-child {
      margin-bottom: 0;
    }
    .reply-section-bd ol,
    .reply-section-bd ul {
      margin: 0;
      padding-left: 1.3em;
    }
    .reply-section-bd li {
      margin: 5px 0;
      line-height: 1.4;
    }
    .reply-section-bd li.check {
      list-style: none;
      margin-left: -1.1em;
      padding-left: 1.35em;
      position: relative;
    }
    .reply-section-bd li.check::before {
      content: "";
      position: absolute;
      left: 0.15em;
      top: 0.45em;
      width: 0.55em;
      height: 0.55em;
      border-radius: 2px;
      background: var(--ok);
    }
    .reply-prose p {
      margin: 0 0 8px;
    }
    .reply-prose p:last-child {
      margin-bottom: 0;
    }
    .code-box pre {
      margin: 0;
      padding: 10px 12px;
      overflow: auto;
      max-height: 280px;
      white-space: pre;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.85em;
      line-height: 1.45;
      background: color-mix(in srgb, var(--bg) 70%, var(--card));
    }
    .inline-code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.9em;
      padding: 0 4px;
      border-radius: 3px;
      background: color-mix(in srgb, var(--fg) 10%, transparent);
    }
    .tool, .edit, .thoughts, .summary-card {
      font-size: 0.85em;
      background: var(--card);
      border: 1px dashed var(--border);
      border-radius: 8px;
      padding: 8px;
    }
    .summary-card {
      border-style: solid;
      border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
      background: color-mix(in srgb, var(--accent) 10%, var(--card));
      margin-top: 4px;
    }
    .summary-card .title {
      font-weight: 650;
      margin-bottom: 6px;
    }
    .summary-card ul {
      margin: 0;
      padding-left: 1.2em;
    }
    .summary-card li {
      margin: 3px 0;
      line-height: 1.35;
    }
    .thoughts {
      color: var(--muted);
      border-style: solid;
      opacity: 0.95;
    }
    .thoughts summary {
      cursor: pointer;
      font-weight: 600;
      color: var(--fg);
      list-style: none;
    }
    .thoughts summary::-webkit-details-marker { display: none; }
    .thoughts ol {
      margin: 8px 0 0;
      padding-left: 1.2em;
    }
    .thoughts li {
      margin: 3px 0;
      line-height: 1.35;
    }
    .thoughts .step {
      font-family: var(--vscode-editor-font-family, monospace);
      opacity: 0.75;
      margin-right: 6px;
    }
    .edit pre {
      max-height: 160px;
      overflow: auto;
      margin: 6px 0;
      white-space: pre-wrap;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.85em;
    }
    .composer {
      display: flex;
      flex-direction: column;
      gap: 6px;
      border-top: 1px solid var(--border);
      padding-top: 8px;
    }
    textarea {
      width: 100%;
      min-height: 88px;
      resize: vertical;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px;
      font: inherit;
    }
    .dot {
      width: 8px; height: 8px; border-radius: 50%;
      display: inline-block; margin-right: 6px;
      background: var(--danger);
    }
    .dot.ok { background: var(--ok); }
  </style>
</head>
<body>
  <header>
    <div class="brand-row">
      <img src="${iconUri}" alt="" />
      <div class="brand">${escapeHtml(displayName)}</div>
      <div class="brand-spacer"></div>
    </div>
    <div class="meta" id="health"><span class="dot" id="healthDot"></span><span id="healthText">Checking backend…</span></div>
    <div class="meta" id="modeLine">Coding assistant</div>
    <div class="row">
      <button class="chip" id="btnAutoApply" title="Write proposed edits to disk without asking (this chat only)">Auto-apply</button>
      <button id="btnHealth" title="Recheck ChatRouter / Ollama">Ping</button>
      <button id="btnClear" title="Clear conversation">Clear</button>
      <button id="btnCancel">Stop</button>
    </div>
  </header>
  <div id="messages">
    <div class="busy-row" id="busyRow" aria-hidden="true">
      <div class="spinner" id="busySpinner" title="Working…"></div>
      <span id="busyLabel">Working…</span>
    </div>
  </div>
  <div class="composer">
    <textarea id="input" placeholder="Ask your coding assistant…"></textarea>
    <div class="row">
      <button class="primary" id="btnSend">Send</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const input = document.getElementById('input');
    const healthDot = document.getElementById('healthDot');
    const healthText = document.getElementById('healthText');
    const modeLine = document.getElementById('modeLine');
    let streamingEl = null;
    let thoughtsEl = null;
    let thoughtsList = null;
    let busy = false;

    function ensureThoughts() {
      if (thoughtsEl) return;
      thoughtsEl = document.createElement('details');
      thoughtsEl.className = 'thoughts';
      thoughtsEl.open = true;
      const sum = document.createElement('summary');
      sum.textContent = 'Thinking…';
      thoughtsList = document.createElement('ol');
      thoughtsEl.appendChild(sum);
      thoughtsEl.appendChild(thoughtsList);
      messagesEl.appendChild(thoughtsEl);
      pinBusyToBottom();
    }

    function addThought(step, message, local) {
      ensureThoughts();
      const li = document.createElement('li');
      if (step) {
        const s = document.createElement('span');
        s.className = 'step';
        s.textContent = local ? '[' + step + ']' : step;
        li.appendChild(s);
      }
      li.appendChild(document.createTextNode(message));
      thoughtsList.appendChild(li);
      const sum = thoughtsEl.querySelector('summary');
      const n = thoughtsList.children.length;
      sum.textContent = local ? ('Prep · ' + n + ' step' + (n === 1 ? '' : 's')) : ('Thinking · ' + n + ' step' + (n === 1 ? '' : 's'));
      pinBusyToBottom();
    }

    function pinBusyToBottom() {
      const row = document.getElementById('busyRow');
      if (!row) return;
      messagesEl.appendChild(row);
      if (busy) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }

    function append(role, text) {
      const el = document.createElement('div');
      el.className = 'msg ' + role;
      el.textContent = text;
      messagesEl.appendChild(el);
      pinBusyToBottom();
      return el;
    }

    function appendInline(parent, text) {
      const tick = String.fromCharCode(96);
      const re = new RegExp('(\\\\*\\\\*[^*]+\\\\*\\\\*|' + tick + '[^' + tick + ']+' + tick + ')', 'g');
      let last = 0;
      let m;
      while ((m = re.exec(text))) {
        if (m.index > last) {
          parent.appendChild(document.createTextNode(text.slice(last, m.index)));
        }
        const token = m[0];
        if (token.startsWith('**')) {
          const strong = document.createElement('strong');
          strong.textContent = token.slice(2, -2);
          parent.appendChild(strong);
        } else {
          const code = document.createElement('code');
          code.className = 'inline-code';
          code.textContent = token.slice(1, -1);
          parent.appendChild(code);
        }
        last = m.index + token.length;
      }
      if (last < text.length) {
        parent.appendChild(document.createTextNode(text.slice(last)));
      }
    }

    function appendFormatted(parent, body) {
      if (!body || !body.trim()) return;
      const lines = body.split(/\\n/);
      let list = null;
      let listKind = '';
      const flushList = () => { list = null; listKind = ''; };
      const ensureList = (tag, kind) => {
        if (list && listKind === kind) return;
        flushList();
        list = document.createElement(tag);
        listKind = kind;
        parent.appendChild(list);
      };
      for (const raw of lines) {
        const line = raw.replace(/\\s+$/, '');
        if (!line.trim()) {
          flushList();
          continue;
        }
        const check = line.match(/^\\s*(?:[✓✔√]|[-*•]\\s*[✓✔√]|\\[[xX]\\])\\s+(.+)$/);
        const ol = line.match(/^\\s*(\\d+)\\.\\s+(.+)$/);
        const ul = line.match(/^\\s*[-*•]\\s+(.+)$/);
        if (check) {
          ensureList('ul', 'check');
          const li = document.createElement('li');
          li.className = 'check';
          appendInline(li, check[1]);
          list.appendChild(li);
        } else if (ol) {
          ensureList('ol', 'ol');
          const li = document.createElement('li');
          appendInline(li, ol[2]);
          list.appendChild(li);
        } else if (ul) {
          ensureList('ul', 'ul');
          const li = document.createElement('li');
          appendInline(li, ul[1]);
          list.appendChild(li);
        } else {
          flushList();
          const p = document.createElement('p');
          appendInline(p, line.trim());
          parent.appendChild(p);
        }
      }
    }

    function prettySectionTitle(raw) {
      const t = String(raw || '').replace(/:$/, '').trim();
      if (/^plan\\b/i.test(t)) return 'Plan';
      if (/^verify\\b/i.test(t)) return 'Verify';
      if (/^execute\\b/i.test(t)) return 'Execute';
      if (/^phase\\s+/i.test(t)) return t.replace(/^phase/i, 'Phase');
      return t.replace(/\\b\\w/g, (c) => c.toUpperCase());
    }

    function pushTextBlocks(blocks, text) {
      if (!text || !String(text).trim()) return;
      const lines = String(text).split(/\\r?\\n/);
      let i = 0;
      while (i < lines.length) {
        while (i < lines.length && !lines[i].trim()) i++;
        if (i >= lines.length) break;
        const line = lines[i];
        if (/^---+\\s*$/.test(line.trim())) { i++; continue; }
        const hm = line.match(/^#{1,3}\\s+(.+?)\\s*$/);
        const bare = line.match(/^(PLAN|VERIFY|EXECUTE|PHASE\\s+[A-D])\\s*:?\\s*$/i);
        if (hm || bare) {
          const title = prettySectionTitle(hm ? hm[1] : bare[1]);
          i++;
          const body = [];
          while (i < lines.length) {
            if (/^---+\\s*$/.test(lines[i].trim())) break;
            if (/^#{1,3}\\s+\\S/.test(lines[i])) break;
            if (/^(PLAN|VERIFY|EXECUTE)\\s*:?\\s*$/i.test(lines[i].trim())) break;
            body.push(lines[i]);
            i++;
          }
          blocks.push({ type: 'section', title, body: body.join('\\n').trim() });
          continue;
        }
        const prose = [];
        while (i < lines.length) {
          if (/^---+\\s*$/.test(lines[i].trim())) break;
          if (/^#{1,3}\\s+\\S/.test(lines[i])) break;
          if (/^(PLAN|VERIFY|EXECUTE)\\s*:?\\s*$/i.test(lines[i].trim())) break;
          prose.push(lines[i]);
          i++;
        }
        const body = prose.join('\\n').trim();
        if (body) blocks.push({ type: 'prose', body });
      }
    }

    function isDeleteCode(b) {
      if (!b || b.type !== 'code') return false;
      const c = (b.content || '').trim();
      if (/^(delete|remove)$/i.test(b.lang || '')) return true;
      if (/^(DELETE|REMOVE)(?:\\s+FILE)?$/i.test(c)) return true;
      // Empty path-labeled fence = delete marker
      return !c && Boolean(b.path);
    }

    function normalizeBlocks(blocks) {
      const out = [];
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (b.type === 'section' && !(b.body || '').trim()) {
          const kids = [];
          let j = i + 1;
          while (j < blocks.length && blocks[j].type === 'code') {
            kids.push(blocks[j]);
            j++;
          }
          if (kids.length > 0) {
            out.push({ type: 'group', title: b.title, kids });
            i = j - 1;
            continue;
          }
          // Empty structural header with nothing under it — skip
          continue;
        }
        out.push(b);
      }
      return out;
    }

    function parseReplyBlocks(text) {
      const blocks = [];
      const re = /\`\`\`([^\\n\`]*)\\n([\\s\\S]*?)\`\`\`/g;
      let last = 0;
      let m;
      while ((m = re.exec(text))) {
        pushTextBlocks(blocks, text.slice(last, m.index));
        const info = (m[1] || '').trim();
        const pathM = info.match(/\\b(?:path|file)\\s*[=:]\\s*["']?([^\\s"'\`]+)/i);
        const tokens = info.split(/\\s+/).filter(Boolean);
        let lang = '';
        for (const t of tokens) {
          if (/^(?:path|file)=/i.test(t)) continue;
          if (/[=:]/.test(t)) continue;
          lang = t;
          break;
        }
        blocks.push({
          type: 'code',
          path: pathM ? pathM[1].replace(/\\\\/g, '/') : '',
          lang,
          content: (m[2] || '').replace(/\\n$/, ''),
        });
        last = m.index + m[0].length;
      }
      pushTextBlocks(blocks, text.slice(last));
      return normalizeBlocks(blocks);
    }

    function renderCodeOrAction(parent, b) {
      if (isDeleteCode(b)) {
        const row = document.createElement('div');
        row.className = 'file-action delete';
        const label = document.createElement('span');
        label.className = 'file-action-label';
        label.textContent = 'Delete';
        const path = document.createElement('span');
        path.className = 'file-action-path';
        path.textContent = b.path || 'file';
        row.appendChild(label);
        row.appendChild(path);
        parent.appendChild(row);
        return;
      }
      const box = document.createElement('div');
      box.className = 'code-box';
      const hd = document.createElement('div');
      hd.className = 'code-box-hd';
      const path = document.createElement('span');
      path.textContent = b.path || 'Code';
      hd.appendChild(path);
      if (b.lang && !/^(delete|remove)$/i.test(b.lang)) {
        const lang = document.createElement('span');
        lang.className = 'lang';
        lang.textContent = b.lang;
        hd.appendChild(lang);
      }
      const pre = document.createElement('pre');
      pre.textContent = b.content;
      box.appendChild(hd);
      box.appendChild(pre);
      parent.appendChild(box);
    }

    function renderAssistant(el, text) {
      el.classList.add('rich');
      el.textContent = '';
      const blocks = parseReplyBlocks(text || '');
      if (blocks.length === 0) {
        el.classList.remove('rich');
        el.textContent = text || '';
        return;
      }
      for (const b of blocks) {
        if (b.type === 'group') {
          const wrap = document.createElement('div');
          wrap.className = 'reply-group';
          const eye = document.createElement('div');
          eye.className = 'reply-eyebrow';
          eye.textContent = b.title;
          const body = document.createElement('div');
          body.className = 'reply-group-body';
          for (const kid of b.kids) {
            renderCodeOrAction(body, kid);
          }
          wrap.appendChild(eye);
          wrap.appendChild(body);
          el.appendChild(wrap);
        } else if (b.type === 'section') {
          const box = document.createElement('section');
          box.className = 'reply-section';
          const hd = document.createElement('header');
          hd.className = 'reply-section-hd';
          hd.textContent = b.title;
          const bd = document.createElement('div');
          bd.className = 'reply-section-bd';
          appendFormatted(bd, b.body);
          box.appendChild(hd);
          box.appendChild(bd);
          el.appendChild(box);
        } else if (b.type === 'code') {
          renderCodeOrAction(el, b);
        } else {
          const wrap = document.createElement('div');
          wrap.className = 'reply-prose';
          appendFormatted(wrap, b.body);
          el.appendChild(wrap);
        }
      }
    }

    function setBusy(v) {
      busy = v;
      document.getElementById('btnSend').disabled = v;
      const row = document.getElementById('busyRow');
      if (row) {
        if (v) row.classList.add('on');
        else row.classList.remove('on');
        row.setAttribute('aria-hidden', v ? 'false' : 'true');
      }
      pinBusyToBottom();
    }

    function send() {
      const text = input.value.trim();
      if (!text || busy) return;
      append('user', text);
      input.value = '';
      setBusy(true);
      streamingEl = null;
      vscode.postMessage({ type: 'chat', text });
    }

    document.getElementById('btnSend').addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    document.getElementById('btnClear').addEventListener('click', () => {
      vscode.postMessage({ type: 'clear' });
    });
    document.getElementById('btnCancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });
    document.getElementById('btnHealth').addEventListener('click', () => {
      vscode.postMessage({ type: 'checkHealth' });
    });
    document.getElementById('btnAutoApply').addEventListener('click', () => {
      const btn = document.getElementById('btnAutoApply');
      const next = !btn.classList.contains('active');
      vscode.postMessage({ type: 'setAutoApply', enabled: next });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'health':
          healthDot.className = 'dot' + (msg.pending ? '' : (msg.ok ? ' ok' : ''));
          if (msg.pending) healthDot.style.opacity = '0.45';
          else healthDot.style.opacity = '1';
          healthText.textContent = msg.detail;
          break;
        case 'mode':
          modeLine.textContent = msg.source
            ? ('Coding · ' + msg.model + ' · ' + msg.source)
            : ('Coding · ' + msg.model);
          break;
        case 'autoApply': {
          const btn = document.getElementById('btnAutoApply');
          if (msg.enabled) btn.classList.add('active');
          else btn.classList.remove('active');
          break;
        }
        case 'status':
          if (msg.text) {
            addThought('local', msg.text, true);
          }
          break;
        case 'assistantStart':
          thoughtsEl = null;
          thoughtsList = null;
          streamingEl = null;
          break;
        case 'thought':
          addThought(msg.step || '', msg.message || '', false);
          break;
        case 'token':
          if (thoughtsEl && thoughtsEl.open) {
            // collapse trail once answer starts flowing
            thoughtsEl.open = false;
            const sum = thoughtsEl.querySelector('summary');
            if (sum && thoughtsList) {
              sum.textContent = 'Thoughts · ' + thoughtsList.children.length;
            }
          }
          if (!streamingEl) streamingEl = append('assistant', '');
          streamingEl.textContent += msg.text;
          pinBusyToBottom();
          break;
        case 'tool': {
          const t = document.createElement('div');
          t.className = 'tool';
          t.textContent = (msg.name === 'editor_context' ? 'Attached ' : 'Tool · ') +
            (msg.name === 'editor_context' ? msg.detail : (msg.name + (msg.detail ? '\\n' + msg.detail : '')));
          messagesEl.appendChild(t);
          if (msg.name === 'editor_context') {
            addThought('local', 'Attached ' + msg.detail, true);
          }
          pinBusyToBottom();
          break;
        }
        case 'pendingEdit': {
          const wrap = document.createElement('div');
          wrap.className = 'edit';
          wrap.dataset.editId = msg.id;
          const title = document.createElement('div');
          title.textContent = msg.isDelete
            ? ("Delete: " + msg.path)
            : ((msg.isNew ? "New file: " : "Edit: ") + msg.path);
          const pre = document.createElement('pre');
          pre.textContent = msg.isDelete
            ? '(will remove from disk)'
            : (msg.preview + (msg.preview && msg.preview.length >= 4000 ? '\\n…' : ''));
          const row = document.createElement('div');
          row.className = 'row';
          const apply = document.createElement('button');
          apply.className = 'primary';
          apply.textContent = msg.isDelete ? 'Delete' : 'Apply';
          apply.onclick = () => vscode.postMessage({ type: 'applyEdit', editId: msg.id });
          const reject = document.createElement('button');
          reject.textContent = 'Reject';
          reject.onclick = () => vscode.postMessage({ type: 'rejectEdit', editId: msg.id });
          row.appendChild(apply);
          row.appendChild(reject);
          wrap.appendChild(title);
          wrap.appendChild(pre);
          wrap.appendChild(row);
          messagesEl.appendChild(wrap);
          pinBusyToBottom();
          break;
        }
        case 'editApplied':
        case 'editRejected': {
          const el = document.querySelector('[data-edit-id="' + msg.id + '"]');
          if (el) {
            el.querySelectorAll('button').forEach((b) => b.disabled = true);
            el.appendChild(document.createTextNode(msg.type === 'editApplied' ? ' ✓ applied' : ' ✗ rejected'));
          }
          if (msg.type === 'editApplied' && msg.path && !el) {
            // Quiet marker only — no "Done — applied" chat spam
            const note = document.createElement('div');
            note.className = 'tool';
            note.textContent = '✓ ' + msg.path;
            messagesEl.appendChild(note);
            pinBusyToBottom();
          }
          break;
        }
        case 'error':
          if (thoughtsEl) {
            thoughtsEl.open = false;
            const sum = thoughtsEl.querySelector('summary');
            if (sum) sum.textContent = 'Failed';
          }
          streamingEl = null;
          append('error', 'Error — ' + (msg.text || 'Unknown error'));
          setBusy(false);
          thoughtsEl = null;
          thoughtsList = null;
          break;
        case 'codingSummary': {
          const card = document.createElement('div');
          card.className = 'summary-card';
          const title = document.createElement('div');
          title.className = 'title';
          title.textContent = 'Summary';
          const ul = document.createElement('ul');
          const add = (text) => {
            const li = document.createElement('li');
            li.textContent = text;
            ul.appendChild(li);
          };
          if (msg.backend) add('Backend: ' + msg.backend);
          const created = msg.created || [];
          const updated = msg.updated || [];
          const deleted = msg.deleted || [];
          const notes = Array.isArray(msg.modelNotes) ? msg.modelNotes : [];
          // Prefer disk-truth from Apply over model prose (models often fake "Deleted …").
          const hasDiskEdits = created.length + updated.length + deleted.length > 0;
          if (hasDiskEdits) {
            created.forEach((p) => add('Created ' + p));
            updated.forEach((p) => add('Updated ' + p));
            deleted.forEach((p) => add('Deleted ' + p));
          } else if (notes.length > 0) {
            notes.forEach((n) => add(n));
          }
          if (hasDiskEdits) {
            const n = created.length + updated.length + deleted.length;
            add(msg.autoApplied
              ? 'Changes were written to disk (auto-apply).'
              : (n === 1
                ? 'Click Apply to write it to disk.'
                : 'Click Apply on each card to write to disk.'));
          }
          card.appendChild(title);
          card.appendChild(ul);
          messagesEl.appendChild(card);
          pinBusyToBottom();
          break;
        }
        case 'assistantDone':
          if (streamingEl && typeof msg.text === 'string' && msg.text.length) {
            renderAssistant(streamingEl, msg.text);
          } else if (streamingEl && streamingEl.textContent) {
            renderAssistant(streamingEl, streamingEl.textContent);
          }
          setBusy(false);
          streamingEl = null;
          thoughtsEl = null;
          thoughtsList = null;
          break;
        case 'cleared':
          messagesEl.innerHTML = '';
          // Recreate busy row after clear (innerHTML wiped it)
          {
            const row = document.createElement('div');
            row.className = 'busy-row';
            row.id = 'busyRow';
            row.setAttribute('aria-hidden', 'true');
            row.innerHTML = '<div class="spinner" id="busySpinner" title="Working…"></div><span id="busyLabel">Working…</span>';
            messagesEl.appendChild(row);
          }
          break;
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

/** One-line tab label from the user's first ask (no LLM). */
function summarizeAskForTab(text: string, maxLen = 48): string {
  let s = text.replace(/\s+/g, " ").trim();
  s = s.replace(/^\/[a-z]+\s+/i, "");
  if (!s) {
    s = text.replace(/\s+/g, " ").trim();
  }
  if (!s) {
    return "";
  }
  if (s.length <= maxLen) {
    return s;
  }
  const cut = s.slice(0, maxLen - 1);
  const sp = cut.lastIndexOf(" ");
  const base = sp > Math.floor(maxLen * 0.45) ? cut.slice(0, sp) : cut;
  return `${base.replace(/[.,;:!?…\-–—\s]+$/u, "")}…`;
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
