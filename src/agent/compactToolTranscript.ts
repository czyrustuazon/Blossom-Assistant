import { getConfig } from "../config";
import type { ToolTranscriptEntry } from "./toolProtocol";

const SEARCH_TEXT_LINES_KEEP = 10;
const READ_FILE_HEAD_LINES = 40;
const READ_FILE_TAIL_LINES = 10;
const LIST_DIR_LINES_KEEP = 40;
const RUN_COMMAND_BODY_DEFAULT = 1500;

function resultMaxChars(): number {
  const n = getConfig().agent.toolResultMaxChars;
  return Number.isFinite(n) && n > 400 ? Math.floor(n) : 2500;
}

function runCommandBodyMax(): number {
  return Math.min(RUN_COMMAND_BODY_DEFAULT, Math.floor(resultMaxChars() * 0.7));
}

export function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n…(truncated ${text.length - max} chars)`;
}

/** Collapse long runs of identical lines (test/progress spam). */
export function collapseRepeatedLines(
  text: string,
  maxRepeat = 2
): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let last = "";
  let count = 0;
  const flushRepeat = () => {
    if (count > maxRepeat) {
      out.push(`… (${count - maxRepeat} identical line(s) omitted)`);
    }
  };
  for (const line of lines) {
    if (line === last) {
      count++;
      if (count <= maxRepeat) {
        out.push(line);
      }
      continue;
    }
    flushRepeat();
    last = line;
    count = 1;
    out.push(line);
  }
  flushRepeat();
  return out.join("\n");
}

/** Keep head + tail so failures at the end of pytest/npm still show. */
export function keepHeadAndTail(body: string, maxChars: number): string {
  if (body.length <= maxChars) {
    return body;
  }
  const head = Math.floor(maxChars * 0.35);
  const tail = Math.max(200, maxChars - head - 60);
  const omitted = body.length - head - tail;
  return `${body.slice(0, head)}\n… (${omitted} chars omitted) …\n${body.slice(-tail)}`;
}

function looksLikeGitLog(commandHint: string, body: string): boolean {
  if (/\bgit\s+(log|show|blame)\b/i.test(commandHint)) {
    return true;
  }
  const commitLines = (body.match(/^commit\s+[0-9a-f]{7,}/gim) || []).length;
  return commitLines >= 3;
}

function compactSearchText(result: string): string {
  if (result === "No matches.") {
    return result;
  }
  const lines = result.split("\n").filter((l) => l.trim().length > 0);
  const kept = lines.slice(0, SEARCH_TEXT_LINES_KEEP);
  const more =
    lines.length > SEARCH_TEXT_LINES_KEEP
      ? `\n… and ${lines.length - SEARCH_TEXT_LINES_KEEP} more hit(s)`
      : "";
  return `${lines.length} hit(s):\n${kept.join("\n")}${more}`;
}

function compactReadFile(result: string): string {
  const match = result.match(/^\/\/ (.+)\n([\s\S]*)$/);
  if (!match) {
    return clip(result, resultMaxChars());
  }
  const filePath = match[1];
  const body = match[2];
  const lines = body.split("\n");
  const maxLines = READ_FILE_HEAD_LINES + READ_FILE_TAIL_LINES + 5;
  if (lines.length <= maxLines) {
    return clip(result, resultMaxChars());
  }
  const head = lines.slice(0, READ_FILE_HEAD_LINES);
  const tail = lines.slice(-READ_FILE_TAIL_LINES);
  const omitted = lines.length - READ_FILE_HEAD_LINES - READ_FILE_TAIL_LINES;
  return clip(
    [
      `// ${filePath}`,
      ...head,
      `… (${omitted} lines omitted) …`,
      ...tail,
    ].join("\n"),
    resultMaxChars()
  );
}

function compactListDir(result: string): string {
  const lines = result.split("\n");
  if (lines.length <= LIST_DIR_LINES_KEEP + 1) {
    return result;
  }
  const header = lines[0] ?? "";
  const entries = lines.slice(1);
  return [
    header,
    ...entries.slice(0, LIST_DIR_LINES_KEEP),
    `… and ${entries.length - LIST_DIR_LINES_KEEP} more entries`,
  ].join("\n");
}

function extractCommandHint(entry: ToolTranscriptEntry): string {
  if (typeof entry.args === "string") {
    return entry.args;
  }
  return String(entry.args?.command ?? "");
}

function compactRunCommand(entry: ToolTranscriptEntry): string {
  const result = entry.result;
  const commandHint = extractCommandHint(entry);
  const stdoutIdx = result.indexOf("--- stdout ---");
  if (stdoutIdx < 0) {
    const cleaned = collapseRepeatedLines(result);
    return clip(keepHeadAndTail(cleaned, resultMaxChars()), resultMaxChars());
  }
  const prefix = result.slice(0, stdoutIdx);
  const rest = result.slice(stdoutIdx);
  const stderrIdx = rest.indexOf("--- stderr ---");
  const stdoutBlock = stderrIdx >= 0 ? rest.slice(0, stderrIdx) : rest;
  const stderrBlock = stderrIdx >= 0 ? rest.slice(stderrIdx) : "";
  const bodyMax = runCommandBodyMax();

  const trimSection = (block: string, label: string) => {
    const marker = `--- ${label} ---`;
    const idx = block.indexOf(marker);
    if (idx < 0) {
      return block;
    }
    const body = block.slice(idx + marker.length).trim();
    if (body === "(empty)") {
      return block;
    }
    let cleaned = collapseRepeatedLines(body);
    if (looksLikeGitLog(commandHint, cleaned)) {
      const lines = cleaned.split("\n");
      if (lines.length > 24) {
        cleaned = [
          ...lines.slice(0, 12),
          `… (${lines.length - 20} log lines omitted) …`,
          ...lines.slice(-8),
        ].join("\n");
      }
    }
    if (cleaned.length <= bodyMax) {
      return `${block.slice(0, idx + marker.length)}\n${cleaned}`;
    }
    return `${block.slice(0, idx + marker.length)}\n${keepHeadAndTail(cleaned, bodyMax)}`;
  };

  const compact = [
    prefix.trimEnd(),
    trimSection(stdoutBlock, "stdout"),
    stderrBlock ? trimSection(stderrBlock, "stderr") : "",
  ]
    .filter(Boolean)
    .join("\n");
  return clip(compact, resultMaxChars());
}

function compactWriteOrDelete(result: string): string {
  const first = result.split("\n")[0]?.trim() ?? result;
  return first.length > 240 ? `${first.slice(0, 240)}…` : first;
}

/** Rules-based compaction before results re-enter the model context. */
export function compactToolResult(entry: ToolTranscriptEntry): string {
  if (!entry.ok) {
    return clip(collapseRepeatedLines(entry.result), 800);
  }
  switch (entry.name) {
    case "search_text":
      return compactSearchText(entry.result);
    case "read_file":
      return compactReadFile(entry.result);
    case "list_dir":
    case "list_related":
    case "list_siblings":
      return compactListDir(entry.result);
    case "run_command":
      return compactRunCommand(entry);
    case "write_file":
    case "search_replace":
    case "delete_file":
      return compactWriteOrDelete(entry.result);
    case "list_workspace_roots":
    case "peek_related":
    case "peek_sibling":
    case "read_ghidra":
    case "ghidra_mcp":
      return clip(collapseRepeatedLines(entry.result), Math.min(1500, resultMaxChars()));
    default:
      return clip(collapseRepeatedLines(entry.result), resultMaxChars());
  }
}

/** One-line summary for older agent-loop rounds. */
export function summarizeToolResultOneLine(entry: ToolTranscriptEntry): string {
  const status = entry.ok ? "ok" : "error";
  const base = `Round ${entry.round} — ${entry.name} (${status})`;
  if (!entry.ok) {
    const err = entry.result.split("\n")[0]?.trim() ?? "failed";
    return `${base}: ${err.slice(0, 120)}`;
  }
  switch (entry.name) {
    case "search_text": {
      if (entry.result === "No matches.") {
        return `${base}: no matches`;
      }
      const hitMatch = entry.result.match(/^(\d+) hit/);
      if (hitMatch) {
        return `${base}: ${hitMatch[1]} hit(s)`;
      }
      const n = entry.result.split("\n").filter((l) => l.trim()).length;
      return `${base}: ${n} hit(s)`;
    }
    case "read_file": {
      const m = entry.result.match(/^\/\/ (.+)\n/);
      return `${base}: read ${m?.[1] ?? "file"}`;
    }
    case "list_dir":
      return `${base}: listed ${entry.result.split("\n").length - 1} entries`;
    case "run_command": {
      const exit = entry.result.match(/^exit: (.+)$/m)?.[1] ?? "?";
      return `${base}: exit ${exit.trim()}`;
    }
    case "write_file":
    case "search_replace":
    case "delete_file":
      return `${base}: ${compactWriteOrDelete(entry.result)}`;
    default:
      return `${base}: ${entry.result.split("\n")[0]?.slice(0, 100) ?? "done"}`;
  }
}
