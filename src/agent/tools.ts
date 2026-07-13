import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { getConfig } from "../config";
import type { OllamaTool } from "../ollama/client";

export interface ToolResult {
  ok: boolean;
  content: string;
  /** When set, UI should show an edit preview card before applying. */
  pendingEdit?: PendingEdit;
}

export interface PendingEdit {
  id: string;
  relativePath: string;
  absolutePath: string;
  newContent: string;
  oldContent: string;
  /** write = create/update file; delete = remove file from disk */
  kind?: "write" | "delete";
}

export interface RelatedFolder {
  /** Short name used in tools (workspace folder name or sibling basename). */
  name: string;
  absolutePath: string;
  /** workspace = multi-root folder (writable); sibling = disk neighbor (read-only). */
  kind: "workspace" | "sibling";
  /** Which workspace root this sibling sits next to (for siblings only). */
  nearRoot?: string;
}

const pendingEdits = new Map<string, PendingEdit>();

export function getPendingEdit(id: string): PendingEdit | undefined {
  return pendingEdits.get(id);
}

export function clearPendingEdit(id: string): void {
  pendingEdits.delete(id);
}

export const AGENT_TOOLS: OllamaTool[] = [
  {
    type: "function",
    function: {
      name: "list_workspace_roots",
      description:
        "List all folders in the VS Code multi-root workspace (name + absolute path). Use these names as path prefixes.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description:
        "List files and folders. Path is relative to a workspace root. In multi-root workspaces use 'RootName/subdir' or pass root.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path. '.' or a root name lists that root.",
          },
          root: {
            type: "string",
            description: "Optional workspace folder name when path has no prefix.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a text file from any workspace root. Use 'RootName/path' in multi-root workspaces.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          root: {
            type: "string",
            description: "Optional workspace folder name when path has no prefix.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_text",
      description:
        "Search for a text pattern across all workspace roots (or one root if specified).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          glob: {
            type: "string",
            description: "Optional glob like **/*.{ts,js}",
          },
          root: {
            type: "string",
            description: "Optional workspace folder name to limit search.",
          },
          maxResults: { type: "number" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Propose writing/updating a file inside a workspace root (not disk siblings). User must approve before apply. Use 'RootName/path' in multi-root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          content: { type: "string", description: "Full new file contents." },
          root: {
            type: "string",
            description: "Optional workspace folder name when path has no prefix.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description:
        "Propose deleting a file inside a workspace root. User must approve (or auto-apply) before the file is removed. Use for unused/orphan files listed in [UNUSED FILES].",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path to delete." },
          root: {
            type: "string",
            description: "Optional workspace folder name when path has no prefix.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_related",
      description:
        "List related folders: other multi-root workspace folders plus disk sibling folders next to each workspace root (dependency peek).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_siblings",
      description:
        "Alias of list_related — list related workspace roots and parent-directory siblings.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "peek_related",
      description:
        "Read-only peek into a related folder (another workspace root or a disk sibling). Prefer this for dependencies outside the active project.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Related folder name from list_related (workspace or sibling).",
          },
          path: {
            type: "string",
            description: "Path relative to that folder ('.' to list).",
          },
        },
        required: ["name", "path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "peek_sibling",
      description: "Alias of peek_related — read-only peek into a related folder.",
      parameters: {
        type: "object",
        properties: {
          sibling: {
            type: "string",
            description: "Related folder name (same as peek_related name).",
          },
          path: {
            type: "string",
            description: "Path relative to that folder.",
          },
        },
        required: ["sibling", "path"],
      },
    },
  },
];

function workspaceFolders(): readonly vscode.WorkspaceFolder[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    throw new Error("No workspace folder open.");
  }
  return folders;
}

function primaryRoot(): vscode.WorkspaceFolder {
  return workspaceFolders()[0];
}

function findWorkspaceFolder(name: string): vscode.WorkspaceFolder | undefined {
  const lower = name.toLowerCase();
  return workspaceFolders().find(
    (f) => f.name.toLowerCase() === lower || path.basename(f.uri.fsPath).toLowerCase() === lower
  );
}

/**
 * Resolve a path that may be:
 * - "file.ts" (primary root)
 * - "RootName/file.ts" (multi-root)
 * - with explicit root arg
 * Returns absolute path + display relative path + whether writable (inside a workspace root).
 */
function resolveInWorkspace(
  rel: string,
  rootHint?: string
): { absolutePath: string; displayPath: string; folder: vscode.WorkspaceFolder } {
  const cleaned = (rel || ".").replace(/\\/g, "/").replace(/^\.\//, "");
  const folders = workspaceFolders();

  if (rootHint) {
    const folder = findWorkspaceFolder(rootHint);
    if (!folder) {
      throw new Error(
        `Unknown workspace root "${rootHint}". Use list_workspace_roots.`
      );
    }
    const abs = path.resolve(
      folder.uri.fsPath,
      cleaned === "." || cleaned === folder.name ? "." : cleaned
    );
    assertInside(folder.uri.fsPath, abs);
    const display =
      folders.length > 1
        ? path.posix.join(folder.name, cleaned === "." ? "" : cleaned).replace(/\/$/, "") ||
          folder.name
        : cleaned === "."
          ? "."
          : cleaned;
    return { absolutePath: abs, displayPath: display, folder };
  }

  // Multi-root: first segment may be a workspace folder name
  if (folders.length > 1 && cleaned !== ".") {
    const parts = cleaned.split("/");
    const maybeRoot = parts[0];
    const folder = findWorkspaceFolder(maybeRoot);
    if (folder) {
      const rest = parts.slice(1).join("/") || ".";
      const abs = path.resolve(folder.uri.fsPath, rest === "." ? "." : rest);
      assertInside(folder.uri.fsPath, abs);
      return {
        absolutePath: abs,
        displayPath: cleaned,
        folder,
      };
    }
  }

  const folder = primaryRoot();
  const abs = path.resolve(folder.uri.fsPath, cleaned === "." ? "." : cleaned);
  assertInside(folder.uri.fsPath, abs);
  const display =
    folders.length > 1
      ? path.posix.join(folder.name, cleaned === "." ? "" : cleaned).replace(/\/$/, "") ||
        folder.name
      : cleaned;
  return { absolutePath: abs, displayPath: display, folder };
}

function assertInside(root: string, abs: string): void {
  const normalizedRoot = path.resolve(root);
  const normalizedAbs = path.resolve(abs);
  if (
    normalizedAbs !== normalizedRoot &&
    !normalizedAbs.startsWith(normalizedRoot + path.sep)
  ) {
    throw new Error(`Path escapes workspace root: ${abs}`);
  }
}

function parseArgs(raw: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return raw ?? {};
}

export async function runTool(
  name: string,
  rawArgs: Record<string, unknown> | string
): Promise<ToolResult> {
  const args = parseArgs(rawArgs);
  try {
    switch (name) {
      case "list_workspace_roots":
        return listWorkspaceRoots();
      case "list_dir":
        return await listDir(
          String(args.path ?? "."),
          args.root ? String(args.root) : undefined
        );
      case "read_file":
        return await readFile(
          String(args.path ?? ""),
          args.root ? String(args.root) : undefined
        );
      case "search_text":
        return await searchText(
          String(args.query ?? ""),
          args.glob ? String(args.glob) : undefined,
          typeof args.maxResults === "number" ? args.maxResults : 40,
          args.root ? String(args.root) : undefined
        );
      case "write_file":
        return await proposeWrite(
          String(args.path ?? ""),
          String(args.content ?? ""),
          args.root ? String(args.root) : undefined
        );
      case "delete_file":
        return await proposeFileDelete(
          String(args.path ?? ""),
          args.root ? String(args.root) : undefined
        );
      case "list_related":
      case "list_siblings":
        return await listRelated();
      case "peek_related":
        return await peekRelated(String(args.name ?? ""), String(args.path ?? "."));
      case "peek_sibling":
        return await peekRelated(
          String(args.sibling ?? args.name ?? ""),
          String(args.path ?? ".")
        );
      default:
        return { ok: false, content: `Unknown tool: ${name}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, content: msg };
  }
}

function listWorkspaceRoots(): ToolResult {
  const folders = workspaceFolders();
  const lines = folders.map(
    (f, i) =>
      `${i === 0 ? "primary" : "root"}\t${f.name}\t${f.uri.fsPath}`
  );
  return {
    ok: true,
    content: [
      `Workspace roots (${folders.length}):`,
      ...lines,
      folders.length > 1
        ? "Paths: use RootName/relative/path for tools."
        : "Single-root workspace — relative paths are from this folder.",
    ].join("\n"),
  };
}

async function listDir(rel: string, rootHint?: string): Promise<ToolResult> {
  const { absolutePath, displayPath } = resolveInWorkspace(rel || ".", rootHint);
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  const lines = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => `${e.isDirectory() ? "dir" : "file"}\t${e.name}`);
  return {
    ok: true,
    content: [`[${displayPath}]`, ...(lines.length ? lines : ["(empty)"])].join("\n"),
  };
}

async function readFile(rel: string, rootHint?: string): Promise<ToolResult> {
  if (!rel) {
    return { ok: false, content: "path is required" };
  }
  const { absolutePath, displayPath } = resolveInWorkspace(rel, rootHint);
  const buf = await fs.readFile(absolutePath);
  const max = 200_000;
  const text = buf.slice(0, max).toString("utf8");
  const truncated = buf.length > max ? `\n\n… truncated (${buf.length} bytes total)` : "";
  return { ok: true, content: `// ${displayPath}\n${text}${truncated}` };
}

async function searchText(
  query: string,
  glob: string | undefined,
  maxResults: number,
  rootHint?: string
): Promise<ToolResult> {
  if (!query) {
    return { ok: false, content: "query is required" };
  }

  const folders = rootHint
    ? (() => {
        const f = findWorkspaceFolder(rootHint);
        if (!f) {
          throw new Error(`Unknown workspace root "${rootHint}".`);
        }
        return [f];
      })()
    : [...workspaceFolders()];

  const hits: string[] = [];
  const lower = query.toLowerCase();
  const include = glob && glob.trim() ? glob : "**/*";

  for (const folder of folders) {
    if (hits.length >= maxResults) {
      break;
    }
    const pattern = new vscode.RelativePattern(folder, include);
    const files = await vscode.workspace.findFiles(
      pattern,
      "**/node_modules/**",
      200
    );
    for (const file of files) {
      if (hits.length >= maxResults) {
        break;
      }
      try {
        const doc = await vscode.workspace.fs.readFile(file);
        const text = Buffer.from(doc).toString("utf8");
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(lower)) {
            const rel = vscode.workspace.asRelativePath(file, false);
            hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            if (hits.length >= maxResults) {
              break;
            }
          }
        }
      } catch {
        // skip binary / unreadable
      }
    }
  }

  return {
    ok: true,
    content: hits.length ? hits.join("\n") : "No matches.",
  };
}

async function proposeWrite(
  rel: string,
  content: string,
  rootHint?: string
): Promise<ToolResult> {
  if (!rel) {
    return { ok: false, content: "path is required" };
  }
  const { absolutePath, displayPath } = resolveInWorkspace(rel, rootHint);
  let oldContent = "";
  try {
    oldContent = await fs.readFile(absolutePath, "utf8");
  } catch {
    oldContent = "";
  }
  const id = `edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pending: PendingEdit = {
    id,
    relativePath: displayPath,
    absolutePath,
    newContent: content,
    oldContent,
    kind: "write",
  };
  pendingEdits.set(id, pending);
  return {
    ok: true,
    content: `Edit proposed for ${pending.relativePath}. Waiting for user approval (id=${id}).`,
    pendingEdit: pending,
  };
}

/** Public wrapper so ChatRouter replies can propose Apply cards without tool calling. */
export async function proposeFileEdit(
  rel: string,
  content: string,
  rootHint?: string
): Promise<ToolResult> {
  return proposeWrite(rel, content, rootHint);
}

/** Propose deleting a workspace-relative file (Apply / Auto-apply will unlink it). */
export async function proposeFileDelete(
  rel: string,
  rootHint?: string
): Promise<ToolResult> {
  let absolutePath: string;
  let displayPath: string;
  try {
    const resolved = resolveInWorkspace(rel, rootHint);
    absolutePath = resolved.absolutePath;
    displayPath = resolved.displayPath;
  } catch (err) {
    return {
      ok: false,
      content: err instanceof Error ? err.message : String(err),
    };
  }
  let oldContent = "";
  try {
    oldContent = await fs.readFile(absolutePath, "utf8");
  } catch {
    return {
      ok: false,
      content: `Cannot delete ${displayPath}: file not found on disk.`,
    };
  }
  const id = `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pending: PendingEdit = {
    id,
    relativePath: displayPath,
    absolutePath,
    newContent: "",
    oldContent,
    kind: "delete",
  };
  pendingEdits.set(id, pending);
  return {
    ok: true,
    content: `Delete proposed for ${displayPath}. Waiting for approval (id=${id}).`,
    pendingEdit: pending,
  };
}

export async function applyPendingEdit(id: string): Promise<string> {
  const pending = pendingEdits.get(id);
  if (!pending) {
    throw new Error(`Unknown edit id: ${id}`);
  }
  // Writes/deletes only allowed inside a workspace root
  const inside = workspaceFolders().some((f) => {
    const root = path.resolve(f.uri.fsPath);
    const abs = path.resolve(pending.absolutePath);
    return abs === root || abs.startsWith(root + path.sep);
  });
  if (!inside) {
    throw new Error("Refusing to modify files outside workspace roots.");
  }

  const uri = vscode.Uri.file(pending.absolutePath);

  if (pending.kind === "delete") {
    try {
      await vscode.workspace.fs.delete(uri, { useTrash: true });
    } catch {
      await fs.unlink(pending.absolutePath);
    }
    pendingEdits.delete(id);
    return pending.relativePath;
  }

  const dir = path.dirname(pending.absolutePath);
  await fs.mkdir(dir, { recursive: true });
  const edit = new vscode.WorkspaceEdit();
  try {
    await vscode.workspace.fs.stat(uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    const full = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(doc.getText().length)
    );
    edit.replace(uri, full, pending.newContent);
  } catch {
    edit.createFile(uri, {
      overwrite: true,
      contents: Buffer.from(pending.newContent, "utf8"),
    });
  }
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    throw new Error("VS Code rejected the edit");
  }

  const autoSave =
    vscode.workspace
      .getConfiguration("blossom")
      .get<boolean>("edits.autoSave", true) ?? true;

  if (autoSave) {
    // Disk truth: always flush bytes so Auto-apply / Apply work without Ctrl+S.
    await fs.writeFile(pending.absolutePath, pending.newContent, "utf8");
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      if (doc.isDirty) {
        await doc.save();
      }
    } catch {
      // file write above is enough
    }
  }

  pendingEdits.delete(id);
  return pending.relativePath;
}

export async function rejectPendingEdit(id: string): Promise<void> {
  pendingEdits.delete(id);
}

/** Gather multi-root folders + disk siblings of each root. */
export async function collectRelatedFolders(): Promise<RelatedFolder[]> {
  const cfg = getConfig().siblingPeek;
  const folders = workspaceFolders();
  const related: RelatedFolder[] = [];
  const seen = new Set<string>();

  const add = (item: RelatedFolder): void => {
    const key = path.resolve(item.absolutePath).toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    related.push(item);
  };

  for (const f of folders) {
    add({
      name: f.name,
      absolutePath: f.uri.fsPath,
      kind: "workspace",
    });
  }

  if (!cfg.enabled) {
    return related;
  }

  for (const f of folders) {
    const rootPath = f.uri.fsPath;
    const parent = path.dirname(rootPath);
    const selfName = path.basename(rootPath);
    try {
      const entries = await fs.readdir(parent, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".")) {
          continue;
        }
        if (e.name === selfName) {
          continue;
        }
        const abs = path.join(parent, e.name);
        // Skip if this sibling is already a workspace root
        const alreadyRoot = folders.some(
          (wf) => path.resolve(wf.uri.fsPath) === path.resolve(abs)
        );
        if (alreadyRoot) {
          continue;
        }
        add({
          name: e.name,
          absolutePath: abs,
          kind: "sibling",
          nearRoot: f.name,
        });
      }
    } catch {
      // unreadable parent
    }
  }

  return related;
}

async function listRelated(): Promise<ToolResult> {
  const related = await collectRelatedFolders();
  const workspace = related.filter((r) => r.kind === "workspace");
  const siblings = related.filter((r) => r.kind === "sibling");

  const lines: string[] = [
    `Related folders (${related.length}):`,
    "",
    "Workspace roots (writable):",
    ...workspace.map((r) => `- ${r.name}\t${r.absolutePath}`),
  ];

  if (siblings.length) {
    lines.push("", "Disk siblings near a root (read-only via peek_related):");
    lines.push(
      ...siblings.map(
        (r) => `- ${r.name}\tnear=${r.nearRoot}\t${r.absolutePath}`
      )
    );
  } else if (!getConfig().siblingPeek.enabled) {
    lines.push("", "(Disk sibling peek disabled in settings.)");
  } else {
    lines.push("", "(No extra disk siblings found.)");
  }

  lines.push(
    "",
    "Use peek_related with name + path for read-only dependency context.",
    "Use RootName/path with read_file/write_file for workspace roots."
  );

  return { ok: true, content: lines.join("\n") };
}

async function peekRelated(name: string, rel: string): Promise<ToolResult> {
  const cfg = getConfig().siblingPeek;
  if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
    return { ok: false, content: "Invalid related folder name." };
  }
  const cleanedRel = (rel || ".").replace(/\\/g, "/");
  if (cleanedRel.includes("..")) {
    return { ok: false, content: "Invalid path (must be relative, no ..)." };
  }

  const related = await collectRelatedFolders();
  const match =
    related.find((r) => r.name.toLowerCase() === name.toLowerCase()) ??
    related.find(
      (r) => path.basename(r.absolutePath).toLowerCase() === name.toLowerCase()
    );

  if (!match) {
    return {
      ok: false,
      content: `Unknown related folder "${name}". Call list_related first.`,
    };
  }

  if (match.kind === "sibling" && !cfg.enabled) {
    return { ok: false, content: "Sibling peek is disabled in settings." };
  }

  const abs = path.resolve(
    match.absolutePath,
    cleanedRel === "." ? "." : cleanedRel
  );
  assertInside(match.absolutePath, abs);

  const stat = await fs.stat(abs);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const limited = entries.slice(0, cfg.maxFiles);
    return {
      ok: true,
      content: [
        `[${match.kind}:${match.name}/${cleanedRel === "." ? "" : cleanedRel}]`,
        ...limited.map((e) => `${e.isDirectory() ? "dir" : "file"}\t${e.name}`),
      ].join("\n"),
    };
  }

  if (stat.size > cfg.maxBytes) {
    return {
      ok: false,
      content: `File too large (${stat.size} bytes; max ${cfg.maxBytes}).`,
    };
  }
  const text = await fs.readFile(abs, "utf8");
  return {
    ok: true,
    content: `// ${match.kind}:${match.name}/${cleanedRel}\n${text.slice(0, cfg.maxBytes)}`,
  };
}

/** Suggest related folder names that look like package / path dependencies. */
export async function suggestRelatedFolders(): Promise<string[]> {
  try {
    const related = await collectRelatedFolders();
    const depNames = new Set<string>();

    for (const folder of workspaceFolders()) {
      await collectDepHints(folder.uri.fsPath, depNames);
    }

    const suggestions = related
      .filter((r) => r.kind === "sibling" || related.filter((x) => x.kind === "workspace").length > 1)
      .filter((r) => {
        if (r.kind === "workspace" && r.name === primaryRoot().name) {
          return false; // skip primary itself in suggestions
        }
        if (depNames.size === 0) {
          return r.kind === "workspace"; // still surface other roots
        }
        return (
          depNames.has(r.name) ||
          [...depNames].some(
            (n) =>
              n === r.name ||
              n.endsWith(`/${r.name}`) ||
              n.includes(r.name) ||
              r.name.includes(n.replace(/^@[^/]+\//, ""))
          )
        );
      })
      .map((r) => `${r.name}(${r.kind})`);

    // Always mention other workspace roots
    for (const r of related) {
      if (r.kind === "workspace" && r.name !== primaryRoot().name) {
        const tag = `${r.name}(workspace)`;
        if (!suggestions.includes(tag)) {
          suggestions.unshift(tag);
        }
      }
    }

    return [...new Set(suggestions)];
  } catch {
    return [];
  }
}

/** @deprecated use suggestRelatedFolders */
export async function suggestDependencySiblings(): Promise<string[]> {
  return suggestRelatedFolders();
}

async function collectDepHints(rootPath: string, into: Set<string>): Promise<void> {
  // package.json
  try {
    const raw = await fs.readFile(path.join(rootPath, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      name?: string;
    };
    for (const n of [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]) {
      into.add(n);
      into.add(n.split("/").pop() ?? n);
    }
  } catch {
    // ignore
  }

  // go.mod require lines
  try {
    const raw = await fs.readFile(path.join(rootPath, "go.mod"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([^\s]+)\s+v/);
      if (m) {
        into.add(m[1]);
        into.add(m[1].split("/").pop() ?? m[1]);
      }
    }
  } catch {
    // ignore
  }

  // tsconfig paths values
  try {
    const raw = await fs.readFile(path.join(rootPath, "tsconfig.json"), "utf8");
    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const ts = JSON.parse(stripped) as {
      compilerOptions?: { paths?: Record<string, string[]> };
    };
    for (const targets of Object.values(ts.compilerOptions?.paths ?? {})) {
      for (const t of targets) {
        const seg = t.replace(/^\.\.\//, "").split("/")[0];
        if (seg && seg !== "*") {
          into.add(seg);
        }
      }
    }
  } catch {
    // ignore
  }
}
