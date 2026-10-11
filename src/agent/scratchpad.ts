import type { ExtensionContext } from "vscode";

/** Workspace-scoped working notes injected into each coding turn. */
export const SCRATCHPAD_STATE_KEY = "blossom.scratchpad";

/** Soft cap — keep the pad small so it does not crowd editor context. */
export const SCRATCHPAD_MAX_CHARS = 4000;

export type ScratchpadNeedLevel = "skip" | "optional" | "required";

export interface ScratchpadNeed {
  level: ScratchpadNeedLevel;
  /** Short host reasons (for the injected directive). */
  reasons: string[];
}

const FENCE_RE =
  /```(?:scratchpad|scratch)\s*\r?\n([\s\S]*?)```/i;

/** Short one-shot form: SCRATCHPAD: note text (first paragraph only). */
const LINE_RE = /^SCRATCHPAD:\s*([\s\S]+)$/im;

const MULTI_STEP_RE =
  /\b(multi[- ]?step|step[- ]by[- ]step|checklist|roadmap|then|after that|next we|phase\b|first\b.+\bthen\b)/i;
const MULTI_FILE_RE =
  /\b(and also|multiple files|all files|several files|across (?:the )?repo|entire (?:repo|project)|every file|\.html.+\.css|\.ts.+\.tsx|create \w+.+\bedit\b|\bedit\b.+\bcreate\b)/i;
const HARD_TASK_RE =
  /\b(refactor|migrate|architecture|restructure|ghidra|reverse.?eng|patch_[\w.]+|deploy_[\w.]+|inject_[\w.]+|code\.bin|hook cave|debug|investigate|root cause|flaky|race condition)\b/i;
const PLANISH_RE =
  /\b(where should we begin|how should we|plan\b|approach\b|outline|roadmap|organize|before we change|problem analysis)\b/i;
const TRIVIAL_RE =
  /\b(typo|rename this|what does this (?:line|function)|explain this|where is\b|which file)\b/i;

export function getScratchpad(context: ExtensionContext): string {
  const raw = context.workspaceState.get<string>(SCRATCHPAD_STATE_KEY, "");
  return typeof raw === "string" ? raw : "";
}

export async function setScratchpad(
  context: ExtensionContext,
  text: string
): Promise<string> {
  const next = clipScratchpad(text);
  await context.workspaceState.update(
    SCRATCHPAD_STATE_KEY,
    next.length > 0 ? next : undefined
  );
  return next;
}

export async function clearScratchpad(
  context: ExtensionContext
): Promise<void> {
  await context.workspaceState.update(SCRATCHPAD_STATE_KEY, undefined);
}

export function clipScratchpad(text: string): string {
  const normalized = (text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= SCRATCHPAD_MAX_CHARS) {
    return normalized;
  }
  return (
    normalized.slice(0, SCRATCHPAD_MAX_CHARS) +
    `\n\n… truncated (${normalized.length} → ${SCRATCHPAD_MAX_CHARS} chars)`
  );
}

/**
 * Host-side necessity: when the pipeline should maintain a scratchpad
 * without waiting for the user to open it.
 */
export function assessScratchpadNeed(
  userText: string,
  opts?: {
    existing?: string;
    promptTier?: "full" | "plan" | "tiny";
    toolRounds?: number;
    toolFailures?: number;
    attachedPathCount?: number;
  }
): ScratchpadNeed {
  const text = (userText || "").trim();
  const existing = (opts?.existing || "").trim();
  const reasons: string[] = [];
  let score = 0;

  if (existing) {
    score += 2;
    reasons.push("pad already has notes — keep them current or clear");
  }
  if (opts?.promptTier === "plan") {
    score += 3;
    reasons.push("plan-first / multi-step planning");
  } else if (opts?.promptTier === "full") {
    score += 1;
  }
  if (opts?.promptTier === "tiny" && !existing && text.length < 400) {
    return { level: "skip", reasons: ["tiny single-step edit"] };
  }

  if (MULTI_STEP_RE.test(text)) {
    score += 3;
    reasons.push("multi-step language");
  }
  if (MULTI_FILE_RE.test(text) || (opts?.attachedPathCount ?? 0) >= 2) {
    score += 3;
    reasons.push("multi-file scope");
  }
  if (HARD_TASK_RE.test(text)) {
    score += 3;
    reasons.push("hard / investigative task");
  }
  if (PLANISH_RE.test(text)) {
    score += 2;
    reasons.push("planning ask");
  }
  if (text.length > 900) {
    score += 2;
    reasons.push("long request");
  }
  if ((opts?.toolRounds ?? 0) >= 2) {
    score += 2;
    reasons.push("multi-round agent loop");
  }
  if ((opts?.toolFailures ?? 0) > 0) {
    score += 2;
    reasons.push("tool failure(s) to remember");
  }
  if (TRIVIAL_RE.test(text) && score < 3 && !existing) {
    return { level: "skip", reasons: ["trivial ask"] };
  }

  if (score >= 4) {
    return { level: "required", reasons: reasons.slice(0, 4) };
  }
  if (score >= 2 || existing) {
    return {
      level: "optional",
      reasons: reasons.length ? reasons.slice(0, 3) : ["maybe useful"],
    };
  }
  return { level: "skip", reasons: ["simple turn"] };
}

/** Tagged block for the coding user prompt (may be a directive-only when empty). */
export function formatScratchpadBlock(
  text: string,
  need?: ScratchpadNeed
): string {
  const body = clipScratchpad(text);
  const level = need?.level ?? (body ? "optional" : "skip");
  if (level === "skip" && !body) {
    return "";
  }

  const reasonLine =
    need?.reasons?.length
      ? `Host assessment (${level}): ${need.reasons.join("; ")}.`
      : `Host assessment: ${level}.`;

  if (level === "required") {
    return [
      "[SCRATCHPAD — REQUIRED THIS TURN]",
      reasonLine,
      "Maintain working notes yourself — the host injects this pad; the user does not edit it.",
      "Before you finish the turn (or when decisions/blockers change mid-loop), emit a full-overwrite fence:",
      "```scratchpad",
      "Goal: …",
      "Decisions: …",
      "Done: …",
      "Next: …",
      "Blockers: …",
      "```",
      "Skip the fence only if the entire ask is finished in one trivial step with no open follow-ups.",
      "Empty fence clears the pad when the multi-step work is done and nothing remains.",
      "",
      body || "(empty — create notes this turn)",
    ].join("\n");
  }

  if (level === "optional") {
    return [
      "[SCRATCHPAD — use if helpful]",
      reasonLine,
      "Update via ```scratchpad fence when you lock a decision, hit a blocker, or finish a step with more left.",
      "Do not bother for a one-shot trivial fix.",
      "",
      body || "(empty)",
    ].join("\n");
  }

  // skip but non-empty: still inject so the model can clear stale notes
  return [
    "[SCRATCHPAD — existing notes; may be stale]",
    reasonLine,
    "This ask looks simple. If these notes are obsolete, clear with an empty ```scratchpad fence; otherwise leave them.",
    "",
    body,
  ].join("\n");
}

/** Short CONTINUE-block nudge for agent rounds. */
export function formatScratchpadContinueHint(
  need: ScratchpadNeed,
  existing: string
): string {
  if (need.level === "skip") {
    return "";
  }
  const empty = !existing.trim();
  if (need.level === "required") {
    return [
      "[SCRATCHPAD DUTY]",
      empty
        ? "Pad is empty but this task needs notes — emit a ```scratchpad fence before finishing (Goal/Decisions/Done/Next/Blockers)."
        : "Refresh the ```scratchpad fence if Done/Next/Blockers changed this round; clear with an empty fence when the multi-step work is finished.",
    ].join("\n");
  }
  if (empty) {
    return "";
  }
  return [
    "[SCRATCHPAD DUTY]",
    "Optional: refresh ```scratchpad if notes changed; clear if obsolete.",
  ].join("\n");
}

export function stripScratchpadFence(text: string): string {
  return (text || "")
    .replace(FENCE_RE, "")
    .replace(/\n?SCRATCHPAD:\s*.+$/im, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * If the assistant emitted a scratchpad update, persist it (full overwrite)
 * and return the reply with the fence/marker removed.
 */
export async function applyScratchpadUpdate(
  context: ExtensionContext,
  assistantText: string
): Promise<{ clean: string; updated: boolean; text: string }> {
  const fence = (assistantText || "").match(FENCE_RE);
  if (fence) {
    const next = await setScratchpad(context, fence[1] ?? "");
    return {
      clean: stripScratchpadFence(assistantText),
      updated: true,
      text: next,
    };
  }
  const line = (assistantText || "").match(LINE_RE);
  if (line && (line[1] || "").trim()) {
    const body = (line[1] || "").split(/\n\n/)[0] ?? "";
    const next = await setScratchpad(context, body);
    return {
      clean: stripScratchpadFence(assistantText),
      updated: true,
      text: next,
    };
  }
  return {
    clean: assistantText,
    updated: false,
    text: getScratchpad(context),
  };
}

/**
 * When the host required notes and the model forgot a fence, synthesize a
 * minimal pad from the turn so the next round still has working memory.
 */
export async function autofillScratchpadIfNeeded(
  context: ExtensionContext,
  opts: {
    need: ScratchpadNeed;
    alreadyUpdated: boolean;
    userText: string;
    assistantText: string;
    toolFailureNotes?: string[];
  }
): Promise<{ filled: boolean; text: string }> {
  if (opts.alreadyUpdated || opts.need.level !== "required") {
    return { filled: false, text: getScratchpad(context) };
  }

  const planItems = extractPlanItems(opts.assistantText);
  const summaryBits = extractSummaryBits(opts.assistantText);
  const failures = (opts.toolFailureNotes || [])
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
  const goal = oneLineGoal(opts.userText);

  if (
    planItems.length === 0 &&
    summaryBits.length === 0 &&
    failures.length === 0
  ) {
    // Still seed a thin goal so multi-step work doesn't start blank next turn.
    if (!goal || goal.length < 12) {
      return { filled: false, text: getScratchpad(context) };
    }
  }

  const existing = getScratchpad(context);
  const lines = [
    `Goal: ${goal || "(see user ask)"}`,
    planItems.length
      ? `Plan:\n${planItems.map((p, i) => `${i + 1}. ${p}`).join("\n")}`
      : "",
    summaryBits.length ? `Done: ${summaryBits.join("; ")}` : "Done: (see reply)",
    failures.length
      ? `Blockers:\n${failures.map((f) => `- ${f}`).join("\n")}`
      : "Blockers: (none noted)",
    "Next: continue remaining plan / verify",
    "",
    "(auto) Host filled — overwrite with a ```scratchpad fence next turn if this is wrong.",
  ].filter((l) => l !== "");

  // Don't clobber a richer existing pad with a weaker autofill.
  if (existing.trim().length > lines.join("\n").length + 80) {
    return { filled: false, text: existing };
  }

  const next = await setScratchpad(context, lines.join("\n"));
  return { filled: true, text: next };
}

function oneLineGoal(userText: string): string {
  return (userText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function extractPlanItems(assistantText: string): string[] {
  const text = assistantText || "";
  const block = text.match(
    /(?:^|\n)PLAN:\s*\n((?:[ \t]*(?:\d+[.)]|[-*])\s+.+\n?)+)/i
  );
  if (!block) {
    return [];
  }
  return (block[1] || "")
    .split("\n")
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim())
    .filter((l) => l.length > 0)
    .slice(0, 8);
}

function extractSummaryBits(assistantText: string): string[] {
  const text = assistantText || "";
  const m = text.match(/###\s*Summary\s*\n([\s\S]{0,800})/i);
  if (!m) {
    return [];
  }
  return (m[1] || "")
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
    .filter((l) => l.length > 0 && !/^```/.test(l))
    .slice(0, 4);
}

export function scratchpadStatus(text: string): {
  empty: boolean;
  chars: number;
} {
  const body = clipScratchpad(text);
  return { empty: body.length === 0, chars: body.length };
}
