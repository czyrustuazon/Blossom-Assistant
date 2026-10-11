import { getConfig } from "../config";

export type FeedbackVerdict = "correct" | "incorrect";

export interface RegisterFeedbackResult {
  ok: boolean;
  feedback_id?: string;
  route?: string;
  error?: string;
  reason?: string;
}

export interface SendFeedbackResult {
  ok: boolean;
  error?: string;
  feedback_id?: string;
  verdict?: string;
  learned?: boolean;
  detail?: string;
}

/**
 * POST ChatRouter /v1/feedback — soft-fail on network errors.
 * Verdict: correct (thumbs up) | incorrect (thumbs down).
 */
export async function sendCorrectnessFeedback(opts: {
  feedbackId: string;
  verdict: FeedbackVerdict;
  note?: string;
}): Promise<SendFeedbackResult> {
  const feedbackId = (opts.feedbackId || "").trim();
  if (!feedbackId) {
    return { ok: false, error: "missing feedback_id" };
  }
  const base = getConfig().baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/feedback`;
  try {
    const body: Record<string, string> = {
      feedback_id: feedbackId,
      verdict: opts.verdict,
    };
    const note = (opts.note || "").trim();
    if (note) {
      body.note = note.slice(0, 2000);
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: String(data.detail || data.error || res.statusText || res.status),
      };
    }
    return {
      ok: data.ok !== false,
      feedback_id:
        typeof data.feedback_id === "string"
          ? data.feedback_id
          : typeof data.id === "string"
            ? data.id
            : feedbackId,
      verdict: typeof data.verdict === "string" ? data.verdict : opts.verdict,
      learned: Boolean(data.learned),
      detail: typeof data.detail === "string" ? data.detail : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Register a feedbackable turn after extension-side escalate (Cursor/Gemini).
 * Learning happens on thumbs-up via POST /v1/feedback — not auto-learn.
 */
export async function registerFeedbackTurn(opts: {
  userPrompt: string;
  answer: string;
  source: string;
  route?: "coding" | "japanese";
  memoryId?: string;
}): Promise<RegisterFeedbackResult> {
  const userPrompt = (opts.userPrompt || "").trim();
  const answer = (opts.answer || "").trim();
  if (!userPrompt || !answer) {
    return { ok: false, error: "missing user_prompt or answer" };
  }
  const base = getConfig().baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/feedback/register`;
  try {
    const body: Record<string, string> = {
      route: opts.route ?? "coding",
      user_prompt: userPrompt.slice(0, 8000),
      answer: answer.slice(0, 12000),
      source: opts.source,
    };
    if (opts.memoryId) {
      body.memory_id = opts.memoryId;
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: String(data.detail || data.error || res.statusText || res.status),
      };
    }
    const feedbackId =
      typeof data.feedback_id === "string" ? data.feedback_id : undefined;
    return {
      ok: Boolean(data.ok),
      feedback_id: feedbackId,
      route: typeof data.route === "string" ? data.route : opts.route,
      reason: typeof data.reason === "string" ? data.reason : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
