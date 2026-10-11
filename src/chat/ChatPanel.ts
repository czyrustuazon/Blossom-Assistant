import * as path from "path";
import * as vscode from "vscode";
import { getConfig, resolveBrandIconUri } from "../config";
import {
  openDiffOnReplaceEnabled,
  openPendingEditDiff,
} from "../agent/diffDocuments";
import { diffFileContents } from "../agent/lineDiff";
import {
  getPendingEdit,
  restorePendingEdit,
  type PendingEdit,
} from "../agent/tools";
import { AgentOrchestrator, type OrchestratorEvents } from "../agent/orchestrator";
import { checkHealth } from "../ollama/client";
import { sendCorrectnessFeedback } from "../feedback/client";
import {
  buildImageAttachment,
  pickImageAttachments,
  type ImageAttachment,
} from "./attachments";
import {
  clearScratchpad,
  getScratchpad,
  SCRATCHPAD_MAX_CHARS,
  setScratchpad,
  scratchpadStatus,
} from "../agent/scratchpad";
import {
  deleteChatArchive,
  historyForRestore,
  listChatArchives,
  loadChatArchive,
  newChatArchiveId,
  saveChatArchive,
  uiEditsFromArchive,
  uiMessagesFromArchive,
  type ChatArchive,
  type ChatArchiveEdit,
} from "../agent/chatArchive";

/**
 * Host for Blossom chat tabs in the editor area.
 * Each blossom.openChat click opens a new tab in the existing Blossom group
 * (same column), instead of focusing/replacing the current tab or splitting away.
 */
export class BlossomChatPanel {
  public static readonly viewType = "blossom.chatPanel";

  private static nextTab = 1;
  private readonly sessions = new Set<BlossomChatSession>();
  private lastActiveSession?: BlossomChatSession;

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

  openNewChat(opts?: { archive?: ChatArchive }): void {
    const tabIndex = BlossomChatPanel.nextTab++;
    const column = this.pickColumn();
    const session = new BlossomChatSession(
      this.context,
      tabIndex,
      column,
      () => {
        this.sessions.delete(session);
        if (this.lastActiveSession === session) {
          this.lastActiveSession = undefined;
        }
      },
      (active) => {
        this.lastActiveSession = active;
      },
      opts?.archive
    );
    this.sessions.add(session);
    this.lastActiveSession = session;
  }

  /** Pick a saved chat and open it in a new tab. */
  async openChatHistory(): Promise<void> {
    const entries = await listChatArchives();
    if (!entries.length) {
      void vscode.window.showInformationMessage(
        "No saved Blossom chats yet. Chats are saved automatically after each reply (workspace must be open)."
      );
      return;
    }

    type HistItem = vscode.QuickPickItem & {
      archiveId: string;
      action: "open" | "delete";
    };

    const items: HistItem[] = entries.map((e) => {
      const when = e.updatedAt.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
      return {
        label: e.title,
        description: when,
        detail: `${e.messageCount} messages · ${e.preview}`,
        archiveId: e.id,
        action: "open" as const,
      };
    });
    items.push({
      label: "$(trash) Delete a saved chat…",
      description: "",
      archiveId: "",
      action: "delete",
    });

    const picked = await vscode.window.showQuickPick(items, {
      title: "Blossom chat history",
      placeHolder: "Open a past chat to revisit or continue",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) {
      return;
    }

    if (picked.action === "delete") {
      await this.deleteChatHistoryPick();
      return;
    }

    const archive = await loadChatArchive(picked.archiveId);
    if (!archive) {
      void vscode.window.showWarningMessage(
        `Could not load saved chat "${picked.archiveId}".`
      );
      return;
    }
    this.openNewChat({ archive });
  }

  private async deleteChatHistoryPick(): Promise<void> {
    const entries = await listChatArchives();
    if (!entries.length) {
      return;
    }
    const picked = await vscode.window.showQuickPick(
      entries.map((e) => ({
        label: e.title,
        description: e.updatedAt.replace("T", " ").replace(/\.\d{3}Z$/, ""),
        detail: e.id,
        id: e.id,
      })),
      {
        title: "Delete saved Blossom chat",
        placeHolder: "Select a chat to delete permanently",
      }
    );
    if (!picked) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Delete saved chat “${picked.label}”?`,
      { modal: true },
      "Delete"
    );
    if (confirm !== "Delete") {
      return;
    }
    await deleteChatArchive(picked.id);
    void vscode.window.showInformationMessage("Saved chat deleted.");
  }

  /** Force-save the active chat now (also happens automatically after each turn). */
  async saveActiveChat(): Promise<void> {
    const session = this.lastActiveSession ?? [...this.sessions].pop();
    if (!session) {
      void vscode.window.showWarningMessage(
        "Open a Blossom chat tab first, then try again."
      );
      return;
    }
    const saved = await session.persistArchive();
    if (!saved) {
      void vscode.window.showInformationMessage(
        "Nothing to save yet (send a message first, and open a workspace folder)."
      );
      return;
    }
    void vscode.window.showInformationMessage(
      `Saved chat “${saved.title}” (.blossom/chats).`
    );
  }

  /** Copy compressed session handoff for Cursor IDE (P0). */
  async copyCursorHandoff(): Promise<void> {
    const session = this.lastActiveSession ?? [...this.sessions].pop();
    if (!session) {
      void vscode.window.showWarningMessage(
        "Open a Blossom chat tab first, then try again."
      );
      return;
    }
    await session.copyCursorHandoff();
  }

  /** Retry the last cloud escalation answer with local Blossom (P2 de-escalate). */
  async retryWithLocalBlossom(): Promise<void> {
    const session = this.lastActiveSession ?? [...this.sessions].pop();
    if (!session) {
      void vscode.window.showWarningMessage(
        "Open a Blossom chat tab first, then try again."
      );
      return;
    }
    await session.retryWithLocalBlossom();
  }

  /** Push current scratchpad chip state to every open chat tab. */
  broadcastScratchpad(): void {
    for (const session of this.sessions) {
      session.postScratchpadState();
    }
  }

  async editScratchpad(): Promise<void> {
    const current = getScratchpad(this.context);
    const value = await vscode.window.showInputBox({
      title: "Blossom Scratchpad",
      prompt: `Working notes for coding turns (max ${SCRATCHPAD_MAX_CHARS} chars). Injected each turn; not durable memory.`,
      value: current,
      placeHolder: "Goals, decisions, paths tried, blockers…",
      ignoreFocusOut: true,
    });
    if (value === undefined) {
      return;
    }
    const next = await setScratchpad(this.context, value);
    const st = scratchpadStatus(next);
    this.broadcastScratchpad();
    void vscode.window.showInformationMessage(
      st.empty
        ? "Blossom scratchpad cleared."
        : `Blossom scratchpad saved (${st.chars} chars).`
    );
  }

  async showScratchpad(): Promise<void> {
    const current = getScratchpad(this.context);
    const doc = await vscode.workspace.openTextDocument({
      content: current || "(empty — use Blossom: Edit Scratchpad, or a ```scratchpad fence from the agent)",
      language: "markdown",
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  async clearScratchpad(): Promise<void> {
    const current = getScratchpad(this.context);
    if (!current.trim()) {
      void vscode.window.showInformationMessage("Blossom scratchpad is already empty.");
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      "Clear the workspace scratchpad?",
      { modal: true },
      "Clear"
    );
    if (choice !== "Clear") {
      return;
    }
    await clearScratchpad(this.context);
    this.broadcastScratchpad();
    void vscode.window.showInformationMessage("Blossom scratchpad cleared.");
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
  /** Last user ask — attached to error events for Retry. */
  private lastAsk = "";
  /** Durable archive id under .blossom/chats (new per Clear). */
  private archiveId = newChatArchiveId();
  private archiveCreatedAt = new Date().toISOString();
  /** Pending UI restore after webview ready (opened from history). */
  private pendingRestore?: ChatArchive;
  /** Keep edit payloads for Compare after auto-apply clears pendingEdits. */
  private readonly editDiffCache = new Map<string, PendingEdit>();
  /** Session edit cards persisted into History (status + payloads). */
  private readonly sessionEdits = new Map<string, ChatArchiveEdit>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    tabIndex: number,
    column: vscode.ViewColumn,
    onDispose: () => void,
    private readonly onActivate?: (session: BlossomChatSession) => void,
    initialArchive?: ChatArchive
  ) {
    this.tabIndex = tabIndex;
    this.orchestrator = new AgentOrchestrator(context);

    if (initialArchive) {
      this.archiveId = initialArchive.id;
      this.archiveCreatedAt = initialArchive.createdAt || this.archiveCreatedAt;
      this.topicSummary = initialArchive.title;
      const restored = historyForRestore(initialArchive);
      this.orchestrator.restoreArchive(restored);
      this.hydrateEditsFromArchive(initialArchive);
      this.pendingRestore = initialArchive;
    }

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
        void this.persistArchive();
        this.orchestrator.cancel();
        onDispose();
      },
      undefined,
      this.context.subscriptions
    );

    void this.postHealth();
  }

  async persistArchive(): Promise<ChatArchive | undefined> {
    const snap = this.orchestrator.getArchiveSnapshot();
    if (!snap.history.length && !snap.historySummary?.trim()) {
      return undefined;
    }
    return saveChatArchive({
      id: this.archiveId,
      title: this.topicSummary,
      history: snap.history,
      historySummary: snap.historySummary,
      createdAt: this.archiveCreatedAt,
      edits: [...this.sessionEdits.values()],
    });
  }

  private beginFreshArchive(): void {
    this.archiveId = newChatArchiveId();
    this.archiveCreatedAt = new Date().toISOString();
    this.editDiffCache.clear();
    this.sessionEdits.clear();
  }

  private hydrateEditsFromArchive(archive: ChatArchive): void {
    this.editDiffCache.clear();
    this.sessionEdits.clear();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    for (const e of uiEditsFromArchive(archive)) {
      this.sessionEdits.set(e.id, e);
      const abs = root
        ? path.join(root, e.relativePath.replace(/\//g, path.sep))
        : e.relativePath;
      const pending: PendingEdit = {
        id: e.id,
        relativePath: e.relativePath,
        absolutePath: abs,
        oldContent: e.oldContent || "",
        newContent: e.newContent || "",
        kind: e.kind === "delete" ? "delete" : "write",
        source: e.source,
        replacePreview: e.replacePreview,
      };
      this.editDiffCache.set(e.id, pending);
      // Pending cards need the live map so Apply still works after History restore.
      if (e.status === "pending") {
        restorePendingEdit(pending);
      }
    }
  }

  private rememberSessionEdit(
    edit: PendingEdit,
    status: ChatArchiveEdit["status"],
    auto?: boolean
  ): void {
    const prev = this.sessionEdits.get(edit.id);
    this.sessionEdits.set(edit.id, {
      id: edit.id,
      relativePath: edit.relativePath.replace(/\\/g, "/"),
      kind: edit.kind === "delete" ? "delete" : "write",
      source: edit.source,
      oldContent: edit.oldContent || "",
      newContent: edit.newContent || "",
      replacePreview: edit.replacePreview,
      status,
      auto: auto ?? prev?.auto,
    });
  }

  private postRestoreIfNeeded(): void {
    const archive = this.pendingRestore;
    if (!archive) {
      return;
    }
    this.pendingRestore = undefined;
    const messages = uiMessagesFromArchive(archive);
    const edits = uiEditsFromArchive(archive);
    this.post({
      type: "restoreHistory",
      title: archive.title,
      messages,
      edits: edits.map((e) => {
        const isDelete = e.kind === "delete";
        const isNew = !isDelete && !e.oldContent;
        const diff = isDelete
          ? diffFileContents(e.oldContent || "", "")
          : diffFileContents(e.oldContent || "", e.newContent || "");
        const preview = e.replacePreview;
        return {
          id: e.id,
          path: e.relativePath,
          isNew,
          isDelete,
          source:
            e.source ||
            (isDelete ? "delete" : isNew ? "write_file" : "write_file"),
          status: e.status,
          auto: !!e.auto,
          replacePreview: preview
            ? {
                oldString: preview.oldString,
                newString: preview.newString,
                replaceAll: !!preview.replaceAll,
                matchCount: preview.matchCount ?? 1,
              }
            : undefined,
          diff: {
            additions: diff.additions,
            deletions: diff.deletions,
            truncated: diff.truncated,
            hunks: diff.hunks.map((h) => ({
              header: h.header,
              oldStart: h.oldStart,
              newStart: h.newStart,
              lines: h.lines.map((l) => ({
                kind: l.kind,
                text: l.text,
                oldLine: l.oldLine,
                newLine: l.newLine,
                segments: l.segments,
              })),
            })),
          },
        };
      }),
    });
  }

  get visible(): boolean {
    return this.panel.visible;
  }

  get viewColumn(): vscode.ViewColumn | undefined {
    return this.panel.viewColumn;
  }

  async copyCursorHandoff(): Promise<void> {
    const { copyCursorHandoff } = await import("../cursor/handoff");
    await copyCursorHandoff(this.context, this.orchestrator);
  }

  async retryWithLocalBlossom(): Promise<void> {
    await this.runDeescalateRetry();
  }

  postScratchpadState(): void {
    const st = scratchpadStatus(getScratchpad(this.context));
    this.post({
      type: "scratchpad",
      empty: st.empty,
      chars: st.chars,
    });
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
      detail: `v${this.context.extension.packageJSON.version} · ${health.detail} · ${stamp}`,
      pending: false,
    });
    if (opts?.announce) {
      void vscode.window.setStatusBarMessage(
        `Blossom: ${health.ok ? "backend OK" : "backend unreachable"} — ${health.detail}`,
        4000
      );
    }
  }

  private async handlePickImages(): Promise<void> {
    const picked = await pickImageAttachments();
    if (!picked.length) {
      return;
    }
    this.post({
      type: "imageAttachments",
      items: picked.map((a) => ({
        path: a.path,
        fileName: a.fileName,
        metadata: a.metadata,
      })),
    });
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private orchestratorEvents(turnFeedbackId: {
    id?: string;
  }): OrchestratorEvents {
    return {
      onStatus: (statusText, opts) => {
        const t = (statusText || "").trim();
        if (!t) {
          return;
        }
        this.post({
          type: "status",
          text: t,
          phaseOnly: !!opts?.phaseOnly,
        });
      },
      onMode: (mode, model, source) =>
        this.post({ type: "mode", mode, model, source }),
      onToken: (delta) => this.post({ type: "token", text: delta }),
      onStreamBreak: () => this.post({ type: "streamBreak" }),
      onThought: (thought) => {
        const step = (thought.step || "").toLowerCase();
        if (step === "model_reasoning" && thought.message?.trim()) {
          this.post({ type: "reasoning", text: thought.message });
        }
      },
      onTool: (name, detail) => this.post({ type: "tool", name, detail }),
      onPendingCommand: (req) =>
        this.post({
          type: "pendingCommand",
          id: req.id,
          command: req.command,
          cwd: req.cwd,
          root: req.root,
        }),
      onCommandResolved: (id, result) =>
        this.post({
          type: "commandResolved",
          id,
          decision: result.decision,
          detail: result.detail,
        }),
      onPendingStep: (req) =>
        this.post({
          type: "pendingStep",
          id: req.id,
          reason: req.reason,
          detail: req.detail,
        }),
      onStepResolved: (id, result) =>
        this.post({
          type: "stepResolved",
          id,
          decision: result.decision,
          detail: result.detail,
        }),
      onPendingAskUser: (req) =>
        this.post({
          type: "pendingAskUser",
          id: req.id,
          question: req.question,
          options: req.options,
        }),
      onAskUserResolved: (id, result) =>
        this.post({
          type: "askUserResolved",
          id,
          detail: result.detail,
          skipped: !!result.skipped,
        }),
      onPendingEdit: (edit, meta) => {
        const isDelete = edit.kind === "delete";
        const isNew = !isDelete && !edit.oldContent;
        const diff = isDelete
          ? diffFileContents(edit.oldContent || "", "")
          : diffFileContents(edit.oldContent || "", edit.newContent || "");
        const preview = edit.replacePreview;
        this.editDiffCache.set(edit.id, { ...edit });
        this.rememberSessionEdit(edit, "pending", !!meta?.autoApply);
        this.post({
          type: "pendingEdit",
          id: edit.id,
          path: edit.relativePath,
          isNew,
          isDelete,
          source:
            edit.source ||
            (isDelete ? "delete" : isNew ? "write_file" : "write_file"),
          autoApply: !!meta?.autoApply,
          replacePreview: preview
            ? {
                oldString: preview.oldString,
                newString: preview.newString,
                replaceAll: !!preview.replaceAll,
                matchCount: preview.matchCount ?? 1,
              }
            : undefined,
          diff: {
            additions: diff.additions,
            deletions: diff.deletions,
            truncated: diff.truncated,
            hunks: diff.hunks.map((h) => ({
              header: h.header,
              oldStart: h.oldStart,
              newStart: h.newStart,
              lines: h.lines.map((l) => ({
                kind: l.kind,
                text: l.text,
                oldLine: l.oldLine,
                newLine: l.newLine,
                segments: l.segments,
              })),
            })),
          },
        });
        // Realtime side-by-side for search_replace (GitHub-PR feel in the editor).
        if (
          edit.source === "search_replace" &&
          openDiffOnReplaceEnabled() &&
          !isDelete
        ) {
          void openPendingEditDiff(edit).catch(() => undefined);
        }
      },
      onEditNeedsApply: (id) => this.post({ type: "editNeedsApply", id }),
      onEditApplied: (id, path) => {
        this.orchestrator.noteFileApplied(path, true);
        const cached = this.editDiffCache.get(id) || getPendingEdit(id);
        if (cached) {
          this.rememberSessionEdit(cached, "applied", true);
        } else {
          const prev = this.sessionEdits.get(id);
          if (prev) {
            this.sessionEdits.set(id, { ...prev, status: "applied", auto: true });
          }
        }
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
      onFeedback: (info) => {
        turnFeedbackId.id = info.id;
      },
      onContextInject: (block) => {
        const preview =
          block.split("\n").find((l) => l.trim() && !l.startsWith("[")) ||
          block;
        this.post({
          type: "status",
          text: `Incorporating: ${preview.slice(0, 80)}${preview.length > 80 ? "…" : ""}`,
          phaseOnly: true,
        });
      },
      onScratchpad: (info) => {
        this.post({
          type: "scratchpad",
          empty: info.empty,
          chars: info.chars,
        });
      },
      onDone: (finalText, opts) => {
        this.post({
          type: "autoApply",
          enabled: this.orchestrator.getAutoApply(),
        });
        this.post({
          type: "fastMode",
          enabled: this.orchestrator.getFastMode(),
        });
        this.postScratchpadState();
        this.post({
          type: "assistantDone",
          text: finalText,
          feedbackId: turnFeedbackId.id,
          deescalateAvailable: !!opts?.deescalateAvailable,
        });
      },
      onError: (message) =>
        this.post({
          type: "error",
          text: message,
          question: this.lastAsk,
        }),
    };
  }

  private async runDeescalateRetry(): Promise<void> {
    if (!this.orchestrator.canDeescalate()) {
      this.post({
        type: "error",
        text: "No cloud answer available to retry locally.",
      });
      return;
    }
    this.post({ type: "assistantStart" });
    this.post({
      type: "status",
      text: "Retrying with local Blossom…",
      phaseOnly: true,
    });
    const turnFeedbackId: { id?: string } = {};
    await this.orchestrator.retryWithLocalBlossom(
      this.orchestratorEvents(turnFeedbackId)
    );
    void this.persistArchive();
  }

  private async onMessage(msg: {
    type: string;
    text?: string;
    editId?: string;
    commandId?: string;
    stepId?: string;
    askId?: string;
    optionIndex?: number;
    skipped?: boolean;
    decision?: string;
    command?: string;
    enabled?: boolean;
    feedbackId?: string;
    verdict?: string;
    attachments?: Array<{ path: string; fileName: string; metadata?: string }>;
    paths?: string[];
  }): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.postHealth();
        this.post({
          type: "autoApply",
          enabled: this.orchestrator.getAutoApply(),
        });
        this.post({
          type: "fastMode",
          enabled: this.orchestrator.getFastMode(),
        });
        this.postScratchpadState();
        this.postRestoreIfNeeded();
        break;
      case "editScratchpad":
        await vscode.commands.executeCommand("blossom.editScratchpad");
        break;
      case "openHistory":
        await vscode.commands.executeCommand("blossom.openChatHistory");
        break;
      case "pickImages":
        await this.handlePickImages();
        break;
      case "attachPaths": {
        const paths = msg.paths ?? [];
        const attachments: ImageAttachment[] = [];
        for (const p of paths) {
          const att = await buildImageAttachment(p);
          if (att) {
            attachments.push(att);
          }
        }
        this.post({
          type: "imageAttachments",
          items: attachments.map((a) => ({
            path: a.path,
            fileName: a.fileName,
            metadata: a.metadata,
          })),
        });
        break;
      }
      case "chat": {
        this.onActivate?.(this);
        const text = (msg.text ?? "").trim();
        const attachments: ImageAttachment[] = (msg.attachments ?? []).map(
          (a) => ({
            path: a.path,
            fileName: a.fileName,
            metadata: a.metadata,
          })
        );
        if (!text && attachments.length === 0) {
          return;
        }
        if (!text && attachments.length > 0) {
          this.post({
            type: "error",
            text: "Add a question or description with your image(s).",
          });
          return;
        }
        this.lastAsk = text;
        this.setTopicFromAsk(text);
        this.post({ type: "assistantStart" });
        if (attachments.length > 0) {
          this.post({
            type: "status",
            text: `${attachments.length} image(s) attached — checking routing…`,
          });
        }
        this.post({ type: "status", text: "Checking backend…", phaseOnly: true });
        const health = await checkHealth();
        this.post({
          type: "health",
          ok: health.ok,
          detail: `${health.detail} · ${new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}`,
          pending: false,
        });
        if (!health.ok) {
          // Soft warn — /health can flap while chat still works; don't hard-block.
          this.post({
            type: "status",
            text: `Backend looks down (${health.detail}). Trying the request anyway…`,
          });
        }
        let turnFeedbackId: { id?: string } = {};
        await this.orchestrator.handleUserMessage(
          text,
          this.orchestratorEvents(turnFeedbackId),
          { imageAttachments: attachments.length ? attachments : undefined }
        );
        void this.persistArchive();
        break;
      }
      case "cancel":
        this.orchestrator.cancel();
        break;
      case "deescalateRetry":
        await this.runDeescalateRetry();
        break;
      case "addContext": {
        const text = (msg.text ?? "").trim();
        if (!text) {
          break;
        }
        const result = this.orchestrator.addContextInject(text);
        if (result.ok) {
          this.post({
            type: "status",
            text: "Queued — will apply on the next agent step…",
            phaseOnly: true,
          });
        } else {
          this.post({
            type: "contextInjectError",
            error: result.error || "Could not add context",
          });
        }
        break;
      }
      case "clear":
        this.orchestrator.cancel();
        await this.persistArchive();
        this.orchestrator.clearHistory();
        this.clearTopic();
        this.beginFreshArchive();
        this.post({ type: "cleared" });
        this.post({
          type: "autoApply",
          enabled: this.orchestrator.getAutoApply(),
        });
        this.post({
          type: "fastMode",
          enabled: this.orchestrator.getFastMode(),
        });
        this.postScratchpadState();
        break;
      case "applyEdit":
        if (msg.editId) {
          try {
            const cached =
              getPendingEdit(msg.editId) || this.editDiffCache.get(msg.editId);
            const appliedPath = await this.orchestrator.applyEdit(msg.editId);
            this.orchestrator.noteFileApplied(appliedPath, false);
            if (cached) {
              this.rememberSessionEdit(cached, "applied", false);
            } else {
              const prev = this.sessionEdits.get(msg.editId);
              if (prev) {
                this.sessionEdits.set(msg.editId, {
                  ...prev,
                  status: "applied",
                  auto: false,
                });
              }
            }
            this.post({ type: "editApplied", id: msg.editId, path: appliedPath });
            void vscode.window.showInformationMessage(`Applied: ${appliedPath}`);
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            this.post({ type: "error", text: m });
          }
        }
        break;
      case "openEditDiff":
        if (msg.editId) {
          const pending =
            getPendingEdit(msg.editId) || this.editDiffCache.get(msg.editId);
          if (pending) {
            try {
              await openPendingEditDiff(pending);
            } catch (err) {
              const m = err instanceof Error ? err.message : String(err);
              this.post({ type: "error", text: m });
            }
          } else {
            this.post({
              type: "error",
              text: "Diff no longer available for this card.",
            });
          }
        }
        break;
      case "rejectEdit":
        if (msg.editId) {
          const cached =
            getPendingEdit(msg.editId) || this.editDiffCache.get(msg.editId);
          await this.orchestrator.rejectEdit(msg.editId);
          if (cached) {
            this.rememberSessionEdit(cached, "rejected", false);
          } else {
            const prev = this.sessionEdits.get(msg.editId);
            if (prev) {
              this.sessionEdits.set(msg.editId, {
                ...prev,
                status: "rejected",
              });
            }
          }
          this.post({ type: "editRejected", id: msg.editId });
        }
        break;
      case "resolveCommand": {
        const id = (msg.commandId ?? "").trim();
        const raw = (msg.decision ?? "").trim().toLowerCase();
        const decision =
          raw === "always" || raw === "allow_always"
            ? ("always" as const)
            : raw === "deny" || raw === "reject"
              ? ("deny" as const)
              : ("run" as const);
        if (id) {
          this.orchestrator.resolveCommand(id, decision);
        }
        break;
      }
      case "resolveStep": {
        const id = (msg.stepId ?? "").trim();
        const raw = (msg.decision ?? "").trim().toLowerCase();
        const decision =
          raw === "stop" || raw === "deny" || raw === "reject"
            ? ("stop" as const)
            : ("continue" as const);
        if (id) {
          this.orchestrator.resolveStep(id, decision);
        }
        break;
      }
      case "resolveAskUser": {
        const id = (msg.askId ?? "").trim();
        if (!id) {
          break;
        }
        if (msg.skipped === true || msg.decision === "skip") {
          this.orchestrator.resolveAskUser(id, { kind: "skip" });
          break;
        }
        const index = Number(msg.optionIndex);
        if (Number.isFinite(index) && index >= 0) {
          this.orchestrator.resolveAskUser(id, {
            kind: "choice",
            index: Math.floor(index),
          });
        } else {
          this.orchestrator.resolveAskUser(id, { kind: "skip" });
        }
        break;
      }
      case "setMode":
        break;
      case "setFastMode": {
        this.orchestrator.setFastMode(!!msg.enabled);
        this.post({
          type: "fastMode",
          enabled: this.orchestrator.getFastMode(),
        });
        this.post({
          type: "autoApply",
          enabled: this.orchestrator.getAutoApply(),
        });
        break;
      }
      case "checkHealth":
        await this.postHealth({ announce: true });
        break;
      case "submitFeedback": {
        const feedbackId = (msg.feedbackId ?? "").trim();
        const raw = (msg.verdict ?? "").trim().toLowerCase();
        const verdict =
          raw === "correct" || raw === "up" || raw === "good" || raw === "👍"
            ? ("correct" as const)
            : raw === "incorrect" || raw === "down" || raw === "bad" || raw === "👎"
              ? ("incorrect" as const)
              : null;
        if (!feedbackId || !verdict) {
          this.post({
            type: "feedbackResult",
            feedbackId,
            ok: false,
            error: "Missing feedback id or verdict",
          });
          break;
        }
        const result = await sendCorrectnessFeedback({ feedbackId, verdict });
        this.post({
          type: "feedbackResult",
          feedbackId,
          ok: result.ok,
          verdict,
          error: result.error,
          detail: result.detail,
        });
        if (result.ok && verdict === "correct") {
          // Reinforce durable coding memory on thumbs-up (soft-fail).
          const { learnCodingLesson } = await import("../memory/client");
          const snap = this.orchestrator.getArchiveSnapshot();
          const lastUser = [...snap.history]
            .reverse()
            .find((m) => m.role === "user");
          const lastAsst = [...snap.history]
            .reverse()
            .find((m) => m.role === "assistant");
          if (lastUser?.content && lastAsst?.content) {
            void learnCodingLesson({
              userPrompt: lastUser.content,
              answer: lastAsst.content,
              source: "blossom_assistant_thumbs_up",
            });
          }
        }
        if (
          result.ok &&
          verdict === "incorrect" &&
          this.orchestrator.canDeescalate()
        ) {
          const choice = await vscode.window.showInformationMessage(
            "Cloud answer marked incorrect. Retry with local Blossom?",
            "Retry locally",
            "Dismiss"
          );
          if (choice === "Retry locally") {
            await this.runDeescalateRetry();
          }
        }
        break;
      }
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
      --surface-1: color-mix(in srgb, var(--fg) 4%, var(--bg));
      --surface-2: color-mix(in srgb, var(--fg) 7%, var(--card));
      --user: color-mix(in srgb, var(--accent) 18%, transparent);
      --assistant: color-mix(in srgb, var(--fg) 6%, transparent);
      --danger: var(--vscode-errorForeground);
      --ok: var(--vscode-testing-iconPassed, #3fae5a);
      --radius: 8px;
      --radius-sm: 6px;
      --prose-lh: 1.55;
      --diff-add-fg: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-testing-iconPassed, #3fae5a));
      --diff-del-fg: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-errorForeground));
      --diff-add-bg: var(--vscode-diffEditor-insertedTextBackground, color-mix(in srgb, var(--diff-add-fg) 18%, transparent));
      --diff-del-bg: var(--vscode-diffEditor-removedTextBackground, color-mix(in srgb, var(--diff-del-fg) 16%, transparent));
      --diff-add-ih: var(--vscode-diffEditor-insertedLineBackground, color-mix(in srgb, var(--diff-add-fg) 40%, transparent));
      --diff-del-ih: var(--vscode-diffEditor-removedLineBackground, color-mix(in srgb, var(--diff-del-fg) 40%, transparent));
      --focus: var(--vscode-focusBorder, var(--accent));
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
      padding: 10px 12px 12px;
      gap: 8px;
    }
    header.chrome {
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex-shrink: 0;
    }
    .brand-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .brand-row img {
      width: 22px;
      height: 22px;
      border-radius: 5px;
      flex-shrink: 0;
    }
    .brand {
      font-size: 0.95rem;
      font-weight: 600;
      letter-spacing: 0.01em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .brand-status {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      flex: 1;
      color: var(--muted);
      font-size: 0.8em;
      line-height: 1.35;
    }
    .brand-status #healthText {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mode-line {
      color: var(--muted);
      font-size: 0.78em;
      line-height: 1.3;
      opacity: 0.85;
    }
    .mode-line:empty { display: none; }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      align-items: center;
    }
    .toolbar .btn-stop {
      margin-left: auto;
    }
    .busy-row {
      display: none;
      align-items: center;
      gap: 8px;
      min-height: 18px;
      margin-top: 4px;
      padding: 6px 8px;
      color: var(--muted);
      font-size: 0.85em;
      flex-shrink: 0;
      flex-wrap: nowrap;
      border: none;
      border-radius: var(--radius-sm);
      background: var(--surface-1);
    }
    .busy-row.on {
      display: flex;
    }
    .busy-reasoning-wrap {
      display: none;
      align-items: baseline;
      gap: 0;
      flex: 1;
      min-width: 0;
      overflow: hidden;
    }
    .busy-reasoning-wrap.on {
      display: flex;
    }
    .busy-reasoning-label {
      display: none;
    }
    .busy-reasoning {
      flex: 1;
      min-width: 0;
      max-height: 5em;
      overflow-x: hidden;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-style: italic;
      color: var(--muted);
      opacity: 0.9;
      line-height: 1.4;
      font-size: 0.92em;
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
    @media (prefers-reduced-motion: reduce) {
      .spinner { animation: none; border-top-color: color-mix(in srgb, var(--fg) 45%, transparent); opacity: 0.85; }
      * { scroll-behavior: auto !important; }
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
      border: 1px solid transparent;
      background: var(--surface-1);
      color: var(--fg);
      border-radius: var(--radius-sm);
      padding: 4px 9px;
      cursor: pointer;
      font: inherit;
      transition: background 0.12s ease, border-color 0.12s ease, opacity 0.12s ease;
    }
    button:hover:not(:disabled), .chip:hover:not(:disabled) {
      background: var(--surface-2);
      border-color: color-mix(in srgb, var(--border) 70%, transparent);
    }
    button:focus-visible, .chip:focus-visible {
      outline: 1px solid var(--focus);
      outline-offset: 1px;
    }
    button:active:not(:disabled), .chip:active:not(:disabled) {
      opacity: 0.92;
    }
    button.primary {
      background: var(--accent);
      color: var(--accent-fg);
      border-color: transparent;
    }
    button.primary:hover:not(:disabled) {
      filter: brightness(1.08);
      background: var(--accent);
      border-color: transparent;
    }
    button:disabled { opacity: 0.5; cursor: default; }
    .chip {
      border-color: color-mix(in srgb, var(--border) 55%, transparent);
      background: var(--card);
    }
    .chip.active {
      border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
      background: color-mix(in srgb, var(--accent) 22%, transparent);
    }
    .toolbar button, .toolbar .chip {
      font-size: 0.82em;
      padding: 3px 8px;
    }
    #messages {
      flex: 1;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding: 2px 0 10px;
      min-height: 0;
    }
    /* Do not flex-shrink cards — that crushed diff views into a 1-line strip. */
    #messages > * {
      flex-shrink: 0;
    }
    .msg {
      padding: 10px 12px;
      border-radius: var(--radius);
      white-space: pre-wrap;
      word-break: break-word;
      line-height: var(--prose-lh);
      border: none;
    }
    .msg.user { background: var(--user); }
    .msg.assistant { background: var(--assistant); }
    .tool {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.85em;
      line-height: 1.5;
      color: var(--muted);
      white-space: pre-wrap;
      word-break: break-word;
      padding: 8px 10px;
      border-radius: var(--radius-sm);
      border: none;
      background: var(--surface-1);
      max-height: 220px;
      overflow: auto;
    }
    .tool .tool-hd {
      color: color-mix(in srgb, var(--fg) 78%, var(--muted));
      font-weight: 600;
      margin-bottom: 2px;
    }
    .tool .tool-bd {
      white-space: pre-wrap;
      word-break: break-word;
    }
    .msg.assistant.rich {
      white-space: normal;
      background: transparent;
      border: none;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .feedback-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 2px;
      padding: 2px 0;
    }
    .feedback-row .fb-label {
      color: var(--muted);
      font-size: 0.8em;
      margin-right: 2px;
    }
    .feedback-row button {
      padding: 2px 8px;
      font-size: 0.8em;
      line-height: 1.3;
    }
    .feedback-row button.active-up {
      border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
      background: color-mix(in srgb, var(--accent) 22%, transparent);
    }
    .feedback-row button.active-down {
      border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
      background: color-mix(in srgb, var(--danger) 18%, transparent);
    }
    .feedback-row .fb-status {
      color: var(--muted);
      font-size: 0.8em;
    }
    .deescalate-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 4px;
      padding: 2px 0;
    }
    .deescalate-row button {
      font-size: 0.85em;
      padding: 4px 10px;
    }
    .deescalate-row .de-label {
      color: var(--muted);
      font-size: 0.8em;
    }
    .msg.system {
      color: var(--muted);
      background: transparent;
      border: 1px dashed color-mix(in srgb, var(--border) 80%, transparent);
      font-size: 0.9em;
    }
    .msg.error { color: var(--danger); }
    .error-card {
      position: relative;
      border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border));
      border-radius: var(--radius);
      background: color-mix(in srgb, var(--danger) 8%, var(--card));
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .error-card-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }
    .error-card-title {
      font-weight: 600;
      color: var(--danger);
      font-size: 0.9em;
    }
    .error-card-retry {
      flex-shrink: 0;
      margin-left: auto;
    }
    .error-card-question {
      font-size: 0.9em;
      line-height: var(--prose-lh);
      white-space: pre-wrap;
      word-break: break-word;
      padding: 8px 10px;
      border-radius: var(--radius-sm);
      background: var(--surface-1);
      border: none;
      color: var(--fg);
    }
    .error-card-question-label {
      font-size: 0.78em;
      font-weight: 600;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .error-card-detail {
      color: var(--danger);
      font-size: 0.85em;
      opacity: 0.95;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .reply-section, .code-box {
      border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
      border-radius: var(--radius-sm);
      overflow: hidden;
      background: var(--card);
    }
    .reply-eyebrow {
      font-size: 0.8em;
      font-weight: 600;
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
      border-left: 2px solid color-mix(in srgb, var(--fg) 14%, transparent);
    }
    .file-action {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
      border-radius: var(--radius-sm);
      background: var(--card);
      font-size: 0.9em;
    }
    .file-action.delete {
      border-color: color-mix(in srgb, var(--danger) 40%, var(--border));
      background: color-mix(in srgb, var(--danger) 8%, var(--card));
    }
    .file-action-label {
      font-size: 0.8em;
      font-weight: 600;
      color: var(--danger);
      flex-shrink: 0;
    }
    .file-action-path {
      font-family: var(--vscode-editor-font-family, monospace);
      font-weight: 600;
    }
    .reply-section-hd {
      font-size: 0.8em;
      font-weight: 600;
      padding: 6px 10px;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
      background: var(--surface-2);
      color: var(--muted);
    }
    .code-box-hd {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 6px 10px;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
      background: var(--surface-2);
      font-size: 0.82rem;
      font-weight: 600;
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--fg);
    }
    .code-box-hd .lang {
      margin-left: auto;
      font-size: 0.72rem;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: var(--muted);
      font-family: var(--vscode-font-family);
      text-transform: uppercase;
    }
    .reply-section-bd {
      padding: 8px 12px 10px;
      line-height: var(--prose-lh);
    }
    .reply-section-bd p {
      margin: 0 0 8px;
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
      line-height: var(--prose-lh);
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
      top: 0.5em;
      width: 0.55em;
      height: 0.55em;
      border-radius: 2px;
      background: var(--ok);
    }
    .reply-prose {
      line-height: var(--prose-lh);
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
      line-height: 1.5;
      background: color-mix(in srgb, var(--bg) 70%, var(--card));
    }
    .inline-code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.9em;
      padding: 0.1em 0.35em;
      border-radius: 4px;
      background: color-mix(in srgb, var(--fg) 10%, transparent);
      border: none;
    }
    .edit {
      border: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
      border-radius: var(--radius);
      padding: 0;
      overflow: hidden;
      background: color-mix(in srgb, var(--bg) 55%, var(--card));
    }
    .diff-file-hd {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
      background: var(--surface-2);
    }
    .diff-file-icon {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      flex-shrink: 0;
      background: var(--accent);
      opacity: 0.85;
    }
    .diff-file-name {
      flex: 1;
      min-width: 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.92em;
      font-weight: 600;
      color: color-mix(in srgb, var(--fg) 88%, transparent);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .diff-file-stats {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.8em;
      font-weight: 600;
      flex-shrink: 0;
    }
    .diff-file-stats .add { color: var(--diff-add-fg); }
    .diff-file-stats .del { color: var(--diff-del-fg); margin-left: 6px; }
    .diff-file-badge {
      font-size: 0.75em;
      font-weight: 600;
      color: color-mix(in srgb, var(--accent) 85%, var(--fg));
      border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
      border-radius: 4px;
      padding: 1px 6px;
      flex-shrink: 0;
    }
    .diff-replace {
      border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.88em;
      line-height: 1.55;
    }
    .diff-replace-hd {
      padding: 8px 12px 4px;
      font-size: 0.8em;
      font-weight: 600;
      color: var(--muted);
    }
    .diff-replace-hd.del { color: var(--diff-del-fg); }
    .diff-replace-hd.add { color: var(--diff-add-fg); }
    .diff-view {
      max-height: min(560px, 55vh);
      overflow: auto;
      margin: 0;
      background: transparent;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.88em;
      line-height: 1.55;
    }
    .diff-hunk-hd {
      padding: 6px 12px;
      color: color-mix(in srgb, var(--fg) 45%, transparent);
      background: color-mix(in srgb, var(--fg) 4%, transparent);
      user-select: none;
      font-size: 0.92em;
    }
    .diff-hunk + .diff-hunk {
      border-top: 1px solid color-mix(in srgb, var(--fg) 10%, transparent);
    }
    .diff-line {
      display: grid;
      grid-template-columns: 48px 18px minmax(0, 1fr);
      white-space: pre-wrap;
      word-break: break-word;
      min-height: 1.55em;
      padding: 1px 0;
    }
    .diff-line .ln {
      text-align: right;
      padding: 0 8px 0 6px;
      color: color-mix(in srgb, var(--fg) 35%, transparent);
      user-select: none;
      font-variant-numeric: tabular-nums;
    }
    .diff-line .gutter {
      text-align: center;
      user-select: none;
      opacity: 0.85;
      font-weight: 600;
    }
    .diff-line .body {
      padding-right: 12px;
      min-width: 0;
    }
    .diff-line.add { background: var(--diff-add-bg); }
    .diff-line.del { background: var(--diff-del-bg); }
    .diff-line.ctx { color: color-mix(in srgb, var(--fg) 72%, transparent); }
    .diff-line.add .gutter { color: var(--diff-add-fg); }
    .diff-line.del .gutter { color: var(--diff-del-fg); }
    .diff-line .ih { border-radius: 2px; }
    .diff-line.del .ih {
      background: var(--diff-del-ih);
    }
    .diff-line.add .ih {
      background: var(--diff-add-ih);
    }
    .diff-empty {
      padding: 10px 12px;
      color: var(--muted);
      font-style: italic;
    }
    .edit .row { padding: 10px 12px 12px; }
    .edit .cmd-card-status { padding: 8px 12px 12px; }
    .cmd-card {
      border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
      border-radius: var(--radius);
      background: color-mix(in srgb, var(--accent) 8%, var(--card));
      padding: 10px 12px;
    }
    .cmd-card.resolved {
      border-style: dashed;
      border-color: var(--border);
      background: var(--card);
      opacity: 0.92;
    }
    .cmd-card.denied {
      border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
    }
    .cmd-card-title {
      font-weight: 600;
      margin-bottom: 6px;
      color: var(--fg);
    }
    .cmd-card-cmd {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.92em;
      white-space: pre-wrap;
      word-break: break-word;
      padding: 6px 8px;
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--fg) 6%, transparent);
      margin: 0 0 6px;
    }
    .cmd-card-meta {
      color: var(--muted);
      font-size: 0.9em;
      margin-bottom: 8px;
    }
    .cmd-card-status {
      color: var(--muted);
      margin-top: 6px;
    }
    .ask-card-question {
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0 0 10px;
      line-height: 1.45;
    }
    .ask-card-options {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 8px;
    }
    .ask-card-options button {
      text-align: left;
      white-space: normal;
      line-height: 1.35;
    }
    .summary-card {
      border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
      border-radius: var(--radius);
      background: color-mix(in srgb, var(--accent) 8%, var(--card));
      margin-top: 4px;
      padding: 10px 12px;
    }
    .summary-card .title {
      font-weight: 600;
      margin-bottom: 8px;
    }
    .summary-card ul {
      margin: 0;
      padding-left: 1.2em;
    }
    .summary-card li {
      margin: 4px 0;
      line-height: var(--prose-lh);
    }
    .edit pre {
      max-height: 280px;
      overflow: auto;
      margin: 8px 0;
      white-space: pre-wrap;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.88em;
      line-height: 1.55;
    }
    .composer {
      display: flex;
      flex-direction: column;
      gap: 6px;
      border-top: 1px solid color-mix(in srgb, var(--border) 65%, transparent);
      padding-top: 10px;
      flex-shrink: 0;
    }
    .attach-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      min-height: 0;
    }
    .attach-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.82em;
      padding: 3px 8px;
      border-radius: var(--radius-sm);
      background: var(--surface-1);
      border: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
      max-width: 100%;
    }
    .attach-chip button {
      border: none;
      background: transparent;
      cursor: pointer;
      padding: 0 2px;
      font-size: 1em;
      line-height: 1;
      opacity: 0.7;
    }
    .attach-chip button:hover { opacity: 1; background: transparent; }
    .msg.user.context-inject {
      border-left: 3px solid var(--vscode-textLink-foreground, var(--accent));
      border-radius: 0 var(--radius) var(--radius) 0;
      opacity: 0.95;
    }
    .context-inject-label {
      font-size: 0.78em;
      font-weight: 600;
      opacity: 0.75;
      margin-bottom: 4px;
    }
    .context-inject-body {
      white-space: pre-wrap;
    }
    .composer-box {
      display: flex;
      flex-direction: column;
      gap: 0;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
      border-radius: var(--radius);
      overflow: hidden;
    }
    .composer-box:focus-within {
      outline: 1px solid var(--focus);
      border-color: var(--focus);
    }
    textarea {
      width: 100%;
      min-height: 72px;
      resize: vertical;
      background: transparent;
      color: inherit;
      border: none;
      border-radius: 0;
      padding: 10px 10px 6px;
      font: inherit;
      line-height: var(--prose-lh);
      outline: none;
    }
    .composer-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      padding: 6px 8px 8px;
      border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
    }
    .composer-actions .spacer {
      flex: 1;
      min-width: 4px;
    }
    .composer-actions button {
      font-size: 0.88em;
      padding: 4px 10px;
    }
    .dot {
      width: 7px; height: 7px; border-radius: 50%;
      display: inline-block; flex-shrink: 0;
      background: var(--danger);
    }
    .dot.ok { background: var(--ok); }
  </style>
</head>
<body>
  <header class="chrome">
    <div class="brand-row">
      <img src="${iconUri}" alt="" />
      <div class="brand">${escapeHtml(displayName)}</div>
      <div class="brand-status" id="health" title="Backend status">
        <span class="dot" id="healthDot" aria-hidden="true"></span>
        <span id="healthText">Checking backend…</span>
      </div>
    </div>
    <div class="mode-line" id="modeLine">Coding assistant</div>
    <div class="toolbar" role="toolbar" aria-label="Chat actions">
      <button type="button" class="chip" id="btnScratchpad" title="Workspace working notes injected into each coding turn">Scratchpad</button>
      <button type="button" class="chip" id="btnHistory" title="Open a previously saved Blossom chat">History</button>
      <button type="button" id="btnHealth" title="Recheck Blossom / Ollama">Ping</button>
      <button type="button" id="btnClear" title="Clear conversation (current chat stays in History)">Clear</button>
      <button type="button" class="btn-stop" id="btnCancel" title="Stop the current turn">Stop</button>
    </div>
  </header>
  <div id="messages" role="log" aria-relevant="additions">
    <div class="busy-row" id="busyRow" aria-hidden="true">
      <div class="spinner" id="busySpinner" aria-hidden="true" title="Working…"></div>
      <span id="busyLabel">Working…</span>
      <div id="busyReasoningWrap" class="busy-reasoning-wrap" aria-live="polite">
        <span class="busy-reasoning-label">Blossom Thinking</span>
        <span id="busyReasoning" class="busy-reasoning"></span>
      </div>
    </div>
  </div>
  <div class="composer">
    <div class="attach-row" id="attachRow" hidden></div>
    <div class="composer-box">
      <textarea id="input" placeholder="Ask your coding assistant…" aria-label="Message"></textarea>
      <div class="composer-actions">
        <button type="button" class="chip" id="btnFastMode" title="Fast mode: auto-run shell commands and auto-apply edits. Click again to turn off.">Fast</button>
        <div class="spacer"></div>
        <button type="button" id="btnAttach" title="Attach PNG/JPEG/WebP/GIF for local vision captioning">Attach image</button>
        <button type="button" class="primary" id="btnSend">Send</button>
      </div>
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
    let reasoningText = '';
    let reasoningDoneTimer = null;
    let lastAsk = '';
    let busy = false;
    let pendingAttachments = [];

    function renderAttachmentChips() {
      const row = document.getElementById('attachRow');
      if (!row) return;
      row.innerHTML = '';
      if (!pendingAttachments.length) {
        row.hidden = true;
        return;
      }
      row.hidden = false;
      for (let i = 0; i < pendingAttachments.length; i++) {
        const a = pendingAttachments[i];
        const chip = document.createElement('span');
        chip.className = 'attach-chip';
        chip.title = a.metadata || a.path || '';
        const label = document.createElement('span');
        label.textContent = a.fileName || 'image';
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.textContent = '×';
        rm.setAttribute('aria-label', 'Remove ' + (a.fileName || 'image'));
        rm.title = 'Remove';
        rm.onclick = () => {
          pendingAttachments.splice(i, 1);
          renderAttachmentChips();
        };
        chip.appendChild(label);
        chip.appendChild(rm);
        row.appendChild(chip);
      }
    }

    function appendContextInject(text) {
      const el = document.createElement('div');
      el.className = 'msg user context-inject';
      const label = document.createElement('div');
      label.className = 'context-inject-label';
      label.textContent = 'Context added';
      const body = document.createElement('div');
      body.className = 'context-inject-body';
      const t = String(text || '').trim();
      body.textContent = t.length > 280 ? (t.slice(0, 277) + '…') : t;
      body.title = t;
      el.appendChild(label);
      el.appendChild(body);
      messagesEl.appendChild(el);
      pinBusyToBottom();
    }

    function sendText(text, opts) {
      const ask = (text || '').trim();
      if (!ask) return;
      if (busy && !(opts && opts.retry)) {
        appendContextInject(ask);
        input.value = '';
        vscode.postMessage({ type: 'addContext', text: ask });
        return;
      }
      if ((!ask && !pendingAttachments.length) || busy) return;
      if (!ask && pendingAttachments.length) {
        append('assistant', 'Add a question or description with your image(s).');
        return;
      }
      const isRetry = opts && opts.retry;
      const attachments = pendingAttachments.slice();
      lastAsk = ask;
      if (!isRetry) {
        let userBody = ask;
        if (attachments.length) {
          userBody += '\\n\\n[' + attachments.length + ' image(s): ' +
            attachments.map((a) => a.fileName).join(', ') + ']';
        }
        append('user', userBody);
        input.value = '';
        pendingAttachments = [];
        renderAttachmentChips();
      } else {
        const note = document.createElement('div');
        note.className = 'tool';
        note.textContent = 'Retrying…';
        messagesEl.appendChild(note);
        pinBusyToBottom();
      }
      setBusy(true);
      setBusyLabel(isRetry ? 'Retrying…' : 'Working…');
      streamingEl = null;
      vscode.postMessage({ type: 'chat', text: ask, attachments: attachments });
    }

    function showErrorCard(errorText, question) {
      const ask = (question || lastAsk || '').trim();
      const card = document.createElement('div');
      card.className = 'error-card';

      const top = document.createElement('div');
      top.className = 'error-card-top';
      const title = document.createElement('div');
      title.className = 'error-card-title';
      title.textContent = 'Request failed';
      top.appendChild(title);

      if (ask) {
        const retry = document.createElement('button');
        retry.className = 'primary error-card-retry';
        retry.textContent = 'Retry';
        retry.title = 'Send this question again';
        retry.onclick = () => {
          retry.disabled = true;
          sendText(ask, { retry: true });
        };
        top.appendChild(retry);
      }
      card.appendChild(top);

      if (ask) {
        const qWrap = document.createElement('div');
        const qLabel = document.createElement('div');
        qLabel.className = 'error-card-question-label';
        qLabel.textContent = 'Question';
        const qBody = document.createElement('div');
        qBody.className = 'error-card-question';
        qBody.textContent = ask;
        qWrap.appendChild(qLabel);
        qWrap.appendChild(qBody);
        card.appendChild(qWrap);
      }

      const detail = document.createElement('div');
      detail.className = 'error-card-detail';
      detail.textContent = errorText || 'Unknown error';
      card.appendChild(detail);

      messagesEl.appendChild(card);
      pinBusyToBottom();
    }

    function cleanReasoningText(text) {
      return String(text || '')
        .replace(/^(?:thought\\s+)?step\\s*=\\s*model_reasoning\\s*/i, '')
        .replace(/^model_reasoning\\s*/i, '')
        .trim();
    }

    function ensureBusyRowVisible() {
      const row = document.getElementById('busyRow');
      if (!row) return;
      row.classList.add('on');
      row.setAttribute('aria-hidden', 'false');
      pinBusyToBottom();
    }

    /** Live model reasoning beside the busy spinner (streamed, not stepped). */
    function setReasoningTicker(text) {
      if (!busy) return;
      const cleaned = cleanReasoningText(text);
      if (!cleaned) return;
      reasoningText = cleaned;
      const wrap = document.getElementById('busyReasoningWrap');
      const el = document.getElementById('busyReasoning');
      const label = document.getElementById('busyLabel');
      if (!wrap || !el) return;
      ensureBusyRowVisible();
      wrap.classList.add('on');
      if (label) label.style.display = 'none';
      el.textContent = reasoningText;
      el.title = reasoningText;
      el.scrollTop = el.scrollHeight;
      pinBusyToBottom();
    }

    function finishReasoningTicker() {
      if (reasoningDoneTimer) {
        clearTimeout(reasoningDoneTimer);
        reasoningDoneTimer = null;
      }
      const wrap = document.getElementById('busyReasoningWrap');
      const el = document.getElementById('busyReasoning');
      const label = document.getElementById('busyLabel');
      const row = document.getElementById('busyRow');
      const spinner = document.getElementById('busySpinner');
      if (wrap) wrap.classList.remove('on');
      if (el) {
        el.textContent = '';
        el.removeAttribute('title');
      }
      if (label) {
        label.style.display = '';
        label.textContent = 'Working…';
      }
      if (spinner) spinner.style.display = '';
      reasoningText = '';
      if (row && !busy) {
        row.classList.remove('on');
        row.setAttribute('aria-hidden', 'true');
      }
    }

    function completeReasoningTicker() {
      if (reasoningDoneTimer) {
        clearTimeout(reasoningDoneTimer);
        reasoningDoneTimer = null;
      }
      const wrap = document.getElementById('busyReasoningWrap');
      const el = document.getElementById('busyReasoning');
      const label = document.getElementById('busyLabel');
      const row = document.getElementById('busyRow');
      const spinner = document.getElementById('busySpinner');
      const hadReasoning = Boolean(reasoningText);
      reasoningText = '';
      if (!hadReasoning) {
        if (row && !busy) {
          row.classList.remove('on');
          row.setAttribute('aria-hidden', 'true');
        }
        return;
      }
      if (row) {
        row.classList.add('on');
        row.setAttribute('aria-hidden', 'false');
      }
      if (spinner) spinner.style.display = 'none';
      if (label) label.style.display = 'none';
      if (wrap && el) {
        wrap.classList.add('on');
        el.textContent = 'Done';
        el.title = 'Done';
        el.style.fontStyle = 'normal';
        el.style.opacity = '0.75';
      }
      pinBusyToBottom();
      reasoningDoneTimer = setTimeout(() => {
        reasoningDoneTimer = null;
        if (el) {
          el.style.fontStyle = '';
          el.style.opacity = '';
        }
        finishReasoningTicker();
      }, 900);
    }

    function resetReasoningTicker() {
      if (reasoningDoneTimer) {
        clearTimeout(reasoningDoneTimer);
        reasoningDoneTimer = null;
      }
      reasoningText = '';
      const wrap = document.getElementById('busyReasoningWrap');
      const el = document.getElementById('busyReasoning');
      const label = document.getElementById('busyLabel');
      const spinner = document.getElementById('busySpinner');
      if (wrap) wrap.classList.remove('on');
      if (el) {
        el.textContent = '';
        el.removeAttribute('title');
        el.style.fontStyle = '';
        el.style.opacity = '';
      }
      if (label) {
        label.style.display = '';
        label.textContent = 'Working…';
      }
      if (spinner) spinner.style.display = '';
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

    /** Seal the open streaming bubble with rich markdown; next token opens a new one. */
    function sealStreamingBubble() {
      if (!streamingEl) return;
      const body = streamingEl.textContent || '';
      if (body.trim()) {
        renderAssistant(streamingEl, body);
      } else {
        streamingEl.remove();
      }
      streamingEl = null;
    }

    /**
     * Split a long live stream into separate bubbles at natural segment markers
     * (closed scratchpad fences, Edit/Summary headings) so narration is not one wall.
     */
    function splitStreamingOnMarkers() {
      if (!streamingEl) return;
      let body = streamingEl.textContent || '';
      let guard = 0;
      while (guard++ < 12) {
        let cut = -1;
        const scratch = body.match(/\`\`\`scratchpad\\r?\\n[\\s\\S]*?\`\`\`/);
        if (scratch && typeof scratch.index === 'number') {
          cut = scratch.index + scratch[0].length;
        } else {
          const heading = body.match(/\\n\\n(?:#{1,3}\\s+|\\*\\*Edit:\\*\\*|\\*\\*Summary\\*\\*|###\\s+Summary\\b)/i);
          if (heading && typeof heading.index === 'number' && heading.index >= 80) {
            cut = heading.index;
          }
        }
        if (cut < 0) break;
        const head = body.slice(0, cut).replace(/\\s+$/, '');
        const tail = body.slice(cut).replace(/^\\r?\\n+/, '');
        if (!head.trim() || !tail.trim()) break;
        const ticks = (head.match(/\`\`\`/g) || []).length;
        if (ticks % 2 !== 0) break;
        renderAssistant(streamingEl, head);
        streamingEl = null;
        streamingEl = append('assistant', tail);
        body = tail;
      }
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
      if (/^(DELETE|REMOVE)(?:[_\s]+FILE)?$/i.test(c)) return true;
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

    function parseReplyBlocks(text, opts) {
      const preserveFileFences = !!(opts && opts.preserveFileFences);
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
        // Shell tool requests are approval cards — never show as Code boxes.
        if (/^tool_call$/i.test(lang)) {
          last = m.index + m[0].length;
          continue;
        }
        let filePath = pathM ? pathM[1].replace(/\\\\/g, '/') : '';
        // Filename-as-lang style (e.g. blog.php) — treat as path
        if (!filePath && lang && /\\.[\\w]{1,8}$/.test(lang) && !/[=:]/.test(lang)) {
          filePath = lang;
          lang = '';
        }
        // Live turns: path-labeled dumps become diff cards — show path, skip body.
        // History restore without archived edits: keep the fence body so code is visible.
        if (
          !preserveFileFences &&
          filePath &&
          /\\b(?:path|file)\\s*[=:]/i.test(info) &&
          !/\\b(?:delete|remove)\\b/i.test(info)
        ) {
          blocks.push({ type: 'prose', body: '**Edit:** \`' + filePath + '\`' });
          last = m.index + m[0].length;
          continue;
        }
        blocks.push({
          type: 'code',
          path: filePath,
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

    function renderAssistant(el, text, opts) {
      el.classList.add('rich');
      el.textContent = '';
      const blocks = parseReplyBlocks(text || '', opts);
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

    function attachFeedback(afterEl, feedbackId) {
      if (!feedbackId || !afterEl) return;
      const row = document.createElement('div');
      row.className = 'feedback-row';
      row.dataset.feedbackId = feedbackId;
      const label = document.createElement('span');
      label.className = 'fb-label';
      label.textContent = 'Was this helpful?';
      const up = document.createElement('button');
      up.type = 'button';
      up.title = 'Correct';
      up.setAttribute('aria-label', 'Helpful');
      up.textContent = 'Helpful';
      const down = document.createElement('button');
      down.type = 'button';
      down.title = 'Incorrect';
      down.setAttribute('aria-label', 'Not helpful');
      down.textContent = 'Not helpful';
      const status = document.createElement('span');
      status.className = 'fb-status';
      const lock = (verdict) => {
        up.disabled = true;
        down.disabled = true;
        if (verdict === 'correct') up.classList.add('active-up');
        if (verdict === 'incorrect') down.classList.add('active-down');
      };
      up.onclick = () => {
        lock('correct');
        status.textContent = 'Sending…';
        vscode.postMessage({ type: 'submitFeedback', feedbackId: feedbackId, verdict: 'correct' });
      };
      down.onclick = () => {
        lock('incorrect');
        status.textContent = 'Sending…';
        vscode.postMessage({ type: 'submitFeedback', feedbackId: feedbackId, verdict: 'incorrect' });
      };
      row.appendChild(label);
      row.appendChild(up);
      row.appendChild(down);
      row.appendChild(status);
      afterEl.insertAdjacentElement('afterend', row);
    }

    function attachDeescalate(afterEl) {
      if (!afterEl) return;
      const row = document.createElement('div');
      row.className = 'deescalate-row';
      const label = document.createElement('span');
      label.className = 'de-label';
      label.textContent = 'Cloud answer not enough?';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Retry with local Blossom';
      btn.title = 'Re-run local Blossom using the cloud answer as read-only reference';
      btn.onclick = () => {
        btn.disabled = true;
        row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        vscode.postMessage({ type: 'deescalateRetry' });
      };
      row.appendChild(label);
      row.appendChild(btn);
      afterEl.insertAdjacentElement('afterend', row);
    }

    function setBusyLabel(text) {
      const label = document.getElementById('busyLabel');
      const wrap = document.getElementById('busyReasoningWrap');
      if (!label) return;
      const t = String(text || '').trim();
      if (!t) return;
      const short = t.length > 90 ? (t.slice(0, 89) + '…') : t;
      label.textContent = short;
      label.title = t;
      // Reasoning ticker owns the row when active; keep label text ready underneath.
      if (!wrap || !wrap.classList.contains('on')) {
        label.style.display = '';
      }
    }

    function setBusy(v) {
      busy = v;
      document.body.setAttribute('aria-busy', v ? 'true' : 'false');
      const sendBtn = document.getElementById('btnSend');
      if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.textContent = v ? 'Add context' : 'Send';
        sendBtn.title = v
          ? 'Add context for the current task (does not stop the agent)'
          : 'Send message';
      }
      const attachBtn = document.getElementById('btnAttach');
      if (attachBtn) attachBtn.disabled = v;
      if (input) {
        input.placeholder = v
          ? 'Add context for the current task…'
          : 'Ask your coding assistant…';
      }
      const row = document.getElementById('busyRow');
      if (row) {
        if (v) {
          row.classList.add('on');
          row.setAttribute('aria-hidden', 'false');
          setBusyLabel('Working…');
        } else if (reasoningText) {
          // Skip remaining flavor sentences — flash Done then hide.
          completeReasoningTicker();
        } else {
          row.classList.remove('on');
          row.setAttribute('aria-hidden', 'true');
          resetReasoningTicker();
        }
      }
      pinBusyToBottom();
    }

    function send() {
      sendText(input.value, { retry: false });
    }

    document.getElementById('btnAttach').addEventListener('click', () => {
      vscode.postMessage({ type: 'pickImages' });
    });
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
    document.getElementById('btnFastMode').addEventListener('click', () => {
      const btn = document.getElementById('btnFastMode');
      const next = !btn.classList.contains('active');
      vscode.postMessage({ type: 'setFastMode', enabled: next });
    });
    const btnScratchpad = document.getElementById('btnScratchpad');
    if (btnScratchpad) {
      btnScratchpad.addEventListener('click', () => {
        vscode.postMessage({ type: 'editScratchpad' });
      });
    }
    const btnHistory = document.getElementById('btnHistory');
    if (btnHistory) {
      btnHistory.addEventListener('click', () => {
        vscode.postMessage({ type: 'openHistory' });
      });
    }

    function wipeMessages() {
      pendingAttachments = [];
      renderAttachmentChips();
      messagesEl.innerHTML = '';
      lastAsk = '';
      resetReasoningTicker();
      streamingEl = null;
      const row = document.createElement('div');
      row.className = 'busy-row';
      row.id = 'busyRow';
      row.setAttribute('aria-hidden', 'true');
      row.innerHTML = '<div class="spinner" id="busySpinner" aria-hidden="true" title="Working…"></div><span id="busyLabel">Working…</span><div id="busyReasoningWrap" class="busy-reasoning-wrap" aria-live="polite"><span class="busy-reasoning-label">Blossom Thinking</span><span id="busyReasoning" class="busy-reasoning"></span></div>';
      messagesEl.appendChild(row);
    }

    function onHostMessage(msg) {
      if (!msg || !msg.type) return;
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
        case 'autoApply':
          break;
        case 'fastMode': {
          const btn = document.getElementById('btnFastMode');
          if (!btn) break;
          if (msg.enabled) {
            btn.classList.add('active');
            btn.textContent = 'Fast on';
            btn.title = 'Fast mode on — commands auto-run and edits auto-apply. Click to turn off.';
          } else {
            btn.classList.remove('active');
            btn.textContent = 'Fast';
            btn.title = 'Fast mode: auto-run shell commands and auto-apply edits. Click again to turn off.';
          }
          break;
        }
        case 'scratchpad':
          break;
        case 'assistantStart':
          resetReasoningTicker();
          streamingEl = null;
          setBusyLabel('Starting…');
          break;
        case 'status': {
          const t = (msg.text || '').trim();
          if (t) setBusyLabel(t);
          break;
        }
        case 'reasoning':
          setReasoningTicker(msg.text || '');
          pinBusyToBottom();
          break;
        case 'thought':
          // Legacy trail box removed — ignore pipeline thought steps entirely.
          break;
        case 'token':
          // Do NOT clear the reasoning ticker here — ChatRouter often emits
          // model_reasoning immediately before answer tokens, so wiping on
          // first token made the ticker invisible. Keep sentences rotating.
          if (!streamingEl) streamingEl = append('assistant', '');
          streamingEl.textContent += msg.text;
          splitStreamingOnMarkers();
          pinBusyToBottom();
          break;
        case 'streamBreak':
          // Seal the current assistant bubble so Apply / ✓ cards sit between
          // segments; the next token opens a new bubble.
          sealStreamingBubble();
          pinBusyToBottom();
          break;
        case 'tool': {
          // Keep tool rows outside the prose bubble (and restore markdown style).
          sealStreamingBubble();
          const t = document.createElement('div');
          t.className = 'tool';
          const hd = document.createElement('div');
          hd.className = 'tool-hd';
          const bd = document.createElement('div');
          bd.className = 'tool-bd';
          if (msg.name === 'editor_context') {
            hd.textContent = 'Attached';
            bd.textContent = msg.detail || '';
          } else if (msg.name === 'run_command') {
            hd.textContent = 'Command';
            bd.textContent = msg.detail || '';
          } else {
            hd.textContent = 'Tool · ' + msg.name;
            bd.textContent = msg.detail || '';
          }
          t.appendChild(hd);
          if ((bd.textContent || '').trim()) t.appendChild(bd);
          messagesEl.appendChild(t);
          setBusyLabel(msg.name === 'editor_context'
            ? ('Attached ' + msg.detail)
            : (msg.name === 'run_command' ? 'Running command…' : ('Running ' + msg.name + '…')));
          pinBusyToBottom();
          break;
        }
        case 'pendingCommand': {
          sealStreamingBubble();
          const wrap = document.createElement('div');
          wrap.className = 'cmd-card';
          wrap.dataset.commandId = msg.id;
          const title = document.createElement('div');
          title.className = 'cmd-card-title';
          title.textContent = 'Run this command?';
          const pre = document.createElement('div');
          pre.className = 'cmd-card-cmd';
          pre.textContent = '$ ' + (msg.command || '');
          wrap.appendChild(title);
          wrap.appendChild(pre);
          if (msg.cwd && msg.cwd !== '.') {
            const meta = document.createElement('div');
            meta.className = 'cmd-card-meta';
            meta.textContent = 'in ' + msg.cwd + (msg.root ? ' (' + msg.root + ')' : '');
            wrap.appendChild(meta);
          }
          const row = document.createElement('div');
          row.className = 'row';
          const run = document.createElement('button');
          run.className = 'primary';
          run.textContent = 'Run';
          run.title = 'Run this command once';
          const always = document.createElement('button');
          always.textContent = 'Always allow';
          always.title = 'Whitelist this command type (first word) and run';
          const deny = document.createElement('button');
          deny.textContent = 'Deny';
          deny.title = 'Do not run this command';
          const lock = (decision) => {
            run.disabled = true;
            always.disabled = true;
            deny.disabled = true;
            vscode.postMessage({ type: 'resolveCommand', commandId: msg.id, decision: decision });
          };
          run.onclick = () => lock('run');
          always.onclick = () => lock('always');
          deny.onclick = () => lock('deny');
          row.appendChild(run);
          row.appendChild(always);
          row.appendChild(deny);
          wrap.appendChild(row);
          messagesEl.appendChild(wrap);
          setBusyLabel('Waiting for your OK to run the command…');
          pinBusyToBottom();
          break;
        }
        case 'pendingStep': {
          sealStreamingBubble();
          const wrap = document.createElement('div');
          wrap.className = 'cmd-card';
          wrap.dataset.stepId = msg.id;
          const title = document.createElement('div');
          title.className = 'cmd-card-title';
          title.textContent = msg.reason || 'Continue to the next step?';
          wrap.appendChild(title);
          if (msg.detail) {
            const meta = document.createElement('div');
            meta.className = 'cmd-card-meta';
            meta.textContent = msg.detail;
            wrap.appendChild(meta);
          }
          const row = document.createElement('div');
          row.className = 'row';
          const cont = document.createElement('button');
          cont.className = 'primary';
          cont.textContent = 'Continue';
          cont.title = 'Continue the agent loop';
          const stop = document.createElement('button');
          stop.textContent = 'Stop';
          stop.title = 'Stop here and finish with current results';
          const lock = (decision) => {
            cont.disabled = true;
            stop.disabled = true;
            vscode.postMessage({ type: 'resolveStep', stepId: msg.id, decision: decision });
          };
          cont.onclick = () => lock('continue');
          stop.onclick = () => lock('stop');
          row.appendChild(cont);
          row.appendChild(stop);
          wrap.appendChild(row);
          messagesEl.appendChild(wrap);
          setBusyLabel('Waiting for Continue / Stop…');
          pinBusyToBottom();
          break;
        }
        case 'stepResolved': {
          const el = document.querySelector('[data-step-id="' + msg.id + '"]');
          if (el) {
            el.classList.add('resolved');
            const meta = document.createElement('div');
            meta.className = 'cmd-card-meta';
            meta.textContent = msg.detail || msg.decision || '';
            el.appendChild(meta);
          }
          break;
        }
        case 'pendingAskUser': {
          sealStreamingBubble();
          const wrap = document.createElement('div');
          wrap.className = 'cmd-card';
          wrap.dataset.askId = msg.id;
          const title = document.createElement('div');
          title.className = 'cmd-card-title';
          title.textContent = 'Blossom needs a choice';
          wrap.appendChild(title);
          const q = document.createElement('div');
          q.className = 'ask-card-question';
          q.textContent = msg.question || 'Which option should I take?';
          wrap.appendChild(q);
          const optsWrap = document.createElement('div');
          optsWrap.className = 'ask-card-options';
          const letters = 'ABCDEF';
          const options = Array.isArray(msg.options) ? msg.options : [];
          const buttons = [];
          const lockAsk = (payload) => {
            buttons.forEach((b) => { b.disabled = true; });
            vscode.postMessage(Object.assign({ type: 'resolveAskUser', askId: msg.id }, payload));
          };
          options.forEach((label, i) => {
            const btn = document.createElement('button');
            if (i === 0) btn.className = 'primary';
            const letter = letters[i] || String(i + 1);
            btn.textContent = letter + ' · ' + String(label || '');
            btn.title = 'Choose option ' + letter;
            btn.onclick = () => lockAsk({ optionIndex: i });
            buttons.push(btn);
            optsWrap.appendChild(btn);
          });
          wrap.appendChild(optsWrap);
          const row = document.createElement('div');
          row.className = 'row';
          const skip = document.createElement('button');
          skip.textContent = 'Skip';
          skip.title = 'No preference — let Blossom continue without a choice';
          skip.onclick = () => lockAsk({ skipped: true, decision: 'skip' });
          buttons.push(skip);
          row.appendChild(skip);
          wrap.appendChild(row);
          messagesEl.appendChild(wrap);
          setBusyLabel('Waiting for your choice…');
          pinBusyToBottom();
          break;
        }
        case 'askUserResolved': {
          const el = document.querySelector('[data-ask-id="' + msg.id + '"]');
          if (el) {
            el.classList.add('resolved');
            if (msg.skipped) el.classList.add('denied');
            el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
            let st = el.querySelector('.cmd-card-status');
            if (!st) {
              st = document.createElement('div');
              st.className = 'cmd-card-status';
              el.appendChild(st);
            }
            st.textContent = msg.detail || (msg.skipped ? 'Skipped' : 'Answered');
          }
          if (!msg.skipped) {
            setBusyLabel('Got your choice — continuing…');
          }
          pinBusyToBottom();
          break;
        }
        case 'commandResolved': {
          const el = document.querySelector('[data-command-id="' + msg.id + '"]');
          if (el) {
            el.classList.add('resolved');
            if (msg.decision === 'deny') el.classList.add('denied');
            el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
            let st = el.querySelector('.cmd-card-status');
            if (!st) {
              st = document.createElement('div');
              st.className = 'cmd-card-status';
              el.appendChild(st);
            }
            st.textContent = msg.detail || (msg.decision === 'deny' ? 'Denied' : 'Approved');
          }
          if (msg.decision !== 'deny') {
            setBusyLabel(msg.detail || 'Running command…');
          }
          pinBusyToBottom();
          break;
        }
        case 'pendingEdit': {
          sealStreamingBubble();
          const wrap = document.createElement('div');
          wrap.className = 'edit';
          wrap.dataset.editId = msg.id;

          const diff = msg.diff || {};
          const additions = diff.additions || 0;
          const deletions = diff.deletions || 0;
          const isReplace = msg.source === 'search_replace';

          const hd = document.createElement('div');
          hd.className = 'diff-file-hd';
          const icon = document.createElement('span');
          icon.className = 'diff-file-icon';
          icon.setAttribute('aria-hidden', 'true');
          const name = document.createElement('span');
          name.className = 'diff-file-name';
          name.textContent = msg.path || 'file';
          name.title = msg.isDelete
            ? ('Delete ' + msg.path)
            : (msg.isNew ? ('New file ' + msg.path) : (isReplace ? ('Replace in ' + msg.path) : ('Update ' + msg.path)));
          if (isReplace) {
            const badge = document.createElement('span');
            badge.className = 'diff-file-badge';
            badge.textContent = 'replace';
            hd.appendChild(icon);
            hd.appendChild(name);
            hd.appendChild(badge);
          } else {
            hd.appendChild(icon);
            hd.appendChild(name);
          }
          const stats = document.createElement('span');
          stats.className = 'diff-file-stats';
          if (msg.isDelete) {
            stats.innerHTML = '<span class="del">−' + deletions + '</span>';
          } else if (msg.isNew) {
            stats.innerHTML = '<span class="add">+' + additions + '</span>';
          } else {
            stats.innerHTML = '<span class="add">+' + additions + '</span><span class="del">−' + deletions + '</span>';
          }
          hd.appendChild(stats);
          wrap.appendChild(hd);

          const appendSegments = (parent, line) => {
            const body = document.createElement('span');
            body.className = 'body';
            const segs = Array.isArray(line.segments) ? line.segments : null;
            if (segs && segs.length) {
              for (const seg of segs) {
                if (seg.highlight) {
                  const mark = document.createElement('span');
                  mark.className = 'ih';
                  mark.textContent = seg.text == null ? '' : String(seg.text);
                  body.appendChild(mark);
                } else {
                  body.appendChild(document.createTextNode(seg.text == null ? '' : String(seg.text)));
                }
              }
            } else {
              body.textContent = line.text == null ? '' : String(line.text);
            }
            parent.appendChild(body);
          };

          const appendPlainLines = (parent, text, kind) => {
            const lines = String(text || '').replace(/\\r\\n/g, '\\n').split('\\n');
            const max = 80;
            const shown = lines.slice(0, max);
            for (const lineText of shown) {
              const row = document.createElement('div');
              row.className = 'diff-line ' + kind;
              const ln = document.createElement('span');
              ln.className = 'ln';
              const gutter = document.createElement('span');
              gutter.className = 'gutter';
              gutter.textContent = kind === 'add' ? '+' : '−';
              const body = document.createElement('span');
              body.className = 'body';
              body.textContent = lineText;
              row.appendChild(ln);
              row.appendChild(gutter);
              row.appendChild(body);
              parent.appendChild(row);
            }
            if (lines.length > max) {
              const more = document.createElement('div');
              more.className = 'diff-empty';
              more.textContent = '…' + (lines.length - max) + ' more lines';
              parent.appendChild(more);
            }
          };

          // Exact removed → added strings from search_replace (PR-style focus).
          const rp = msg.replacePreview;
          if (rp && (rp.oldString || rp.newString)) {
            const box = document.createElement('div');
            box.className = 'diff-replace';
            const remHd = document.createElement('div');
            remHd.className = 'diff-replace-hd del';
            remHd.textContent = rp.replaceAll
              ? ('Removed ×' + (rp.matchCount || 1))
              : 'Removed';
            box.appendChild(remHd);
            appendPlainLines(box, rp.oldString, 'del');
            const addHd = document.createElement('div');
            addHd.className = 'diff-replace-hd add';
            addHd.textContent = 'Added';
            box.appendChild(addHd);
            appendPlainLines(box, rp.newString, 'add');
            wrap.appendChild(box);
          }

          const view = document.createElement('div');
          view.className = 'diff-view';
          const hunks = Array.isArray(diff.hunks) ? diff.hunks : [];

          if (hunks.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'diff-empty';
            empty.textContent = msg.isDelete
              ? '(file will be deleted)'
              : (msg.isNew ? '(new file)' : (rp ? '' : '(no line changes)'));
            if (empty.textContent) view.appendChild(empty);
          } else {
            for (const hunk of hunks) {
              const block = document.createElement('div');
              block.className = 'diff-hunk';
              if (hunk.header) {
                const hh = document.createElement('div');
                hh.className = 'diff-hunk-hd';
                hh.textContent = hunk.header;
                block.appendChild(hh);
              }
              for (const line of (hunk.lines || [])) {
                const row = document.createElement('div');
                const kind = line.kind === 'add' ? 'add' : (line.kind === 'del' ? 'del' : 'ctx');
                row.className = 'diff-line ' + kind;
                const ln = document.createElement('span');
                ln.className = 'ln';
                const lineNo = kind === 'del'
                  ? line.oldLine
                  : (kind === 'add' ? line.newLine : (line.newLine || line.oldLine));
                ln.textContent = lineNo != null ? String(lineNo) : '';
                const gutter = document.createElement('span');
                gutter.className = 'gutter';
                gutter.textContent = kind === 'add' ? '+' : (kind === 'del' ? '−' : ' ');
                row.appendChild(ln);
                row.appendChild(gutter);
                appendSegments(row, line);
                block.appendChild(row);
              }
              view.appendChild(block);
            }
            if (diff.truncated) {
              const more = document.createElement('div');
              more.className = 'diff-empty';
              more.textContent = '…more changes omitted';
              view.appendChild(more);
            }
          }
          if (view.childNodes.length) wrap.appendChild(view);

          const row = document.createElement('div');
          row.className = 'row';
          const compare = document.createElement('button');
          compare.textContent = 'Compare';
          compare.title = 'Open side-by-side diff';
          compare.onclick = () => vscode.postMessage({ type: 'openEditDiff', editId: msg.id });
          row.appendChild(compare);
          const restoredStatus = msg.status;
          if (restoredStatus === 'applied' || restoredStatus === 'rejected') {
            wrap.appendChild(row);
            const st = document.createElement('div');
            st.className = 'cmd-card-status';
            st.textContent = restoredStatus === 'applied'
              ? (msg.auto ? '✓ Auto-applied' : '✓ Applied')
              : '✗ Rejected';
            wrap.appendChild(st);
          } else if (!msg.autoApply) {
            const apply = document.createElement('button');
            apply.className = 'primary';
            apply.textContent = msg.isDelete ? 'Delete' : 'Apply';
            apply.onclick = () => vscode.postMessage({ type: 'applyEdit', editId: msg.id });
            const reject = document.createElement('button');
            reject.textContent = 'Reject';
            reject.onclick = () => vscode.postMessage({ type: 'rejectEdit', editId: msg.id });
            row.appendChild(apply);
            row.appendChild(reject);
            wrap.appendChild(row);
          } else {
            wrap.appendChild(row);
            const st = document.createElement('div');
            st.className = 'cmd-card-status';
            st.textContent = 'Auto-applying…';
            wrap.appendChild(st);
          }
          messagesEl.appendChild(wrap);
          if (!msg.skipScroll) {
            try { wrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
          }
          pinBusyToBottom();
          break;
        }
        case 'editNeedsApply': {
          const el = document.querySelector('[data-edit-id="' + msg.id + '"]');
          if (el && !el.querySelector('button')) {
            const st = el.querySelector('.cmd-card-status');
            if (st) st.remove();
            const row = document.createElement('div');
            row.className = 'row';
            const apply = document.createElement('button');
            apply.className = 'primary';
            apply.textContent = 'Apply';
            apply.onclick = () => vscode.postMessage({ type: 'applyEdit', editId: msg.id });
            const reject = document.createElement('button');
            reject.textContent = 'Reject';
            reject.onclick = () => vscode.postMessage({ type: 'rejectEdit', editId: msg.id });
            row.appendChild(apply);
            row.appendChild(reject);
            el.appendChild(row);
          }
          pinBusyToBottom();
          break;
        }
        case 'editApplied':
        case 'editRejected': {
          const el = document.querySelector('[data-edit-id="' + msg.id + '"]');
          if (el) {
            el.querySelectorAll('button').forEach((b) => b.disabled = true);
            let st = el.querySelector('.cmd-card-status');
            if (!st) {
              st = document.createElement('div');
              st.className = 'cmd-card-status';
              el.appendChild(st);
            }
            st.textContent = msg.type === 'editApplied'
              ? (msg.auto ? '✓ Auto-applied' : '✓ Applied')
              : '✗ Rejected';
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
          streamingEl = null;
          showErrorCard(msg.text || 'Unknown error', msg.question || lastAsk);
          setBusy(false);
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
          // Model narration first ("what I did"), then disk-truth paths.
          notes.forEach((n) => add(n));
          const hasDiskEdits = created.length + updated.length + deleted.length > 0;
          if (hasDiskEdits) {
            created.forEach((p) => add('Created ' + p));
            updated.forEach((p) => add('Updated ' + p));
            deleted.forEach((p) => add('Deleted ' + p));
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
          // With live per-file streamBreaks, do NOT replace the last bubble with
          // the full turn text — each segment already holds its own slice.
          sealStreamingBubble();
          if (msg.feedbackId) {
            const target = messagesEl.querySelector('.msg.assistant:last-of-type');
            if (target) attachFeedback(target, msg.feedbackId);
          }
          if (msg.deescalateAvailable) {
            const deTarget = messagesEl.querySelector('.feedback-row:last-of-type')
              || messagesEl.querySelector('.msg.assistant:last-of-type');
            if (deTarget) attachDeescalate(deTarget);
          }
          setBusy(false);
          break;
        case 'feedbackResult': {
          const row = document.querySelector('.feedback-row[data-feedback-id="' + (msg.feedbackId || '') + '"]');
          if (row) {
            const st = row.querySelector('.fb-status');
            if (st) {
              st.textContent = msg.ok
                ? (msg.verdict === 'incorrect' ? 'Marked incorrect' : 'Marked correct')
                : ('Failed: ' + (msg.error || 'error'));
            }
            if (!msg.ok) {
              row.querySelectorAll('button').forEach((b) => { b.disabled = false; b.classList.remove('active-up', 'active-down'); });
            }
          }
          break;
        }
        case 'cleared':
          wipeMessages();
          break;
        case 'restoreHistory': {
          wipeMessages();
          const msgs = msg.messages || [];
          const edits = Array.isArray(msg.edits) ? msg.edits : [];
          // Older archives have no edit cards — show path-labeled fence bodies.
          // Newer archives restore PR-style cards, so keep the live "Edit: path" labels.
          const preserveFileFences = edits.length === 0;
          for (const m of msgs) {
            if (!m || !m.content) continue;
            if (m.role === 'user') {
              append('user', m.content);
            } else if (m.role === 'assistant') {
              const el = append('assistant', '');
              renderAssistant(el, m.content, { preserveFileFences });
            }
          }
          for (const edit of edits) {
            if (!edit || !edit.id) continue;
            onHostMessage(Object.assign({}, edit, {
              type: 'pendingEdit',
              autoApply: false,
              status: edit.status || 'applied',
              skipScroll: true,
            }));
          }
          const note = document.createElement('div');
          note.className = 'tool';
          note.textContent = msgs.length
            ? 'Restored from History — continue this chat or ask about it.'
            : 'Opened saved chat (empty transcript).';
          messagesEl.appendChild(note);
          pinBusyToBottom();
          break;
        }
        case 'imageAttachments': {
          const items = msg.items || [];
          for (const it of items) {
            if (!it || !it.path) continue;
            if (pendingAttachments.some((p) => p.path === it.path)) continue;
            pendingAttachments.push({
              path: it.path,
              fileName: it.fileName || it.path.split(/[/\\\\]/).pop(),
              metadata: it.metadata,
            });
          }
          renderAttachmentChips();
          break;
        }
        case 'contextInjectError': {
          const t = document.createElement('div');
          t.className = 'tool';
          t.textContent = msg.error || 'Could not add context';
          messagesEl.appendChild(t);
          pinBusyToBottom();
          break;
        }
      }
    }

    window.addEventListener('message', (event) => {
      onHostMessage(event.data);
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
