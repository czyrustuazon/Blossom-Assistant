import * as vscode from "vscode";
import type { BlossomMode } from "../config";
import { getConfig, modelForMode } from "../config";
import { registerFeedbackTurn } from "../feedback/client";
import { compressConversationForHandoff, type HandoffCompression } from "../escalate/compressHandoff";
import { runCloudEscalation, cloudProviderDisplayName } from "../escalate/fallbackChain";
import {
  buildDeescalateRetryPrompt,
  createCloudSnapshot,
  mergeDeescalateAnswer,
  type CloudEscalationSnapshot,
} from "../escalate/deescalate";
import { promptEscalationChoice } from "../escalate/promptEscalationChoice";
import { proposeEditsFromCloudAnswer } from "../escalate/proposeCloudEdits";
import type { EscalateTarget } from "./prompts";
import { resolveWorkspaceRoot } from "../cursor/client";
import {
  attachmentPathsForHandoff,
  formatImageMetadataBlock,
  type ImageAttachment,
} from "../chat/attachments";
import { captionImageAttachments } from "../vision/caption";
import {
  fetchCodingMemoryForPrompt,
  learnCodingLesson,
} from "../memory/client";
import {
  decompMemoryQuery,
  detectDecompWorkspace,
} from "./decompContext";
import { formatContinuityBrief } from "./continuity";
import {
  looksLikeDocsResearch,
  maybePrefetchResearchBrief,
  prependResearchBrief,
} from "../research/client";
import {
  buildSystemPrompt,
  detectPromptTier,
  ensureChatRouterCodingRoute,
  hasEditorContextInPrompt,
  stripEscalateMarkers,
  wrapUserPromptForCodingAgent,
  wrapUserPromptForSequentialAgent,
} from "./prompts";
import {
  DeferCloudEscalationError,
  labelIntelSource,
  LlmError,
  type BlossomThought,
  type ChatTool,
  type OllamaMessage,
  type OllamaToolCall,
  streamChat,
} from "../ollama/client";
import { stripSlashCommand } from "./router";
import {
  buildCodingSummaryInfo,
  type CodingSummaryInfo,
  consumeCompletedFences,
  createFenceScanState,
  type FenceScanState,
  parseModelSummaryNotes,
  pathsMatch,
  proposeEditsFromAssistantReply,
  resolveUserDeleteTargets,
  stripCodingSummarySection,
} from "./applyFromResponse";
import {
  isDryRunVerified,
  markDryRunFromCommand,
  resetDryRunSession,
  validateDryRunBeforeApply,
} from "./dryRunGate";
import { parseAutoApplyIntent } from "./autoApply";
import { enrichWithEditorContext } from "./editorContext";
import { ensureRepoKnowledge } from "./repoKnowledge";
import {
  applyScratchpadUpdate,
  assessScratchpadNeed,
  autofillScratchpadIfNeeded,
  formatScratchpadContinueHint,
  getScratchpad,
  scratchpadStatus,
  type ScratchpadNeed,
} from "./scratchpad";
import {
  applyPendingEdit,
  clearSearchLineHints,
  isParallelSafeTool,
  normalizeAskUserArgs,
  proposeFileDelete,
  proposeFileEdit,
  rejectPendingEdit,
  resolveToolProfile,
  runTool,
  setActiveToolProfile,
  suggestRelatedFolders,
  toolsForProfile,
  type PendingEdit,
  type ToolResult,
} from "./tools";
import {
  addCommandToAllowlist,
  createToolCallTokenFilter,
  isCommandAllowlisted,
  isPathLabeledWriteFence,
  pathFromFenceInfo,
  type CommandDecision,
} from "./commandPolicy";
import { compactToolResult } from "./compactToolTranscript";
import { closeBrowserSession } from "../web/browser";
import {
  confirmWebUse,
  isWebTool,
  resetWebTurnGate,
  webStatusLabel,
} from "../web/gate";
import {
  buildChatRouterAgentTurn,
  buildLocalRetryPrompt,
  parseToolCallFences,
  stripToolCallFences,
  toOllamaToolCalls,
  type ToolTranscriptEntry,
} from "./toolProtocol";
import {
  compressHistoryIfNeeded,
  mergeHistoryWithSummary,
  wrapPromptWithSessionContext,
} from "./sessionHistory";

export interface ChatHistoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface StatusOptions {
  /** Update the spinner label only — do not append a Thinking trail step. */
  phaseOnly?: boolean;
}

export interface PendingCommandRequest {
  id: string;
  command: string;
  cwd: string;
  root?: string;
}

export interface OrchestratorEvents {
  onStatus: (text: string, opts?: StatusOptions) => void;
  onMode: (mode: BlossomMode, model: string, source: string) => void;
  onToken: (delta: string) => void;
  /** Seal the current assistant bubble so the next tokens/cards start a new segment. */
  onStreamBreak?: () => void;
  onThought: (thought: BlossomThought) => void;
  onTool: (name: string, detail: string) => void;
  /** Ask the user before running a shell command (agent loop pauses). */
  onPendingCommand?: (req: PendingCommandRequest) => void;
  /** Update the command card after Run / Always allow / Deny. */
  onCommandResolved?: (
    id: string,
    result: { decision: CommandDecision; detail: string }
  ) => void;
  /** HITL step gate (confirmTools / planSteps). */
  onPendingStep?: (req: {
    id: string;
    reason: string;
    detail?: string;
  }) => void;
  onStepResolved?: (
    id: string,
    result: { decision: "continue" | "stop"; detail: string }
  ) => void;
  /** Multiple-choice ask_user card (agent loop pauses). */
  onPendingAskUser?: (req: {
    id: string;
    question: string;
    options: string[];
  }) => void;
  onAskUserResolved?: (
    id: string,
    result: { detail: string; skipped?: boolean }
  ) => void;
  onPendingEdit: (
    edit: PendingEdit,
    meta?: { autoApply?: boolean }
  ) => void;
  /** Auto-apply failed — show Apply/Reject on an existing change card. */
  onEditNeedsApply?: (id: string) => void;
  onEditApplied: (id: string, path: string) => void;
  onCodingSummary: (summary: CodingSummaryInfo) => void;
  /** ChatRouter correctness feedback id (coding/japanese) — show thumbs when present */
  onFeedback?: (info: { id: string; route?: string }) => void;
  /** Mid-turn user context inject acknowledged (not a new turn). */
  onContextInject?: (text: string) => void;
  /** Workspace scratchpad changed (model fence or host edit). */
  onScratchpad?: (info: { empty: boolean; chars: number }) => void;
  onDone: (
    finalText: string,
    opts?: { deescalateAvailable?: boolean }
  ) => void;
  onError: (message: string) => void;
}

/** Spinner heartbeats while ChatRouter/Ollama is silent (hung fetch or slow model). */
function startWaitHeartbeat(
  events: OrchestratorEvents,
  signal: AbortSignal,
  label: string
): { bump: () => void; stop: () => void } {
  const started = Date.now();
  let lastActivity = started;
  const tick = setInterval(() => {
    if (signal.aborted) {
      return;
    }
    const silentSec = Math.floor((Date.now() - lastActivity) / 1000);
    if (silentSec < 6) {
      return;
    }
    const totalSec = Math.floor((Date.now() - started) / 1000);
    events.onStatus(`${label} (${totalSec}s)`, { phaseOnly: true });
  }, 4000);
  return {
    bump: () => {
      lastActivity = Date.now();
    },
    stop: () => {
      clearInterval(tick);
    },
  };
}

/** Live per-fence apply while the assistant reply is still streaming. */
interface LiveEditSession {
  enabled: boolean;
  applyNow: boolean;
  fenceState: FenceScanState;
  deliveredRelPaths: string[];
  onEditCollected?: (edit: PendingEdit) => void;
  preDeletePaths: string[];
  lockDeletesToUserTargets: boolean;
  onSkippedDelete?: (path: string, reason: string) => void;
  onSkippedWrite?: (path: string, reason: string) => void;
}

export type StepDecision = "continue" | "stop";

/** ask_user card: option index (0-based) or skip. */
export type AskUserDecision =
  | { kind: "choice"; index: number }
  | { kind: "skip" };

function isAbortLike(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const name = (err as { name?: string }).name;
  return name === "AbortError" || name === "AbortSignal";
}

function formatChatError(err: unknown): string {
  if (err instanceof LlmError) {
    return err.message;
  }
  if (err instanceof Error) {
    const m = err.message || err.name;
    if (/failed to fetch|networkerror|econnrefused|fetch failed/i.test(m)) {
      const url = getConfig().baseUrl;
      return `Could not reach the LLM at ${url}. Is Blossom / Ollama running? (${m})`;
    }
    return m;
  }
  return String(err);
}

/** ChatRouter answered via its built-in Claude/Gemini fallback (not extension-chosen). */
function isChatRouterAutoCloudIntel(source?: string): boolean {
  if (!source) {
    return false;
  }
  const s = source.toLowerCase();
  return (
    s === "claude" ||
    s === "gemini" ||
    s.startsWith("claude") ||
    s.startsWith("gemini")
  );
}

function chatRouterRequestFlags(sequentialMode = false): {
  deferCloud: boolean;
  sequentialMode: boolean;
} {
  const cfg = getConfig();
  return {
    deferCloud: cfg.backend === "chatRouter" && cfg.escalate.askFirst,
    sequentialMode: cfg.backend === "chatRouter" && sequentialMode,
  };
}

function isContextOverflowReason(reason: string): boolean {
  const m = reason.toLowerCase();
  return (
    m.includes("context") ||
    m.includes("overflow") ||
    m.includes("exceed") ||
    m.includes("sequential")
  );
}

export class AgentOrchestrator {
  private history: OllamaMessage[] = [];
  /** Compressed summary of turns rolled off when history exceeds the limit. */
  private historySummary?: string;
  private autoApply = true;
  /** When true, skip Run / Always allow / Deny for shell commands. */
  private fastMode = false;
  private abort?: AbortController;
  private lastUserText = "";
  private lastLocalAttempt = "";
  private handoffCache?: HandoffCompression;
  private lastCloudEscalation?: CloudEscalationSnapshot;
  private userChoseCloudEscalation = false;
  private sequentialRetryAttempted = false;
  private turnInProgress = false;
  private pendingContextInjects: string[] = [];
  private turnContextInjects: string[] = [];
  private readonly pendingCommands = new Map<
    string,
    (decision: CommandDecision) => void
  >();
  private commandSeq = 0;
  private readonly pendingSteps = new Map<
    string,
    (decision: StepDecision) => void
  >();
  private stepSeq = 0;
  private readonly pendingAskUsers = new Map<
    string,
    (decision: AskUserDecision) => void
  >();
  private askUserSeq = 0;
  /** Edits held until python --dry-run verifies patch scripts (same turn). */
  private readonly dryRunBlockedEdits = new Map<string, PendingEdit>();
  /** Host scratchpad necessity for the in-flight coding turn. */
  private turnScratchpadNeed: ScratchpadNeed = {
    level: "skip",
    reasons: [],
  };
  /** Compact tool-failure notes for host autofill this turn. */
  private turnToolFailureNotes: string[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.autoApply = this.readConfiguredAutoApply();
    this.fastMode = this.readConfiguredFastMode();
  }

  private refreshTurnScratchpadNeed(
    userText: string,
    opts?: { attachedPathCount?: number; toolRounds?: number; toolFailures?: number }
  ): ScratchpadNeed {
    this.turnScratchpadNeed = assessScratchpadNeed(userText, {
      existing: getScratchpad(this.context),
      promptTier: detectPromptTier(userText, {
        hasEditorContext: true,
      }),
      attachedPathCount: opts?.attachedPathCount,
      toolRounds: opts?.toolRounds,
      toolFailures: opts?.toolFailures,
    });
    return this.turnScratchpadNeed;
  }

  private async settleScratchpad(
    events: OrchestratorEvents,
    assistantText: string,
    userText: string,
    toolFailureNotes?: string[]
  ): Promise<string> {
    const scratch = await applyScratchpadUpdate(this.context, assistantText);
    let clean = scratch.clean;
    let updated = scratch.updated;
    let text = scratch.text;

    if (updated) {
      const st = scratchpadStatus(text);
      events.onStatus(
        st.empty
          ? "Scratchpad cleared"
          : `Scratchpad updated (${st.chars} chars)`
      );
      events.onScratchpad?.(st);
      return clean;
    }

    const auto = await autofillScratchpadIfNeeded(this.context, {
      need: this.turnScratchpadNeed,
      alreadyUpdated: false,
      userText,
      assistantText: clean,
      toolFailureNotes: toolFailureNotes ?? this.turnToolFailureNotes,
    });
    if (auto.filled) {
      const st = scratchpadStatus(auto.text);
      events.onStatus(
        `Scratchpad auto-filled (${st.chars} chars) — model can overwrite next turn`
      );
      events.onScratchpad?.(st);
    }
    return clean;
  }

  private readConfiguredAutoApply(): boolean {
    return (
      vscode.workspace
        .getConfiguration("blossom")
        .get<boolean>("edits.autoApply", true) ?? true
    );
  }

  getAutoApply(): boolean {
    return this.autoApply;
  }

  setAutoApply(enabled: boolean): void {
    this.autoApply = enabled;
    // Persist so the next session / window starts with the same preference.
    void vscode.workspace
      .getConfiguration("blossom")
      .update("edits.autoApply", enabled, vscode.ConfigurationTarget.Global);
  }

  private readConfiguredFastMode(): boolean {
    // Fast mode is the inverse of ask-before-run.
    return !(
      vscode.workspace
        .getConfiguration("blossom")
        .get<boolean>("commands.askBeforeRun", true) ?? true
    );
  }

  /** Fast mode = skip Run / Always allow / Deny prompts (askBeforeRun off). */
  getFastMode(): boolean {
    return this.fastMode;
  }

  setFastMode(enabled: boolean): void {
    this.fastMode = enabled;
    void vscode.workspace
      .getConfiguration("blossom")
      .update(
        "commands.askBeforeRun",
        !enabled,
        vscode.ConfigurationTarget.Global
      );
    // Fast mode includes auto-apply (header Auto-apply chip removed).
    if (enabled) {
      this.setAutoApply(true);
      for (const [id, resolve] of [...this.pendingCommands.entries()]) {
        this.pendingCommands.delete(id);
        resolve("run");
      }
    }
  }

  clearHistory(): void {
    this.history = [];
    this.historySummary = undefined;
    this.autoApply = this.readConfiguredAutoApply();
    this.fastMode = this.readConfiguredFastMode();
    this.lastUserText = "";
    this.lastLocalAttempt = "";
    this.handoffCache = undefined;
    this.lastCloudEscalation = undefined;
    this.userChoseCloudEscalation = false;
    this.clearContextInjectState();
  }

  /** Snapshot for durable chat archive (disk under .blossom/chats). */
  getArchiveSnapshot(): {
    history: OllamaMessage[];
    historySummary?: string;
    lastUserText: string;
  } {
    return {
      history: [...this.history],
      historySummary: this.historySummary,
      lastUserText: this.lastUserText,
    };
  }

  /** Restore a previously saved chat so the agent can continue it. */
  restoreArchive(opts: {
    history: OllamaMessage[];
    historySummary?: string;
  }): void {
    this.cancel();
    this.history = opts.history.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    this.historySummary = opts.historySummary?.trim() || undefined;
    this.lastUserText = "";
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].role === "user") {
        this.lastUserText = this.history[i].content;
        break;
      }
    }
    this.lastLocalAttempt = "";
    this.handoffCache = undefined;
    this.lastCloudEscalation = undefined;
    this.userChoseCloudEscalation = false;
    this.clearContextInjectState();
  }

  canDeescalate(): boolean {
    return !!this.lastCloudEscalation && getConfig().deescalate.enabled;
  }

  /**
   * Queue mid-turn context while the agent loop is running (does not abort).
   * Max 3 injects per turn; drained at the next tool-loop round.
   */
  addContextInject(text: string): { ok: boolean; error?: string } {
    if (!this.turnInProgress) {
      return { ok: false, error: "No active turn" };
    }
    const t = (text || "").trim();
    if (!t) {
      return { ok: false, error: "Empty context" };
    }
    const total =
      this.pendingContextInjects.length + this.turnContextInjects.length;
    if (total >= 3) {
      return {
        ok: false,
        error: "Queue full — Stop or wait for this turn to finish (max 3).",
      };
    }
    this.pendingContextInjects.push(t.slice(0, 4000));
    return { ok: true };
  }

  private clearContextInjectState(): void {
    this.pendingContextInjects = [];
    this.turnContextInjects = [];
    this.turnInProgress = false;
  }

  private drainContextInjects(): string | undefined {
    if (!this.pendingContextInjects.length) {
      return undefined;
    }
    const batch = this.pendingContextInjects.splice(0);
    for (const line of batch) {
      this.turnContextInjects.push(line);
    }
    const body =
      batch.length === 1
        ? batch[0]
        : batch.map((line, i) => `${i + 1}. ${line}`).join("\n\n");
    return [
      "[USER CONTEXT UPDATE — mid-turn; prioritize this over earlier assumptions]",
      body,
      "",
      "Continue the current task with this new information. Do not restart from scratch unless the update invalidates prior work.",
    ].join("\n");
  }

  private flushTurnContextInjectsToHistory(): void {
    const pending = this.pendingContextInjects.splice(0);
    const all = [...this.turnContextInjects, ...pending];
    this.turnContextInjects = [];
    if (!all.length) {
      return;
    }
    const body =
      all.length === 1
        ? all[0]
        : all.map((line, i) => `${i + 1}. ${line}`).join("\n\n");
    this.history.push({
      role: "user",
      content: `[Context added mid-turn${all.length > 1 ? ` ×${all.length}` : ""}]\n${body}`,
    });
  }

  private activeMidTurnInjects(): string[] {
    return [...this.turnContextInjects, ...this.pendingContextInjects];
  }

  /** Snapshot for manual Cursor handoff (copyCursorHandoff command). */
  getHandoffContext(): {
    history: OllamaMessage[];
    historySummary?: string;
    lastUserText: string;
    lastLocalAttempt: string;
    handoffCache?: HandoffCompression;
  } {
    return {
      history: mergeHistoryWithSummary(this.history, this.historySummary),
      historySummary: this.historySummary,
      lastUserText: this.lastUserText,
      lastLocalAttempt: this.lastLocalAttempt,
      handoffCache: this.handoffCache,
    };
  }

  private async maintainSessionHistory(
    events: OrchestratorEvents,
    userText: string
  ): Promise<void> {
    this.historySummary = await compressHistoryIfNeeded(
      this.context,
      this.history,
      this.historySummary,
      userText,
      (msg) => events.onStatus(msg)
    );
  }

  cancel(): void {
    this.abort?.abort();
    this.rejectAllPendingCommands();
    this.rejectAllPendingSteps();
    this.rejectAllPendingAskUsers();
    this.clearContextInjectState();
  }

  /** Resolve a paused run_command from the chat UI. */
  resolveCommand(id: string, decision: CommandDecision): void {
    const resolve = this.pendingCommands.get(id);
    if (!resolve) {
      return;
    }
    this.pendingCommands.delete(id);
    resolve(decision);
  }

  /** Resolve a HITL step gate (Continue / Stop). */
  resolveStep(id: string, decision: StepDecision): void {
    const resolve = this.pendingSteps.get(id);
    if (!resolve) {
      return;
    }
    this.pendingSteps.delete(id);
    resolve(decision);
  }

  /** Resolve an ask_user multiple-choice card. */
  resolveAskUser(id: string, decision: AskUserDecision): void {
    const resolve = this.pendingAskUsers.get(id);
    if (!resolve) {
      return;
    }
    this.pendingAskUsers.delete(id);
    resolve(decision);
  }

  private rejectAllPendingCommands(): void {
    for (const [id, resolve] of this.pendingCommands) {
      this.pendingCommands.delete(id);
      resolve("deny");
    }
  }

  private rejectAllPendingSteps(): void {
    for (const [id, resolve] of this.pendingSteps) {
      this.pendingSteps.delete(id);
      resolve("stop");
    }
  }

  private rejectAllPendingAskUsers(): void {
    for (const [id, resolve] of this.pendingAskUsers) {
      this.pendingAskUsers.delete(id);
      resolve({ kind: "skip" });
    }
  }

  /**
   * Pause for a multiple-choice ask_user card; returns a tool result for the transcript.
   */
  private async promptAskUser(
    args: Record<string, unknown>,
    events: OrchestratorEvents,
    signal: AbortSignal
  ): Promise<ToolResult> {
    const normalized = normalizeAskUserArgs(args);
    if (!normalized.ok) {
      return { ok: false, content: normalized.content };
    }
    const { question, options } = normalized;
    const id = `ask-${++this.askUserSeq}-${Date.now()}`;
    const letters = "ABCDEF";
    events.onStreamBreak?.();
    events.onPendingAskUser?.({ id, question, options });
    events.onStatus("Waiting for your choice…");
    events.onTool(
      "ask_user",
      `${question.slice(0, 80)}${question.length > 80 ? "…" : ""} (${options.length} options)`
    );

    const decision = await new Promise<AskUserDecision>((resolve) => {
      this.pendingAskUsers.set(id, resolve);
      if (signal.aborted) {
        this.pendingAskUsers.delete(id);
        resolve({ kind: "skip" });
        return;
      }
      const onAbort = () => {
        if (this.pendingAskUsers.has(id)) {
          this.pendingAskUsers.delete(id);
          resolve({ kind: "skip" });
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });

    if (decision.kind === "skip") {
      const detail =
        "Skipped — no choice selected. Agent should not assume a preference.";
      events.onAskUserResolved?.(id, { detail, skipped: true });
      return {
        ok: true,
        content: [
          "User skipped ask_user (no choice selected).",
          `Question: ${question}`,
          "Do not assume a preference; either state a safe default explicitly, or call ask_user again with clearer options.",
        ].join("\n"),
      };
    }

    const idx = Math.max(0, Math.min(options.length - 1, decision.index));
    const letter = letters[idx] || String(idx + 1);
    const label = options[idx];
    const detail = `Chose ${letter}: ${label}`;
    events.onAskUserResolved?.(id, { detail });
    return {
      ok: true,
      content: [
        "User answered ask_user.",
        `Question: ${question}`,
        `Choice: ${letter} — ${label}`,
      ].join("\n"),
    };
  }

  /**
   * Pause for Continue / Stop when stepMode gates fire.
   */
  private async confirmContinueStep(
    reason: string,
    detail: string | undefined,
    events: OrchestratorEvents,
    signal: AbortSignal
  ): Promise<StepDecision> {
    const id = `step-${++this.stepSeq}-${Date.now()}`;
    events.onStreamBreak?.();
    events.onPendingStep?.({ id, reason, detail });
    events.onStatus("Waiting for Continue / Stop…");

    const decision = await new Promise<StepDecision>((resolve) => {
      this.pendingSteps.set(id, resolve);
      if (signal.aborted) {
        this.pendingSteps.delete(id);
        resolve("stop");
        return;
      }
      const onAbort = () => {
        if (this.pendingSteps.has(id)) {
          this.pendingSteps.delete(id);
          resolve("stop");
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });

    if (decision === "stop") {
      events.onStepResolved?.(id, {
        decision: "stop",
        detail: "Stopped — agent will finish with what it has.",
      });
      return "stop";
    }

    events.onStepResolved?.(id, {
      decision: "continue",
      detail: "Continue — next agent step…",
    });
    return "continue";
  }

  async applyEdit(id: string): Promise<string> {
    return applyPendingEdit(id);
  }

  async rejectEdit(id: string): Promise<void> {
    return rejectPendingEdit(id);
  }

  /**
   * Pause for Run / Always allow / Deny when ask-before-run is on and the
   * command is not allowlisted.
   */
  private async confirmRunCommand(
    command: string,
    cwd: string,
    root: string | undefined,
    events: OrchestratorEvents,
    signal: AbortSignal
  ): Promise<"allowlisted" | "approved" | "denied"> {
    const cfg = getConfig().commands;
    const cmd = (command || "").trim();
    if (!cmd) {
      return "denied";
    }
    if (
      this.fastMode ||
      !cfg.askBeforeRun ||
      isCommandAllowlisted(cmd, cfg.allowlist)
    ) {
      return "allowlisted";
    }

    const id = `cmd-${++this.commandSeq}-${Date.now()}`;
    events.onStreamBreak?.();
    events.onPendingCommand?.({ id, command: cmd, cwd: cwd || ".", root });
    events.onStatus("Waiting for your OK to run the command…");

    const decision = await new Promise<CommandDecision>((resolve) => {
      this.pendingCommands.set(id, resolve);
      if (signal.aborted) {
        this.pendingCommands.delete(id);
        resolve("deny");
        return;
      }
      const onAbort = () => {
        if (this.pendingCommands.has(id)) {
          this.pendingCommands.delete(id);
          resolve("deny");
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });

    if (decision === "deny") {
      events.onCommandResolved?.(id, {
        decision: "deny",
        detail: "Denied — command was not run.",
      });
      return "denied";
    }

    if (decision === "always") {
      const pattern = await addCommandToAllowlist(cmd);
      events.onCommandResolved?.(id, {
        decision: "always",
        detail: pattern
          ? `Always allow · whitelisted “${pattern}” — running…`
          : "Always allow — running…",
      });
      return "approved";
    }

    events.onCommandResolved?.(id, {
      decision: "run",
      detail: "Approved — running…",
    });
    return "approved";
  }

  private toolDetailForUi(
    name: string,
    args: Record<string, unknown> | string
  ): string {
    const obj =
      typeof args === "string"
        ? (() => {
            try {
              return JSON.parse(args) as Record<string, unknown>;
            } catch {
              return { value: args };
            }
          })()
        : args || {};
    const str = (key: string): string => String(obj[key] ?? "").trim();
    const lineCount = (text: string): number => {
      if (!text) {
        return 0;
      }
      return text.replace(/\r\n/g, "\n").split("\n").length;
    };
    const clipOneLine = (text: string, max = 100): string => {
      const one = text.replace(/\s+/g, " ").trim();
      return one.length > max ? `${one.slice(0, max)}…` : one;
    };

    if (name === "ask_user") {
      const q = str("question") || str("prompt");
      const opts = Array.isArray(obj.options)
        ? obj.options.length
        : Array.isArray(obj.choices)
          ? obj.choices.length
          : 0;
      return opts > 0
        ? `${clipOneLine(q, 90)}\n${opts} option(s)`
        : clipOneLine(q, 100);
    }
    if (name === "run_command") {
      const command = str("command");
      const cwd = str("cwd") || ".";
      return cwd && cwd !== "."
        ? `$ ${command}\n(in ${cwd})`
        : `$ ${command}`;
    }
    if (name === "write_file") {
      const path = str("path") || str("file") || "(unknown path)";
      const content = String(obj.content ?? "");
      const n = lineCount(content);
      const first = content
        .replace(/\r\n/g, "\n")
        .split("\n")
        .find((l) => l.trim());
      const hint = first ? `\n${clipOneLine(first, 80)}` : "";
      return `path: ${path}\n${n} line(s)${hint}`;
    }
    if (name === "search_replace") {
      const path = str("path") || str("file") || "(unknown path)";
      const oldN = lineCount(String(obj.old_string ?? ""));
      const newN = lineCount(String(obj.new_string ?? ""));
      const all = obj.replace_all === true ? " · replace_all" : "";
      return `path: ${path}\n-${oldN} / +${newN} line(s)${all}`;
    }
    if (name === "read_file") {
      const path = str("path") || str("file") || "(unknown path)";
      const start = obj.start_line ?? obj.offset;
      const end = obj.end_line ?? obj.limit;
      if (start != null || end != null) {
        return `path: ${path}\nlines: ${start ?? "?"}–${end ?? "?"}`;
      }
      return `path: ${path}`;
    }
    if (name === "delete_file" || name === "list_dir") {
      return `path: ${str("path") || str("file") || "(unknown path)"}`;
    }
    if (name === "search_text") {
      const pattern = str("pattern") || str("query") || "";
      const path = str("path") || str("glob") || ".";
      return `pattern: ${clipOneLine(pattern, 80)}\npath: ${path}`;
    }
    if (name === "web_search") {
      return `query: ${clipOneLine(str("query"), 100)}`;
    }
    if (name === "fetch_url" || name === "browser_navigate") {
      return `url: ${clipOneLine(str("url"), 120)}`;
    }
    if (name === "browser_click" || name === "browser_type") {
      const ref = str("ref");
      const text = str("text");
      return text ? `ref: ${ref}\ntext: ${clipOneLine(text, 80)}` : `ref: ${ref}`;
    }
    if (name === "browser_scroll") {
      return `direction: ${str("direction") || "down"}`;
    }
    if (name === "browser_screenshot") {
      return str("name") ? `name: ${str("name")}` : "viewport PNG";
    }

    const entries = Object.entries(obj);
    if (entries.length === 0) {
      return name;
    }
    return entries
      .map(([k, v]) => {
        if (typeof v === "string") {
          const n = lineCount(v);
          if (n > 3 || v.length > 160) {
            return `${k}: ${n} line(s) · ${clipOneLine(v, 72)}`;
          }
          return `${k}: ${v}`;
        }
        return `${k}: ${JSON.stringify(v)}`;
      })
      .join("\n");
  }

  /** Quiet history breadcrumb after a write — do NOT spam the chat with "Done". */
  noteFileApplied(path: string, auto: boolean): string {
    // Keep a short memory for the model; return empty so the UI does not print "Done".
    this.history.push({
      role: "assistant",
      content: auto
        ? `(Saved \`${path}\` to disk.)`
        : `(User applied \`${path}\`.)`,
    });
    return "";
  }

  /** Record a content-guard block so the model can revise on the next turn. */
  private noteBlockedWrite(
    events: OrchestratorEvents,
    path: string,
    reason: string
  ): void {
    events.onStatus(`Blocked write to ${path}: ${reason}`);
    this.history.push({
      role: "assistant",
      content: `(Apply blocked for \`${path}\`: ${reason})`,
    });
  }

  private normEditPath(p: string): string {
    return p.replace(/\\/g, "/");
  }

  private async flushDryRunBlockedEdits(
    verifiedPath: string,
    events: OrchestratorEvents,
    applyNow: boolean
  ): Promise<void> {
    if (!applyNow) {
      return;
    }
    for (const [path, edit] of [...this.dryRunBlockedEdits.entries()]) {
      if (!pathsMatch(path, verifiedPath)) {
        continue;
      }
      if (!isDryRunVerified(edit.relativePath)) {
        continue;
      }
      try {
        const applied = await applyPendingEdit(edit.id);
        events.onStatus(`Auto-applied (after dry-run): ${applied}`);
        events.onEditApplied(edit.id, applied);
        this.dryRunBlockedEdits.delete(path);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        events.onStatus(`Auto-apply after dry-run failed (${msg}).`);
        events.onEditNeedsApply?.(edit.id);
      }
    }
  }

  private async deliverPendingEdit(
    edit: PendingEdit,
    events: OrchestratorEvents,
    applyNow: boolean
  ): Promise<void> {
    let doApply = applyNow;
    const dryRun = validateDryRunBeforeApply(edit.relativePath);
    if (doApply && !dryRun.allowed) {
      this.dryRunBlockedEdits.set(this.normEditPath(edit.relativePath), edit);
      events.onStatus(dryRun.reason ?? `Dry-run required for ${edit.relativePath}.`);
      doApply = false;
    }
    // Seal the current text bubble so the diff card sits between segments.
    events.onStreamBreak?.();
    // Always show the change card (line diff) — even when auto-applying.
    events.onPendingEdit(edit, { autoApply: doApply });
    // Let the webview paint the PR-style diff before disk write (realtime review).
    await new Promise<void>((r) => setTimeout(r, 50));
    if (!doApply) {
      return;
    }
    try {
      const path = await applyPendingEdit(edit.id);
      events.onStatus(`Auto-applied: ${path}`);
      events.onEditApplied(edit.id, path);
      this.dryRunBlockedEdits.delete(this.normEditPath(edit.relativePath));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      events.onStatus(`Auto-apply failed (${msg}); awaiting manual Apply.`);
      events.onEditNeedsApply?.(edit.id);
    }
  }

  private livePathDelivered(live: LiveEditSession, path: string): boolean {
    return live.deliveredRelPaths.some((p) => pathsMatch(p, path));
  }

  private markLivePath(live: LiveEditSession, path: string): void {
    const norm = path.replace(/\\/g, "/");
    if (!this.livePathDelivered(live, norm)) {
      live.deliveredRelPaths.push(norm);
    }
  }

  private deleteAllowedForLive(
    live: LiveEditSession,
    path: string,
    source: "user" | "model"
  ): boolean {
    if (!live.lockDeletesToUserTargets || live.preDeletePaths.length === 0) {
      return true;
    }
    const allowed = live.preDeletePaths.some((p) => pathsMatch(p, path));
    if (!allowed) {
      live.onSkippedDelete?.(
        path,
        source === "model"
          ? `user asked to delete ${live.preDeletePaths.join(", ")}, not this path`
          : "not in resolved user delete targets"
      );
    }
    return allowed;
  }

  /** Propose+deliver path-labeled fences that just closed in the stream buffer. */
  private async consumeAndDeliverLiveFences(
    buffer: string,
    live: LiveEditSession,
    events: OrchestratorEvents
  ): Promise<void> {
    if (!live.enabled) {
      return;
    }
    const completed = consumeCompletedFences(buffer, live.fenceState);
    for (const fence of completed) {
      if (!fence.hintPath) {
        // Unlabeled fences wait for end-of-turn scoring against attached files.
        continue;
      }
      const path = fence.hintPath.replace(/\\/g, "/");
      if (this.livePathDelivered(live, path)) {
        continue;
      }

      const isDelete =
        Boolean(fence.isDelete) ||
        /^(?:DELETE|REMOVE)(?:[_\s]+FILE)?\s*$/i.test((fence.content || "").trim());

      if (isDelete) {
        if (!this.deleteAllowedForLive(live, path, "model")) {
          continue;
        }
        const result = await proposeFileDelete(path);
        if (result.ok && result.pendingEdit) {
          this.markLivePath(live, path);
          live.onEditCollected?.(result.pendingEdit);
          await this.deliverPendingEdit(result.pendingEdit, events, live.applyNow);
        } else if (!result.ok) {
          live.onSkippedDelete?.(path, result.content || "delete failed");
        }
        continue;
      }

      const result = await proposeFileEdit(path, fence.content);
      if (result.ok && result.pendingEdit) {
        this.markLivePath(live, path);
        live.onEditCollected?.(result.pendingEdit);
        await this.deliverPendingEdit(result.pendingEdit, events, live.applyNow);
      } else if (!result.ok) {
        live.onSkippedWrite?.(path, result.content || "write blocked");
      }
    }
  }

  /**
   * Replay a non-streamed final answer fence-by-fence so Apply cards appear
   * between sections (batch replay when streaming was skipped).
   */
  private async replayContentWithLiveFences(
    text: string,
    events: OrchestratorEvents,
    live: LiveEditSession | undefined
  ): Promise<void> {
    if (!text) {
      return;
    }
    if (!live?.enabled) {
      events.onToken(text);
      return;
    }

    // New buffer — keep fingerprints so we do not re-apply, but reset offset.
    live.fenceState.scannedUpTo = 0;

    const fenceRe = /```([^\n`]*)\n([\s\S]*?)```/g;
    let emitted = 0;
    let m: RegExpExecArray | null;
    while ((m = fenceRe.exec(text)) !== null) {
      const end = m.index + m[0].length;
      const before = text.slice(emitted, m.index);
      if (before) {
        events.onToken(before);
      }
      const info = m[1] ?? "";
      // Path-labeled writes become diff cards — show path line, not full file body.
      if (isPathLabeledWriteFence(info)) {
        const pathHint = pathFromFenceInfo(info);
        if (pathHint) {
          events.onToken(`\n**Edit:** \`${pathHint}\`\n`);
        }
      } else {
        events.onToken(m[0]);
      }
      emitted = end;
      await this.consumeAndDeliverLiveFences(text.slice(0, end), live, events);
    }
    if (emitted < text.length) {
      events.onToken(text.slice(emitted));
      await this.consumeAndDeliverLiveFences(text, live, events);
    }
  }

  /**
   * Parse a cloud escalation answer (Cursor/Gemini/Claude) into Apply cards (P3).
   */
  private async applyEditsFromCloudAnswer(opts: {
    cloudText: string;
    providerLabel: string;
    attachedPaths: string[];
    preDeletePaths: string[];
    lockDeletesToUserTargets: boolean;
    applyNow: boolean;
    events: OrchestratorEvents;
    codingEdits: PendingEdit[];
  }): Promise<number> {
    if (!getConfig().escalate.applyFromCloud) {
      return 0;
    }

    const proposed = await proposeEditsFromCloudAnswer({
      cloudText: opts.cloudText,
      attachedPaths: opts.attachedPaths,
      preDeletePaths: opts.preDeletePaths,
      lockDeletesToUserTargets: opts.lockDeletesToUserTargets,
      onPendingEdit: async (edit) => {
        await this.deliverPendingEdit(edit, opts.events, opts.applyNow);
      },
      onSkippedDelete: (path, reason) => {
        opts.events.onStatus(`Skipped cloud delete of ${path} (${reason}).`);
      },
      onSkippedWrite: (path, reason) => {
        this.noteBlockedWrite(opts.events, path, reason);
      },
    });

    if (proposed.edits.length > 0) {
      const seen = new Set(opts.codingEdits.map((e) => e.absolutePath));
      for (const edit of proposed.edits) {
        if (!seen.has(edit.absolutePath)) {
          opts.codingEdits.push(edit);
          seen.add(edit.absolutePath);
        }
      }
    }

    if (proposed.count > 0) {
      const deletes = proposed.edits.filter((e) => e.kind === "delete").length;
      const writes = proposed.count - deletes;
      opts.events.onStatus(
        opts.applyNow
          ? `Applied ${writes} write(s) and ${deletes} delete(s) from ${opts.providerLabel}.`
          : proposed.count === 1
            ? deletes
              ? `Cloud proposed a delete — click Delete to confirm (${opts.providerLabel}).`
              : `Cloud proposed an edit — click Apply (${opts.providerLabel}).`
            : `Cloud proposed ${writes} write(s) and ${deletes} delete(s) — click Apply/Delete (${opts.providerLabel}).`
      );
    }

    return proposed.count;
  }

  async handleUserMessage(
    rawText: string,
    events: OrchestratorEvents,
    opts?: { imageAttachments?: ImageAttachment[]; sequentialMode?: boolean }
  ): Promise<void> {
    this.abort?.abort();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.turnInProgress = true;
    this.userChoseCloudEscalation = false;
    if (!opts?.sequentialMode) {
      this.sequentialRetryAttempted = false;
    }
    this.pendingContextInjects = [];
    this.turnContextInjects = [];
    resetDryRunSession();
    this.dryRunBlockedEdits.clear();

    try {
      const mode: BlossomMode = "coding";
      let userText = stripSlashCommand(rawText) || rawText;
      this.lastUserText = userText;
      const imageAttachments = opts?.imageAttachments ?? [];
      const sequentialMode = opts?.sequentialMode ?? false;
      const cfg = getConfig();

      if (imageAttachments.length > 0) {
        events.onTool(
          "image_attach",
          imageAttachments.map((a) => a.fileName).join(", ")
        );
        if (cfg.vision.onAttach === "escalate") {
          const vision = await this.handleVisionAttach(
            userText,
            imageAttachments,
            events
          );
          if (vision.kind === "cancel") {
            events.onStatus("Cancelled — image attach discarded.");
            events.onDone("");
            return;
          }
          if (vision.kind === "done") {
            this.history.push({
              role: "user",
              content: vision.userHistoryLine,
            });
            this.history.push({ role: "assistant", content: vision.finalText });
            await this.maintainSessionHistory(events, userText);
            if (vision.feedbackId) {
              events.onFeedback?.({ id: vision.feedbackId });
            }
            events.onDone(vision.finalText, {
              deescalateAvailable: this.canDeescalate(),
            });
            return;
          }
          userText = vision.promptText;
        } else if (cfg.vision.onAttach === "local-caption") {
          const batch = await captionImageAttachments(imageAttachments, {
            onStatus: (msg) => events.onStatus(msg),
          });
          const sources = batch.captions.map((c) => c.source).join(", ");
          events.onTool("image_caption", sources || "none");
          userText = batch.block
            ? `${batch.block}\n\n${userText}`
            : `${formatImageMetadataBlock(imageAttachments)}\n\n${userText}`;
          if (batch.usable) {
            events.onStatus(
              `Local image caption ready (${sources}) — local coder is still text-only.`
            );
          } else {
            events.onStatus(
              "Local VL/OCR unavailable — metadata only. See hand-off.md vision roadblocks."
            );
          }
        } else {
          userText = `${formatImageMetadataBlock(imageAttachments)}\n\n${userText}`;
          events.onStatus(
            "Image metadata attached — local coder cannot see pixels."
          );
        }
      }

      const autoIntent = parseAutoApplyIntent(userText);
      if (autoIntent.disableSession) {
        this.autoApply = false;
        events.onStatus("Auto-apply off for this session.");
      } else if (autoIntent.enableSession) {
        this.autoApply = true;
        events.onStatus("Auto-apply on for this session.");
      }
      const applyNow = this.autoApply || !!autoIntent.applyOnce;

      const model = modelForMode(mode);
      events.onMode(mode, model, "coding");

      const enriched = await enrichWithEditorContext(userText, {
        forceActiveEditor: true,
        extensionContext: this.context,
        includeRepoKnowledge: true,
      });
      if (enriched.attached.length > 0) {
        events.onTool("editor_context", enriched.attached.join(", "));
      } else {
        events.onStatus(
          "No editor file attached — open the file in a tab, then ask again."
        );
      }
      this.turnToolFailureNotes = [];
      const padNeed = this.refreshTurnScratchpadNeed(userText, {
        attachedPathCount: enriched.attachedPaths.length,
      });
      if (padNeed.level === "required") {
        events.onStatus("Scratchpad required for this task — agent will maintain notes");
      }

      const decompWs = await detectDecompWorkspace();
      const memoryQuery = decompWs
        ? decompMemoryQuery(userText)
        : userText;
      const memoryHits = await fetchCodingMemoryForPrompt(
        memoryQuery,
        decompWs ? 6 : 4
      );
      if (memoryHits.block) {
        events.onStatus(
          decompWs
            ? `Coding memory (decomp): ${memoryHits.count} lesson(s).`
            : `Coding memory: ${memoryHits.count} lesson(s) for this ask.`
        );
        events.onTool("coding_memory", `${memoryHits.count} hit(s)`);
      }
      const continuityBrief = formatContinuityBrief({
        hasScratchpad: Boolean(getScratchpad(this.context).trim()),
        memoryHitCount: memoryHits.count,
        archiveHint: true,
      });

      const system = await buildSystemPrompt();
      let promptUser = [
        continuityBrief,
        memoryHits.block,
        enriched.promptText,
      ]
        .filter(Boolean)
        .join("\n\n");
      if (cfg.backend === "chatRouter") {
        // ChatRouter drops extension system prompts — inject protocol into the user turn.
        promptUser = sequentialMode
          ? wrapUserPromptForSequentialAgent(promptUser)
          : wrapUserPromptForCodingAgent(
              promptUser,
              detectPromptTier(promptUser, {
                hasEditorContext:
                  enriched.attached.length > 0 || hasEditorContextInPrompt(promptUser),
              })
            );
        promptUser = ensureChatRouterCodingRoute(promptUser);
        events.onStatus(
          sequentialMode
            ? "Blossom sequential chunk mode (read_file catalog)…"
            : "Blossom coding…"
        );
      }

      // ChatRouter only uses the last user message for routing — put editor
      // context there and force the coding keyword path.
      await this.maintainSessionHistory(events, userText);
      if (cfg.backend === "chatRouter") {
        promptUser = wrapPromptWithSessionContext(
          promptUser,
          this.historySummary,
          this.history
        );
        promptUser = await this.injectResearchBriefIfNeeded(
          promptUser,
          userText,
          events,
          signal
        );
      }
      const messages: OllamaMessage[] =
        cfg.backend === "chatRouter"
          ? [{ role: "user", content: promptUser }]
          : [
              { role: "system", content: await this.augmentSystem(system) },
              ...this.history,
              { role: "user", content: promptUser },
            ];

      this.history.push({ role: "user", content: userText });

      // Resolve delete targets before the agent loop so live fence applies
      // can honor the same allowlist mid-stream.
      const deletePlan = enriched.safeDeleteIntent
        ? {
            resolved: [] as string[],
            missing: [] as string[],
            ambiguous: [] as { hint: string; candidates: string[] }[],
          }
        : await resolveUserDeleteTargets(userText, enriched.attachedPaths);

      if (!enriched.safeDeleteIntent) {
        for (const miss of deletePlan.missing) {
          events.onStatus(`No workspace file matching "${miss}" to delete.`);
        }
        for (const amb of deletePlan.ambiguous) {
          events.onStatus(
            `Ambiguous delete "${amb.hint}" — matches ${amb.candidates.join(", ")}. Not deleting.`
          );
        }
        if (deletePlan.resolved.length > 0) {
          events.onStatus(
            `Delete target(s) from your ask: ${deletePlan.resolved.join(", ")}`
          );
        }
      }

      let codingEdits: PendingEdit[] = [];
      const live: LiveEditSession = {
        // Safe-delete mode ignores model fences entirely.
        enabled: !enriched.safeDeleteIntent,
        applyNow,
        fenceState: createFenceScanState(),
        deliveredRelPaths: [],
        onEditCollected: (edit) => {
          codingEdits.push(edit);
        },
        preDeletePaths: deletePlan.resolved,
        lockDeletesToUserTargets: deletePlan.resolved.length > 0,
        onSkippedDelete: (path, reason) => {
          events.onStatus(`Skipped delete of ${path} (${reason}).`);
        },
        onSkippedWrite: (path, reason) => {
          this.noteBlockedWrite(events, path, reason);
        },
      };

      let looped;
      try {
        looped = await this.runToolLoop(
          model,
          messages,
          events,
          signal,
          applyNow,
          (edit) => {
            codingEdits.push(edit);
            this.markLivePath(live, edit.relativePath);
          },
          live,
          sequentialMode
        );
      } catch (err) {
        if (err instanceof DeferCloudEscalationError) {
          if (
            !this.sequentialRetryAttempted &&
            isContextOverflowReason(err.message) &&
            cfg.backend === "chatRouter"
          ) {
            this.sequentialRetryAttempted = true;
            events.onStatus(
              "Context overflow — retrying with sequential chunk mode (read_file catalog)…"
            );
            events.onStreamBreak?.();
            if (
              this.history.length > 0 &&
              this.history[this.history.length - 1].role === "user"
            ) {
              this.history.pop();
            }
            await this.handleUserMessage(rawText, events, {
              imageAttachments,
              sequentialMode: true,
            });
            return;
          }
          await this.finishDeferredRouterEscalation({
            err,
            userText,
            system,
            enriched,
            deletePlan,
            applyNow,
            events,
            codingEdits,
            mode,
            model,
          });
          return;
        }
        throw err;
      }
      let assistantText = looped.content;
      let intelSource = looped.intelSource;
      let turnFeedbackId = looped.feedbackId;
      if (cfg.backend === "ollama" && !intelSource) {
        intelSource = "ollama";
      }

      // Safe-delete asks: extension deletes [UNUSED FILES] for real.
      // Skip model fences entirely in that mode — the coder often recreates
      // orphans or adds unused links back into index.html.
      if (enriched.safeDeleteIntent) {
        codingEdits = [];
        const deletePaths = enriched.unusedPaths ?? [];
        const deleted: string[] = [];
        for (const rel of deletePaths) {
          const result = await proposeFileDelete(rel);
          if (result.ok && result.pendingEdit) {
            await this.deliverPendingEdit(result.pendingEdit, events, applyNow);
            deleted.push(rel);
            codingEdits.push(result.pendingEdit);
          }
        }
        if (deleted.length > 0) {
          events.onStatus(
            applyNow
              ? `Deleted unused file(s): ${deleted.join(", ")}`
              : `Proposed delete(s): ${deleted.join(", ")} — click Delete to confirm.`
          );
        } else {
          events.onStatus(
            "No unused sibling files to delete (all are linked or none found)."
          );
        }
      } else {
        const proposed = await proposeEditsFromAssistantReply(
          assistantText,
          enriched.attachedPaths,
          async (edit) => {
            await this.deliverPendingEdit(edit, events, applyNow);
          },
          deletePlan.resolved,
          {
            lockDeletesToUserTargets: deletePlan.resolved.length > 0,
            skipPaths: live.deliveredRelPaths,
            onSkippedDelete: (path, reason) => {
              events.onStatus(`Skipped delete of ${path} (${reason}).`);
            },
            onSkippedWrite: (path, reason) => {
              this.noteBlockedWrite(events, path, reason);
            },
          }
        );
        // Prefer tool write_file/delete_file edits when present; merge fence-based ones.
        if (proposed.edits.length > 0) {
          const seen = new Set(codingEdits.map((e) => e.absolutePath));
          for (const edit of proposed.edits) {
            if (!seen.has(edit.absolutePath)) {
              codingEdits.push(edit);
              seen.add(edit.absolutePath);
            }
          }
        }
        if (proposed.count > 0 && !applyNow) {
          const deletes = proposed.edits.filter((e) => e.kind === "delete").length;
          const writes = proposed.count - deletes;
          events.onStatus(
            proposed.count === 1
              ? deletes
                ? "Proposed file delete — click Delete to remove it from disk."
                : "Proposed file edit — click Apply to write it to disk."
              : `Proposed ${writes} write(s) and ${deletes} delete(s) — click Apply/Delete to confirm.`
          );
        }
      }

      const backendLabel = intelSource
        ? labelIntelSource(intelSource)
        : undefined;
      if (backendLabel) {
        events.onMode(mode, model, backendLabel);
        events.onStatus(`Backend: ${backendLabel}`);
      }

      // Keep the reply clean — summary is a separate UI card at the end
      const modelNotes = parseModelSummaryNotes(assistantText);
      assistantText = stripCodingSummarySection(assistantText);
      assistantText = await this.settleScratchpad(
        events,
        assistantText,
        userText
      );

      const { clean, target, escalateReason } = stripEscalateMarkers(assistantText);
      let finalText = clean;

      if (escalateReason && target) {
        this.lastLocalAttempt = clean;
        events.onStatus(`Escalation suggested: ${escalateReason}`);

        const escalation = await this.runUserChosenEscalation({
          userText,
          localAttempt: clean,
          suggestedTarget: target,
          escalateReason,
          system,
          events,
        });

        if (escalation?.accepted && escalation.text && escalation.provider) {
          const label = cloudProviderDisplayName(escalation.provider);
          finalText = `${clean}\n\n---\n*${label}:*\n${escalation.text}`.trim();
          events.onToken(`\n\n---\n*${label}:*\n${escalation.text}`);

          await this.applyEditsFromCloudAnswer({
            cloudText: escalation.text,
            providerLabel: label,
            attachedPaths: enriched.attachedPaths,
            preDeletePaths: deletePlan.resolved,
            lockDeletesToUserTargets: deletePlan.resolved.length > 0,
            applyNow,
            events,
            codingEdits,
          });

          const reg = await registerFeedbackTurn({
            userPrompt: userText,
            answer: finalText,
            source:
              escalation.feedbackSource ??
              `blossom_assistant_${escalation.provider}`,
          });
          if (reg.feedback_id) {
            turnFeedbackId = reg.feedback_id;
            events.onStatus("Rate this answer with 👍/👎 to teach Blossom.");
          } else if (reg.error) {
            events.onStatus(`Could not register feedback: ${reg.error}`);
          }

          if (getConfig().deescalate.enabled) {
            this.lastCloudEscalation = createCloudSnapshot({
              userText,
              localAttempt: clean,
              provider: escalation.provider,
              cloudAnswer: escalation.text,
              displayedAnswer: finalText,
            });
          }
        }
      }

      const summary = buildCodingSummaryInfo(codingEdits, {
        autoApplied: applyNow && codingEdits.length > 0,
        backend: backendLabel,
        modelNotes,
      });
      if (summary) {
        events.onCodingSummary(summary);
      }

      if (
        getConfig().memory.enabled &&
        getConfig().memory.autoLearn &&
        finalText.trim().length > 80 &&
        !escalateReason
      ) {
        const learn = await learnCodingLesson({
          userPrompt: userText,
          answer: finalText,
          source: "blossom_assistant_local",
        });
        if (learn.stored) {
          events.onStatus("Saved coding lesson to local memory.");
        }
      }

      this.flushTurnContextInjectsToHistory();
      this.history.push({ role: "assistant", content: finalText });
      await this.maintainSessionHistory(events, userText);
      if (turnFeedbackId) {
        events.onFeedback?.({ id: turnFeedbackId });
      }
      events.onDone(finalText, { deescalateAvailable: this.canDeescalate() });
    } catch (err) {
      // User hit Stop (or fetch aborted) — not a backend failure.
      if (isAbortLike(err) && !(err instanceof LlmError)) {
        events.onStatus("Cancelled");
        events.onDone("");
        return;
      }

      const msg = formatChatError(err);
      try {
        this.abort?.abort();
      } catch {
        // ignore
      }
      events.onStatus(`Error: ${msg}`);
      events.onError(msg);
    } finally {
      this.turnInProgress = false;
      this.pendingContextInjects = [];
      this.turnContextInjects = [];
    }
  }

  /**
   * After a cloud escalation answer, re-run local Blossom with the cloud text
   * as read-only reference (P2 de-escalate).
   */
  async retryWithLocalBlossom(events: OrchestratorEvents): Promise<void> {
    const snap = this.lastCloudEscalation;
    if (!snap || !getConfig().deescalate.enabled) {
      events.onError("No cloud answer to retry locally.");
      return;
    }
    if (this.turnInProgress) {
      events.onError("Wait for the current turn to finish.");
      return;
    }

    this.lastCloudEscalation = undefined;
    this.abort?.abort();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.turnInProgress = true;
    this.pendingContextInjects = [];
    this.turnContextInjects = [];

    try {
      events.onStreamBreak?.();
      events.onStatus(
        "Local Blossom retry — cloud answer is read-only reference…"
      );

      const cfg = getConfig();
      const mode: BlossomMode = "coding";
      const model = modelForMode(mode);
      const applyNow = this.autoApply;
      events.onMode(mode, model, "coding");

      const retryRaw = buildDeescalateRetryPrompt(snap);
      const enriched = await enrichWithEditorContext(retryRaw, {
        forceActiveEditor: true,
        extensionContext: this.context,
        includeRepoKnowledge: true,
      });
      if (enriched.attached.length > 0) {
        events.onTool("editor_context", enriched.attached.join(", "));
      }

      const last = this.history[this.history.length - 1];
      if (
        last?.role === "assistant" &&
        last.content === snap.displayedAnswer
      ) {
        this.history.pop();
      }

      const system = await buildSystemPrompt();
      let promptUser = enriched.promptText;
      if (cfg.backend === "chatRouter") {
        promptUser = wrapUserPromptForCodingAgent(
          promptUser,
          detectPromptTier(promptUser, {
            hasEditorContext: enriched.attached.length > 0 || hasEditorContextInPrompt(promptUser),
          })
        );
        promptUser = ensureChatRouterCodingRoute(promptUser);
        events.onStatus("Blossom coding…");
      }

      await this.maintainSessionHistory(events, snap.userText);
      if (cfg.backend === "chatRouter") {
        promptUser = wrapPromptWithSessionContext(
          promptUser,
          this.historySummary,
          this.history
        );
        promptUser = await this.injectResearchBriefIfNeeded(
          promptUser,
          snap.userText,
          events,
          signal
        );
      }
      const messages: OllamaMessage[] =
        cfg.backend === "chatRouter"
          ? [{ role: "user", content: promptUser }]
          : [
              { role: "system", content: await this.augmentSystem(system) },
              ...this.history,
              { role: "user", content: promptUser },
            ];

      const deletePlan = enriched.safeDeleteIntent
        ? {
            resolved: [] as string[],
            missing: [] as string[],
            ambiguous: [] as { hint: string; candidates: string[] }[],
          }
        : await resolveUserDeleteTargets(snap.userText, enriched.attachedPaths);

      let codingEdits: PendingEdit[] = [];
      const live: LiveEditSession = {
        enabled: !enriched.safeDeleteIntent,
        applyNow,
        fenceState: createFenceScanState(),
        deliveredRelPaths: [],
        onEditCollected: (edit) => {
          codingEdits.push(edit);
        },
        preDeletePaths: deletePlan.resolved,
        lockDeletesToUserTargets: deletePlan.resolved.length > 0,
        onSkippedDelete: (path, reason) => {
          events.onStatus(`Skipped delete of ${path} (${reason}).`);
        },
        onSkippedWrite: (path, reason) => {
          this.noteBlockedWrite(events, path, reason);
        },
      };

      events.onToken(`---\n*Local retry:*\n`);

      const looped = await this.runToolLoop(
        model,
        messages,
        events,
        signal,
        applyNow,
        (edit) => {
          codingEdits.push(edit);
          this.markLivePath(live, edit.relativePath);
        },
        live
      );
      let assistantText = looped.content;
      let intelSource = looped.intelSource;
      let turnFeedbackId = looped.feedbackId;
      if (cfg.backend === "ollama" && !intelSource) {
        intelSource = "ollama";
      }

      if (!enriched.safeDeleteIntent) {
        const proposed = await proposeEditsFromAssistantReply(
          assistantText,
          enriched.attachedPaths,
          async (edit) => {
            await this.deliverPendingEdit(edit, events, applyNow);
          },
          deletePlan.resolved,
          {
            lockDeletesToUserTargets: deletePlan.resolved.length > 0,
            skipPaths: live.deliveredRelPaths,
            onSkippedDelete: (path, reason) => {
              events.onStatus(`Skipped delete of ${path} (${reason}).`);
            },
            onSkippedWrite: (path, reason) => {
              this.noteBlockedWrite(events, path, reason);
            },
          }
        );
        if (proposed.edits.length > 0) {
          const seen = new Set(codingEdits.map((e) => e.absolutePath));
          for (const edit of proposed.edits) {
            if (!seen.has(edit.absolutePath)) {
              codingEdits.push(edit);
              seen.add(edit.absolutePath);
            }
          }
        }
        if (proposed.count > 0 && !applyNow) {
          const deletes = proposed.edits.filter((e) => e.kind === "delete").length;
          const writes = proposed.count - deletes;
          events.onStatus(
            proposed.count === 1
              ? deletes
                ? "Proposed file delete — click Delete to remove it from disk."
                : "Proposed file edit — click Apply to write it to disk."
              : `Proposed ${writes} write(s) and ${deletes} delete(s) — click Apply/Delete to confirm.`
          );
        }
      }

      const backendLabel = intelSource
        ? labelIntelSource(intelSource)
        : undefined;
      if (backendLabel) {
        events.onMode(mode, model, backendLabel);
        events.onStatus(`Backend: ${backendLabel}`);
      }

      const modelNotes = parseModelSummaryNotes(assistantText);
      assistantText = stripCodingSummarySection(assistantText);
      this.refreshTurnScratchpadNeed(snap.userText);
      assistantText = await this.settleScratchpad(
        events,
        assistantText,
        snap.userText
      );
      const { clean, target } = stripEscalateMarkers(assistantText);
      if (target) {
        events.onStatus(
          "De-escalate retry ignores further cloud escalation markers."
        );
      }

      const finalText = mergeDeescalateAnswer(snap, clean);
      const summary = buildCodingSummaryInfo(codingEdits, {
        autoApplied: applyNow && codingEdits.length > 0,
        backend: backendLabel,
        modelNotes,
      });
      if (summary) {
        events.onCodingSummary(summary);
      }

      this.history.push({ role: "assistant", content: finalText });
      await this.maintainSessionHistory(events, snap.userText);

      const reg = await registerFeedbackTurn({
        userPrompt: snap.userText,
        answer: finalText,
        source: "blossom_assistant_deescalate",
      });
      if (reg.feedback_id) {
        turnFeedbackId = reg.feedback_id;
        events.onStatus("Rate this local retry with 👍/👎 to teach Blossom.");
      } else if (reg.error) {
        events.onStatus(`Could not register feedback: ${reg.error}`);
      }

      if (turnFeedbackId) {
        events.onFeedback?.({ id: turnFeedbackId });
      }
      events.onDone(finalText, { deescalateAvailable: false });
    } catch (err) {
      if (isAbortLike(err) && !(err instanceof LlmError)) {
        events.onStatus("Cancelled");
        events.onDone("");
        return;
      }

      const msg = formatChatError(err);
      try {
        this.abort?.abort();
      } catch {
        // ignore
      }
      events.onStatus(`Error: ${msg}`);
      events.onError(msg);
    } finally {
      this.turnInProgress = false;
      this.pendingContextInjects = [];
      this.turnContextInjects = [];
    }
  }

  /**
   * ChatRouter deferred cloud (local coder failed) — show picker, then extension-owned escalate.
   */
  private async finishDeferredRouterEscalation(opts: {
    err: DeferCloudEscalationError;
    userText: string;
    system: string;
    enriched: Awaited<ReturnType<typeof enrichWithEditorContext>>;
    deletePlan: Awaited<ReturnType<typeof resolveUserDeleteTargets>>;
    applyNow: boolean;
    events: OrchestratorEvents;
    codingEdits: PendingEdit[];
    mode: BlossomMode;
    model: string;
  }): Promise<void> {
    const {
      err,
      userText,
      system,
      enriched,
      deletePlan,
      applyNow,
      events,
      codingEdits,
      mode,
      model,
    } = opts;

    events.onStatus("Local coder failed — pick how to continue…");
    events.onStreamBreak?.();
    this.lastLocalAttempt = err.localAttempt;

    const escalation = await this.runUserChosenEscalation({
      userText,
      localAttempt: err.localAttempt,
      suggestedTarget: "cursor",
      escalateReason: err.message,
      system,
      events,
    });

    let finalText = err.localAttempt;
    let turnFeedbackId: string | undefined;
    let backendLabel: string | undefined;

    if (escalation?.accepted && escalation.text && escalation.provider) {
      const label = cloudProviderDisplayName(escalation.provider);
      backendLabel = label;
      finalText = err.localAttempt
        ? `${err.localAttempt}\n\n---\n*${label}:*\n${escalation.text}`.trim()
        : escalation.text.trim();
      if (err.localAttempt) {
        events.onToken(`\n\n---\n*${label}:*\n${escalation.text}`);
      } else {
        events.onToken(finalText);
      }

      await this.applyEditsFromCloudAnswer({
        cloudText: escalation.text,
        providerLabel: label,
        attachedPaths: enriched.attachedPaths,
        preDeletePaths: deletePlan.resolved,
        lockDeletesToUserTargets: deletePlan.resolved.length > 0,
        applyNow,
        events,
        codingEdits,
      });

      const reg = await registerFeedbackTurn({
        userPrompt: userText,
        answer: finalText,
        source:
          escalation.feedbackSource ??
          `blossom_assistant_${escalation.provider}`,
      });
      if (reg.feedback_id) {
        turnFeedbackId = reg.feedback_id;
        events.onStatus("Rate this answer with 👍/👎 to teach Blossom.");
      } else if (reg.error) {
        events.onStatus(`Could not register feedback: ${reg.error}`);
      }

      if (getConfig().deescalate.enabled) {
        this.lastCloudEscalation = createCloudSnapshot({
          userText,
          localAttempt: err.localAttempt,
          provider: escalation.provider,
          cloudAnswer: escalation.text,
          displayedAnswer: finalText,
        });
      }
    } else if (err.localAttempt) {
      events.onToken(err.localAttempt);
    } else if (!escalation) {
      finalText = "Escalation cancelled.";
      events.onStatus("Escalation cancelled.");
    }

    if (backendLabel) {
      events.onMode(mode, model, backendLabel);
      events.onStatus(`Backend: ${backendLabel}`);
    }

    const summary = buildCodingSummaryInfo(codingEdits, {
      autoApplied: applyNow && codingEdits.length > 0,
      backend: backendLabel,
    });
    if (summary) {
      events.onCodingSummary(summary);
    }

    this.flushTurnContextInjectsToHistory();
    this.history.push({ role: "assistant", content: finalText });
    await this.maintainSessionHistory(events, opts.userText);
    if (turnFeedbackId) {
      events.onFeedback?.({ id: turnFeedbackId });
    }
    events.onDone(finalText, { deescalateAvailable: this.canDeescalate() });
  }

  /**
   * Compress session, optionally ask user which cloud path, then escalate.
   */
  private async runUserChosenEscalation(opts: {
    userText: string;
    localAttempt: string;
    suggestedTarget: EscalateTarget;
    escalateReason: string;
    system: string;
    events: OrchestratorEvents;
    forVision?: boolean;
    imageAttachments?: Array<{ path: string; metadata?: string }>;
    /** Skip picker — use suggestedTarget (e.g. user already chose in vision flow). */
    skipChoice?: boolean;
  }) {
    opts.events.onStatus("Compressing conversation for cloud handoff…");
    const repo = await ensureRepoKnowledge(this.context, 4000);
    const compressed = await compressConversationForHandoff(this.context, {
      history: mergeHistoryWithSummary(this.history, this.historySummary),
      userText: opts.userText,
      localAttempt: opts.localAttempt,
      escalateReason: opts.escalateReason,
      repoMapSnippet: repo.summary,
      midTurnInjects: this.activeMidTurnInjects(),
      imageAttachments: opts.imageAttachments,
    });
    this.handoffCache = compressed;

    let target = opts.suggestedTarget;
    const cfg = getConfig();

    if (cfg.escalate.askFirst && !opts.skipChoice) {
      opts.events.onStatus("Blossom is unsure — pick how to continue…");
      const choice = await promptEscalationChoice({
        reason: opts.escalateReason,
        suggested: opts.suggestedTarget,
        forVision: opts.forVision,
        handoffChars: compressed.compressedChars,
      });
      if (choice.action === "local") {
        opts.events.onStatus("Keeping local Blossom attempt.");
        return null;
      }
      if (choice.action === "cancel") {
        opts.events.onStatus("Escalation cancelled.");
        return null;
      }
      target = choice.provider;
      this.userChoseCloudEscalation = true;
    } else if (!opts.skipChoice) {
      this.userChoseCloudEscalation = true;
    }

    if (opts.forVision && target !== "cursor") {
      opts.events.onStatus(
        "Note: text-only cloud path — image paths in handoff, not pixels."
      );
    }

    const workspace = resolveWorkspaceRoot() ?? "";
    return runCloudEscalation(this.context, {
      target,
      ctx: {
        compressed,
        userText: opts.userText,
        localAttempt: opts.localAttempt,
        workspace,
        systemPrompt: opts.system,
        reason: opts.escalateReason,
        repoMap: repo.summary,
        activeFile: vscode.window.activeTextEditor?.document.uri.fsPath,
        imageAttachments: opts.imageAttachments,
      },
      onStatus: (text) => opts.events.onStatus(text),
    });
  }

  /**
   * Docs/version/API asks: POST ChatRouter /v1/research and prepend brief
   * before the tool loop. Soft-fail; no TS planner/search.
   */
  private async injectResearchBriefIfNeeded(
    promptUser: string,
    userText: string,
    events: OrchestratorEvents,
    signal: AbortSignal
  ): Promise<string> {
    if (!looksLikeDocsResearch(userText)) {
      return promptUser;
    }
    events.onStatus("Research pipeline (docs/API)…");
    const pref = await maybePrefetchResearchBrief(userText, signal);
    if (signal.aborted || !pref.brief) {
      return promptUser;
    }
    const src =
      pref.sourceCount > 0 ? `, ${pref.sourceCount} source(s)` : "";
    events.onTool("research", `${pref.mode}${src}`);
    events.onStatus(
      `Research brief ready (${pref.mode}${src}) — coding with cited context…`
    );
    return prependResearchBrief(promptUser, pref.brief);
  }

  /**
   * Image attach with vision.onAttach=escalate — skip local coder unless user
   * chooses metadata-only or declines cloud escalate.
   */
  private async handleVisionAttach(
    userText: string,
    imageAttachments: ImageAttachment[],
    events: OrchestratorEvents
  ): Promise<
    | { kind: "cancel" }
    | { kind: "local"; promptText: string }
    | {
        kind: "done";
        finalText: string;
        userHistoryLine: string;
        feedbackId?: string;
      }
  > {
    const metaBlock = formatImageMetadataBlock(imageAttachments);
    const displayPrompt = metaBlock ? `${metaBlock}\n\n${userText}` : userText;
    const userHistoryLine = `${userText}\n[${imageAttachments.length} image(s) attached]`;
    const handoffImages = attachmentPathsForHandoff(imageAttachments);
    const visionReason = "Vision upload — local coder is text-only";

    events.onStatus("Image attached — local Blossom coder is text-only.");

    let cloudTarget: EscalateTarget = "cursor";
    if (getConfig().escalate.askFirst) {
      const choice = await promptEscalationChoice({
        reason: visionReason,
        suggested: "cursor",
        forVision: true,
      });
      if (choice.action === "cancel") {
        return { kind: "cancel" };
      }
      if (choice.action === "local") {
        events.onStatus(
          "Staying local with metadata only — Blossom cannot see image pixels."
        );
        return { kind: "local", promptText: displayPrompt };
      }
      cloudTarget = choice.provider;
    }

    events.onStatus("Preparing cloud handoff with session context…");
    const system = await buildSystemPrompt();
    const escalation = await this.runUserChosenEscalation({
      userText,
      localAttempt: "",
      suggestedTarget: cloudTarget,
      escalateReason: visionReason,
      system,
      events,
      forVision: true,
      imageAttachments: handoffImages,
      skipChoice: true,
    });

    if (escalation?.accepted && escalation.text && escalation.provider) {
      const label = cloudProviderDisplayName(escalation.provider);
      const finalText = `*${label} (vision):*\n${escalation.text}`.trim();
      events.onToken(`\n\n*${label} (vision):*\n${escalation.text}`);

      const enriched = await enrichWithEditorContext(userText, {
        forceActiveEditor: true,
        extensionContext: this.context,
        includeRepoKnowledge: false,
      });
      await this.applyEditsFromCloudAnswer({
        cloudText: escalation.text,
        providerLabel: label,
        attachedPaths: enriched.attachedPaths,
        preDeletePaths: [],
        lockDeletesToUserTargets: false,
        applyNow: this.autoApply,
        events,
        codingEdits: [],
      });

      let feedbackId: string | undefined;
      const reg = await registerFeedbackTurn({
        userPrompt: userText,
        answer: finalText,
        source:
          escalation.feedbackSource ??
          `blossom_assistant_${escalation.provider}`,
      });
      if (reg.feedback_id) {
        feedbackId = reg.feedback_id;
        events.onStatus("Rate this answer with 👍/👎 to teach Blossom.");
      } else if (reg.error) {
        events.onStatus(`Could not register feedback: ${reg.error}`);
      }

      if (getConfig().deescalate.enabled) {
        this.lastCloudEscalation = createCloudSnapshot({
          userText,
          localAttempt: "",
          provider: escalation.provider,
          cloudAnswer: escalation.text,
          displayedAnswer: finalText,
        });
      }

      return { kind: "done", finalText, userHistoryLine, feedbackId };
    }

    events.onStatus(
      "Escalation declined or failed — continuing locally with metadata only (no vision)."
    );
    return { kind: "local", promptText: displayPrompt };
  }

  private async augmentSystem(system: string): Promise<string> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const related = await suggestRelatedFolders();
    const rootLines =
      folders.length > 1
        ? `Multi-root workspace (${folders.length}): ${folders.map((f) => f.name).join(", ")}. Prefer paths like RootName/relative/path. Use list_workspace_roots / list_related / peek_related for other folders.`
        : folders.length === 1
          ? `Workspace root: ${folders[0].name}. Use list_related / peek_related for sibling dependency folders.`
          : "";
    const relatedLine =
      related.length > 0
        ? `Likely related folders: ${related.join(", ")}`
        : "";
    const summaryLine = this.historySummary?.trim()
      ? `[PRIOR SESSION SUMMARY]\n${this.historySummary.trim()}`
      : "";
    return [system, rootLines, relatedLine, summaryLine].filter(Boolean).join("\n\n");
  }

  private async streamPlain(
    model: string,
    messages: OllamaMessage[],
    events: OrchestratorEvents,
    signal: AbortSignal,
    live?: LiveEditSession,
    sequentialMode = false,
    tools?: ChatTool[]
  ): Promise<{
    content: string;
    toolCalls: OllamaToolCall[];
    intelSource?: string;
    intelLabel?: string;
    feedbackId?: string;
  }> {
    const cfg = getConfig();
    const waitLabel =
      cfg.backend === "chatRouter"
        ? "Still waiting on Blossom…"
        : `Still waiting on ${model}…`;
    events.onStatus(
      cfg.backend === "chatRouter"
        ? "Blossom Thinking…"
        : `Streaming from ${model}…`
    );
    let content = "";
    let toolCalls: OllamaToolCall[] = [];
    /** Tokens after tool_call fences are stripped — used for live path-fence apply. */
    let fenceBuf = "";
    let intelSource: string | undefined;
    let intelLabel: string | undefined;
    let feedbackId: string | undefined;
    let reasoningAccum = "";
    if (live) {
      // Fresh stream buffer; fingerprints still dedupe across rounds.
      live.fenceState.scannedUpTo = 0;
    }

    const mergeReasoning = (incoming: string): string => {
      const msg = incoming;
      if (!msg) {
        return reasoningAccum;
      }
      if (!reasoningAccum) {
        return msg;
      }
      if (msg === reasoningAccum || reasoningAccum.endsWith(msg)) {
        return reasoningAccum;
      }
      if (msg.startsWith(reasoningAccum)) {
        return msg;
      }
      if (reasoningAccum.startsWith(msg)) {
        return reasoningAccum;
      }
      // Streaming delta from reasoning_content
      return reasoningAccum + msg;
    };

    const waitPulse = startWaitHeartbeat(events, signal, waitLabel);
    const tokenFilter = createToolCallTokenFilter();

    const noteThought = (t: BlossomThought): void => {
      waitPulse.bump();
      const fromFields = t.source || t.provider;
      if (fromFields) {
        intelSource = fromFields;
        intelLabel = labelIntelSource(fromFields);
      }
      const step = (t.step ?? "").toLowerCase();
      if (step === "intel_ready" || step === "cloud" || step === "learn" || step === "done") {
        const m =
          t.message.match(/\bsource\s*=\s*([a-z0-9_]+)/i) ||
          t.message.match(/\bprovider\s*=\s*([a-z0-9_]+)/i);
        if (m) {
          intelSource = m[1];
          intelLabel = labelIntelSource(m[1]);
        }
      }

      if (step === "model_reasoning") {
        const merged = mergeReasoning(t.message || "");
        if (!merged || merged === reasoningAccum) {
          return;
        }
        reasoningAccum = merged;
        events.onThought({
          step: "model_reasoning",
          message: reasoningAccum,
          source: t.source,
          provider: t.provider,
        });
        return;
      }
    };

    try {
      for await (const chunk of streamChat({
        model,
        messages,
        tools,
        signal,
        ...chatRouterRequestFlags(sequentialMode),
      })) {
        waitPulse.bump();
        if (chunk.intelSource) {
          intelSource = chunk.intelSource;
          intelLabel = chunk.intelLabel || labelIntelSource(chunk.intelSource);
        }
        if (chunk.feedback?.id && chunk.feedback.enabled !== false) {
          feedbackId = chunk.feedback.id;
        }
        if (chunk.thought) {
          noteThought(chunk.thought);
        }
        if (chunk.thoughts?.length) {
          for (const t of chunk.thoughts) {
            noteThought(t);
          }
        }
        if (chunk.message?.tool_calls?.length) {
          toolCalls = chunk.message.tool_calls;
        }
        const delta = chunk.message?.content ?? "";
        if (delta) {
          content += delta;
          const visibleDelta = tokenFilter.push(delta);
          if (visibleDelta) {
            fenceBuf += visibleDelta;
            events.onToken(visibleDelta);
            if (live) {
              await this.consumeAndDeliverLiveFences(fenceBuf, live, events);
            }
          }
        }
      }
      const tail = tokenFilter.flush();
      if (tail) {
        fenceBuf += tail;
        events.onToken(tail);
        if (live) {
          await this.consumeAndDeliverLiveFences(fenceBuf, live, events);
        }
      }
    } finally {
      waitPulse.stop();
    }
    // Keep raw `content` (with tool_call fences) so the agent loop can parse
    // and execute them; the UI only saw filtered tokens via tokenFilter.
    return {
      content,
      toolCalls,
      intelSource,
      intelLabel,
      feedbackId,
    };
  }

  private async runToolLoop(
    model: string,
    messages: OllamaMessage[],
    events: OrchestratorEvents,
    signal: AbortSignal,
    applyNow: boolean,
    onEditCollected?: (edit: PendingEdit) => void,
    live?: LiveEditSession,
    sequentialMode = false
  ): Promise<{
    content: string;
    intelSource?: string;
    feedbackId?: string;
  }> {
    const cfg = getConfig();
    const chatRouter = cfg.backend === "chatRouter";
    const maxToolRounds = Math.max(1, Math.min(32, cfg.agent.maxToolRounds || 12));
    const stepMode = cfg.agent.stepMode;
    const confirmAfter = Math.max(
      1,
      Math.min(20, cfg.agent.confirmToolsAfterRounds || 3)
    );
    const tier = detectPromptTier(this.lastUserText || "", {
      hasEditorContext: true,
    });
    const toolProfile = resolveToolProfile(tier, cfg.agent.toolProfile);
    const effectiveProfile =
      sequentialMode && toolProfile === "minimal" ? "research" : toolProfile;
    const loopTools = toolsForProfile(effectiveProfile);
    setActiveToolProfile(effectiveProfile);
    clearSearchLineHints();
    resetWebTurnGate();
    events.onStatus(
      chatRouter
        ? `Blossom agent loop (tools:${effectiveProfile})…`
        : `Agent loop on ${model} (tools:${effectiveProfile})…`
    );

    let lastContent = "";
    let intelSource: string | undefined;
    let feedbackId: string | undefined;
    const transcript: ToolTranscriptEntry[] = [];
    const baseUserPrompt =
      messages.filter((m) => m.role === "user").pop()?.content ?? "";
    // Mutable copy for Ollama native tool-call history
    const ollamaMessages = messages.map((m) => ({ ...m }));
    this.turnToolFailureNotes = [];

    try {
    for (let round = 0; round < maxToolRounds; round++) {
      if (signal.aborted) {
        break;
      }

      const injectBlock = this.drainContextInjects();
      if (injectBlock) {
        events.onStatus("Incorporating your update…");
        events.onContextInject?.(injectBlock);
      }

      let result: {
        content: string;
        toolCalls: OllamaToolCall[];
        feedback?: { id: string; route?: string; enabled?: boolean };
        /** True when visible prose was already streamed to the UI. */
        alreadyStreamed?: boolean;
      };

      const failCount = transcript.filter((t) => t.ok === false).length;
      // Re-score from the raw user ask only — never the packed ChatRouter prompt.
      if (this.lastUserText.trim()) {
        this.refreshTurnScratchpadNeed(this.lastUserText, {
          toolRounds: round,
          toolFailures: failCount,
        });
      } else if (failCount > 0 || round >= 2) {
        this.turnScratchpadNeed = {
          level: "required",
          reasons: failCount
            ? ["tool failure(s) to remember"]
            : ["multi-round agent loop"],
        };
      }
      const scratchHint = formatScratchpadContinueHint(
        this.turnScratchpadNeed,
        getScratchpad(this.context)
      );

      const packed = buildChatRouterAgentTurn(
        baseUserPrompt,
        transcript,
        round,
        maxToolRounds,
        {
          scratchpadHint: scratchHint,
          lastAssistantProse: lastContent || undefined,
        }
      );
      if (injectBlock && !chatRouter) {
        ollamaMessages.push({ role: "user", content: injectBlock });
      }

      const roundMessages: OllamaMessage[] = chatRouter
        ? [
            {
              role: "user",
              content: injectBlock ? `${injectBlock}\n\n${packed}` : packed,
            },
          ]
        : ollamaMessages;

      events.onStatus(
        chatRouter
          ? transcript.length
            ? `Blossom agent round ${round + 1} (${transcript.length} tool result(s))…`
            : `Blossom agent round ${round + 1} (RESEARCH)…`
          : `Agent round ${round + 1} on ${model}…`
      );

      const streamed = await this.streamPlain(
        model,
        roundMessages,
        events,
        signal,
        live,
        sequentialMode,
        chatRouter ? undefined : loopTools
      );

      // Agent rounds MUST stream (streamPlain → streamChat). Do not swap in chatOnce here:
      // chatOnce buffers the full reply and breaks live reasoning + token UX.

      const fenceCalls = parseToolCallFences(streamed.content || "");
      const streamedToolCalls =
        streamed.toolCalls.length > 0
          ? streamed.toolCalls
          : toOllamaToolCalls(fenceCalls);

      result = {
        content: streamed.content,
        toolCalls: streamedToolCalls,
        feedback: streamed.feedbackId
          ? { id: streamed.feedbackId, enabled: true }
          : undefined,
        alreadyStreamed: true,
      };
      if (streamed.intelSource) {
        intelSource = streamed.intelSource;
      }
      if (streamed.feedbackId) {
        feedbackId = streamed.feedbackId;
      }

      if (result.feedback?.id && result.feedback.enabled !== false) {
        feedbackId = result.feedback.id;
      }

      const toolCalls =
        result.toolCalls.length > 0
          ? result.toolCalls
          : toOllamaToolCalls(parseToolCallFences(result.content || ""));

      // Seal this round's prose into its own bubble before tools / next round /
      // final return — otherwise every round appends into one plain-text panel.
      events.onStreamBreak?.();

      if (toolCalls.length > 0) {
        const visible = stripToolCallFences(result.content || "");
        if (visible) {
          lastContent = visible;
          // Research / tool rounds: stream visible prose; live-apply any path fences.
          // Skip replay when streamPlain already pushed those tokens to the UI.
          if (!result.alreadyStreamed) {
            await this.replayContentWithLiveFences(visible, events, live);
            events.onStreamBreak?.();
          }
        }

        if (!chatRouter) {
          ollamaMessages.push({
            role: "assistant",
            content: result.content || "",
            tool_calls: toolCalls,
          });
        }

        type PreparedCall = {
          name: string;
          args: Record<string, unknown>;
          commandGate?: "allowlisted" | "approved" | "denied";
          skip?: boolean;
        };
        const prepared: PreparedCall[] = [];
        for (const call of toolCalls) {
          if (signal.aborted) {
            break;
          }
          const name = call.function.name;
          const args =
            typeof call.function.arguments === "string"
              ? (() => {
                  try {
                    return JSON.parse(call.function.arguments) as Record<
                      string,
                      unknown
                    >;
                  } catch {
                    return { value: call.function.arguments };
                  }
                })()
              : call.function.arguments || {};

          let commandGate: "allowlisted" | "approved" | "denied" | undefined;
          if (name === "run_command") {
            const command = String(args.command ?? "").trim();
            const cwd = args.cwd != null ? String(args.cwd) : ".";
            const root = args.root != null ? String(args.root) : undefined;
            commandGate = await this.confirmRunCommand(
              command,
              cwd,
              root,
              events,
              signal
            );
            if (commandGate === "denied") {
              const denied =
                "User denied running this command. Do not retry the same command; use another approach or ask the user.";
              events.onStatus(`Denied: ${command}`);
              transcript.push({
                round: round + 1,
                name,
                args,
                result: denied,
                ok: false,
              });
              this.turnToolFailureNotes.push(
                `run_command denied: ${String(args.command ?? "").trim()}`.slice(
                  0,
                  160
                )
              );
              if (!chatRouter) {
                ollamaMessages.push({ role: "tool", content: denied });
              }
              prepared.push({ name, args, commandGate, skip: true });
              continue;
            }
          }

          if (isWebTool(name)) {
            const detail =
              String(args.query ?? args.url ?? args.ref ?? "").trim() ||
              this.toolDetailForUi(name, args);
            events.onStatus(`Waiting for OK to use network (${name})…`);
            const allowed = await confirmWebUse(name, detail, {
              fastMode: this.fastMode,
              signal,
            });
            if (!allowed) {
              const denied =
                "User denied network/web tool use (or web is disabled). Do not invent search/fetch results; use local tools or ask the user to enable blossom.web.enabled.";
              events.onStatus(`Denied web: ${name}`);
              transcript.push({
                round: round + 1,
                name,
                args,
                result: denied,
                ok: false,
              });
              this.turnToolFailureNotes.push(`${name} denied`.slice(0, 160));
              if (!chatRouter) {
                ollamaMessages.push({ role: "tool", content: denied });
              }
              prepared.push({ name, args, skip: true });
              continue;
            }
          }

          prepared.push({ name, args, commandGate });
        }

        const runnable = prepared.filter((p) => !p.skip);
        const parallelOn = cfg.agent.parallelTools !== false;
        const parallelBatch = parallelOn
          ? runnable.filter((p) => isParallelSafeTool(p.name))
          : [];
        const sequentialBatch = parallelOn
          ? runnable.filter((p) => !isParallelSafeTool(p.name))
          : runnable;

        let producedEdit = false;

        const executeOne = async (
          p: PreparedCall
        ): Promise<{ producedEdit: boolean }> => {
          const { name, args, commandGate } = p;
          const editToolUi =
            name === "search_replace" ||
            name === "write_file" ||
            name === "delete_file";
          if (
            !editToolUi &&
            name !== "ask_user" &&
            (name !== "run_command" || commandGate === "allowlisted")
          ) {
            events.onTool(name, this.toolDetailForUi(name, args));
          }
          events.onStatus(
            name === "ask_user"
              ? "Waiting for your choice…"
              : name === "run_command"
                ? `Running: ${String(args.command ?? "").trim()}…`
                : isWebTool(name)
                  ? webStatusLabel(name)
                  : `Running ${name}…`
          );
          const toolResult =
            name === "ask_user"
              ? await this.promptAskUser(args, events, signal)
              : await runTool(name, args);
          let edit = false;
          if (name === "run_command" && toolResult.ok) {
            const cmd = String(args.command ?? "").trim();
            const verified = markDryRunFromCommand(cmd, true);
            for (const path of verified) {
              events.onStatus(`Dry-run OK for ${path}.`);
              await this.flushDryRunBlockedEdits(path, events, applyNow);
            }
          }
          if (toolResult.pendingEdit) {
            edit = true;
            onEditCollected?.(toolResult.pendingEdit);
            await this.deliverPendingEdit(
              toolResult.pendingEdit,
              events,
              applyNow
            );
          }
          const entry: ToolTranscriptEntry = {
            round: round + 1,
            name,
            args,
            result: toolResult.content,
            ok: toolResult.ok,
          };
          const compacted = compactToolResult(entry);
          transcript.push({ ...entry, result: compacted });
          if (!toolResult.ok) {
            const detail = compacted
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 140);
            this.turnToolFailureNotes.push(
              `${name} failed${detail ? `: ${detail}` : ""}`
            );
          }
          if (!chatRouter) {
            ollamaMessages.push({
              role: "tool",
              content: compacted,
            });
          }
          return { producedEdit: edit };
        };

        if (parallelBatch.length > 1) {
          events.onStatus(
            `Running ${parallelBatch.length} read tools in parallel…`
          );
          const results = await Promise.all(
            parallelBatch.map((p) => executeOne(p))
          );
          if (results.some((r) => r.producedEdit)) {
            producedEdit = true;
          }
        } else if (parallelBatch.length === 1) {
          const r = await executeOne(parallelBatch[0]);
          if (r.producedEdit) {
            producedEdit = true;
          }
        }

        for (const p of sequentialBatch) {
          if (signal.aborted) {
            break;
          }
          const r = await executeOne(p);
          if (r.producedEdit) {
            producedEdit = true;
          }
        }

        if (signal.aborted) {
          break;
        }

        const roundNum = round + 1;
        let gateReason = "";
        let gateDetail = "";
        if (
          stepMode === "confirmTools" &&
          roundNum % confirmAfter === 0 &&
          roundNum < maxToolRounds
        ) {
          gateReason = `Paused after ${roundNum} tool round(s)`;
          gateDetail = `${transcript.length} tool result(s) so far. Continue researching/editing, or stop here.`;
        } else if (stepMode === "planSteps" && producedEdit) {
          gateReason = "Review edits before the next step";
          gateDetail =
            "Write/delete tools ran this round. Review the Apply cards, then Continue or Stop.";
        }
        if (gateReason) {
          const step = await this.confirmContinueStep(
            gateReason,
            gateDetail,
            events,
            signal
          );
          if (step === "stop") {
            lastContent =
              stripToolCallFences(lastContent) ||
              "Stopped at your request after the last tool round.";
            return { content: lastContent, intelSource, feedbackId };
          }
        }
        continue;
      }

      // Final turn — no tools; prose already streamed live when alreadyStreamed.
      lastContent = stripToolCallFences(result.content);
      if (!result.alreadyStreamed) {
        await this.replayContentWithLiveFences(lastContent, events, live);
      }
      return { content: lastContent, intelSource, feedbackId };
    }

    events.onStatus("Tool round limit reached");

    // Offline try-harder: one local self-critique pass before cloud escalate.
    if (cfg.agent.localRetryBeforeEscalate !== false && !signal.aborted) {
      events.onStatus("Local retry before escalate — self-critique pass…");
      const retryPacked = buildLocalRetryPrompt(
        baseUserPrompt,
        transcript,
        lastContent
      );
      const retryMessages: OllamaMessage[] = chatRouter
        ? [{ role: "user", content: retryPacked }]
        : [
            ...ollamaMessages,
            {
              role: "user",
              content:
                "LOCAL RETRY before escalate: finish with evidence above or emit at most 3 new tool_call fences. Do not escalate.",
            },
          ];
      const retryStreamed = await this.streamPlain(
        model,
        retryMessages,
        events,
        signal,
        live,
        sequentialMode,
        chatRouter ? undefined : loopTools
      );
      events.onStreamBreak?.();
      const retryCalls =
        retryStreamed.toolCalls.length > 0
          ? retryStreamed.toolCalls
          : toOllamaToolCalls(parseToolCallFences(retryStreamed.content || ""));
      if (retryCalls.length > 0 && retryCalls.length <= 3) {
        events.onStatus(
          `Local retry: running ${retryCalls.length} follow-up tool(s)…`
        );
        for (const call of retryCalls) {
          if (signal.aborted) {
            break;
          }
          const name = call.function.name;
          const args =
            typeof call.function.arguments === "string"
              ? (() => {
                  try {
                    return JSON.parse(call.function.arguments) as Record<
                      string,
                      unknown
                    >;
                  } catch {
                    return { value: call.function.arguments };
                  }
                })()
              : call.function.arguments || {};
          if (name === "run_command") {
            const gate = await this.confirmRunCommand(
              String(args.command ?? "").trim(),
              args.cwd != null ? String(args.cwd) : ".",
              args.root != null ? String(args.root) : undefined,
              events,
              signal
            );
            if (gate === "denied") {
              continue;
            }
          }
          if (isWebTool(name)) {
            const allowed = await confirmWebUse(
              name,
              this.toolDetailForUi(name, args),
              { fastMode: this.fastMode, signal }
            );
            if (!allowed) {
              continue;
            }
          }
          if (name !== "ask_user") {
            events.onTool(name, this.toolDetailForUi(name, args));
          }
          const toolResult =
            name === "ask_user"
              ? await this.promptAskUser(args, events, signal)
              : await runTool(name, args);
          if (toolResult.pendingEdit) {
            onEditCollected?.(toolResult.pendingEdit);
            await this.deliverPendingEdit(
              toolResult.pendingEdit,
              events,
              applyNow
            );
          }
          const entry: ToolTranscriptEntry = {
            round: maxToolRounds + 1,
            name,
            args,
            result: toolResult.content,
            ok: toolResult.ok,
          };
          transcript.push({ ...entry, result: compactToolResult(entry) });
        }
        // One finish pass after bonus tools
        const finishPacked = buildChatRouterAgentTurn(
          baseUserPrompt,
          transcript,
          maxToolRounds,
          maxToolRounds + 1,
          {
            scratchpadHint: formatScratchpadContinueHint(
              this.turnScratchpadNeed,
              getScratchpad(this.context)
            ),
            lastAssistantProse: lastContent || undefined,
          }
        );
        const finishMessages: OllamaMessage[] = chatRouter
          ? [{ role: "user", content: finishPacked }]
          : ollamaMessages;
        const finishStreamed = await this.streamPlain(
          model,
          finishMessages,
          events,
          signal,
          live,
          sequentialMode,
          chatRouter ? undefined : loopTools
        );
        events.onStreamBreak?.();
        lastContent = stripToolCallFences(finishStreamed.content || lastContent);
        if (!/ESCALATE_/i.test(lastContent) && lastContent.trim()) {
          return { content: lastContent, intelSource, feedbackId };
        }
      } else {
        lastContent = stripToolCallFences(
          retryStreamed.content || lastContent
        );
        if (
          lastContent.trim() &&
          !/ESCALATE_/i.test(lastContent) &&
          (/###\s*Summary/i.test(lastContent) || lastContent.length > 200)
        ) {
          return { content: lastContent, intelSource, feedbackId };
        }
      }
    }

    if (!/ESCALATE_GEMINI:/i.test(lastContent)) {
      lastContent +=
        "\n\nESCALATE_GEMINI: Reached tool round limit without a complete answer after local retry.";
    }
    return {
      content: stripToolCallFences(lastContent),
      intelSource,
      feedbackId,
    };
    } finally {
      setActiveToolProfile("full");
      await closeBrowserSession();
    }
  }
}

export function normalizeToolCalls(
  calls: OllamaToolCall[] | undefined
): OllamaToolCall[] {
  return calls ?? [];
}
