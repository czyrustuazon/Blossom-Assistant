import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { diffFileContents } from "./lineDiff";

export interface PatchScriptMeta {
  match: string;
  role: string;
  entrypoints: string[];
  caveLabels: string[];
  forbiddenSymbols: string[];
}

/** Optional curated hints when a known basename is present (NLPP, etc.). */
export const PATCH_SCRIPT_REGISTRY: PatchScriptMeta[] = [
  {
    match: "patch_input_bplace_list.py",
    role:
      "Birthplace candidate list: BL hook → enter cave, fill_rows, select_hook vtable patch.",
    entrypoints: ["build_blob", "apply_patch", "main"],
    caveLabels: ["enter", "fill_rows", "select_hook"],
    forbiddenSymbols: [
      "build_romaji_blob",
      "patch_input_romaji",
      "HIRA_ROMAJI",
      "ADDR_DRAW_CELL",
      "FUN_001fc304",
    ],
  },
  {
    match: "patch_input_romaji.py",
    role: "Gojūon grid display-only romaji — not B_Place row select.",
    entrypoints: ["build_romaji_blob", "patch_input_romaji", "patch_code_bin_romaji"],
    caveLabels: [],
    forbiddenSymbols: [
      "build_blob(",
      "select_hook",
      "fill_rows",
      "VT_BP_TOUCH",
      "ADDR_BP_SELECT",
    ],
  },
  {
    match: "deploy_name_kanji_trb.py",
    role: "LayeredFS TRB rebuild — not code.bin ARM caves.",
    entrypoints: ["main"],
    caveLabels: [],
    forbiddenSymbols: ["build_blob", "build_romaji_blob", "u32("],
  },
];

export interface PatchFileIndex {
  relPath: string;
  basename: string;
  entrypoints: string[];
  caveLabels: string[];
  docLine: string;
  patchScore: number;
  registry?: PatchScriptMeta;
}

export interface WorkspacePatchIndex {
  files: PatchFileIndex[];
  /** Symbol → owning relPath when uniquely defined in one patch file. */
  symbolOwners: Map<string, string>;
  scannedAt: number;
}

const RE_TASK_RE =
  /\b(code\.bin|ghidra|patch_|deploy_|inject_|hook cave|arm thumb|binary patch|exefs\/code|\.asm\b|build_blob|vtable|0x[0-9a-f]{6,})\b/i;

const PATCH_FILENAME_RE =
  /^(patch_|deploy_|inject_|hook_|apply_|mod_).*\.(py|sh|c|cpp|asm|inc)$/i;

const PATCH_DIR_HINTS = [
  "src",
  "tools",
  "scripts",
  "script",
  "patches",
  "patch",
  "lib",
  "hack",
  "mods",
  "tools/patch",
];

const SCAN_MAX_DEPTH = 4;
const SCAN_MAX_FILES = 120;
const INDEX_TTL_MS = 90_000;

let cachedIndex: WorkspacePatchIndex | null = null;
let indexPromise: Promise<WorkspacePatchIndex> | null = null;

function normRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function registryForBasename(basename: string): PatchScriptMeta | undefined {
  return PATCH_SCRIPT_REGISTRY.find((m) => m.match === basename);
}

function metaForPath(relativePath: string): PatchScriptMeta | undefined {
  const base = normRel(relativePath).split("/").pop() ?? relativePath;
  return registryForBasename(base);
}

function extractDefs(text: string): string[] {
  const defs = new Set<string>();
  for (const m of text.matchAll(/^def (\w+)\s*\(/gm)) {
    defs.add(m[1]);
  }
  for (const m of text.matchAll(/^async def (\w+)\s*\(/gm)) {
    defs.add(m[1]);
  }
  return [...defs];
}

function extractCaveLabels(text: string): string[] {
  const labels = new Set<string>();
  for (const m of text.matchAll(/L\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    labels.add(m[1]);
  }
  for (const m of text.matchAll(/label\s*=\s*["']([^"']+)["']/gi)) {
    labels.add(m[1]);
  }
  return [...labels];
}

function firstDocLine(text: string): string {
  const m = text.match(/^(?:\s*#[^\n]*\n)*\s*"""([^"]{8,200})/s) ||
    text.match(/^(?:\s*#[^\n]*\n)*\s*'''([^']{8,200})/s);
  if (m) {
    return m[1].replace(/\s+/g, " ").trim();
  }
  const hash = text.match(/^\s*#\s*(.{12,160})/m);
  return hash ? hash[1].trim() : "";
}

function scorePatchContent(text: string, basename: string): number {
  let s = 0;
  if (PATCH_FILENAME_RE.test(basename)) {
    s += 4;
  } else if (/\bpatch\b/i.test(basename)) {
    s += 2;
  }
  if (/\bu32\s*\(/i.test(text)) {
    s += 2;
  }
  if (/\b(build_blob|build_\w+_blob|assemble|cave|thumb|\.word\b)\b/i.test(text)) {
    s += 1;
  }
  if (/--dry-run\b/.test(text)) {
    s += 2;
  }
  if (/\b0x[0-9a-f]{6,8}\b/i.test(text)) {
    s += 1;
  }
  if (/\bcode\.bin\b/i.test(text)) {
    s += 2;
  }
  if (/\b(ghidra|ida|radare)\b/i.test(text)) {
    s += 1;
  }
  if (/\bapply_patch\b/.test(text)) {
    s += 1;
  }
  return s;
}

async function walkForPatchFiles(
  absDir: string,
  relPrefix: string,
  depth: number,
  out: PatchFileIndex[],
  budget: { left: number }
): Promise<void> {
  if (depth > SCAN_MAX_DEPTH || budget.left <= 0) {
    return;
  }
  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (budget.left <= 0) {
      break;
    }
    if (ent.name.startsWith(".") || ent.name === "node_modules" || ent.name === "__pycache__") {
      continue;
    }
    const abs = path.join(absDir, ent.name);
    const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      await walkForPatchFiles(abs, rel, depth + 1, out, budget);
      continue;
    }
    if (!/\.(py|sh|c|cpp|asm|inc)$/i.test(ent.name)) {
      continue;
    }
    budget.left--;
    let text = "";
    try {
      text = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    const score = scorePatchContent(text, ent.name);
    const registry = registryForBasename(ent.name);
    if (score < 3 && !registry) {
      continue;
    }
    const entrypoints = extractDefs(text);
    const caveLabels = [
      ...new Set([...extractCaveLabels(text), ...(registry?.caveLabels ?? [])]),
    ];
    out.push({
      relPath: normRel(rel),
      basename: ent.name,
      entrypoints: entrypoints.length > 0 ? entrypoints : registry?.entrypoints ?? [],
      caveLabels,
      docLine: firstDocLine(text) || registry?.role || "",
      patchScore: score + (registry ? 2 : 0),
      registry,
    });
  }
}

function buildSymbolOwners(files: PatchFileIndex[]): Map<string, string> {
  const counts = new Map<string, string[]>();
  for (const f of files) {
    for (const sym of f.entrypoints) {
      const list = counts.get(sym) ?? [];
      list.push(f.relPath);
      counts.set(sym, list);
    }
  }
  const owners = new Map<string, string>();
  for (const [sym, paths] of counts) {
    if (paths.length === 1) {
      owners.set(sym, paths[0]);
    }
  }
  return owners;
}

async function scanWorkspacePatchScripts(): Promise<WorkspacePatchIndex> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const files: PatchFileIndex[] = [];
  const budget = { left: SCAN_MAX_FILES };

  for (const folder of folders) {
    for (const sub of PATCH_DIR_HINTS) {
      await walkForPatchFiles(
        path.join(folder.uri.fsPath, sub),
        sub,
        0,
        files,
        budget
      );
    }
    // Root-level patch_*.py
    try {
      const rootEntries = await fs.readdir(folder.uri.fsPath, { withFileTypes: true });
      for (const ent of rootEntries) {
        if (!ent.isFile() || !PATCH_FILENAME_RE.test(ent.name)) {
          continue;
        }
        const abs = path.join(folder.uri.fsPath, ent.name);
        const text = await fs.readFile(abs, "utf8");
        const registry = registryForBasename(ent.name);
        files.push({
          relPath: ent.name,
          basename: ent.name,
          entrypoints: extractDefs(text).length
            ? extractDefs(text)
            : registry?.entrypoints ?? [],
          caveLabels: [
            ...new Set([...extractCaveLabels(text), ...(registry?.caveLabels ?? [])]),
          ],
          docLine: firstDocLine(text) || registry?.role || "",
          patchScore: scorePatchContent(text, ent.name) + (registry ? 2 : 0),
          registry,
        });
      }
    } catch {
      // ignore
    }
  }

  const dedup = new Map<string, PatchFileIndex>();
  for (const f of files) {
    const prev = dedup.get(f.relPath);
    if (!prev || f.patchScore > prev.patchScore) {
      dedup.set(f.relPath, f);
    }
  }
  const unique = [...dedup.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));

  return {
    files: unique,
    symbolOwners: buildSymbolOwners(unique),
    scannedAt: Date.now(),
  };
}

/** Refresh workspace patch index (cached ~90s). */
export async function warmPatchIndex(force = false): Promise<WorkspacePatchIndex> {
  if (
    !force &&
    cachedIndex &&
    Date.now() - cachedIndex.scannedAt < INDEX_TTL_MS
  ) {
    return cachedIndex;
  }
  if (!force && indexPromise) {
    return indexPromise;
  }
  indexPromise = scanWorkspacePatchScripts()
    .then((idx) => {
      cachedIndex = idx;
      indexPromise = null;
      return idx;
    })
    .catch((err) => {
      indexPromise = null;
      throw err;
    });
  return indexPromise;
}

export function getPatchIndexSync(): WorkspacePatchIndex | null {
  return cachedIndex;
}

export function invalidatePatchIndex(): void {
  cachedIndex = null;
  indexPromise = null;
}

export function userTextWantsPatchContext(userText: string): boolean {
  return RE_TASK_RE.test(userText || "");
}

export function isPatchLikePath(relativePath: string, index?: WorkspacePatchIndex | null): boolean {
  const norm = normRel(relativePath);
  const base = norm.split("/").pop() ?? norm;
  if (PATCH_FILENAME_RE.test(base)) {
    return true;
  }
  if (metaForPath(norm)) {
    return true;
  }
  const idx = index ?? cachedIndex;
  if (idx?.files.some((f) => f.relPath === norm || f.basename === base)) {
    return true;
  }
  return false;
}

export async function workspaceHasPatchScripts(): Promise<boolean> {
  const idx = await warmPatchIndex();
  return idx.files.length > 0;
}

function genericPatchHintLines(): string[] {
  return [
    "[PATCH SCRIPT MAP — auto-discovered; host enforced]",
    "This workspace has patch/deploy/inject scripts. Each file owns its symbols — do NOT merge logic across files.",
    "",
    "Multi-pass workflow (preferred — extra tool rounds are OK):",
    "1. read_file the target section",
    "2. search_replace ONE labeled block / function / cave per pass",
    "3. run_command dry-run or smoke test",
    "4. repeat for the next section — do NOT rewrite the whole file in one Apply",
    "",
    "Hard rules:",
    "- search_replace only on existing patch scripts (≥60 lines). write_file / path fences create new files only.",
    "- Do not paste symbols defined in sibling patch files (see Owned symbols below).",
    "- Preserve shared helpers (encoding helpers, bl/jmp wrappers, blob builders) unless read_file shows exact bytes.",
    "- Use read_ghidra (decompile/disassemble) for VA truth before ARM edits when Ghidra bridge is connected.",
    "- After edits: python <path> --dry-run (host blocks Apply until dry-run passes).",
    "",
  ];
}

/** Inject when patch scripts exist in workspace or the ask mentions RE/patch work. */
export async function buildPatchScriptMapBlock(userText: string): Promise<string> {
  const index = await warmPatchIndex();
  const hasScripts = index.files.length > 0;
  if (!hasScripts && !userTextWantsPatchContext(userText)) {
    return "";
  }

  const lines = genericPatchHintLines();

  if (hasScripts) {
    lines.push(`Discovered ${index.files.length} patch-like file(s):`, "");
    for (const f of index.files) {
      lines.push(`• ${f.relPath}`);
      if (f.registry?.role) {
        lines.push(`  Role: ${f.registry.role}`);
      } else if (f.docLine) {
        lines.push(`  Summary: ${f.docLine.slice(0, 160)}`);
      }
      if (f.entrypoints.length > 0) {
        lines.push(`  Defs: ${f.entrypoints.slice(0, 12).join(", ")}${f.entrypoints.length > 12 ? "…" : ""}`);
      }
      if (f.caveLabels.length > 0) {
        lines.push(`  Cave labels (do not remove): ${f.caveLabels.join(", ")}`);
      }
      const ownedHere = [...index.symbolOwners.entries()]
        .filter(([, owner]) => owner === f.relPath)
        .map(([sym]) => sym)
        .slice(0, 10);
      if (ownedHere.length > 0) {
        lines.push(`  Owned symbols (keep in this file): ${ownedHere.join(", ")}`);
      }
      if (f.registry?.forbiddenSymbols.length) {
        lines.push(`  Never use here: ${f.registry.forbiddenSymbols.join(", ")}`);
      }
      lines.push("");
    }

    // Cross-file confusion summary
    const multiOwner = new Map<string, string[]>();
    for (const f of index.files) {
      for (const sym of f.entrypoints) {
        const paths = multiOwner.get(sym) ?? [];
        paths.push(f.relPath);
        multiOwner.set(sym, paths);
      }
    }
    const ambiguous = [...multiOwner.entries()].filter(([, ps]) => ps.length > 1);
    if (ambiguous.length > 0) {
      lines.push(
        "Ambiguous symbols (appear in multiple patch files — edit only the file that owns the behavior):"
      );
      for (const [sym, ps] of ambiguous.slice(0, 8)) {
        lines.push(`  ${sym}: ${ps.join(", ")}`);
      }
      lines.push("");
    }
  } else {
    lines.push(
      "(No patch scripts scanned yet — task mentions binary/RE work.)",
      "Treat each patch_*.py / deploy_*.py as a separate surface. Use search_replace in multiple passes.",
      ""
    );
  }

  return lines.join("\n");
}

function mentionsSymbol(text: string, sym: string): boolean {
  if (sym.endsWith("(")) {
    return text.includes(sym);
  }
  return new RegExp(`\\b${sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);
}

function mentionsCaveLabel(text: string, label: string): boolean {
  return (
    text.includes(`"${label}"`) ||
    text.includes(`'${label}'`) ||
    text.includes(`L("${label}")`) ||
    text.includes(`L('${label}')`)
  );
}

function nonEmptyLines(text: string): number {
  return text.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
}

function changeTooLargeForOnePass(old: string, neu: string, oldLines: number): boolean {
  const d = diffFileContents(old, neu);
  const churn = d.additions + d.deletions;
  return churn > Math.max(28, Math.floor(oldLines * 0.38));
}

function ownerPathForSymbol(
  sym: string,
  index: WorkspacePatchIndex | null,
  meta?: PatchScriptMeta
): string | undefined {
  const bare = sym.replace(/\($/, "");
  const fromIndex = index?.symbolOwners.get(bare);
  if (fromIndex) {
    return fromIndex;
  }
  const owner = PATCH_SCRIPT_REGISTRY.find((m) =>
    m.entrypoints.some((e) => {
      const eb = e.replace(/\($/, "");
      return e === sym || eb === bare || sym.startsWith(eb);
    })
  );
  return owner?.match;
}

/** Block cross-file symbols, gutted caves, and oversized one-pass rewrites on patch scripts. */
export function validatePatchScriptEdit(opts: {
  relativePath: string;
  newContent: string;
  oldContent: string;
}): { allowed: boolean; reason?: string } {
  const norm = normRel(opts.relativePath);
  const index = getPatchIndexSync();
  const meta = metaForPath(norm);
  const fileIndex = index?.files.find((f) => f.relPath === norm || f.basename === path.basename(norm));

  if (!isPatchLikePath(norm, index) && !meta && !fileIndex) {
    return { allowed: true };
  }

  const neu = opts.newContent ?? "";
  const old = opts.oldContent ?? "";
  const oldLines = nonEmptyLines(old);

  // Registry forbidden symbols (curated projects)
  if (meta) {
    for (const sym of meta.forbiddenSymbols) {
      if (mentionsSymbol(neu, sym) && !mentionsSymbol(old, sym)) {
        const hint = ownerPathForSymbol(sym, index, meta) ?? "another patch script";
        return {
          allowed: false,
          reason:
            `Patch script guard: ${norm} must not reference \`${sym}\` (belongs in ${hint}). ` +
            `Use search_replace in the owning file; multi-pass edits are OK.`,
        };
      }
    }
  }

  // Auto-discovered cross-file symbol paste
  if (index) {
    for (const [sym, ownerPath] of index.symbolOwners) {
      if (ownerPath === norm) {
        continue;
      }
      if (mentionsSymbol(neu, sym) && !mentionsSymbol(old, sym)) {
        return {
          allowed: false,
          reason:
            `Patch script guard: \`${sym}\` is owned by ${ownerPath}, not ${norm}. ` +
            `Edit ${ownerPath} in a separate pass with search_replace.`,
        };
      }
    }

    for (const f of index.files) {
      if (f.relPath === norm) {
        continue;
      }
      const mod = f.basename.replace(/\.(py|sh|c|cpp)$/i, "");
      const importRe = new RegExp(`\\b(from|import)\\s+${mod.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      if (importRe.test(neu) && !importRe.test(old)) {
        return {
          allowed: false,
          reason:
            `Patch script guard: do not import ${mod} into ${norm}. ` +
            `Keep patch surfaces separate; edit ${f.relPath} directly.`,
        };
      }
    }
  }

  const caveLabels = [
    ...new Set([
      ...(meta?.caveLabels ?? []),
      ...(fileIndex?.caveLabels ?? []),
    ]),
  ];
  for (const label of caveLabels) {
    if (mentionsCaveLabel(old, label) && !mentionsCaveLabel(neu, label)) {
      return {
        allowed: false,
        reason:
          `Patch script guard: refused removing cave label \`${label}\` from ${norm}. ` +
          `search_replace inside that block only — next pass can edit another section.`,
      };
    }
  }

  const armHelpers = [
    "def ldrh_imm",
    "def bl(",
    "def push(",
    "def u32(",
    "def build_blob",
    "def assemble",
  ];
  const oldHas = armHelpers.filter((h) => old.includes(h)).length;
  const newHas = armHelpers.filter((h) => neu.includes(h)).length;
  if (oldHas >= 2 && newHas < Math.max(1, oldHas - 2) && oldLines > 60) {
    return {
      allowed: false,
      reason:
        `Patch script guard: refused gutting encoding/helper defs in ${norm}. ` +
        `Multi-pass search_replace on one cave section; preserve shared helpers.`,
    };
  }

  if (oldLines >= 60 && old.trim() && changeTooLargeForOnePass(old, neu, oldLines)) {
    return {
      allowed: false,
      reason:
        `Patch script guard: change too large for one Apply on ${norm} ` +
        `(~${oldLines} lines). Split into multiple search_replace passes — read_file one section, edit, dry-run, repeat.`,
    };
  }

  return { allowed: true };
}
