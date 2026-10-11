import { getConfig } from "../config";

/** Mirrors ResearchPipeline.DEEP_KEYWORDS (docs / compare / migrate). */
const DEEP_KEYWORDS = [
  "research",
  "compare sources",
  "compare options",
  "latest docs",
  "documentation",
  "cite",
  "citation",
  "citations",
  "sources for",
  "what changed in",
  "breaking change",
  "migration guide",
  " pros and cons",
  "pros/cons",
  "versus",
  " vs ",
  "survey",
  "deep dive",
  "look into",
  "investigate",
] as const;

/** Mirrors ResearchPipeline.VERSION_API_RE. */
const VERSION_API_RE =
  /\b(latest version|current version|which version|api (?:for|of)|breaking changes?|deprecated|changelog|release notes|how (?:do|does) .+ (?:work|work now)|docs? for)\b/i;

export interface ResearchSource {
  title?: string;
  url?: string;
  snippet?: string;
}

export interface ResearchBriefResult {
  ok: boolean;
  brief: string;
  mode: string;
  sources: ResearchSource[];
  queries: string[];
  error?: string;
}

/**
 * Heuristic for "documentation-heavy" asks — when true, Assistant should
 * POST /v1/research before the tool loop (ChatRouter owns planner/search/synth).
 */
export function looksLikeDocsResearch(text: string): boolean {
  const focus = (text || "").trim();
  if (!focus || focus.length < 8) {
    return false;
  }
  const lower = focus.toLowerCase();
  if (DEEP_KEYWORDS.some((kw) => lower.includes(kw))) {
    return true;
  }
  return VERSION_API_RE.test(focus);
}

export function formatResearchBriefBlock(brief: string): string {
  const body = brief.trim();
  if (!body) {
    return "";
  }
  return (
    "[RESEARCH BRIEF — ChatRouter multi-agent pipeline]\n" +
    "Use this cited context when helpful. Prefer it over guessing current APIs/docs.\n\n" +
    body
  );
}

/** Prepend a non-empty research brief to the model prompt. */
export function prependResearchBrief(prompt: string, brief: string): string {
  const block = formatResearchBriefBlock(brief);
  if (!block) {
    return prompt;
  }
  const rest = (prompt || "").trimStart();
  return rest ? `${block}\n\n---\n\n${rest}` : block;
}

/**
 * POST ChatRouter /v1/research — soft-fail if ChatRouter is down.
 */
export async function fetchResearchBrief(opts: {
  query: string;
  coding?: boolean;
  signal?: AbortSignal;
}): Promise<ResearchBriefResult> {
  const query = (opts.query || "").trim();
  if (!query) {
    return { ok: false, brief: "", mode: "skip", sources: [], queries: [], error: "empty query" };
  }

  const base = getConfig().baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/research`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: query.slice(0, 4000),
        coding: opts.coding !== false,
      }),
      signal: opts.signal,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        brief: "",
        mode: "skip",
        sources: [],
        queries: [],
        error: String(data.detail || data.error || res.statusText || res.status),
      };
    }
    const sourcesRaw = Array.isArray(data.sources) ? data.sources : [];
    const queriesRaw = Array.isArray(data.queries) ? data.queries : [];
    return {
      ok: data.ok !== false,
      brief: typeof data.brief === "string" ? data.brief : "",
      mode: typeof data.mode === "string" ? data.mode : "skip",
      sources: sourcesRaw.filter(
        (s): s is ResearchSource => !!s && typeof s === "object"
      ) as ResearchSource[],
      queries: queriesRaw
        .map((q) => (typeof q === "string" ? q : ""))
        .filter(Boolean),
    };
  } catch (err) {
    if (opts.signal?.aborted) {
      return {
        ok: false,
        brief: "",
        mode: "skip",
        sources: [],
        queries: [],
        error: "aborted",
      };
    }
    return {
      ok: false,
      brief: "",
      mode: "skip",
      sources: [],
      queries: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * When ChatRouter + web are on and the ask looks docs-heavy, fetch a brief.
 * Returns empty string on skip/error (turn continues without research).
 */
export async function maybePrefetchResearchBrief(
  userText: string,
  signal?: AbortSignal
): Promise<{ brief: string; mode: string; sourceCount: number }> {
  const cfg = getConfig();
  if (cfg.backend !== "chatRouter" || !cfg.web.enabled) {
    return { brief: "", mode: "skip", sourceCount: 0 };
  }
  if (!looksLikeDocsResearch(userText)) {
    return { brief: "", mode: "skip", sourceCount: 0 };
  }
  if (signal?.aborted) {
    return { brief: "", mode: "skip", sourceCount: 0 };
  }

  const result = await fetchResearchBrief({
    query: userText,
    coding: true,
    signal,
  });
  const brief = result.brief.trim();
  if (!result.ok || !brief || result.mode === "skip") {
    return {
      brief: "",
      mode: result.mode || "skip",
      sourceCount: result.sources.length,
    };
  }
  return {
    brief,
    mode: result.mode,
    sourceCount: result.sources.length,
  };
}
