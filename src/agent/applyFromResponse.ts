import * as vscode from "vscode";
import { proposeFileDelete, proposeFileEdit, rejectPendingEdit, type PendingEdit } from "./tools";

const FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;

const LANG_TO_EXT: Record<string, string> = {
  html: ".html",
  htm: ".html",
  css: ".css",
  javascript: ".js",
  js: ".js",
  jsx: ".jsx",
  typescript: ".ts",
  ts: ".ts",
  tsx: ".tsx",
  json: ".json",
  python: ".py",
  py: ".py",
  md: ".md",
  markdown: ".md",
  xml: ".xml",
  svg: ".svg",
  yaml: ".yml",
  yml: ".yml",
  toml: ".toml",
  sql: ".sql",
  sh: ".sh",
  bash: ".sh",
  powershell: ".ps1",
  ps1: ".ps1",
  go: ".go",
  rust: ".rs",
  rs: ".rs",
  java: ".java",
  csharp: ".cs",
  cs: ".cs",
  php: ".php",
  ruby: ".rb",
  rb: ".rb",
  vue: ".vue",
  svelte: ".svelte",
  delete: "",
  remove: "",
};

const FILE_NAME_RE =
  /([a-zA-Z0-9_.\-]+(?:\/[a-zA-Z0-9_.\-]+)*\.(?:html?|css|js|jsx|ts|tsx|mjs|cjs|json|md|py|go|rs|java|kt|cs|php|rb|vue|svelte|sql|yml|yaml|toml|xml|svg|sh|ps1))/i;

const DELETE_BODY_RE = /^(?:DELETE|REMOVE)(?:[_\s]+FILE)?\s*$/i;

function isDeleteMarker(content: string): boolean {
  return DELETE_BODY_RE.test((content || "").trim());
}

interface ParsedFence {
  info: string;
  content: string;
  hintPath?: string;
  hintExt?: string;
  isDelete?: boolean;
}

function parseFences(text: string): ParsedFence[] {
  const out: ParsedFence[] = [];
  for (const m of text.matchAll(FENCE_RE)) {
    const info = (m[1] ?? "").trim();
    const content = (m[2] ?? "").replace(/\n$/, "");
    const start = m.index ?? 0;
    const before = text.slice(Math.max(0, start - 320), start);
    const headingPath = extractHeadingPathBeforeFence(before);
    const { hintPath, hintExt } = extractPathHints(info, content, headingPath);
    const infoIsDelete = /\b(?:delete|remove)(?:_file)?\b/i.test(info);
    const bodyIsDelete = isDeleteMarker(content);
    const isDelete = infoIsDelete || bodyIsDelete;

    // Skip tiny fences unless they are explicit deletes (empty / DELETE body).
    if (!isDelete && (!content.trim() || content.length < 8)) {
      continue;
    }
    out.push({ info, content, hintPath, hintExt, isDelete });
  }
  return out;
}

/**
 * Explicit delete lines outside fences, e.g.:
 *   DELETE path=contacts.html
 *   DELETE: contacts.html
 *   REMOVE FILE about.html
 */
function extractDeletePathsFromText(text: string): string[] {
  const paths: string[] = [];
  const add = (raw: string | undefined): void => {
    if (!raw) {
      return;
    }
    const cleaned = raw
      .replace(/^[`"'<]+|[`"'>\s.,;:]+$/g, "")
      .replace(/\\/g, "/")
      .trim();
    if (!cleaned || !FILE_NAME_RE.test(cleaned)) {
      return;
    }
    const m = cleaned.match(FILE_NAME_RE);
    const p = (m?.[1] ?? cleaned).replace(/\\/g, "/");
    if (!paths.some((x) => pathsMatch(x, p))) {
      paths.push(p);
    }
  };

  for (const m of text.matchAll(
    /(?:^|\n)\s*(?:DELETE|REMOVE)(?:\s+FILE)?\s*(?:path\s*[=:]\s*|file\s*[=:]\s*|:\s*|=)\s*[`"]?([^\s`"'<\n]+)[`"]?/gi
  )) {
    add(m[1]);
  }

  // Bold / heading: **DELETE contacts.html** / ### DELETE contacts.html
  for (const m of text.matchAll(
    /(?:^|\n)\s*(?:#{1,6}\s*|\*{1,2}\s*)?(?:DELETE|REMOVE)(?:\s+FILE)?\s+([^\n*#]+)/gi
  )) {
    add(m[1]);
  }

  return paths;
}

/** Paths the user explicitly asked to delete, e.g. "Delete end.html and update index". */
export function extractExplicitDeletePathsFromUser(userText: string): string[] {
  // Sync helper: only names that already include an extension.
  return extractDeleteHintsFromUser(userText).filter((h) => /\.\w{1,8}$/.test(h));
}

const DELETE_HINT_STOPWORDS = new Set([
  "file",
  "files",
  "the",
  "a",
  "an",
  "this",
  "that",
  "them",
  "it",
  "unused",
  "orphan",
  "orphans",
  "all",
  "any",
  "some",
  "my",
  "our",
  "please",
  "again",
  "now",
  "here",
]);

/**
 * Name hints from user delete phrasing — with or without extension.
 * Examples: "delete marks", "delete end.html", "you didn't delete marks".
 */
export function extractDeleteHintsFromUser(userText: string): string[] {
  const hints: string[] = [];
  const add = (raw: string | undefined): void => {
    if (!raw) {
      return;
    }
    let cleaned = raw
      .replace(/^[`"'<]+|[`"'>\s.,;:!]+$/g, "")
      .replace(/\\/g, "/")
      .trim();
    // Strip trailing words accidentally captured ("marks please")
    cleaned = cleaned.split(/\s+/)[0] ?? cleaned;
    if (!cleaned || cleaned.length < 2 || cleaned.length > 80) {
      return;
    }
    if (DELETE_HINT_STOPWORDS.has(cleaned.toLowerCase())) {
      return;
    }
    // Reject pure language tags
    if (LANG_TO_EXT[cleaned.toLowerCase()] !== undefined) {
      return;
    }
    if (!hints.some((h) => h.toLowerCase() === cleaned.toLowerCase())) {
      hints.push(cleaned);
    }
  };

  const text = userText || "";
  for (const m of text.matchAll(
    /\b(?:delete|remove|deleting|removing)\s+(?:the\s+)?(?:file\s+)?[`"']?([a-zA-Z][\w.\-/]*)/gi
  )) {
    add(m[1]);
  }
  for (const m of text.matchAll(
    /\b(?:didn'?t|did\s+not)\s+delete\s+[`"']?([a-zA-Z][\w.\-/]*)/gi
  )) {
    add(m[1]);
  }
  for (const m of text.matchAll(
    /\btry\s+(?:to\s+)?(?:delete|deleting|remove|removing)\s+[`"']?([a-zA-Z][\w.\-/]*)/gi
  )) {
    add(m[1]);
  }
  return hints;
}

function basenameNoExt(p: string): string {
  const base = basename(p);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Resolve user delete hints against real workspace files.
 * Bare names like "marks" → marks.html when unique on disk.
 */
export async function resolveUserDeleteTargets(
  userText: string,
  preferNearPaths: string[] = []
): Promise<{
  resolved: string[];
  missing: string[];
  ambiguous: Array<{ hint: string; candidates: string[] }>;
}> {
  const hints = extractDeleteHintsFromUser(userText);
  const resolved: string[] = [];
  const missing: string[] = [];
  const ambiguous: Array<{ hint: string; candidates: string[] }> = [];

  if (hints.length === 0) {
    return { resolved, missing, ambiguous };
  }

  const preferDirs = new Set(
    preferNearPaths.map((p) => {
      const n = p.replace(/\\/g, "/");
      const i = n.lastIndexOf("/");
      return i >= 0 ? n.slice(0, i) : ".";
    })
  );

  for (const hint of hints) {
    const normHint = hint.replace(/\\/g, "/");
    const hasExt = /\.\w{1,8}$/.test(normHint);
    const needle = hasExt ? basename(normHint) : basenameNoExt(normHint);
    const glob = hasExt ? `**/${basename(normHint)}` : `**/${needle}.*`;

    let uris: vscode.Uri[] = [];
    try {
      uris = await vscode.workspace.findFiles(
        glob,
        "**/{node_modules,.git,dist,out,build}/**",
        40
      );
    } catch {
      uris = [];
    }

    const rels = uris
      .map((u) => vscode.workspace.asRelativePath(u, false).replace(/\\/g, "/"))
      .filter(Boolean);

    let matches = rels.filter((rel) => {
      const b = basename(rel);
      if (hasExt) {
        return b.toLowerCase() === basename(normHint).toLowerCase();
      }
      return basenameNoExt(rel).toLowerCase() === needle.toLowerCase();
    });

    // Prefer files near attached editor paths when multiple matches
    if (matches.length > 1 && preferDirs.size > 0) {
      const near = matches.filter((rel) => {
        const i = rel.lastIndexOf("/");
        const dir = i >= 0 ? rel.slice(0, i) : ".";
        return preferDirs.has(dir);
      });
      if (near.length === 1) {
        matches = near;
      } else if (near.length > 1) {
        matches = near;
      }
    }

    if (matches.length === 1) {
      if (!resolved.some((r) => pathsMatch(r, matches[0]))) {
        resolved.push(matches[0]);
      }
    } else if (matches.length === 0) {
      missing.push(hint);
    } else {
      ambiguous.push({ hint, candidates: matches.slice(0, 8) });
    }
  }

  return { resolved, missing, ambiguous };
}

export function deletePathAllowed(
  candidate: string,
  allowed: string[]
): boolean {
  if (allowed.length === 0) {
    return true;
  }
  const cand = candidate.replace(/\\/g, "/");
  const candBase = basename(cand).toLowerCase();
  const candStem = basenameNoExt(cand).toLowerCase();
  return allowed.some((a) => {
    const norm = a.replace(/\\/g, "/");
    if (pathsMatch(norm, cand)) {
      return true;
    }
    const base = basename(norm).toLowerCase();
    const stem = basenameNoExt(norm).toLowerCase();
    return base === candBase || stem === candStem;
  });
}

/**
 * Labels like:
 *   **contacts.html**
 *   **index.html** (with new link added)
 *   ### contacts.html
 *   File: contacts.html
 *   contacts.html:
 */
function extractHeadingPathBeforeFence(before: string): string | undefined {
  const lines = before
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return undefined;
  }

  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i--) {
    let line = lines[i]
      .replace(/\s*\([^)]*\)\s*$/, "") // (with new link added)
      .replace(/[:：]\s*$/, "")
      .trim();

    // Strip common wrappers then look for a filename
    const stripped = line
      .replace(/^\*{1,2}\s*/, "")
      .replace(/\s*\*{1,2}$/, "")
      .replace(/^__\s*/, "")
      .replace(/\s*__$/, "")
      .replace(/^`+|`+$/g, "")
      .replace(/^#{1,6}\s*/, "")
      .replace(/^(?:file|path)\s*[=:]\s*/i, "")
      .trim();

    const direct = stripped.match(new RegExp(`^${FILE_NAME_RE.source}$`, "i"));
    if (direct?.[1] && !LANG_TO_EXT[direct[1].toLowerCase()]) {
      return direct[1].replace(/\\/g, "/");
    }

    // Filename anywhere on the heading line (bold/markdown noise)
    const embedded = line.match(FILE_NAME_RE);
    if (embedded?.[1] && !LANG_TO_EXT[embedded[1].toLowerCase()]) {
      return embedded[1].replace(/\\/g, "/");
    }

    // Bare stem: **contacts** / Contacts → will gain extension from language tag
    const stem = stripped.match(/^([a-zA-Z][a-zA-Z0-9_-]{1,40})$/);
    if (stem && !/^(html|css|javascript|typescript|json|python|bash)$/i.test(stem[1])) {
      return stem[1];
    }
  }
  return undefined;
}

function extractPathHints(
  info: string,
  content: string,
  headingPath?: string
): { hintPath?: string; hintExt?: string } {
  let hintPath: string | undefined;
  let hintExt: string | undefined;

  const pathEq = info.match(/\bpath\s*[=:]\s*["']?([^\s"'`]+)["']?/i);
  if (pathEq) {
    hintPath = pathEq[1].replace(/\\/g, "/");
  }

  const fileEq = info.match(/\bfile\s*[=:]\s*["']?([^\s"'`]+)["']?/i);
  if (!hintPath && fileEq) {
    hintPath = fileEq[1].replace(/\\/g, "/");
  }

  const tokens = info.split(/[\s]+/).filter(Boolean);
  for (const t of tokens) {
    const lower = t.toLowerCase();
    if (LANG_TO_EXT[lower]) {
      hintExt = LANG_TO_EXT[lower];
      continue;
    }
    const cleaned = t.replace(/^path=/i, "").replace(/^file=/i, "").replace(/\\/g, "/");
    if (/[\\/]/.test(cleaned) || /\.\w{1,8}$/.test(cleaned)) {
      if (!LANG_TO_EXT[cleaned.toLowerCase()]) {
        hintPath = hintPath ?? cleaned;
      }
    }
  }

  // <!-- contacts.html --> or // path: contacts.html at top of fence
  if (!hintPath) {
    const head = content.slice(0, 240);
    const comment =
      head.match(/<!--\s*([^\s*]+\.\w{1,8})\s*-->/) ||
      head.match(/(?:^|\n)\s*(?:\/\/|#)\s*(?:file|path)\s*[=:]\s*([^\s]+)/i);
    if (comment) {
      hintPath = comment[1].replace(/\\/g, "/");
    }
  }

  if (!hintPath && headingPath) {
    hintPath = headingPath;
  }

  // Do NOT invent paths from <title>…</title> (e.g. "Valid HTML Example" →
  // validhtmlexample.html). That overwrote the wrong file. Prefer path=,
  // headings, comments, or the attached editor file instead.

  // Bare name without extension + language tag → contacts + html → contacts.html
  if (hintPath && !/\.\w{1,8}$/.test(hintPath) && hintExt) {
    hintPath = `${hintPath}${hintExt}`;
  }

  if (!hintExt && hintPath) {
    const dot = hintPath.lastIndexOf(".");
    if (dot >= 0) {
      hintExt = hintPath.slice(dot).toLowerCase();
    }
  }
  return { hintPath, hintExt };
}

function basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

function extOf(p: string): string {
  const b = basename(p).toLowerCase();
  const dot = b.lastIndexOf(".");
  return dot >= 0 ? b.slice(dot) : "";
}

function pathsMatch(a: string, b: string): boolean {
  const na = a.replace(/\\/g, "/").toLowerCase();
  const nb = b.replace(/\\/g, "/").toLowerCase();
  return (
    na === nb ||
    na.endsWith("/" + nb) ||
    nb.endsWith("/" + na) ||
    basename(na) === basename(nb)
  );
}

function scoreFenceForPath(fence: ParsedFence, path: string): number {
  const norm = path.replace(/\\/g, "/");
  const base = basename(norm).toLowerCase();
  const ext = extOf(norm);
  let score = 0;

  if (fence.hintPath) {
    if (pathsMatch(fence.hintPath, norm)) {
      score += 1000;
    } else {
      // Explicitly labeled for a *different* file — do not dump into this path
      return -1;
    }
  }
  if (fence.hintExt && ext && fence.hintExt === ext) {
    score += 200;
  }
  // Prefer content that mentions this basename (e.g. href="contacts.html")
  if (base && fence.content.toLowerCase().includes(base)) {
    score += 80;
  }
  if (fence.content.length > 80) {
    score += Math.min(120, Math.floor(fence.content.length / 40));
  }
  return score;
}

/**
 * When ChatRouter returns code fences, propose Apply cards for:
 * - attached files
 * - new files labeled via path=, bold headings (**contacts.html**), or comments
 * - deletes via DELETE path=… lines or ```delete path=… fences
 * - user-requested deletes (preDeletePaths), optionally allowlisted so the model
 *   cannot delete a different file than the one the user named
 */
export async function proposeEditsFromAssistantReply(
  assistantText: string,
  attachedPaths: string[],
  onPendingEdit: (
    edit: PendingEdit
  ) => boolean | void | Promise<boolean | void>,
  preDeletePaths: string[] = [],
  opts?: {
    /** When true and preDeletePaths is non-empty, ignore model deletes outside that set. */
    lockDeletesToUserTargets?: boolean;
    onSkippedDelete?: (path: string, reason: string) => void;
  }
): Promise<{ count: number; edits: PendingEdit[] }> {
  if (!assistantText && preDeletePaths.length === 0) {
    return { count: 0, edits: [] };
  }

  const fences = parseFences(assistantText || "");
  const edits: PendingEdit[] = [];
  const usedFences = new Set<number>();
  // Only paths we have successfully proposed — do NOT seed with preDeletePaths
  // or user-requested deletes get skipped as "already done".
  const deletedPaths: string[] = [];
  const lockDeletes =
    Boolean(opts?.lockDeletesToUserTargets) && preDeletePaths.length > 0;

  const pushEdit = async (edit: PendingEdit): Promise<void> => {
    const accepted = await onPendingEdit(edit);
    if (accepted === false) {
      await rejectPendingEdit(edit.id);
      return;
    }
    edits.push(edit);
  };

  const proposeDelete = async (
    path: string,
    source: "user" | "model"
  ): Promise<void> => {
    const norm = path.replace(/\\/g, "/");
    if (deletedPaths.some((p) => pathsMatch(p, norm))) {
      return;
    }
    if (edits.some((e) => pathsMatch(e.relativePath, norm))) {
      return;
    }
    if (lockDeletes && source === "model" && !deletePathAllowed(norm, preDeletePaths)) {
      opts?.onSkippedDelete?.(
        norm,
        `user asked to delete ${preDeletePaths.join(", ")}, not this path`
      );
      return;
    }
    if (lockDeletes && source === "user" && !deletePathAllowed(norm, preDeletePaths)) {
      // Shouldn't happen for resolved user paths; keep safe.
      opts?.onSkippedDelete?.(norm, "not in resolved user delete targets");
      return;
    }
    const result = await proposeFileDelete(norm);
    if (result.ok && result.pendingEdit) {
      deletedPaths.push(norm);
      await pushEdit(result.pendingEdit);
    } else if (!result.ok) {
      opts?.onSkippedDelete?.(norm, result.content || "delete failed");
    }
  };

  // 0) User-requested deletes first (e.g. "delete marks" → marks.html)
  for (const p of preDeletePaths) {
    await proposeDelete(p, "user");
  }
  for (const p of extractDeletePathsFromText(assistantText || "")) {
    await proposeDelete(p, "model");
  }
  for (let i = 0; i < fences.length; i++) {
    const fence = fences[i];
    if (!fence.hintPath) {
      continue;
    }
    if (fence.isDelete || isDeleteMarker(fence.content)) {
      usedFences.add(i);
      await proposeDelete(fence.hintPath, "model");
    }
  }

  if (fences.length === 0 && edits.length > 0) {
    return { count: edits.length, edits };
  }
  if (fences.length === 0) {
    return { count: 0, edits: [] };
  }

  const targets: string[] = [];

  const addTarget = (p: string): void => {
    const norm = p.replace(/\\/g, "/");
    if (!targets.some((t) => pathsMatch(t, norm))) {
      targets.push(norm);
    }
  };

  for (const p of attachedPaths) {
    addTarget(p);
  }
  for (const fence of fences) {
    if (fence.hintPath && !fence.isDelete) {
      addTarget(fence.hintPath);
    }
  }

  // 1) Assign every path-labeled write fence (creates contacts.html etc.)
  for (let i = 0; i < fences.length; i++) {
    const fence = fences[i];
    if (!fence.hintPath || usedFences.has(i)) {
      continue;
    }
    if (fence.isDelete || isDeleteMarker(fence.content)) {
      continue;
    }
    const path = fence.hintPath.replace(/\\/g, "/");
    if (deletedPaths.some((p) => pathsMatch(p, path))) {
      usedFences.add(i);
      continue;
    }
    usedFences.add(i);
    const result = await proposeFileEdit(path, fence.content);
    if (result.ok && result.pendingEdit) {
      await pushEdit(result.pendingEdit);
    }
  }

  // 2) For attached files still missing an assignment, pick best remaining fence
  for (const path of attachedPaths.map((p) => p.replace(/\\/g, "/"))) {
    if (edits.some((e) => pathsMatch(e.relativePath, path))) {
      continue;
    }
    if (deletedPaths.some((p) => pathsMatch(p, path))) {
      continue;
    }
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < fences.length; i++) {
      if (usedFences.has(i) || fences[i].isDelete) {
        continue;
      }
      // Skip fences labeled for another path
      const labeled = fences[i].hintPath;
      if (labeled && !pathsMatch(labeled, path)) {
        continue;
      }
      const s = scoreFenceForPath(fences[i], path);
      if (s > bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    }

    if (bestIdx < 0 && fences.length === 1 && !usedFences.has(0) && !fences[0].hintPath && !fences[0].isDelete) {
      bestIdx = 0;
      bestScore = 1;
    }

    if (bestIdx < 0) {
      continue;
    }
    const chosen = fences[bestIdx];
    if (chosen.hintPath && isDeleteMarker(chosen.content)) {
      usedFences.add(bestIdx);
      await proposeDelete(chosen.hintPath, "model");
      continue;
    }
    // With multiple remaining unlabeled fences, require a real signal
    const unlabeledLeft = fences.filter(
      (f, i) => !usedFences.has(i) && !f.hintPath && !f.isDelete
    );
    if (unlabeledLeft.length > 1 && bestScore < 200) {
      continue;
    }

    usedFences.add(bestIdx);
    const result = await proposeFileEdit(path, fences[bestIdx].content);
    if (result.ok && result.pendingEdit) {
      await pushEdit(result.pendingEdit);
    }
  }

  return { count: edits.length, edits };
}

export interface CodingSummaryInfo {
  backend?: string;
  created: string[];
  updated: string[];
  deleted: string[];
  autoApplied: boolean;
  /** Bullets from the model's own ### Summary (preferred in the UI card). */
  modelNotes?: string[];
}

/** Pull bullet lines from a trailing ### Summary section. */
export function parseModelSummaryNotes(text: string): string[] {
  const section = extractCodingSummary(text);
  if (!section) {
    return [];
  }
  return section
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^#{1,3}\s*Summary\b\s*/i, "")
        .replace(/^[-*•]\s+/, "")
        .replace(/\*\*/g, "")
        .trim()
    )
    .filter((line) => line.length > 0 && !/^summary$/i.test(line));
}

/** Structured summary for a dedicated UI card (not inline markdown). */
export function buildCodingSummaryInfo(
  edits: PendingEdit[],
  opts?: {
    autoApplied?: boolean;
    backend?: string;
    modelNotes?: string[];
  }
): CodingSummaryInfo | null {
  const modelNotes = (opts?.modelNotes ?? []).filter(Boolean);
  if (edits.length === 0 && !opts?.backend && modelNotes.length === 0) {
    return null;
  }
  const deleted = edits
    .filter((e) => e.kind === "delete")
    .map((e) => e.relativePath);
  const writes = edits.filter((e) => e.kind !== "delete");
  return {
    backend: opts?.backend,
    created: writes.filter((e) => !e.oldContent).map((e) => e.relativePath),
    updated: writes.filter((e) => Boolean(e.oldContent)).map((e) => e.relativePath),
    deleted,
    autoApplied: Boolean(opts?.autoApplied && edits.length > 0),
    modelNotes: modelNotes.length > 0 ? modelNotes : undefined,
  };
}

/** @deprecated prefer buildCodingSummaryInfo + UI card */
export function formatCodingWorkSummary(
  edits: PendingEdit[],
  opts?: { autoApplied?: boolean; backend?: string }
): string {
  const info = buildCodingSummaryInfo(edits, opts);
  if (!info) {
    return "";
  }
  const lines = ["### Summary"];
  if (info.backend) {
    lines.push(`- Backend: **${info.backend}**`);
  }
  if (info.created.length > 0) {
    lines.push(
      info.created.length === 1
        ? `- Created \`${info.created[0]}\``
        : `- Created: ${info.created.map((p) => `\`${p}\``).join(", ")}`
    );
  }
  if (info.updated.length > 0) {
    lines.push(
      info.updated.length === 1
        ? `- Updated \`${info.updated[0]}\``
        : `- Updated: ${info.updated.map((p) => `\`${p}\``).join(", ")}`
    );
  }
  if (info.deleted.length > 0) {
    lines.push(
      info.deleted.length === 1
        ? `- Deleted \`${info.deleted[0]}\``
        : `- Deleted: ${info.deleted.map((p) => `\`${p}\``).join(", ")}`
    );
  }
  if (edits.length > 0) {
    if (info.autoApplied) {
      lines.push("- Changes were written to disk (auto-apply).");
    } else {
      lines.push(
        edits.length === 1
          ? "- Click **Apply** to write it to disk."
          : "- Click **Apply** on each card to write to disk."
      );
    }
  }
  return lines.join("\n");
}

/** Remove a trailing ### Summary block the model may have emitted. */
export function stripCodingSummarySection(text: string): string {
  if (!text) {
    return text;
  }
  return text.replace(/\n*#{1,3}\s*Summary\b[\s\S]*$/i, "").trimEnd();
}

export function replyAlreadyHasSummary(text: string): boolean {
  return /(?:^|\n)#{1,3}\s*summary\b|(?:^|\n)\s*summary\s*[:—-]/i.test(text);
}

export function extractCodingSummary(text: string): string {
  const m = text.match(/(?:^|\n)(#{1,3}\s*Summary\b[\s\S]*)$/i);
  return m ? m[1].trim() : "";
}
