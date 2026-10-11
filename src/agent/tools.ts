import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { getConfig } from "../config";
import type { OllamaTool } from "../ollama/client";
import { validateProposedEdit } from "./editGuard";
import { validatePatchScriptEdit, warmPatchIndex } from "./patchScriptContext";
import { validateDryRunBeforeApply } from "./dryRunGate";
import { readGhidra, type ReadGhidraAction } from "../ghidra/client";
import { callGhidraMcpTool } from "../mcp/ghidraMcpClient";
import {
  AGENT_SCRATCH_PREFIX,
  isAgentScratchPath,
  scratchWriteDeniedMessage,
} from "./scratchPaths";
import {
  formatArchiveForAgent,
  formatArchiveList,
  listChatArchives,
  loadChatArchive,
  searchChatArchives,
} from "./chatArchive";

const RUN_COMMAND_DEFAULT_TIMEOUT_MS = 60_000;
const RUN_COMMAND_MAX_TIMEOUT_MS = 180_000;
const RUN_COMMAND_MAX_OUTPUT_CHARS = 64_000;

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
  /** How this edit was produced — drives PR-style replace preview in chat. */
  source?: "write_file" | "search_replace" | "fence" | "delete";
  /** Exact old→new strings from search_replace (shown as removed/added blocks). */
  replacePreview?: {
    oldString: string;
    newString: string;
    replaceAll?: boolean;
    matchCount?: number;
  };
}

export type ProposeWriteMeta = {
  source?: PendingEdit["source"];
  replacePreview?: PendingEdit["replacePreview"];
};

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

/** Recent search_text hits — used to window read_file around match lines. */
const searchLineHints = new Map<string, number[]>();

const READ_WINDOW_PAD = 15;
const READ_WINDOW_MAX_SPAN = 80;
/** Soft-cap when read_file has no range and no search hint. */
const FULL_READ_SOFT_CAP_LINES = 200;

export type ToolProfile = "minimal" | "research" | "full";

/** Set by the agent loop so research/minimal can gate product writes. */
let activeToolProfile: ToolProfile = "full";

export function setActiveToolProfile(profile: ToolProfile): void {
  activeToolProfile = profile;
}

export function getActiveToolProfile(): ToolProfile {
  return activeToolProfile;
}

/** Catalog names for tiny edits — no shell / sibling / ghidra noise. */
const MINIMAL_TOOL_NAMES = new Set([
  "read_file",
  "search_text",
  "search_replace",
]);

/** Plan / research — inspect + verify; scratch write/delete only (gated in propose*). */
const RESEARCH_TOOL_NAMES = new Set([
  "list_workspace_roots",
  "list_dir",
  "read_file",
  "search_text",
  "run_command",
  "write_file",
  "delete_file",
  "read_ghidra",
  "ghidra_mcp",
  "list_related",
  "peek_related",
  "list_chat_history",
  "read_chat_history",
  "search_chat_history",
]);

/** Aliases kept in runTool for back-compat but omitted from catalogs. */
const CATALOG_ALIAS_NAMES = new Set(["list_siblings", "peek_sibling"]);

function normalizeHintPath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

function rememberSearchHit(relPath: string, line: number): void {
  const key = normalizeHintPath(relPath);
  const prev = searchLineHints.get(key) ?? [];
  if (!prev.includes(line)) {
    prev.push(line);
    prev.sort((a, b) => a - b);
  }
  searchLineHints.set(key, prev);
}

/** Cluster nearby search hits into one read window (first dense cluster). */
function clusterSearchLines(lines: number[]): { start: number; end: number } {
  const sorted = [...lines].sort((a, b) => a - b);
  let lo = sorted[0];
  let hi = sorted[0];
  for (const ln of sorted) {
    if (ln - lo <= READ_WINDOW_MAX_SPAN) {
      hi = ln;
    } else {
      break;
    }
  }
  return {
    start: Math.max(1, lo - READ_WINDOW_PAD),
    end: hi + READ_WINDOW_PAD,
  };
}

function resolveReadLineWindow(
  displayPath: string,
  startLine?: number,
  endLine?: number
): { start?: number; end?: number; fromSearch: boolean } {
  if (startLine != null || endLine != null) {
    return {
      start: startLine != null ? Math.max(1, Math.floor(startLine)) : undefined,
      end: endLine != null ? Math.max(1, Math.floor(endLine)) : undefined,
      fromSearch: false,
    };
  }
  const key = normalizeHintPath(displayPath);
  let lines = searchLineHints.get(key);
  if (!lines?.length) {
    const base = key.split("/").pop() ?? key;
    for (const [k, v] of searchLineHints) {
      if (k === base || k.endsWith(`/${base}`)) {
        lines = v;
        break;
      }
    }
  }
  if (!lines?.length) {
    return { fromSearch: false };
  }
  const cluster = clusterSearchLines(lines);
  return {
    start: cluster.start,
    end: cluster.end,
    fromSearch: true,
  };
}

export function clearSearchLineHints(): void {
  searchLineHints.clear();
}

/** Map prompt tier + settings override → tool catalog profile. */
export function resolveToolProfile(
  tier: "full" | "plan" | "tiny",
  override: "auto" | ToolProfile = "auto"
): ToolProfile {
  if (override !== "auto") {
    return override;
  }
  if (tier === "tiny") {
    return "minimal";
  }
  if (tier === "plan") {
    return "research";
  }
  return "full";
}

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
      name: "list_chat_history",
      description:
        "List saved Blossom chat archives in this workspace (.blossom/chats). Use when the user asks about a past conversation or wants you to recall an earlier chat.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Max chats to list (default 30).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_chat_history",
      description:
        "Read one saved Blossom chat by id (from list_chat_history). Optional query filters messages containing that text.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Chat archive id (e.g. chat-2026-…).",
          },
          query: {
            type: "string",
            description: "Optional substring filter on message content.",
          },
          maxChars: {
            type: "number",
            description: "Max characters to return (default 12000).",
          },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_chat_history",
      description:
        "Search across saved Blossom chats for a keyword/phrase. Prefer this when the user refers to something discussed in an earlier session.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to find in past chats." },
          maxChats: {
            type: "number",
            description: "Max matching chats to return (default 8).",
          },
        },
        required: ["query"],
      },
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
          startLine: {
            type: "number",
            description: "Optional 1-based start line (defaults to search hit window).",
          },
          endLine: {
            type: "number",
            description: "Optional 1-based end line (defaults to search hit window).",
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
      name: "search_replace",
      description:
        "Preferred for EDITING existing files: replace one exact old_string with new_string. old_string must match the file exactly (including whitespace). Use replace_all only when intentional. Safer and smaller than write_file for changes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          old_string: {
            type: "string",
            description: "Exact text to find (must be unique unless replace_all).",
          },
          new_string: { type: "string", description: "Replacement text." },
          replace_all: {
            type: "boolean",
            description: "Replace every occurrence (default false).",
          },
          root: {
            type: "string",
            description: "Optional workspace folder name when path has no prefix.",
          },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        `Create/replace a file. Product edits need Apply. Probe helpers: write under ${AGENT_SCRATCH_PREFIX}*.py (auto-applied, no Apply card), then run_command. For existing product files prefer search_replace.`,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: `Workspace-relative path. Scratch probes: ${AGENT_SCRATCH_PREFIX}<name>.py`,
          },
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
        `Propose deleting a workspace file (Apply). Scratch probes under ${AGENT_SCRATCH_PREFIX} delete immediately. Use for unused/orphan files listed in [UNUSED FILES].`,
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
  {
    type: "function",
    function: {
      name: "ghidra_mcp",
      description:
        "Call the local Ghidra MCP bridge (stdio). Workflow: tool=list_instances, then connect_instance, " +
        "then decompile_function / search_functions / get_xrefs_to / list_strings / etc. " +
        "Full tool surface without Cursor escalate. Prefer over read_ghidra for xrefs, strings, and multi-step RE.",
      parameters: {
        type: "object",
        properties: {
          tool: {
            type: "string",
            description: "Exact MCP tool name (see [GHIDRA MCP] block in prompt).",
          },
          arguments: {
            type: "object",
            description: "JSON arguments for that MCP tool.",
          },
        },
        required: ["tool"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_ghidra",
      description:
        "Read reverse-engineering context from a connected Ghidra HTTP/MCP bridge (any project). " +
        "Use before proposing ARM bytes, patch caves, or hook addresses. Auto-discovers bridge on localhost " +
        "(ports 8089, 8192, …) or blossom.ghidra.baseUrl. Omit action+address for status.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description:
              "status | list_programs | program_info | decompile | disassemble | function_info | search_functions. Default: decompile if address set, else status.",
          },
          address: {
            type: "string",
            description: "Function address (0x001fc304). Required for decompile/disassemble/function_info.",
          },
          program: {
            type: "string",
            description:
              "Ghidra program name when multiple binaries are open (e.g. code.bin). Omit to use active program or workspace guess.",
          },
          name_pattern: {
            type: "string",
            description: "Substring for search_functions.",
          },
          limit: {
            type: "number",
            description: "Max results for search_functions (default 40).",
          },
          timeout: {
            type: "number",
            description: "Decompile timeout seconds (default 60).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command inside a workspace root (full shell: python, tests, git status, etc.). " +
        "Use during RESEARCH to reproduce bugs, run tests, or probe with short Python. " +
        "cwd must stay inside a workspace root (not disk siblings). " +
        "On Windows prefer `py -3` or `python` for Python. Output is truncated; long jobs time out.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to run (e.g. `py -3 scripts/probe.py` or `npm test`).",
          },
          cwd: {
            type: "string",
            description:
              "Working directory relative to a workspace root (default '.'). Multi-root: RootName/subdir.",
          },
          root: {
            type: "string",
            description: "Optional workspace folder name when cwd has no RootName prefix.",
          },
          timeout_ms: {
            type: "number",
            description: "Optional timeout in ms (default 60000, max 180000).",
          },
        },
        required: ["command"],
      },
    },
  },
];

/** Tools shown in the prompt / Ollama native tool list for a profile. */
export function toolsForProfile(profile: ToolProfile): OllamaTool[] {
  return AGENT_TOOLS.filter((t) => {
    const name = t.function.name;
    if (CATALOG_ALIAS_NAMES.has(name)) {
      return false;
    }
    if (profile === "minimal") {
      return MINIMAL_TOOL_NAMES.has(name);
    }
    if (profile === "research") {
      return RESEARCH_TOOL_NAMES.has(name);
    }
    return true;
  });
}

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
      case "list_chat_history": {
        const entries = await listChatArchives();
        const limit =
          typeof args.limit === "number" && args.limit > 0
            ? Math.min(args.limit, 80)
            : 30;
        return {
          ok: true,
          content: formatArchiveList(entries, limit),
        };
      }
      case "read_chat_history": {
        const id = String(args.id ?? "").trim();
        if (!id) {
          return { ok: false, content: "read_chat_history requires id." };
        }
        const arch = await loadChatArchive(id);
        if (!arch) {
          return {
            ok: false,
            content: `No saved chat with id "${id}". Use list_chat_history.`,
          };
        }
        return {
          ok: true,
          content: formatArchiveForAgent(arch, {
            query: args.query != null ? String(args.query) : undefined,
            maxChars:
              typeof args.maxChars === "number" ? args.maxChars : undefined,
          }),
        };
      }
      case "search_chat_history": {
        const query = String(args.query ?? "");
        return {
          ok: true,
          content: await searchChatArchives(query, {
            maxChats:
              typeof args.maxChats === "number" ? args.maxChats : undefined,
          }),
        };
      }
      case "list_dir":
        return await listDir(
          String(args.path ?? "."),
          args.root ? String(args.root) : undefined
        );
      case "read_file":
        return await readFile(
          String(args.path ?? ""),
          args.root ? String(args.root) : undefined,
          typeof args.startLine === "number" ? args.startLine : undefined,
          typeof args.endLine === "number" ? args.endLine : undefined
        );
      case "search_text":
        return await searchText(
          String(args.query ?? ""),
          args.glob ? String(args.glob) : undefined,
          typeof args.maxResults === "number" ? args.maxResults : 40,
          args.root ? String(args.root) : undefined
        );
      case "search_replace":
        return await searchReplaceInFile(
          String(args.path ?? ""),
          String(args.old_string ?? ""),
          String(args.new_string ?? ""),
          args.root ? String(args.root) : undefined,
          Boolean(args.replace_all)
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
      case "run_command":
        return await runCommand(
          String(args.command ?? ""),
          args.cwd != null ? String(args.cwd) : ".",
          args.root ? String(args.root) : undefined,
          typeof args.timeout_ms === "number"
            ? args.timeout_ms
            : typeof args.timeoutMs === "number"
              ? args.timeoutMs
              : RUN_COMMAND_DEFAULT_TIMEOUT_MS
        );
      case "ghidra_mcp": {
        let mcpArgs: Record<string, unknown> = {};
        const rawArgs = args.arguments ?? args.args;
        if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
          mcpArgs = rawArgs as Record<string, unknown>;
        } else if (typeof rawArgs === "string") {
          try {
            mcpArgs = JSON.parse(rawArgs) as Record<string, unknown>;
          } catch {
            mcpArgs = {};
          }
        }
        const mcpResult = await callGhidraMcpTool({
          tool: String(args.tool ?? ""),
          arguments: mcpArgs,
        });
        return { ok: mcpResult.ok, content: mcpResult.content };
      }
      case "read_ghidra":
        return await readGhidra({
          action: args.action ? (String(args.action) as ReadGhidraAction) : undefined,
          address: args.address != null ? String(args.address) : undefined,
          program: args.program != null ? String(args.program) : undefined,
          name_pattern:
            args.name_pattern != null
              ? String(args.name_pattern)
              : args.namePattern != null
                ? String(args.namePattern)
                : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          timeout: typeof args.timeout === "number" ? args.timeout : undefined,
        });
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

async function readFile(
  rel: string,
  rootHint?: string,
  startLine?: number,
  endLine?: number
): Promise<ToolResult> {
  if (!rel) {
    return { ok: false, content: "path is required" };
  }
  const { absolutePath, displayPath } = resolveInWorkspace(rel, rootHint);
  const buf = await fs.readFile(absolutePath);
  const max = 200_000;
  let text = buf.slice(0, max).toString("utf8");
  const truncated = buf.length > max ? `\n\n… truncated (${buf.length} bytes total)` : "";

  const window = resolveReadLineWindow(displayPath, startLine, endLine);
  let lineNote = "";
  const allLines = text.split(/\r?\n/);
  if (window.start != null || window.end != null) {
    const start = window.start ?? 1;
    const end = window.end ?? allLines.length;
    const slice = allLines.slice(start - 1, end);
    lineNote = window.fromSearch
      ? ` (lines ${start}-${Math.min(end, allLines.length)} — search window)`
      : ` (lines ${start}-${Math.min(end, allLines.length)})`;
    text = slice.join("\n");
  } else if (allLines.length > FULL_READ_SOFT_CAP_LINES) {
    text = allLines.slice(0, FULL_READ_SOFT_CAP_LINES).join("\n");
    lineNote =
      ` (lines 1-${FULL_READ_SOFT_CAP_LINES} of ${allLines.length}` +
      ` — pass startLine/endLine or search_text first for the rest)`;
  }

  return {
    ok: true,
    content: `// ${displayPath}${lineNote}\n${text}${truncated}`,
  };
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

  type RankedHit = { rel: string; lineNo: number; text: string; score: number };
  const ranked: RankedHit[] = [];
  const lower = query.toLowerCase();
  const include = glob && glob.trim() ? glob : "**/*";
  const scanCap = Math.max(maxResults * 8, 120);

  const activeRel = vscode.window.activeTextEditor?.document.uri
    ? normalizeHintPath(
        vscode.workspace.asRelativePath(
          vscode.window.activeTextEditor.document.uri,
          false
        )
      )
    : "";
  const openRels = new Set(
    vscode.window.visibleTextEditors.map((ed) =>
      normalizeHintPath(
        vscode.workspace.asRelativePath(ed.document.uri, false)
      )
    )
  );

  const pathBoost = (rel: string): number => {
    const norm = normalizeHintPath(rel);
    let boost = 0;
    if (activeRel && norm === activeRel) {
      boost += 1000;
    } else if (openRels.has(norm)) {
      boost += 500;
    }
    const depth = norm.split("/").filter(Boolean).length;
    boost += Math.max(0, 40 - depth * 4);
    if (/\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|php|rb)$/i.test(norm)) {
      boost += 30;
    }
    if (/(^|\/)src\//i.test(norm)) {
      boost += 20;
    }
    if (/(^|\/)(?:test|tests|__tests__)(?:\/|$)/i.test(norm)) {
      boost -= 5;
    }
    const base = norm.split("/").pop() ?? norm;
    if (lower.includes(base.replace(/\.[^.]+$/, "").toLowerCase())) {
      boost += 80;
    }
    return boost;
  };

  for (const folder of folders) {
    if (ranked.length >= scanCap) {
      break;
    }
    const pattern = new vscode.RelativePattern(folder, include);
    const files = await vscode.workspace.findFiles(
      pattern,
      "**/node_modules/**",
      200
    );
    for (const file of files) {
      if (ranked.length >= scanCap) {
        break;
      }
      try {
        const doc = await vscode.workspace.fs.readFile(file);
        const text = Buffer.from(doc).toString("utf8");
        const lines = text.split(/\r?\n/);
        const rel = vscode.workspace.asRelativePath(file, false);
        const boost = pathBoost(rel);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(lower)) {
            const lineNo = i + 1;
            ranked.push({
              rel,
              lineNo,
              text: lines[i].trim().slice(0, 200),
              score: boost * 10000 - lineNo,
            });
            if (ranked.length >= scanCap) {
              break;
            }
          }
        }
      } catch {
        // skip binary / unreadable
      }
    }
  }

  ranked.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
  const hits = ranked.slice(0, maxResults);
  for (const h of hits) {
    rememberSearchHit(h.rel, h.lineNo);
  }

  return {
    ok: true,
    content: hits.length
      ? hits.map((h) => `${h.rel}:${h.lineNo}: ${h.text}`).join("\n")
      : "No matches.",
  };
}

function contentGuardEnabled(): boolean {
  return (
    vscode.workspace
      .getConfiguration("blossom")
      .get<boolean>("edits.contentGuard", true) ?? true
  );
}

async function writeScratchFile(
  absolutePath: string,
  displayPath: string,
  content: string
): Promise<ToolResult> {
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
  const bytes = Buffer.byteLength(content, "utf8");
  const runHint = displayPath.replace(/\\/g, "/");
  return {
    ok: true,
    content:
      `Wrote scratch helper ${displayPath} (${bytes} bytes). ` +
      `Already on disk (no Apply). Run with: py -3 ${runHint} ` +
      `(or python ${runHint}). Optional cleanup: delete_file on the same path.`,
  };
}

async function deleteScratchFile(
  absolutePath: string,
  displayPath: string
): Promise<ToolResult> {
  try {
    await fs.unlink(absolutePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return {
        ok: true,
        content: `Scratch helper ${displayPath} already absent.`,
      };
    }
    return {
      ok: false,
      content: err instanceof Error ? err.message : String(err),
    };
  }
  return {
    ok: true,
    content: `Deleted scratch helper ${displayPath}.`,
  };
}

async function proposeWrite(
  rel: string,
  content: string,
  rootHint?: string,
  meta?: ProposeWriteMeta
): Promise<ToolResult> {
  if (!rel) {
    return { ok: false, content: "path is required" };
  }
  const { absolutePath, displayPath } = resolveInWorkspace(rel, rootHint);

  if (isAgentScratchPath(displayPath) || isAgentScratchPath(rel)) {
    return writeScratchFile(absolutePath, displayPath, content);
  }

  if (activeToolProfile === "research" || activeToolProfile === "minimal") {
    return { ok: false, content: scratchWriteDeniedMessage(displayPath) };
  }

  let oldContent = "";
  try {
    oldContent = await fs.readFile(absolutePath, "utf8");
  } catch {
    oldContent = "";
  }

  if (contentGuardEnabled()) {
    await warmPatchIndex();
    const guard = validateProposedEdit({
      relativePath: displayPath,
      newContent: content,
      oldContent,
    });
    if (!guard.allowed) {
      return { ok: false, content: guard.reason ?? "Edit blocked by content guard." };
    }
    const patchGuard = validatePatchScriptEdit({
      relativePath: displayPath,
      newContent: content,
      oldContent,
    });
    if (!patchGuard.allowed) {
      return { ok: false, content: patchGuard.reason ?? "Edit blocked by patch script guard." };
    }
  }

  const dryRun = validateDryRunBeforeApply(displayPath);

  const id = `edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pending: PendingEdit = {
    id,
    relativePath: displayPath,
    absolutePath,
    newContent: content,
    oldContent,
    kind: "write",
    source: meta?.source ?? "write_file",
    replacePreview: meta?.replacePreview,
  };
  pendingEdits.set(id, pending);
  const dryNote = dryRun.allowed
    ? ""
    : ` ${dryRun.reason ?? "Dry-run required before apply."}`;
  return {
    ok: true,
    content: `Edit proposed for ${pending.relativePath}. Waiting for approval (id=${id}).${dryNote}`,
    pendingEdit: pending,
  };
}

/** Public wrapper so ChatRouter replies can propose Apply cards without tool calling. */
export async function proposeFileEdit(
  rel: string,
  content: string,
  rootHint?: string,
  meta?: ProposeWriteMeta
): Promise<ToolResult> {
  return proposeWrite(rel, content, rootHint, {
    source: meta?.source ?? "fence",
    replacePreview: meta?.replacePreview,
  });
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let pos = 0;
  for (;;) {
    const i = haystack.indexOf(needle, pos);
    if (i < 0) {
      break;
    }
    count++;
    pos = i + needle.length;
  }
  return count;
}

async function searchReplaceInFile(
  rel: string,
  oldString: string,
  newString: string,
  rootHint?: string,
  replaceAll = false
): Promise<ToolResult> {
  if (!rel) {
    return { ok: false, content: "path is required" };
  }
  if (!oldString) {
    return { ok: false, content: "old_string is required" };
  }
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
  let content = "";
  try {
    content = await fs.readFile(absolutePath, "utf8");
  } catch {
    return {
      ok: false,
      content: `Cannot search_replace ${displayPath}: file not found. Use write_file to create it.`,
    };
  }
  const hits = countOccurrences(content, oldString);
  if (hits === 0) {
    return {
      ok: false,
      content:
        `old_string not found in ${displayPath}. read_file the target lines and copy exact whitespace.`,
    };
  }
  if (hits > 1 && !replaceAll) {
    return {
      ok: false,
      content:
        `old_string matched ${hits} times in ${displayPath}. Add surrounding lines to make it unique, or set replace_all true.`,
    };
  }
  const updated = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString);
  if (updated === content) {
    return {
      ok: false,
      content: `No change in ${displayPath} (old_string equals new_string).`,
    };
  }
  return proposeWrite(displayPath, updated, rootHint, {
    source: "search_replace",
    replacePreview: {
      oldString,
      newString,
      replaceAll,
      matchCount: hits,
    },
  });
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

  if (isAgentScratchPath(displayPath) || isAgentScratchPath(rel)) {
    return deleteScratchFile(absolutePath, displayPath);
  }

  if (activeToolProfile === "research" || activeToolProfile === "minimal") {
    return { ok: false, content: scratchWriteDeniedMessage(displayPath) };
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
    source: "delete",
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

  if (pending.kind !== "delete" && contentGuardEnabled()) {
    await warmPatchIndex();
    const guard = validateProposedEdit({
      relativePath: pending.relativePath,
      newContent: pending.newContent,
      oldContent: pending.oldContent,
    });
    if (!guard.allowed) {
      pendingEdits.delete(id);
      throw new Error(guard.reason ?? "Edit blocked by content guard.");
    }
    const patchGuard = validatePatchScriptEdit({
      relativePath: pending.relativePath,
      newContent: pending.newContent,
      oldContent: pending.oldContent,
    });
    if (!patchGuard.allowed) {
      pendingEdits.delete(id);
      throw new Error(patchGuard.reason ?? "Edit blocked by patch script guard.");
    }
  }

  if (pending.kind !== "delete") {
    const dryRun = validateDryRunBeforeApply(pending.relativePath);
    if (!dryRun.allowed) {
      throw new Error(dryRun.reason ?? "Dry-run required before apply.");
    }
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
    // Save only through TextDocument.save(). Never node fs.writeFile on an
    // open buffer — that bumps mtime behind the editor and causes
    // "The content of the file is newer" on the next Ctrl+S.
    await saveAppliedDocument(uri, pending.newContent);
  }

  pendingEdits.delete(id);
  return pending.relativePath;
}

/** Flush an applied edit to disk without fighting the open editor. */
async function saveAppliedDocument(
  uri: vscode.Uri,
  content: string
): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);

  // createFile({ contents }) already wrote disk — buffer should match.
  if (!doc.isDirty && doc.getText() === content) {
    return;
  }

  if (doc.getText() !== content) {
    const full = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(doc.getText().length)
    );
    const fix = new vscode.WorkspaceEdit();
    fix.replace(uri, full, content);
    const fixed = await vscode.workspace.applyEdit(fix);
    if (!fixed) {
      throw new Error("VS Code rejected syncing the buffer before save");
    }
  }

  const reopened = await vscode.workspace.openTextDocument(uri);
  const saved = await reopened.save();
  if (!saved && reopened.isDirty) {
    throw new Error(
      `Could not save ${path.basename(uri.fsPath)} — resolve any file conflict, then Apply again.`
    );
  }
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

async function runCommand(
  command: string,
  cwdRel: string,
  rootHint: string | undefined,
  timeoutMs: number
): Promise<ToolResult> {
  const cmd = (command || "").trim();
  if (!cmd) {
    return { ok: false, content: "run_command requires a non-empty command." };
  }
  if (cmd.length > 8000) {
    return { ok: false, content: "Command too long (max 8000 chars)." };
  }

  const { absolutePath: cwd, displayPath } = resolveInWorkspace(
    cwdRel || ".",
    rootHint
  );
  try {
    const st = await fs.stat(cwd);
    if (!st.isDirectory()) {
      return { ok: false, content: `cwd is not a directory: ${displayPath}` };
    }
  } catch {
    return { ok: false, content: `cwd does not exist: ${displayPath}` };
  }

  const timeout = Math.min(
    Math.max(1000, Math.floor(timeoutMs || RUN_COMMAND_DEFAULT_TIMEOUT_MS)),
    RUN_COMMAND_MAX_TIMEOUT_MS
  );

  return new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd,
      shell: true,
      windowsHide: true,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      const clip = (s: string) =>
        s.length > RUN_COMMAND_MAX_OUTPUT_CHARS
          ? `${s.slice(0, RUN_COMMAND_MAX_OUTPUT_CHARS)}\n…(truncated)`
          : s;
      const parts = [
        `cwd: ${displayPath}`,
        `command: ${cmd}`,
        timedOut ? `status: timeout after ${timeout}ms` : `exit: ${code ?? "null"}${signal ? ` signal=${signal}` : ""}`,
        "",
        "--- stdout ---",
        clip(stdout) || "(empty)",
        "",
        "--- stderr ---",
        clip(stderr) || "(empty)",
      ];
      const ok = !timedOut && code === 0;
      resolve({ ok, content: parts.join("\n") });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 2000);
    }, timeout);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (stdout.length > RUN_COMMAND_MAX_OUTPUT_CHARS * 2) {
        stdout = stdout.slice(0, RUN_COMMAND_MAX_OUTPUT_CHARS);
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (stderr.length > RUN_COMMAND_MAX_OUTPUT_CHARS * 2) {
        stderr = stderr.slice(0, RUN_COMMAND_MAX_OUTPUT_CHARS);
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        ok: false,
        content: `Failed to start command in ${displayPath}: ${err.message}`,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      finish(code, signal);
    });
  });
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
