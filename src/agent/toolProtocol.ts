import type { OllamaTool, OllamaToolCall } from "../ollama/client";
import { compactToolResult, summarizeToolResultOneLine } from "./compactToolTranscript";
import type { ToolProfile } from "./tools";
import { decompCatalogRules, isDecompWorkspaceCached } from "./decompContext";

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolTranscriptEntry {
  round: number;
  name: string;
  args: Record<string, unknown> | string;
  result: string;
  ok: boolean;
}

const TOOL_CALL_FENCE_RE = /```tool_call\s*\r?\n([\s\S]*?)```/gi;
/** How many recent tool results keep full body in ChatRouter packing. */
const FULL_TRANSCRIPT_TAIL = 3;

/** True when the model is requesting extension-side tool execution. */
export function hasToolCallFences(text: string): boolean {
  TOOL_CALL_FENCE_RE.lastIndex = 0;
  return TOOL_CALL_FENCE_RE.test(text || "");
}

function coerceToolCallObject(parsed: {
  name?: string;
  tool?: string;
  arguments?: Record<string, unknown> | string;
  args?: Record<string, unknown> | string;
}): ParsedToolCall | null {
  const name = String(parsed.name || parsed.tool || "").trim();
  if (!name) {
    return null;
  }
  let args: Record<string, unknown> = {};
  const rawArgs = parsed.arguments ?? parsed.args ?? {};
  if (typeof rawArgs === "string") {
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      args = { value: rawArgs };
    }
  } else if (rawArgs && typeof rawArgs === "object") {
    args = rawArgs;
  }
  return { name, arguments: args };
}

/**
 * Parse ```tool_call JSON fences (ChatRouter / local GGUF path).
 * Also recovers bare JSON objects that look like tool calls (common GGUF slip).
 */
export function parseToolCallFences(text: string): ParsedToolCall[] {
  const out: ParsedToolCall[] = [];
  if (!text) {
    return out;
  }
  const seen = new Set<string>();
  const push = (call: ParsedToolCall | null) => {
    if (!call) {
      return;
    }
    const key = `${call.name}:${JSON.stringify(call.arguments)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(call);
  };

  TOOL_CALL_FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOOL_CALL_FENCE_RE.exec(text)) !== null) {
    const body = (match[1] || "").trim();
    if (!body) {
      continue;
    }
    try {
      push(coerceToolCallObject(JSON.parse(body)));
    } catch {
      // Try first JSON object in a noisy fence
      const objMatch = body.match(/\{[\s\S]*\}/);
      if (objMatch) {
        try {
          push(coerceToolCallObject(JSON.parse(objMatch[0])));
        } catch {
          // ignore malformed fence
        }
      }
    }
  }

  // Fallback: unfenced {"name":"…","arguments":{…}} lines (single-line).
  if (out.length === 0) {
    const lineRe =
      /^\s*\{[^{}]*"(?:name|tool)"\s*:\s*"[^"]+"[^{}]*\}\s*$/gm;
    let lineMatch: RegExpExecArray | null;
    while ((lineMatch = lineRe.exec(text)) !== null) {
      try {
        push(coerceToolCallObject(JSON.parse(lineMatch[0])));
      } catch {
        // ignore
      }
    }
  }

  return out;
}

export function stripToolCallFences(text: string): string {
  if (!text) {
    return "";
  }
  return text.replace(TOOL_CALL_FENCE_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function toOllamaToolCalls(calls: ParsedToolCall[]): OllamaToolCall[] {
  return calls.map((c) => ({
    function: {
      name: c.name,
      arguments: c.arguments,
    },
  }));
}

function catalogRules(profile: ToolProfile, hasWebTools: boolean): string[] {
  const webRules = hasWebTools
    ? [
        "- Web: pick web_search / fetch_url / browser_* by need — not local-N-then-web. Local tools for repo; browser only for live UI interaction.",
        "- After web_search: refine, fetch_url a good link, or stop and answer. Do not invent search results.",
      ]
    : [];
  const parallelRule =
    "- Prefer multiple ```tool_call fences in one reply for independent reads (diagnostics/symbols/search/read) — the host may run them in parallel.";
  const askUserRule =
    "- Stuck between real forks (role, approach, which path, risky action): call ask_user with 2–6 options and wait — do not guess silently or edit README to \"capture\" a status answer.";
  if (profile === "minimal") {
    return [
      "Rules:",
      "- Prefer search_replace for edits; skip RESEARCH when [EDITOR CONTEXT] is enough.",
      "- After search_text, read_file with startLine/endLine (or rely on the host search window).",
      "- Use get_diagnostics when fixing compile/lint errors.",
      askUserRule,
      parallelRule,
      "- Do not emit ### Summary until finished (no more tool_call fences).",
    ];
  }
  if (profile === "research") {
    const decompRules = isDecompWorkspaceCached() ? decompCatalogRules() : [];
    return [
      "Rules:",
      "- RESEARCH: no product write_file/delete_file/search_replace until the user approves implement.",
      "- SCRATCH OK: write_file under .blossom/scratch/<name>.py (auto on disk), then run_command; delete_file to clean up.",
      "- Prefer a scratch .py over long `python -c` one-liners when the probe needs >~3 lines.",
      "- After search_text, read_file with startLine/endLine around hits (avoid whole-file reads).",
      "- Use run_command for repros/tests; background=true + await_background_command for long jobs.",
      "- IDE truth: get_diagnostics / get_document_symbols / go_to_definition / find_references when language service helps.",
      "- ghidra_mcp / read_ghidra when Ghidra is connected for RE truth.",
      askUserRule,
      ...decompRules,
      ...webRules,
      parallelRule,
      "- Finish with PLAN (+ ### Summary of the plan).",
    ];
  }
  const decompRules = isDecompWorkspaceCached() ? decompCatalogRules() : [];
  return [
    "Rules:",
    "- Prefer RESEARCH tools before writing product files on non-trivial tasks.",
    "- After search_text, read_file with startLine/endLine around hits (avoid whole-file reads).",
    "- Probes: write_file .blossom/scratch/<name>.py then run_command (or short py -3 -c). Prefer scratch scripts over guessing.",
    "- Long-running commands: run_command with background=true, then await_background_command.",
    "- IDE: get_diagnostics / symbols / go_to_definition / find_references beat guessing compile errors.",
    "- After tool results appear in [AGENT TOOL TRANSCRIPT], continue or finish — do not invent results.",
    askUserRule,
    "- Plan-first asks: RESEARCH → PLAN only. No product write/delete until the user says to implement (scratch probes OK).",
    "- Actionable coding asks: RESEARCH → PLAN → EXECUTE (search_replace for edits) → VERIFY → ### Summary.",
    "- patch_*.py / tools/*.py: run `python path --dry-run` with exit 0 before Apply.",
    "- RE/patch tasks: read_ghidra when Ghidra bridge connected — before ARM byte edits.",
    ...decompRules,
    ...webRules,
    parallelRule,
    "- Do not emit ### Summary until you are finished (no more tool_call fences).",
  ];
}

export function formatToolCatalog(
  tools: OllamaTool[],
  profile: ToolProfile = "full",
  extraBlocks?: string
): string {
  const lines = tools.map((t) => {
    const fn = t.function;
    const required = (fn.parameters?.required as string[] | undefined) ?? [];
    const props =
      (fn.parameters?.properties as
        | Record<string, { description?: string }>
        | undefined) ?? {};
    const argBits = Object.keys(props).map((k) => {
      const req = required.includes(k) ? "*" : "";
      return `${k}${req}`;
    });
    return `- ${fn.name}(${argBits.join(", ")}): ${fn.description}`;
  });
  const extra = (extraBlocks || "").trim();
  const includeGhidraExtra =
    extra &&
    tools.some((t) => t.function.name === "ghidra_mcp" || t.function.name === "read_ghidra");
  const hasWebTools = tools.some((t) =>
    /^(web_search|fetch_url|browser_)/.test(t.function.name)
  );
  return [
    `[AVAILABLE TOOLS — profile:${profile}; ChatRouter has no native function-calling; use fences]`,
    "To call a tool, emit one or more fences (and nothing that pretends the tool already ran):",
    "",
    "```tool_call",
    '{"name":"search_text","arguments":{"query":"def foo"}}',
    "```",
    "",
    "You may emit several fences in one reply for independent reads — the host can run those in parallel.",
    "",
    ...catalogRules(profile, hasWebTools),
    "",
    "Catalog:",
    ...lines,
    includeGhidraExtra ? `\n${extra}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatToolTranscript(entries: ToolTranscriptEntry[]): string {
  if (entries.length === 0) {
    return "";
  }
  const fullFrom = Math.max(0, entries.length - FULL_TRANSCRIPT_TAIL);
  const blocks = entries.map((e, index) => {
    const keepFull = index >= fullFrom;
    if (!keepFull) {
      return summarizeToolResultOneLine(e);
    }
    const argsStr =
      typeof e.args === "string" ? e.args : JSON.stringify(e.args);
    const compact = compactToolResult(e);
    return [
      `### Round ${e.round} — ${e.name} (${e.ok ? "ok" : "error"})`,
      `Args: ${argsStr}`,
      "Result:",
      compact,
    ].join("\n");
  });
  return ["[AGENT TOOL TRANSCRIPT — compact]", ...blocks].join("\n\n");
}

/**
 * ChatRouter only reads the last user message — pack transcript and prior
 * session context into one turn.
 */
export function buildChatRouterAgentTurn(
  basePrompt: string,
  entries: ToolTranscriptEntry[],
  round: number,
  maxRounds: number,
  opts?: { scratchpadHint?: string; lastAssistantProse?: string }
): string {
  const transcript = formatToolTranscript(entries);
  const usedWeb = entries.some((e) =>
    /^(web_search|fetch_url|browser_)/.test(e.name)
  );
  const failCount = entries.filter((e) => !e.ok).length;
  const continueBlock =
    entries.length === 0
      ? [
          "[AGENT LOOP]",
          `Round 1/${maxRounds}. Start with RESEARCH tool_call fences when the repo/runtime truth is unclear.`,
          "If the ask is plan-first (where to begin / architecture / organize / how should we…): RESEARCH then PLAN only — no file writes yet.",
          "If the ask is a tiny actionable edit and editor context is enough, you may skip tools and go PLAN → EXECUTE.",
          "After search_text, prefer ranged read_file (startLine/endLine) over whole files.",
          "Emit multiple independent read tool_call fences together when useful (diagnostics + search + read).",
          "If web tools are listed and you need external docs/facts: web_search or fetch_url immediately by need (not after N local failures). Browser only for live UI interaction.",
        ].join("\n")
      : [
          "[CONTINUE — agent round]",
          `Round ${round + 1}/${maxRounds}. Coding agent continue.`,
          "Either emit more ```tool_call fences, or finish.",
          "The last few tool results above are kept in full — use them; do not re-run identical successful calls.",
          failCount
            ? `${failCount} tool failure(s) so far — adapt (different args/tool), do not repeat the same failing call.`
            : "",
          "Plan-first asks: finish with PLAN (+ ### Summary of the plan) — no write/delete fences until the user approves.",
          "If the user approved a plan (do it / start / implement / go ahead): EXECUTE every plan step in this finish — all CREATE/EDIT fences, not only step 1 — then VERIFY → ### Summary.",
          "Actionable asks: finish with PLAN → EXECUTE (all required files) → VERIFY → ### Summary.",
          "Do not repeat unchanged prior results. Prefer run_command / Python when you need runtime evidence.",
          "After search_text, prefer ranged read_file (startLine/endLine) over whole files.",
          usedWeb
            ? "Web loop: refine search, fetch_url a strong hit, use browser only if interaction is required, or stop and answer — do not spin on the same failing query."
            : "If listed web tools would unlock docs/APIs/changelogs, use them by need; do not invent external facts.",
        ]
          .filter(Boolean)
          .join("\n");

  const hint = (opts?.scratchpadHint || "").trim();
  const prior = (opts?.lastAssistantProse || "").trim();
  const priorBlock = prior
    ? `[PRIOR ASSISTANT PROSE — do not repeat verbatim]\n${prior.slice(0, 1200)}`
    : "";
  return [basePrompt, transcript, continueBlock, priorBlock, hint]
    .filter(Boolean)
    .join("\n\n");
}

/** Prompt for the offline local-retry pass after tool-round exhaustion. */
export function buildLocalRetryPrompt(
  basePrompt: string,
  entries: ToolTranscriptEntry[],
  lastContent: string
): string {
  const transcript = formatToolTranscript(entries);
  return [
    basePrompt,
    transcript,
    "[LOCAL RETRY — before any cloud escalate]",
    "Tool round limit was reached. Stay local.",
    "Self-critique: what is still unknown? What failed?",
    "Either:",
    "1) Finish now with PLAN → EXECUTE (if needed) → VERIFY → ### Summary using evidence above, OR",
    "2) Emit at most 3 high-value ```tool_call fences (new evidence only — no repeats).",
    "Do NOT emit ESCALATE_GEMINI / ESCALATE_CLAUDE / ESCALATE_CURSOR on this retry.",
    lastContent.trim()
      ? `[LAST PARTIAL ANSWER]\n${lastContent.trim().slice(0, 2000)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
