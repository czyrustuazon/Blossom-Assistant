import * as crypto from "crypto";
import * as vscode from "vscode";
import { getConfig, modelForMode } from "../config";
import { callGemini, getGeminiApiKey } from "../gemini/client";
import { chatOnce } from "../ollama/client";

export interface HandoffCompression {
  summaryMarkdown: string;
  rawChars: number;
  compressedChars: number;
  currentUserAsk: string;
  localAttempt?: string;
  /** Cache key — reuse across fallback chain within same turn */
  cacheId: string;
}

export interface CompressHandoffOpts {
  history: Array<{ role: string; content: string }>;
  userText: string;
  localAttempt?: string;
  escalateReason?: string;
  imageAttachments?: Array<{ path: string; metadata?: string }>;
  repoMapSnippet?: string;
  maxSummaryChars?: number;
  summarizeThresholdChars?: number;
  summarizeProvider?: "local" | "gemini" | "rules-only";
  midTurnInjects?: string[];
  priorProviderAttempt?: { provider: string; text: string };
}

function stripNoise(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "[code block omitted]")
    .replace(/### Summary[\s\S]*$/im, "")
    .replace(/\[EDITOR CONTEXT\][\s\S]*?(?=\n\n|\n\[|$)/gi, "[editor context omitted]")
    .replace(/\[REPO KNOWLEDGE\][\s\S]*?(?=\n\n|\n\[|$)/gi, "[repo knowledge omitted]")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractPaths(text: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /(?:^|[\s"'(])([\w.-]+(?:\/|\\)[\w./\\-]+\.\w{1,8})/g,
    /path\s*=\s*["']?([^\s"'`]+)/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const p = (m[1] || "").replace(/\\/g, "/").trim();
      if (p.length > 2 && p.length < 200) {
        found.add(p);
      }
    }
  }
  return [...found].slice(0, 24);
}

function firstUserGoal(history: Array<{ role: string; content: string }>): string {
  for (const m of history) {
    if (m.role === "user") {
      const t = stripNoise(m.content).slice(0, 400);
      if (t) {
        return t;
      }
    }
  }
  return "";
}

function buildRulesSummary(opts: CompressHandoffOpts): string {
  const turns = opts.history.filter((m) => m.role === "user" || m.role === "assistant");
  const stripped = turns
    .map((m) => `${m.role}: ${stripNoise(m.content).slice(0, 1200)}`)
    .join("\n\n");
  const paths = extractPaths(stripped + "\n" + (opts.localAttempt || ""));
  const failures: string[] = [];
  if (opts.localAttempt?.trim()) {
    failures.push(stripNoise(opts.localAttempt).slice(0, 800));
  }
  if (opts.priorProviderAttempt?.text) {
    failures.push(
      `[Prior ${opts.priorProviderAttempt.provider} attempt]\n${opts.priorProviderAttempt.text.slice(0, 600)}`
    );
  }
  if (opts.midTurnInjects?.length) {
    failures.push(
      `[Mid-turn user context]\n${opts.midTurnInjects.map((line, i) => `${i + 1}. ${line}`).join("\n\n").slice(0, 2000)}`
    );
  }
  const images =
    opts.imageAttachments?.map((i) => `- ${i.path}${i.metadata ? ` — ${i.metadata}` : ""}`).join("\n") ||
    "";

  return [
    "[BLOSSOM SESSION SUMMARY — compressed for handoff]",
    `Goal: ${firstUserGoal(opts.history) || opts.userText.slice(0, 400)}`,
    opts.escalateReason ? `Escalation reason: ${opts.escalateReason}` : "",
    paths.length ? `Files mentioned / edited:\n${paths.map((p) => `- ${p}`).join("\n")}` : "",
    failures.length
      ? `Local attempts & failures:\n${failures.join("\n\n")}`
      : "",
    images ? `Attached images:\n${images}` : "",
    opts.repoMapSnippet ? `Repo map:\n${opts.repoMapSnippet.slice(0, 1500)}` : "",
    `Prior turns (count): ${turns.length}`,
    "",
    "Recent turns (trimmed):",
    stripped.slice(-4000),
  ]
    .filter(Boolean)
    .join("\n");
}

async function llmSummarize(
  context: vscode.ExtensionContext,
  rawSummary: string,
  provider: "local" | "gemini"
): Promise<string | undefined> {
  const prompt = [
    "Compress this Blossom coding session into a handoff summary.",
    "Keep: goal, key decisions, files touched, failures, open questions.",
    "Max 1200 words. Plain text only.",
    "",
    rawSummary.slice(0, 24000),
  ].join("\n");

  try {
    if (provider === "gemini") {
      const apiKey = await getGeminiApiKey(context);
      if (!apiKey) {
        return undefined;
      }
      const result = await callGemini({ apiKey, prompt });
      return result.text.trim() || undefined;
    }
    const cfg = getConfig();
    const result = await chatOnce({
      model: modelForMode(),
      messages: [{ role: "user", content: prompt }],
    });
    return result.content.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function compressConversationForHandoff(
  context: vscode.ExtensionContext,
  opts: CompressHandoffOpts
): Promise<HandoffCompression> {
  const cfg = getConfig();
  const maxSummaryChars = opts.maxSummaryChars ?? cfg.handoff.maxSummaryChars;
  const threshold =
    opts.summarizeThresholdChars ?? cfg.handoff.summarizeThresholdChars;
  const provider = opts.summarizeProvider ?? cfg.handoff.summarizeProvider;

  const rawChars = opts.history.reduce((n, m) => n + m.content.length, 0);
  let summaryMarkdown = buildRulesSummary(opts);

  if (rawChars > threshold && provider !== "rules-only") {
    const llm = await llmSummarize(context, summaryMarkdown, provider);
    if (llm) {
      summaryMarkdown = `[BLOSSOM SESSION SUMMARY — compressed for handoff]\n${llm}`;
    }
  }

  if (summaryMarkdown.length > maxSummaryChars) {
    summaryMarkdown = `${summaryMarkdown.slice(0, maxSummaryChars - 20)}\n… [truncated]`;
  }

  const cacheId = crypto
    .createHash("sha256")
    .update(`${opts.userText}::${rawChars}::${summaryMarkdown.length}`)
    .digest("hex")
    .slice(0, 16);

  return {
    summaryMarkdown,
    rawChars,
    compressedChars: summaryMarkdown.length,
    currentUserAsk: opts.userText.slice(0, 2000),
    localAttempt: opts.localAttempt?.slice(0, 4000),
    cacheId,
  };
}
