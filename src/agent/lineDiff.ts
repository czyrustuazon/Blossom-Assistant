/** One highlighted or plain span inside a changed line. */
export interface DiffSegment {
  text: string;
  /** Stronger background — the exact chars/tokens that changed. */
  highlight?: boolean;
}

/** One line inside a diff hunk. */
export interface DiffLine {
  kind: "ctx" | "add" | "del";
  text: string;
  /** 1-based line number in the old file (ctx + del). */
  oldLine?: number;
  /** 1-based line number in the new file (ctx + add). */
  newLine?: number;
  /** Optional intraline segments for word/char highlights. */
  segments?: DiffSegment[];
}

/** A contiguous changed region with a bit of surrounding context. */
export interface DiffHunk {
  /** Unified-diff style header, e.g. @@ -31,4 +31,6 @@ */
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface LineDiffResult {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  /** True when the file is new (no old content). */
  isNew: boolean;
  /** True when this is a delete (no new content). */
  isDelete: boolean;
  /** Diff was truncated for UI size. */
  truncated: boolean;
}

const CONTEXT = 3;
const MAX_DIFF_LINES = 220;
const MAX_INPUT_LINES = 8000;

type Op = { type: "eq" | "del" | "add"; line: string };

function splitLines(text: string): string[] {
  if (!text) {
    return [];
  }
  const parts = text.split(/\r?\n/);
  if (parts.length > 1 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

/** Myers / LCS-backed line ops. Falls back to replace-all on huge inputs. */
function lineOps(oldLines: string[], newLines: string[]): Op[] {
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0 && m === 0) {
    return [];
  }
  if (n === 0) {
    return newLines.map((line) => ({ type: "add" as const, line }));
  }
  if (m === 0) {
    return oldLines.map((line) => ({ type: "del" as const, line }));
  }
  if (n > MAX_INPUT_LINES || m > MAX_INPUT_LINES) {
    return [
      ...oldLines.slice(0, 80).map((line) => ({ type: "del" as const, line })),
      ...newLines.slice(0, 80).map((line) => ({ type: "add" as const, line })),
    ];
  }

  const dp: Uint16Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    dp[i] = new Uint16Array(m + 1);
  }
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        oldLines[i] === newLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: "eq", line: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", line: oldLines[i] });
      i++;
    } else {
      ops.push({ type: "add", line: newLines[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "del", line: oldLines[i++] });
  }
  while (j < m) {
    ops.push({ type: "add", line: newLines[j++] });
  }
  return ops;
}

/** Split into words / whitespace / punctuation for intraline highlighting. */
function tokenize(s: string): string[] {
  return s.split(/(\s+|[^a-zA-Z0-9_]+)/).filter((t) => t.length > 0);
}

function lcsMask(a: string[], b: string[]): { aKeep: boolean[]; bKeep: boolean[] } {
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    dp[i] = new Uint16Array(m + 1);
  }
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const aKeep = new Array(n).fill(false);
  const bKeep = new Array(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      aKeep[i] = true;
      bKeep[j] = true;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return { aKeep, bKeep };
}

function segmentsFromMask(tokens: string[], keep: boolean[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const highlight = !keep[i];
    const last = out[out.length - 1];
    if (last && !!last.highlight === highlight) {
      last.text += tokens[i];
    } else {
      out.push({ text: tokens[i], highlight: highlight || undefined });
    }
  }
  return out;
}

/**
 * Compare two similar lines and mark changed tokens for Cursor-style
 * intraline highlighting (e.g. True → False).
 */
export function intralineSegments(
  oldText: string,
  newText: string
): { del: DiffSegment[]; add: DiffSegment[] } {
  if (oldText === newText) {
    return {
      del: [{ text: oldText }],
      add: [{ text: newText }],
    };
  }
  // Very short / totally different — highlight the whole line.
  if (
    oldText.length > 400 ||
    newText.length > 400 ||
    (oldText.length > 0 &&
      newText.length > 0 &&
      Math.min(oldText.length, newText.length) /
        Math.max(oldText.length, newText.length) <
        0.25)
  ) {
    return {
      del: [{ text: oldText, highlight: true }],
      add: [{ text: newText, highlight: true }],
    };
  }
  const a = tokenize(oldText);
  const b = tokenize(newText);
  if (a.length > 200 || b.length > 200) {
    return {
      del: [{ text: oldText, highlight: true }],
      add: [{ text: newText, highlight: true }],
    };
  }
  const { aKeep, bKeep } = lcsMask(a, b);
  return {
    del: segmentsFromMask(a, aKeep),
    add: segmentsFromMask(b, bKeep),
  };
}

/** Pair consecutive del/add runs and attach intraline segments. */
function annotateIntraline(lines: DiffLine[]): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "del") {
      i++;
      continue;
    }
    const d0 = i;
    while (i < lines.length && lines[i].kind === "del") {
      i++;
    }
    const a0 = i;
    while (i < lines.length && lines[i].kind === "add") {
      i++;
    }
    const dels = lines.slice(d0, a0);
    const adds = lines.slice(a0, i);
    const pairs = Math.min(dels.length, adds.length);
    for (let k = 0; k < pairs; k++) {
      const segs = intralineSegments(dels[k].text, adds[k].text);
      const delHas = segs.del.some((s) => s.highlight);
      const addHas = segs.add.some((s) => s.highlight);
      if (delHas || addHas) {
        dels[k].segments = segs.del;
        adds[k].segments = segs.add;
      }
    }
  }
}

/**
 * Build a line diff between two file versions for the chat UI.
 * Returns hunks with context, line numbers, and intraline highlights.
 */
export function diffFileContents(
  oldText: string,
  newText: string
): LineDiffResult {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const isNew = oldLines.length === 0 && newLines.length > 0;
  const isDelete = newLines.length === 0 && oldLines.length > 0;

  if (oldText === newText) {
    return {
      hunks: [],
      additions: 0,
      deletions: 0,
      isNew: false,
      isDelete: false,
      truncated: false,
    };
  }

  const ops = lineOps(oldLines, newLines);
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.type === "add") {
      additions++;
    } else if (op.type === "del") {
      deletions++;
    }
  }

  const isChange = ops.map((o) => o.type !== "eq");
  const inHunk = new Array(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (!isChange[i]) {
      continue;
    }
    const from = Math.max(0, i - CONTEXT);
    const to = Math.min(ops.length - 1, i + CONTEXT);
    for (let k = from; k <= to; k++) {
      inHunk[k] = true;
    }
  }

  const hunks: DiffHunk[] = [];
  let totalDiffLines = 0;
  let truncated = false;
  let idx = 0;
  let oldLineNo = 1;
  let newLineNo = 1;

  while (idx < ops.length) {
    if (!inHunk[idx]) {
      if (ops[idx].type === "eq") {
        oldLineNo++;
        newLineNo++;
      } else if (ops[idx].type === "del") {
        oldLineNo++;
      } else {
        newLineNo++;
      }
      idx++;
      continue;
    }

    const start = idx;
    while (idx < ops.length && inHunk[idx]) {
      idx++;
    }
    const slice = ops.slice(start, idx);

    let o = oldLineNo;
    let n = newLineNo;
    let oldCount = 0;
    let newCount = 0;
    const lines: DiffLine[] = [];
    for (const op of slice) {
      if (op.type === "eq") {
        oldCount++;
        newCount++;
        lines.push({ kind: "ctx", text: op.line, oldLine: o, newLine: n });
        o++;
        n++;
      } else if (op.type === "del") {
        oldCount++;
        lines.push({ kind: "del", text: op.line, oldLine: o });
        o++;
      } else {
        newCount++;
        lines.push({ kind: "add", text: op.line, newLine: n });
        n++;
      }
    }
    annotateIntraline(lines);

    if (totalDiffLines + lines.length > MAX_DIFF_LINES) {
      const room = Math.max(0, MAX_DIFF_LINES - totalDiffLines);
      if (room > 0) {
        const clipped = lines.slice(0, room);
        annotateIntraline(clipped);
        hunks.push({
          header: `@@ -${oldLineNo},${oldCount} +${newLineNo},${newCount} @@`,
          oldStart: oldLineNo,
          newStart: newLineNo,
          lines: clipped,
        });
        totalDiffLines += room;
      }
      truncated = true;
      break;
    }

    hunks.push({
      header: `@@ -${oldLineNo},${oldCount} +${newLineNo},${newCount} @@`,
      oldStart: oldLineNo,
      newStart: newLineNo,
      lines,
    });
    totalDiffLines += lines.length;
    oldLineNo = o;
    newLineNo = n;
  }

  return {
    hunks,
    additions,
    deletions,
    isNew,
    isDelete,
    truncated,
  };
}
