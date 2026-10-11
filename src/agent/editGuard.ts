/**
 * Block unsafe full-file replaces before Apply / auto-apply.
 * Prevents README/markdown prose from overwriting executable source (and vice versa).
 */

export interface EditGuardResult {
  allowed: boolean;
  reason?: string;
}

const CODE_EXTENSIONS = new Set([
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".cs",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
  ".rb",
  ".php",
  ".vue",
  ".svelte",
  ".sql",
  ".sh",
  ".ps1",
  ".bat",
  ".json",
]);

const DOC_EXTENSIONS = new Set([".md", ".mdc", ".txt", ".rst", ".adoc"]);

const EXT_CODE_PATTERNS: Record<string, RegExp[]> = {
  ".py": [
    /^\s*(def |class |import |from |async def |@)/m,
    /^#!.*python/m,
    /if __name__\s*==\s*['"]__main__['"]/m,
  ],
  ".ts": [/^\s*(import |export |function |const |class |interface |type |enum )/m],
  ".tsx": [/^\s*(import |export |function |const |class |interface |type |enum )/m],
  ".js": [/^\s*(import |export |function |const |class |require\()/m],
  ".jsx": [/^\s*(import |export |function |const |class |require\()/m],
  ".mjs": [/^\s*(import |export |function |const |class )/m],
  ".cjs": [/^\s*(const |require\(|module\.exports)/m],
  ".go": [/^\s*(func |package |import |type )/m],
  ".rs": [/^\s*(fn |pub |use |impl |struct |enum )/m],
  ".java": [/^\s*(public |private |class |import |package )/m],
  ".kt": [/^\s*(fun |class |import |package )/m],
  ".cs": [/^\s*(using |namespace |class |public |private )/m],
  ".rb": [/^\s*(def |class |module |require )/m],
  // Multiple patterns so scoreCode can reach ≥3 on real PHP modules (single-pattern
  // scoring capped at 1 and disabled every gutting check that required oldCode ≥ 3).
  ".php": [
    /^\s*<\?php\b/m,
    /^\s*namespace\s+\w+/m,
    /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+\w+/m,
    /^\s*(?:public|private|protected|static|\s)*function\s+\w+/m,
    /^\s*(?:require|include)(?:_once)?\s*\(?/m,
    /\b(?:new\s+PDO\b|mysqli?_|mysql_|->(?:query|prepare|execute|fetch))\b/m,
  ],
  ".vue": [/<template>|<script|export default/m],
  ".svelte": [/<script|export /m],
  ".sh": [/^\s*(#!\/|function |[a-zA-Z_][\w]*=\(|if \[)/m],
  ".ps1": [/^\s*(function |param\(|#Requires)/m],
  ".bat": [/^\s*(@echo|set |call |:)/im],
  ".json": [/^\s*[\[{]/m],
};

const DEFAULT_CODE_PATTERNS: RegExp[] = [
  /^\s*(import |export |function |class |def |package |fn |pub |use |#include)/m,
  /^\s*[\w$]+\s*[:=]\s*(async\s*)?\(/m,
];

const PROSE_PATTERNS: RegExp[] = [
  /^\s*\|.+\|\s*$/m,
  /^\s*#{1,6}\s+\S/m,
  /^\s*[-*•]\s+\*\*/m,
  /^\s*\d+\.\s+\*\*/m,
  /^---\s*$/m,
  /Do \*\*not\*\*/i,
  /^\s*See also:/im,
  /^\s*\*\*License:\*\*/im,
  /^\s*###\s+/m,
  /^\s*\*\*[^*]+\*\*\s*$/m,
];

function extOf(relativePath: string): string {
  const base = relativePath.replace(/\\/g, "/").split("/").pop() ?? relativePath;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot).toLowerCase() : "";
}

function countPatternHits(text: string, patterns: RegExp[]): number {
  if (!text.trim()) {
    return 0;
  }
  let hits = 0;
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      hits += m.length;
    }
  }
  return hits;
}

function codePatternsFor(ext: string): RegExp[] {
  return EXT_CODE_PATTERNS[ext] ?? DEFAULT_CODE_PATTERNS;
}

function scoreCode(text: string, ext: string): number {
  return countPatternHits(text, codePatternsFor(ext));
}

function scoreProse(text: string): number {
  return countPatternHits(text, PROSE_PATTERNS);
}

function nonEmptyLines(text: string): number {
  return text.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
}

function hasMarkdownHeading(text: string): boolean {
  return /^\s*#{1,6}\s+\S/m.test(text);
}

/** Model pasted a fence path as a heading inside a code file (e.g. ### src/foo.py). */
function hasMarkdownPathHeading(text: string): boolean {
  return /^\s*#{1,6}\s+(?:[\w.-]+\/)*[\w.-]+\.(?:py|ts|tsx|js|jsx|go|rs|java|cs|cpp|c|h|rb|php|sh)\b/im.test(
    text
  );
}

/** Count real defs/classes/imports — not a lone stub pasted over a module. */
function countModuleStructure(text: string, ext: string): number {
  let n = 0;
  if (ext === ".py") {
    n += (text.match(/^\s*(?:async )?def \w+/gm) || []).length;
    n += (text.match(/^\s*class \w+/gm) || []).length;
    n += (text.match(/^\s*(?:from \S+ import|import \S+)/gm) || []).length;
    if (/^#!.*python/m.test(text)) {
      n += 1;
    }
  } else if (ext === ".php") {
    n += (text.match(/^\s*<\?php\b/gm) || []).length;
    n += (text.match(/^\s*namespace\s+\w+/gm) || []).length;
    n += (text.match(/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+\w+/gm) || []).length;
    n += (text.match(/^\s*(?:public|private|protected|static|\s)*function\s+\w+/gm) || []).length;
    n += (text.match(/^\s*(?:require|include)(?:_once)?\s*\(?/gm) || []).length;
    n += (text.match(/\b(?:new\s+PDO\b|mysqli?_\w+|mysql_\w+)/gm) || []).length;
  } else {
    n = scoreCode(text, ext);
  }
  return n;
}

function looksLikePlanPastedIntoCode(text: string, ext: string): boolean {
  if (ext !== ".py" && !CODE_EXTENSIONS.has(ext)) {
    return false;
  }
  const lines = nonEmptyLines(text);
  if (lines > 40) {
    return false;
  }
  const structure = countModuleStructure(text, ext);
  const prose = scoreProse(text);
  const hashCommentLines = (text.match(/^\s*#(?!#)/gm) || []).length;
  if (hasMarkdownPathHeading(text)) {
    return true;
  }
  if (hasMarkdownHeading(text) && structure <= 2) {
    return true;
  }
  if (prose >= 1 && structure <= 2 && lines <= 25) {
    return true;
  }
  if (ext === ".py" && hashCommentLines >= 2 && structure <= 2 && lines <= 30) {
    return true;
  }
  return false;
}

function severeCodeShrink(
  oldLines: number,
  newLines: number,
  oldCode: number,
  newCode: number
): boolean {
  // Line-based gutting must work even when scoreCode is weak (PHP used to cap at 1).
  if (oldLines < 40) {
    return false;
  }
  const ratio = newLines / oldLines;
  if (ratio >= 0.35) {
    return false;
  }
  // Near-total wipe (blog.php → empty / handful of lines).
  if (newLines < Math.max(8, Math.floor(oldLines * 0.12))) {
    return true;
  }
  // Structure-aware stub replace (darcutil 330→11 with one def).
  if (oldCode >= 3 && (newCode <= 2 || newLines < Math.max(12, Math.floor(oldLines * 0.12)))) {
    return true;
  }
  return false;
}

/** Non-empty code file wiped to blank / whitespace-only. */
function isEmptyWipe(oldContent: string, newContent: string): boolean {
  return oldContent.trim().length > 0 && newContent.trim().length === 0;
}

/** Substantial file collapsed to a near-empty stub (≤3 non-empty lines). */
function isNearEmptyWipe(oldLines: number, newLines: number): boolean {
  return oldLines >= 20 && newLines > 0 && newLines <= 3;
}

/** Chain-of-thought pasted into a file (e.g. "# First, let me examine…"). */
const THINKING_COMMENT_RE =
  /^\s*#\s+(?:First,|Let me |The issue|The problem|Looking at|I need to|I should|We need|I see that|It looks like|Let me check)/i;

function looksLikeModelThinkingComments(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return false;
  }
  const hashLines = lines.filter((l) => /^\s*#/.test(l));
  if (hashLines.length < 2) {
    return false;
  }
  const thinking = hashLines.filter((l) => THINKING_COMMENT_RE.test(l));
  return thinking.length >= 2 && thinking.length >= hashLines.length * 0.4;
}

function proseReplacesCodeMessage(relativePath: string, ext: string): string {
  const docHint =
    ext === ".py"
      ? "README.md, technical.md, or tools/README.md"
      : "README.md or a .md file";
  return (
    `Content guard: refused full replace of ${relativePath} — proposed content looks like README/markdown ` +
    `(tables, ### headers, install steps), not executable ${ext.slice(1) || "source"}. ` +
    `Move documentation to ${docHint}; keep imports/functions/classes in code files.`
  );
}

function guttedCodeMessage(relativePath: string, oldLines: number, newLines: number): string {
  return (
    `Content guard: refused gutting ${relativePath} (${oldLines} → ${newLines} non-empty lines) ` +
    `without preserving executable structure. Use search_replace for targeted edits; move prose to path=*.md.`
  );
}

function partialSnippetMessage(
  relativePath: string,
  oldLines: number,
  newLines: number
): string {
  return (
    `Content guard: refused partial replace of ${relativePath} (${oldLines} → ${newLines} lines via full-file write). ` +
    `Use search_replace with a unique old_string/new_string pair, or emit the complete file in write_file / path= fence.`
  );
}

function validateDocTruncation(
  relativePath: string,
  oldContent: string,
  newContent: string
): EditGuardResult | null {
  const oldLines = nonEmptyLines(oldContent);
  const newLines = nonEmptyLines(newContent);
  if (oldLines < 50) {
    return null;
  }
  const ratio = oldLines > 0 ? newLines / oldLines : 1;
  const oldHeaders = (oldContent.match(/^#{1,3}\s/gm) || []).length;
  const newHeaders = (newContent.match(/^#{1,3}\s/gm) || []).length;

  // Severe truncation (e.g. technical.md 799 → 3 lines).
  if (ratio < 0.08 && newLines < 40) {
    return {
      allowed: false,
      reason:
        `Content guard: refused truncating ${relativePath} (${oldLines} → ${newLines} lines). ` +
        `Long-form docs belong in technical.md/README — do not delete sections from markdown while ` +
        `pasting them into .py files. Add or edit docs in path=*.md fences separately.`,
    };
  }

  // Large doc lost most sections (e.g. README 313 → 34 lines).
  if (
    oldLines >= 200 &&
    ratio < 0.2 &&
    oldHeaders >= 10 &&
    newHeaders < Math.max(3, Math.floor(oldHeaders * 0.3))
  ) {
    return {
      allowed: false,
      reason:
        `Content guard: refused truncating ${relativePath} (${oldLines} → ${newLines} lines; ` +
        `${oldHeaders} → ${newHeaders} headings). Consolidate docs additively in path=*.md — ` +
        `do not move README sections into source files.`,
    };
  }

  return null;
}

/**
 * Validate a proposed full-file write before creating an Apply card or auto-applying.
 */
export function validateProposedEdit(opts: {
  relativePath: string;
  newContent: string;
  oldContent: string;
}): EditGuardResult {
  const ext = extOf(opts.relativePath);
  const old = opts.oldContent ?? "";
  const neu = opts.newContent ?? "";
  const oldLines = nonEmptyLines(old);
  const newLines = nonEmptyLines(neu);
  const oldCode = scoreCode(old, ext);
  const newCode = scoreCode(neu, ext);
  const newProse = scoreProse(neu);

  if (DOC_EXTENSIONS.has(ext) && old.trim()) {
    const docBlock = validateDocTruncation(opts.relativePath, old, neu);
    if (docBlock) {
      return docBlock;
    }
    if (oldLines >= 30 && looksLikeModelThinkingComments(neu)) {
      return {
        allowed: false,
        reason:
          `Content guard: refused replacing ${opts.relativePath} with model thinking comments ` +
          `("# First, let me…"). Keep README/markdown prose in proper sections — not chain-of-thought.`,
      };
    }
    return { allowed: true };
  }

  if (oldLines >= 30 && looksLikeModelThinkingComments(neu)) {
    return {
      allowed: false,
      reason:
        `Content guard: refused replacing ${opts.relativePath} with model thinking comments ` +
        `("# First, let me…"). Use search_replace for code edits; reasoning stays in chat.`,
    };
  }

  if (!CODE_EXTENSIONS.has(ext)) {
    return { allowed: true };
  }

  // New code file must not be created as pure markdown.
  if (!old.trim()) {
    if (newCode === 0 && newProse >= 2) {
      return {
        allowed: false,
        reason: proseReplacesCodeMessage(opts.relativePath, ext),
      };
    }
    return { allowed: true };
  }

  // Hard stop: never wipe an existing code file to blank (blog.php → empty).
  if (isEmptyWipe(old, neu) || isNearEmptyWipe(oldLines, newLines)) {
    return {
      allowed: false,
      reason: guttedCodeMessage(opts.relativePath, oldLines, newLines),
    };
  }

  const oldStructure = countModuleStructure(old, ext);
  const newStructure = countModuleStructure(neu, ext);

  // Line-ratio gutting — does not require scoreCode ≥ 3 (PHP / sparse scorers).
  if (severeCodeShrink(oldLines, newLines, Math.max(oldCode, oldStructure), newCode)) {
    return {
      allowed: false,
      reason: guttedCodeMessage(opts.relativePath, oldLines, newLines),
    };
  }

  // Structure collapse: real module → stub with a couple of defs left.
  if (
    oldStructure >= 5 &&
    newStructure <= 2 &&
    newLines < Math.max(12, Math.floor(oldLines * 0.4))
  ) {
    return {
      allowed: false,
      reason: guttedCodeMessage(opts.relativePath, oldLines, newLines),
    };
  }

  // Markdown headings / plan prose pasted into an existing code file.
  if (old.trim() && (oldCode >= 3 || oldStructure >= 3 || oldLines >= 40)) {
    if (hasMarkdownPathHeading(neu)) {
      return {
        allowed: false,
        reason:
          `Content guard: refused replacing ${opts.relativePath} with a markdown path heading ` +
          `(### src/foo.py). That belongs in chat or path=*.md — not inside a ${ext} file.`,
      };
    }
    if (looksLikePlanPastedIntoCode(neu, ext)) {
      return {
        allowed: false,
        reason:
          `Content guard: refused replacing ${opts.relativePath} with plan/markdown prose ` +
          `(### headers, comment bullets, stub defs). Use search_replace for code; docs in path=*.md.`,
      };
    }
    if (hasMarkdownHeading(neu) && newLines < Math.max(20, Math.floor(oldLines * 0.5))) {
      return {
        allowed: false,
        reason: proseReplacesCodeMessage(opts.relativePath, ext),
      };
    }
  }

  // README prose pasted into an existing code file (pure prose, no code structure).
  if ((oldCode >= 3 || oldStructure >= 3) && newCode === 0 && newProse >= 1) {
    return {
      allowed: false,
      reason: proseReplacesCodeMessage(opts.relativePath, ext),
    };
  }

  // Markdown table at top of a Python file with no code left.
  if (ext === ".py" && /^\s*\|/.test(neu.trim()) && newCode === 0) {
    return {
      allowed: false,
      reason: proseReplacesCodeMessage(opts.relativePath, ext),
    };
  }

  // Partial snippet sent as a full-file fence/write (common model mistake).
  // Empty new content is already blocked above; this catches tiny stubs that still look like code.
  if (
    oldLines >= 40 &&
    newLines < Math.max(12, Math.floor(oldLines * 0.35)) &&
    newStructure <= 3 &&
    newCode <= 2
  ) {
    return {
      allowed: false,
      reason: partialSnippetMessage(opts.relativePath, oldLines, newLines),
    };
  }

  // Executable structure fully removed or collapsed to stubs.
  if (
    (oldCode >= 5 || oldStructure >= 5) &&
    newCode <= 1 &&
    newLines < Math.max(8, Math.floor(oldLines * 0.35))
  ) {
    return {
      allowed: false,
      reason: guttedCodeMessage(opts.relativePath, oldLines, newLines),
    };
  }

  return { allowed: true };
}
