import * as vscode from "vscode";
import { compressConversationForHandoff } from "../escalate/compressHandoff";
import type { OllamaMessage } from "../ollama/client";

/** Max stored messages before older turns are compressed. */
export const MAX_SESSION_HISTORY = 40;

/** Full messages kept after compression (recent turns). */
export const KEEP_RECENT_MESSAGES = 16;

const SESSION_SUMMARY_MAX_CHARS = 4000;

function trimMessageContent(content: string, max = 2000): string {
  const t = content.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Merge compressed summary + recent messages for handoff / escalation. */
export function mergeHistoryWithSummary(
  history: OllamaMessage[],
  summary?: string
): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  if (summary?.trim()) {
    out.push({
      role: "assistant",
      content: `[Prior session summary]\n${summary.trim()}`,
    });
  }
  out.push(...history);
  return out;
}

/**
 * Format prior session context for ChatRouter (single user message).
 * Ollama uses summary in system prompt + native multi-turn history instead.
 */
export function formatSessionContextForPrompt(
  summary: string | undefined,
  history: OllamaMessage[]
): string | undefined {
  const parts: string[] = [];

  if (summary?.trim()) {
    parts.push(
      "[PRIOR SESSION SUMMARY — older turns compressed]",
      summary.trim()
    );
  }

  if (history.length > 0) {
    const lines = history.map((m) => {
      const label =
        m.role === "user"
          ? "User"
          : m.role === "assistant"
            ? "Assistant"
            : "System";
      return `${label}: ${trimMessageContent(m.content)}`;
    });
    parts.push(
      "[RECENT SESSION TURNS]",
      ...lines,
      "",
      "Continue from this context. The user's new message is below."
    );
  }

  if (parts.length === 0) {
    return undefined;
  }
  return parts.join("\n");
}

/** Prepend prior context to the current turn for ChatRouter. */
export function wrapPromptWithSessionContext(
  promptUser: string,
  summary: string | undefined,
  history: OllamaMessage[]
): string {
  const prior = formatSessionContextForPrompt(summary, history);
  return prior ? `${prior}\n\n${promptUser}` : promptUser;
}

/**
 * When history exceeds MAX_SESSION_HISTORY, summarize older messages and
 * keep only the most recent KEEP_RECENT_MESSAGES.
 */
export async function compressHistoryIfNeeded(
  context: vscode.ExtensionContext,
  history: OllamaMessage[],
  existingSummary: string | undefined,
  userText: string,
  onStatus?: (msg: string) => void
): Promise<string | undefined> {
  if (history.length <= MAX_SESSION_HISTORY) {
    return existingSummary;
  }

  const overflow = history.splice(0, history.length - KEEP_RECENT_MESSAGES);
  if (overflow.length === 0) {
    return existingSummary;
  }

  onStatus?.("Compressing older conversation turns…");

  const historyForCompress: Array<{ role: string; content: string }> = [];
  if (existingSummary?.trim()) {
    historyForCompress.push({
      role: "assistant",
      content: `[Prior session summary]\n${existingSummary.trim()}`,
    });
  }
  historyForCompress.push(...overflow);

  const compressed = await compressConversationForHandoff(context, {
    history: historyForCompress,
    userText,
    escalateReason: "session history limit reached",
    maxSummaryChars: SESSION_SUMMARY_MAX_CHARS,
    summarizeThresholdChars: 8000,
  });

  onStatus?.(
    `Session context compressed (${compressed.compressedChars} chars, ${history.length} recent turns kept).`
  );
  return compressed.summaryMarkdown;
}
