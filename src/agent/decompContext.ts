/**
 * Matching-decomp workspace pack (nlpp-decomp and similar).
 * Injects policy + match-loop guidance; guards TOML / relink; compresses giant docs.
 * Distinct from EngPatcher patchScriptContext (caves / patch_*.py).
 */

import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import { getConfig } from "../config";

const execFileAsync = promisify(execFile);

export interface DecompWorkspaceInfo {
  root: vscode.WorkspaceFolder;
  rootName: string;
  hasHandoff: boolean;
  hasTechnical: boolean;
  hasCtrdecomp: boolean;
  hasFunctionsToml: boolean;
  hasHandmatch: boolean;
  handoffRoleHint?: "A" | "B" | "unknown";
}

const MARKER_FILES = [
  "AGENT_HANDOFF.md",
  "technical.md",
  "functions.toml",
  "ctrdecomp.toml",
] as const;

/** Basenames that blow 16k contexts when attached whole. */
const HUGE_DOC_BASENAMES = new Set([
  "technical.md",
  "agent_handoff.md",
  "readme.md",
  "claude.md",
]);

/** Paths that must stay append-only (or search_replace only). */
const APPEND_ONLY_BASENAMES = new Set([
  "functions.toml",
  "externs.toml",
]);

const APPEND_ONLY_PATH_RE =
  /(^|\/)(functions|externs)\.toml$/i;

const DECOMP_SRC_RE = /(^|\/)src\/(gen\/|hand_|tagged_str|draw_text|menu_bind)/i;

let cachedInfo: { at: number; info: DecompWorkspaceInfo | null; primed: boolean } = {
  at: 0,
  info: null,
  primed: false,
};
const CACHE_MS = 15_000;

function decompEnabled(): boolean {
  try {
    return (
      vscode.workspace
        .getConfiguration("blossom")
        .get<boolean>("decomp.enabled", true) ?? true
    );
  } catch {
    return true;
  }
}

function attachMaxChars(): number {
  try {
    return (
      vscode.workspace
        .getConfiguration("blossom")
        .get<number>("decomp.attachMaxChars", 3500) ?? 3500
    );
  } catch {
    return 3500;
  }
}

function totalBudgetChars(): number {
  try {
    return (
      vscode.workspace
        .getConfiguration("blossom")
        .get<number>("decomp.totalAttachBudget", 14_000) ?? 14_000
    );
  } catch {
    return 14_000;
  }
}

function blockDuringRelink(): boolean {
  try {
    return (
      vscode.workspace
        .getConfiguration("blossom")
        .get<boolean>("decomp.blockDuringRelink", true) ?? true
    );
  } catch {
    return true;
  }
}

function normRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function basenameOf(p: string): string {
  return path.posix.basename(normRel(p)).toLowerCase();
}

async function pathExists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect a matching-decomp workspace (nlpp-decomp or any tree with handoff + ctrdecomp).
 */
export async function detectDecompWorkspace(
  force = false
): Promise<DecompWorkspaceInfo | null> {
  if (!decompEnabled()) {
    return null;
  }
  const now = Date.now();
  if (!force && cachedInfo.primed && now - cachedInfo.at < CACHE_MS) {
    return cachedInfo.info;
  }

  const folders = vscode.workspace.workspaceFolders ?? [];
  let best: DecompWorkspaceInfo | null = null;
  let bestScore = 0;

  for (const folder of folders) {
    const root = folder.uri.fsPath;
    const name = folder.name.toLowerCase();
    const hasHandoff = await pathExists(path.join(root, "AGENT_HANDOFF.md"));
    const hasTechnical = await pathExists(path.join(root, "technical.md"));
    const hasCtrdecomp =
      (await pathExists(path.join(root, "ctrdecomp.toml"))) ||
      (await pathExists(path.join(root, "ctrdecomp")));
    const hasFunctionsToml = await pathExists(path.join(root, "functions.toml"));
    const hasHandmatch = await pathExists(
      path.join(root, "tools", "handmatch")
    );

    let score = 0;
    if (/nlpp|decomp|matching/.test(name)) {
      score += 3;
    }
    if (hasHandoff) {
      score += 3;
    }
    if (hasTechnical) {
      score += 2;
    }
    if (hasCtrdecomp) {
      score += 3;
    }
    if (hasFunctionsToml) {
      score += 2;
    }
    if (hasHandmatch) {
      score += 1;
    }

    // Need a real decomp signal, not just a random README.
    if (score < 5 || !(hasCtrdecomp || (hasHandoff && hasFunctionsToml))) {
      continue;
    }

    let handoffRoleHint: DecompWorkspaceInfo["handoffRoleHint"] = "unknown";
    if (hasHandoff) {
      try {
        const text = await fs.readFile(
          path.join(root, "AGENT_HANDOFF.md"),
          "utf8"
        );
        if (/AGENT A:\s*RESUME|Agent A:\s*exceptions/i.test(text)) {
          handoffRoleHint = "A";
        }
        if (/AGENT B:\s*RESUME|Agent B:\s*hand-matching/i.test(text)) {
          // Prefer B if both markers (B is usually the active resume).
          if (/AGENT B:\s*RESUME HERE/i.test(text)) {
            handoffRoleHint = "B";
          } else if (handoffRoleHint === "unknown") {
            handoffRoleHint = "B";
          }
        }
      } catch {
        // ignore
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = {
        root: folder,
        rootName: folder.name,
        hasHandoff,
        hasTechnical,
        hasCtrdecomp,
        hasFunctionsToml,
        hasHandmatch,
        handoffRoleHint,
      };
    }
  }

  cachedInfo = { at: now, info: best, primed: true };
  return best;
}

export function isHugeDecompDoc(relativePath: string): boolean {
  return HUGE_DOC_BASENAMES.has(basenameOf(relativePath));
}

export function isAppendOnlyToml(relativePath: string): boolean {
  const n = normRel(relativePath);
  return APPEND_ONLY_BASENAMES.has(basenameOf(n)) || APPEND_ONLY_PATH_RE.test(n);
}

/** Per-file attach budget for decomp workspaces (smaller for giant policy docs). */
export function decompAttachLimit(relativePath: string): number {
  const base = attachMaxChars();
  if (isHugeDecompDoc(relativePath)) {
    return Math.min(base, 2800);
  }
  return Math.min(base, 6000);
}

export function decompTotalAttachBudget(): number {
  return totalBudgetChars();
}

/**
 * Compress a huge decomp doc into a pointer + head + key headings.
 * Prefer read_file windows over dumping technical.md into the prompt.
 */
export function compressDecompDocument(
  relativePath: string,
  body: string,
  maxChars?: number
): { text: string; compressed: boolean } {
  const limit = maxChars ?? decompAttachLimit(relativePath);
  const trimmed = body.trim();
  if (trimmed.length <= limit) {
    return { text: trimmed, compressed: false };
  }

  const lines = body.split(/\r?\n/);
  const headings = lines
    .map((l, i) => ({ l, i: i + 1 }))
    .filter(({ l }) => /^#{1,3}\s+\S/.test(l))
    .slice(0, 40)
    .map(({ l, i }) => `L${i}: ${l.trim()}`);

  const headBudget = Math.max(800, Math.floor(limit * 0.55));
  const head = lines.slice(0, 80).join("\n").slice(0, headBudget);
  const toc = headings.slice(0, 25).join("\n");
  const note =
    `[DECOMP DOC COMPRESSED — ${normRel(relativePath)} was ${body.length} chars]\n` +
    `Do NOT ask the user to paste the full file. Use read_file with startLine/endLine ` +
    `around the heading you need (prefer § cited in AGENT_HANDOFF / seeds).\n` +
    `Headings (partial):\n${toc || "(none)"}\n\n--- head ---\n`;

  let out = note + head;
  if (out.length > limit) {
    out = out.slice(0, limit) + "\n…";
  }
  return { text: out, compressed: true };
}

function nonEmptyLines(text: string): number {
  return text.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
}

/** True if new toml looks like a wholesale rewrite (lost most prior rows). */
function tomlLooksRewritten(oldContent: string, newContent: string): boolean {
  const oldLines = nonEmptyLines(oldContent);
  const newLines = nonEmptyLines(newContent);
  if (oldLines < 20) {
    return false;
  }
  if (newLines < Math.max(8, Math.floor(oldLines * 0.5))) {
    return true;
  }
  // Many old offset keys missing
  const oldKeys = new Set(
    [...oldContent.matchAll(/^\s*(?:offset|addr|va)\s*=\s*["']?(0x[0-9a-fA-F]+|\d+)/gim)].map(
      (m) => m[1].toLowerCase()
    )
  );
  if (oldKeys.size < 8) {
    // Also try bare hex keys common in these tomls
    for (const m of oldContent.matchAll(/^\s*\[?(0x[0-9a-fA-F]{5,})\]?/gm)) {
      oldKeys.add(m[1].toLowerCase());
    }
  }
  if (oldKeys.size >= 8) {
    let kept = 0;
    for (const k of oldKeys) {
      if (newContent.toLowerCase().includes(k)) {
        kept++;
      }
    }
    if (kept < Math.floor(oldKeys.size * 0.6)) {
      return true;
    }
  }
  return false;
}

/**
 * Edit guards for decomp trees: append-only TOML, no full rewrite of large matched sources.
 */
export function validateDecompEdit(opts: {
  relativePath: string;
  newContent: string;
  oldContent: string;
  info?: DecompWorkspaceInfo | null;
}): { allowed: boolean; reason?: string } {
  if (!decompEnabled()) {
    return { allowed: true };
  }
  // Only enforce when caller confirmed a decomp workspace.
  if (!opts.info) {
    return { allowed: true };
  }

  const rel = normRel(opts.relativePath);
  const old = opts.oldContent ?? "";
  const neu = opts.newContent ?? "";

  if (isAppendOnlyToml(rel) && old.trim()) {
    if (tomlLooksRewritten(old, neu)) {
      return {
        allowed: false,
        reason:
          `Decomp guard: ${rel} is append-only. Do not rewrite the whole file ` +
          `(${nonEmptyLines(old)} → ${nonEmptyLines(neu)} rows). ` +
          `Use search_replace to append/edit a single function row; keep other agents' entries.`,
      };
    }
    // Full-file write of a large toml is almost always wrong.
    if (nonEmptyLines(old) >= 40 && neu === old) {
      return { allowed: true };
    }
    if (
      nonEmptyLines(old) >= 40 &&
      Math.abs(neu.length - old.length) > Math.max(2000, old.length * 0.15) &&
      neu.length < old.length
    ) {
      return {
        allowed: false,
        reason:
          `Decomp guard: refused shrinking ${rel}. Append new rows with search_replace; ` +
          `never replace the whole TOML.`,
      };
    }
  }

  // Block full-file gutting of hand / gen sources (matching work is search_replace sized).
  if (DECOMP_SRC_RE.test(rel) && old.trim()) {
    const oldL = nonEmptyLines(old);
    const newL = nonEmptyLines(neu);
    if (oldL >= 80 && newL < Math.max(20, Math.floor(oldL * 0.4))) {
      return {
        allowed: false,
        reason:
          `Decomp guard: refused full rewrite of ${rel} (${oldL} → ${newL} lines). ` +
          `Matching edits must be search_replace sized; keep other functions intact.`,
      };
    }
  }

  // Never let EngPatcher cave scripts land in the decomp tree by accident.
  if (
    /patch_input_|deploy_name_kanji|build_romaji_blob|HIRA_ROMAJI/i.test(neu) &&
    !/patch_input_|deploy_name_kanji/i.test(old) &&
    !/EngPatcher|patcher/i.test(rel)
  ) {
    return {
      allowed: false,
      reason:
        `Decomp guard: EngPatcher / localization symbols do not belong in ${rel}. ` +
        `Match vanilla code.bin only; keep English patch work in the EngPatcher sibling repo.`,
    };
  }

  return { allowed: true };
}

/** Detect a running `ctrdecomp relink` (or python -m ctrdecomp relink). */
export async function isCtrdecompRelinkRunning(
  info?: DecompWorkspaceInfo | null
): Promise<{ running: boolean; detail?: string }> {
  if (!blockDuringRelink()) {
    return { running: false };
  }
  const rootHint = info?.root.uri.fsPath?.replace(/\\/g, "/").toLowerCase() ?? "";

  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | " +
            "Where-Object { $_.Name -match 'python|py' -and $_.CommandLine -match 'ctrdecomp|relink' } | " +
            "Select-Object -First 5 ProcessId, CommandLine | " +
            "ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }",
        ],
        { timeout: 4000, windowsHide: true, maxBuffer: 256_000 }
      );
      const lines = (stdout || "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const hit = lines.find((l) => {
        const low = l.toLowerCase();
        if (!/relink/.test(low)) {
          return false;
        }
        if (rootHint && low.includes(rootHint)) {
          return true;
        }
        // Any ctrdecomp relink is enough to pause edits in a decomp workspace.
        return /ctrdecomp/.test(low) && /relink/.test(low);
      });
      if (hit) {
        return { running: true, detail: hit.slice(0, 200) };
      }
    } catch {
      // fall through
    }
  } else {
    try {
      const { stdout } = await execFileAsync(
        "sh",
        ["-c", "ps -ax -o pid=,command= 2>/dev/null | grep -i '[c]trdecomp' | grep -i relink | head -5"],
        { timeout: 3000, maxBuffer: 128_000 }
      );
      const line = (stdout || "").trim().split(/\r?\n/).filter(Boolean)[0];
      if (line) {
        return { running: true, detail: line.slice(0, 200) };
      }
    } catch {
      // ignore
    }
  }
  return { running: false };
}

export async function validateDecompEditGate(opts: {
  relativePath: string;
  newContent: string;
  oldContent: string;
}): Promise<{ allowed: boolean; reason?: string }> {
  if (!decompEnabled()) {
    return { allowed: true };
  }
  const info = await detectDecompWorkspace();
  if (!info) {
    return { allowed: true };
  }

  const staticGuard = validateDecompEdit({ ...opts, info });
  if (!staticGuard.allowed) {
    return staticGuard;
  }

  const relink = await isCtrdecompRelinkRunning(info);
  if (relink.running) {
    return {
      allowed: false,
      reason:
        `Decomp guard: ctrdecomp relink is running` +
        (relink.detail ? ` (${relink.detail})` : "") +
        `. Do not edit sources until relink finishes (check with Get-CimInstance / await_background_command).`,
    };
  }

  return { allowed: true };
}

/** Memory query biased toward decomp-matching + negative lessons. */
export function decompMemoryQuery(userText: string): string {
  const base = (userText || "").trim().slice(0, 400);
  return [
    "decomp-matching",
    "nlpp-decomp",
    "relink vs score 0",
    "negative lesson handoff_drafts",
    "VA math 0x100000",
    "ARMCC exceptions clean pad",
    base,
  ]
    .filter(Boolean)
    .join(" | ");
}

/**
 * Build the [NLPP DECOMP] policy + match-loop + ownership pack for prompt injection.
 */
export async function buildDecompPolicyBlock(
  userText: string
): Promise<{ block: string; attachedLabel: string } | null> {
  if (!decompEnabled()) {
    return null;
  }
  const info = await detectDecompWorkspace();
  if (!info) {
    return null;
  }

  const root = info.root.uri.fsPath;
  const role =
    info.handoffRoleHint === "A"
      ? "Agent A (exceptions / tooling / src/gen)"
      : info.handoffRoleHint === "B"
        ? "Agent B (hand-match / src/hand_* / tidy / names)"
        : "ask user if unclear (Agent A = exceptions/tooling; Agent B = hand-match)";

  const siblingHint = await findEngPatcherSibling(info);

  const lines: string[] = [
    "[NLPP DECOMP — matching decompilation policy]",
    `Workspace: ${info.rootName}`,
    "Match vanilla ExeFS code.bin byte-for-byte with pinned ARMCC. Plausible Ghidra C ≠ done.",
    "Ghidra image base 0; runtime VA = file offset + 0x100000.",
    "Whole-image proof: `python -m ctrdecomp relink` identical (errors: []). Score 0 on diff is necessary but not sufficient.",
    "Do NOT patch img.bin, ship CIA, or start a Windows port. Localization / English caves stay in EngPatcher — not this tree.",
    siblingHint
      ? `EngPatcher sibling (read notes only): ${siblingHint}`
      : "EngPatcher is a sibling checkout (NewLovePlusPlusEngPatcher) — do not invent patch caves here.",
    "",
    "Match loop (default — run tools, do not narrate):",
    "1) `python tools/handmatch/ready.py --int` (or handmatch README) → pick candidate",
    "2) Draft / search_replace in owning src file (Agent A vs B ownership)",
    "3) `python tools/handmatch/diff.py` (or compare) → chase score 0",
    "4) `python -m ctrdecomp relink` → identical before asking user to commit",
    "Long jobs: run_command background=true + await_background_command. Never edit sources while relink runs.",
    "",
    "Ownership:",
    `- Active role hint: ${role}`,
    "- If role is unknown or the user did not say A vs B: call ask_user (Agent A / Agent B) before editing owned files.",
    "- Agent A owns: ctrdecomp/*.py, tools/wrapgen/*, src/gen/*, symbols/code.bin.csv, boundaries — scratch build/a/",
    "- Agent B owns: src/hand_*, family hand files, tools/handmatch/, handoff_drafts/, names_proposed.csv — scratch build/b/ and build/hm/",
    "- functions.toml / externs.toml are APPEND-ONLY. Stage only your rows. Never git add -A; never rewrite the whole TOML.",
    "",
    "Context budget:",
    "- technical.md / AGENT_HANDOFF.md are huge — host compresses attaches. Use read_file windows; do not dump whole files into fences.",
    "- Prefer search_coding_memory for decomp-matching / negative lessons (handoff_drafts score tables) before retrying a dead shape.",
  ];

  // Optional: surface a couple recent negative drafts if present.
  try {
    const draftsDir = path.join(root, "handoff_drafts");
    const ents = await fs.readdir(draftsDir, { withFileTypes: true });
    const names = ents
      .filter((e) => e.isFile() || e.isDirectory())
      .map((e) => e.name)
      .slice(0, 8);
    if (names.length) {
      lines.push(
        "",
        `Negative / draft lessons on disk (peek before retrying): handoff_drafts/ → ${names.join(", ")}`
      );
    }
  } catch {
    // optional
  }

  try {
    const negDir = path.join(root, "docs", "rag_seeds", "10_negative");
    const neg = await fs.readdir(negDir);
    if (neg.length) {
      lines.push(
        `RAG negative seeds: docs/rag_seeds/10_negative/ (${neg.length} files) — retrieve via coding memory / re-seed Chroma after edits.`
      );
    }
  } catch {
    // optional
  }

  if (/\b(agent\s*[ab]|role|ownership|relink|handmatch|match)\b/i.test(userText)) {
    lines.push(
      "",
      "User mentioned match/agent/relink — re-read AGENT_HANDOFF.md resume section with read_file before editing."
    );
  }

  return {
    block: lines.join("\n"),
    attachedLabel: "nlpp decomp policy",
  };
}

async function findEngPatcherSibling(
  info: DecompWorkspaceInfo
): Promise<string | undefined> {
  const parent = path.dirname(info.root.uri.fsPath);
  const candidates = [
    "NewLovePlusPlusEngPatcher",
    "New Love Plus Decompilation",
    "NLPP-EngPatcher",
  ];
  for (const c of candidates) {
    const abs = path.join(parent, c);
    if (await pathExists(abs)) {
      return `../${c}`;
    }
  }
  // Also check other workspace folders
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    if (f === info.root) {
      continue;
    }
    if (/patcher|engpatch|localization/i.test(f.name)) {
      return f.name;
    }
  }
  return undefined;
}

/** Extra catalog rules when the active workspace is a decomp tree. */
export function decompCatalogRules(): string[] {
  return [
    "- DECOMP workspace: follow [NLPP DECOMP] — ready.py → draft → diff score → relink identical.",
    "- functions.toml/externs.toml append-only via search_replace; never full-file rewrite.",
    "- Do not edit while `python -m ctrdecomp relink` is running.",
    "- Vanilla match only; EngPatcher localization stays out of this tree.",
    "- Prefer search_coding_memory for decomp-matching / negative handoff lessons before retrying failed shapes.",
  ];
}

export async function workspaceIsDecomp(): Promise<boolean> {
  return Boolean(await detectDecompWorkspace());
}

/** Sync read of last detectDecompWorkspace() result (after editorContext primed it). */
export function isDecompWorkspaceCached(): boolean {
  return Boolean(cachedInfo.primed && cachedInfo.info);
}

/** Expose marker list for tests / docs. */
export const DECOMP_MARKER_FILES = MARKER_FILES;

/** Config mirror for callers that already use getConfig(). */
export function decompSettingsFromConfig(): {
  enabled: boolean;
  attachMaxChars: number;
  totalAttachBudget: number;
  blockDuringRelink: boolean;
} {
  const cfg = getConfig();
  return {
    enabled: cfg.decomp?.enabled ?? true,
    attachMaxChars: cfg.decomp?.attachMaxChars ?? 3500,
    totalAttachBudget: cfg.decomp?.totalAttachBudget ?? 14_000,
    blockDuringRelink: cfg.decomp?.blockDuringRelink ?? true,
  };
}
