import { getConfig } from "../config";

export interface LearnCodingLessonResult {
  ok: boolean;
  stored: boolean;
  id?: string;
  reason?: string;
  source?: string;
  error?: string;
}

export interface CodingMemoryHit {
  id?: string;
  text: string;
}

/** Format ChatRouter coding_lessons hits for prompt injection. */
export function formatCodingMemoryBlock(
  memories: CodingMemoryHit[],
  opts?: { maxChars?: number }
): string {
  if (!memories.length) {
    return "";
  }
  const maxChars = opts?.maxChars ?? 2500;
  const parts = ["[CODING MEMORY — durable lessons; prefer disk/tools if conflicting]"];
  let used = parts[0].length;
  for (let i = 0; i < memories.length; i++) {
    const text = (memories[i].text || "").trim().replace(/\s+/g, " ");
    if (!text) {
      continue;
    }
    const line = `${i + 1}. ${text.slice(0, 600)}`;
    if (used + line.length + 1 > maxChars) {
      break;
    }
    parts.push(line);
    used += line.length + 1;
  }
  return parts.length > 1 ? parts.join("\n") : "";
}

/** Soft-fail search for injection into the coding turn. */
export async function fetchCodingMemoryForPrompt(
  query: string,
  n = 4
): Promise<{ block: string; count: number }> {
  const cfg = getConfig();
  if (cfg.memory?.enabled === false) {
    return { block: "", count: 0 };
  }
  const result = await searchCodingLessons(query, n);
  if (!result.ok || !result.memories.length) {
    return { block: "", count: 0 };
  }
  return {
    block: formatCodingMemoryBlock(result.memories),
    count: result.memories.length,
  };
}

/**
 * Persist a coding takeaway into ChatRouter's coding_lessons (Chroma).
 * No-op soft-fail if ChatRouter is down — escalate should still succeed.
 */
export async function learnCodingLesson(opts: {
  userPrompt: string;
  answer: string;
  source?: string;
}): Promise<LearnCodingLessonResult> {
  const userPrompt = (opts.userPrompt || "").trim();
  const answer = (opts.answer || "").trim();
  if (!userPrompt || !answer) {
    return { ok: false, stored: false, reason: "missing user_prompt or answer" };
  }

  const base = getConfig().baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/memory/coding`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_prompt: userPrompt.slice(0, 2000),
        answer: answer.slice(0, 8000),
        source: opts.source || "extension",
      }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        stored: false,
        error: String(data.detail || res.statusText || res.status),
      };
    }
    return {
      ok: Boolean(data.ok),
      stored: Boolean(data.stored),
      id: typeof data.id === "string" ? data.id : undefined,
      reason: typeof data.reason === "string" ? data.reason : undefined,
      source: typeof data.source === "string" ? data.source : opts.source,
    };
  } catch (err) {
    return {
      ok: false,
      stored: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function searchCodingLessons(
  query: string,
  n = 5
): Promise<{ ok: boolean; count: number; memories: Array<{ id?: string; text: string }> }> {
  const q = (query || "").trim();
  if (!q) {
    return { ok: false, count: 0, memories: [] };
  }
  const base = getConfig().baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/memory/coding?q=${encodeURIComponent(q)}&n=${n}`;
  try {
    const res = await fetch(url);
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      count?: number;
      memories?: Array<{ id?: string; text?: string }>;
    };
    if (!res.ok) {
      return { ok: false, count: 0, memories: [] };
    }
    return {
      ok: Boolean(data.ok),
      count: data.count ?? 0,
      memories: (data.memories ?? []).map((m) => ({
        id: m.id,
        text: m.text ?? "",
      })),
    };
  } catch {
    return { ok: false, count: 0, memories: [] };
  }
}
