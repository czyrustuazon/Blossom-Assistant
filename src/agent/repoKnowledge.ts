import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

export interface RepoFileEntry {
  path: string;
  basenames: string[];
}

export interface RepoKnowledge {
  version: 1;
  workspaceId: string;
  updatedAt: string;
  rootNames: string[];
  /** Compact overview injected into prompts. */
  summary: string;
  /** Flat relative paths for fuzzy search. */
  files: RepoFileEntry[];
  /** Learned corrections: wrong token → relative path. */
  aliases: Record<string, string>;
  /** Short durable notes about the repo. */
  notes: Array<{ at: string; text: string }>;
}

const IGNORE =
  /(?:^|\/)(?:node_modules|\.git|\.svn|\.hg|\.cursor|\.vscode|dist|out|build|coverage|\.next|target|__pycache__|\.venv|venv)(?:\/|$)/i;

const CODE_EXT =
  /\.(?:html?|css|js|jsx|ts|tsx|mjs|cjs|json|md|py|go|rs|java|kt|cs|php|rb|vue|svelte|sql|yml|yaml|toml|xml|svg|sh|ps1)$/i;

let memoryCache: RepoKnowledge | null = null;

function storagePath(context: vscode.ExtensionContext): string {
  return path.join(context.storageUri?.fsPath ?? context.globalStorageUri.fsPath, "repo-knowledge.json");
}

function workspaceId(): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.map((f) => f.uri.fsPath).sort().join("|") || "no-workspace";
}

export async function loadRepoKnowledge(
  context: vscode.ExtensionContext
): Promise<RepoKnowledge | null> {
  const id = workspaceId();
  if (memoryCache && memoryCache.workspaceId === id) {
    return memoryCache;
  }
  try {
    if (context.storageUri) {
      await fs.mkdir(context.storageUri.fsPath, { recursive: true });
    } else {
      await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });
    }
    const raw = await fs.readFile(storagePath(context), "utf8");
    const data = JSON.parse(raw) as RepoKnowledge;
    if (data.workspaceId !== id) {
      return null;
    }
    memoryCache = data;
    return data;
  } catch {
    return null;
  }
}

async function saveRepoKnowledge(
  context: vscode.ExtensionContext,
  data: RepoKnowledge
): Promise<void> {
  if (context.storageUri) {
    await fs.mkdir(context.storageUri.fsPath, { recursive: true });
  } else {
    await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });
  }
  memoryCache = data;
  await fs.writeFile(storagePath(context), JSON.stringify(data, null, 2), "utf8");
}

export function clearRepoKnowledgeCache(): void {
  memoryCache = null;
}

/** Rebuild file index + summary and persist. */
export async function rebuildRepoKnowledge(
  context: vscode.ExtensionContext
): Promise<RepoKnowledge> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    throw new Error("No workspace folder open.");
  }

  const files: RepoFileEntry[] = [];
  const treeLines: string[] = [];
  const manifests: string[] = [];

  for (const folder of folders) {
    const prefix = folders.length > 1 ? `${folder.name}/` : "";
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, "**/*"),
      "**/{node_modules,.git,dist,out,build,coverage,.next,target,venv,.venv}/**",
      2500
    );

    const rels = uris
      .map((u) => vscode.workspace.asRelativePath(u, false).replace(/\\/g, "/"))
      .filter((p) => !IGNORE.test(p) && CODE_EXT.test(p))
      .sort();

    for (const rel of rels) {
      const base = path.posix.basename(rel);
      files.push({
        path: rel,
        basenames: [base, base.replace(/\.[^.]+$/, "")].filter(Boolean),
      });
    }

    treeLines.push(`Root: ${folder.name} (${folder.uri.fsPath})`);
    treeLines.push(...buildShallowTree(rels, prefix, 40));

    for (const manifest of [
      "package.json",
      "tsconfig.json",
      "go.mod",
      "Cargo.toml",
      "pyproject.toml",
      "README.md",
      "readme.md",
    ]) {
      try {
        const uri = vscode.Uri.joinPath(folder.uri, manifest);
        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText().slice(0, 3500);
        manifests.push(`--- ${prefix}${manifest} ---\n${text}`);
      } catch {
        // missing
      }
    }
  }

  const entryPoints = files
    .map((f) => f.path)
    .filter((p) =>
      /(?:^|\/)(?:index|main|app|server|program)\.[^/]+$/i.test(p) ||
      /(?:^|\/)src\/(?:index|main|app)\.[^/]+$/i.test(p)
    )
    .slice(0, 20);

  const byExt: Record<string, number> = {};
  for (const f of files) {
    const ext = path.extname(f.path).toLowerCase() || "(none)";
    byExt[ext] = (byExt[ext] ?? 0) + 1;
  }

  const prev = await loadRepoKnowledge(context);
  const summary = [
    `Workspace knowledge (updated ${new Date().toISOString()})`,
    `Roots: ${folders.map((f) => f.name).join(", ")}`,
    `Indexed files: ${files.length}`,
    `Extensions: ${Object.entries(byExt)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([e, n]) => `${e}:${n}`)
      .join(", ")}`,
    entryPoints.length
      ? `Likely entry points:\n${entryPoints.map((p) => `- ${p}`).join("\n")}`
      : "",
    "Structure (sample):",
    ...treeLines.slice(0, 50),
    manifests.length ? "\nKey manifests / README (excerpts):" : "",
    ...manifests.slice(0, 4),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 8000);

  const knowledge: RepoKnowledge = {
    version: 1,
    workspaceId: workspaceId(),
    updatedAt: new Date().toISOString(),
    rootNames: folders.map((f) => f.name),
    summary,
    files,
    aliases: prev?.workspaceId === workspaceId() ? { ...prev.aliases } : {},
    notes: prev?.workspaceId === workspaceId() ? [...(prev.notes ?? [])] : [],
  };

  await saveRepoKnowledge(context, knowledge);
  return knowledge;
}

function buildShallowTree(rels: string[], _prefix: string, maxLines: number): string[] {
  const lines: string[] = [];
  const seenDirs = new Set<string>();
  for (const rel of rels) {
    if (lines.length >= maxLines) {
      lines.push("…");
      break;
    }
    const parts = rel.split("/");
    for (let i = 0; i < Math.min(parts.length - 1, 3); i++) {
      const dir = parts.slice(0, i + 1).join("/");
      if (!seenDirs.has(dir)) {
        seenDirs.add(dir);
        lines.push(`${"  ".repeat(i)}📁 ${parts[i]}/`);
        if (lines.length >= maxLines) {
          break;
        }
      }
    }
    if (parts.length <= 3) {
      lines.push(`${"  ".repeat(Math.max(0, parts.length - 1))}📄 ${parts[parts.length - 1]}`);
    }
  }
  return lines;
}

/** Ensure knowledge exists; rebuild if missing or older than maxAgeMs. */
export async function ensureRepoKnowledge(
  context: vscode.ExtensionContext,
  maxAgeMs = 24 * 60 * 60 * 1000
): Promise<RepoKnowledge> {
  const existing = await loadRepoKnowledge(context);
  if (existing) {
    await scrubBadAliases(context);
  }
  const fresh = await loadRepoKnowledge(context);
  if (fresh && maxAgeMs > 0) {
    const age = Date.now() - new Date(fresh.updatedAt).getTime();
    if (age < maxAgeMs && fresh.files.length > 0) {
      return fresh;
    }
  }
  if (fresh && maxAgeMs === 0 && fresh.files.length > 0) {
    // maxAgeMs 0 means "return cached if present, else rebuild"
    return fresh;
  }
  return rebuildRepoKnowledge(context);
}

export async function rememberAlias(
  context: vscode.ExtensionContext,
  wrong: string,
  correctPath: string
): Promise<void> {
  if (!aliasLooksPlausible(wrong, correctPath)) {
    return;
  }
  const knowledge = (await loadRepoKnowledge(context)) ?? (await rebuildRepoKnowledge(context));
  const key = wrong.replace(/\\/g, "/").toLowerCase();
  knowledge.aliases[key] = correctPath.replace(/\\/g, "/");
  knowledge.updatedAt = new Date().toISOString();
  await saveRepoKnowledge(context, knowledge);
}

/** Drop nonsense learned aliases (e.g. about.html → something.py). */
export async function scrubBadAliases(
  context: vscode.ExtensionContext
): Promise<number> {
  const knowledge = await loadRepoKnowledge(context);
  if (!knowledge) {
    return 0;
  }
  let removed = 0;
  for (const [key, target] of Object.entries(knowledge.aliases)) {
    if (!aliasLooksPlausible(key, target)) {
      delete knowledge.aliases[key];
      removed += 1;
    }
  }
  if (removed > 0) {
    knowledge.updatedAt = new Date().toISOString();
    await saveRepoKnowledge(context, knowledge);
  }
  return removed;
}

export async function rememberNote(
  context: vscode.ExtensionContext,
  text: string
): Promise<void> {
  const knowledge = (await loadRepoKnowledge(context)) ?? (await rebuildRepoKnowledge(context));
  knowledge.notes.push({ at: new Date().toISOString(), text: text.slice(0, 500) });
  if (knowledge.notes.length > 40) {
    knowledge.notes = knowledge.notes.slice(-40);
  }
  knowledge.updatedAt = new Date().toISOString();
  await saveRepoKnowledge(context, knowledge);
}

export interface FuzzyHit {
  path: string;
  score: number;
  reason: string;
}

/** Find best file matches when the user mistypes a name. */
export function fuzzyFindFiles(
  knowledge: RepoKnowledge,
  query: string,
  limit = 5
): FuzzyHit[] {
  const q = query.replace(/\\/g, "/").toLowerCase().trim();
  if (!q || q.length < 2) {
    return [];
  }

  const qBase = path.posix.basename(q);
  const qStem = qBase.replace(/\.[^.]+$/, "");
  const qExt = extOf(qBase);

  if (knowledge.aliases[q]) {
    const aliased = knowledge.aliases[q];
    // Ignore learned aliases that violate extension / name sanity
    if (aliasLooksPlausible(q, aliased)) {
      return [
        {
          path: aliased,
          score: 1000,
          reason: "learned alias",
        },
      ];
    }
  }

  const hits: FuzzyHit[] = [];
  for (const file of knowledge.files) {
    const rel = file.path.toLowerCase();
    const base = path.posix.basename(rel);
    const stem = base.replace(/\.[^.]+$/, "");
    const fileExt = extOf(base);

    // Never cross file kinds (about.html must not match oft.py)
    if (qExt && fileExt && qExt !== fileExt) {
      continue;
    }

    let score = 0;
    let reason = "";

    if (rel === q || base === q) {
      score = 900;
      reason = "exact";
    } else if (base.startsWith(qBase) || rel.endsWith("/" + qBase)) {
      score = 700;
      reason = "prefix";
    } else if (stem === qStem && stem.length >= 3) {
      score = 650;
      reason = "stem";
    } else if (qStem.length >= 4 && (base.includes(qStem) || rel.includes(qStem))) {
      score = 520 + Math.max(0, 40 - Math.abs(stem.length - qStem.length));
      reason = "substring";
    } else if (qStem.length >= 4) {
      const d = levenshtein(stem, qStem);
      const maxLen = Math.max(stem.length, qStem.length, 1);
      if (d <= 2 && d / maxLen <= 0.34) {
        score = 480 - d * 40;
        reason = `fuzzy(d=${d})`;
      }
    }

    if (score > 0) {
      hits.push({ path: file.path, score, reason });
    }
  }

  hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  // unique paths
  const seen = new Set<string>();
  const out: FuzzyHit[] = [];
  for (const h of hits) {
    if (seen.has(h.path)) {
      continue;
    }
    seen.add(h.path);
    out.push(h);
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

function extOf(name: string): string {
  const m = name.toLowerCase().match(/(\.[a-z0-9]+)$/);
  return m ? m[1] : "";
}

function aliasLooksPlausible(query: string, targetPath: string): boolean {
  const q = path.posix.basename(query.replace(/\\/g, "/").toLowerCase());
  const t = path.posix.basename(targetPath.replace(/\\/g, "/").toLowerCase());
  const qExt = extOf(q);
  const tExt = extOf(t);
  if (qExt && tExt && qExt !== tExt) {
    return false;
  }
  const qStem = q.replace(/\.[^.]+$/, "");
  const tStem = t.replace(/\.[^.]+$/, "");
  if (qStem.length >= 3 && tStem.length >= 3) {
    const d = levenshtein(qStem, tStem);
    if (d > 2 && !tStem.includes(qStem) && !qStem.includes(tStem)) {
      return false;
    }
  }
  return true;
}

function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (!a.length) {
    return b.length;
  }
  if (!b.length) {
    return a.length;
  }
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const cur =
        a[i - 1] === b[j - 1]
          ? row[j - 1]
          : 1 + Math.min(row[j - 1], row[j], prev);
      row[j - 1] = prev;
      prev = cur;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}

export function formatKnowledgeForPrompt(
  knowledge: RepoKnowledge,
  maxChars = 3500
): string {
  const notes =
    knowledge.notes.length > 0
      ? `\nLearned notes:\n${knowledge.notes
          .slice(-8)
          .map((n) => `- ${n.text}`)
          .join("\n")}`
      : "";
  const aliases =
    Object.keys(knowledge.aliases).length > 0
      ? `\nKnown file aliases:\n${Object.entries(knowledge.aliases)
          .slice(0, 15)
          .map(([k, v]) => `- "${k}" → ${v}`)
          .join("\n")}`
      : "";
  return `${knowledge.summary.slice(0, maxChars - notes.length - aliases.length)}${notes}${aliases}`.slice(
    0,
    maxChars
  );
}
