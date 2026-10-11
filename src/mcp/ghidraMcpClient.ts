import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getConfig } from "../config";

const DEFAULT_ALLOWLIST = [
  "list_instances",
  "connect_instance",
  "search_functions",
  "decompile_function",
  "disassemble_function",
  "get_function_by_address",
  "get_xrefs_to",
  "get_function_xrefs",
  "list_strings",
  "search_strings",
  "analyze_function_complete",
  "batch_decompile",
  "get_function_documentation",
];

const MAX_OUTPUT_CHARS = 40_000;
const CALL_TIMEOUT_MS = 90_000;

let client: Client | null = null;
let transport: StdioClientTransport | null = null;
let connectPromise: Promise<boolean> | null = null;
let cachedTools: Tool[] = [];
let cachedCatalogBlock = "";

function mcpEnabled(): boolean {
  const cfg = getConfig().ghidra;
  return cfg.enabled && cfg.mcp.enabled;
}

function allowedToolNames(): Set<string> {
  const cfg = getConfig().ghidra.mcp;
  const list =
    cfg.toolAllowlist.length > 0 ? cfg.toolAllowlist : DEFAULT_ALLOWLIST;
  return new Set(list.map((n) => n.trim()).filter(Boolean));
}

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }
  return (
    text.slice(0, MAX_OUTPUT_CHARS) +
    `\n… truncated (${text.length} total chars)`
  );
}

async function resolveMcpLaunch(): Promise<{ command: string; args: string[] }> {
  const cfg = getConfig().ghidra.mcp;
  if (cfg.command.trim()) {
    return { command: cfg.command.trim(), args: cfg.args };
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, ".cursor", "mcp.json"),
    path.join(home, "AppData", "Roaming", "Cursor", "User", "globalStorage", "mcp.json"),
  ];
  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as {
        mcpServers?: Record<
          string,
          { command?: string; args?: string[] }
        >;
      };
      const servers = parsed.mcpServers ?? {};
      const entry = servers.ghidra ?? servers["user-ghidra"];
      if (entry?.command) {
        return {
          command: entry.command,
          args: (entry.args ?? []).map(String),
        };
      }
    } catch {
      // try next
    }
  }
  return { command: "", args: [] };
}

function formatToolResultContent(result: unknown): string {
  if (!result || typeof result !== "object") {
    return clip(String(result ?? "(empty MCP result)"));
  }
  const r = result as {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
    toolResult?: unknown;
  };
  const parts: string[] = [];
  if (r.structuredContent != null) {
    parts.push(JSON.stringify(r.structuredContent, null, 2));
  }
  if (r.toolResult != null) {
    parts.push(
      typeof r.toolResult === "string"
        ? r.toolResult
        : JSON.stringify(r.toolResult, null, 2)
    );
  }
  for (const block of r.content ?? []) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    }
  }
  const body = parts.join("\n\n").trim() || "(empty MCP result)";
  return clip(body);
}

function rebuildCatalogBlock(tools: Tool[]): void {
  const allow = allowedToolNames();
  const names = tools
    .map((t) => t.name)
    .filter((n) => allow.has(n))
    .sort();
  if (names.length === 0) {
    cachedCatalogBlock = "";
    return;
  }
  cachedCatalogBlock = [
    "[GHIDRA MCP — use ghidra_mcp tool]",
    "First: list_instances → connect_instance. Then call tools by exact name.",
    `Allowed (${names.length}): ${names.join(", ")}`,
  ].join("\n");
}

export function invalidateGhidraMcpClient(): void {
  cachedTools = [];
  cachedCatalogBlock = "";
  connectPromise = null;
  void (async () => {
    try {
      await client?.close();
    } catch {
      // ignore
    }
    try {
      await transport?.close();
    } catch {
      // ignore
    }
    client = null;
    transport = null;
  })();
}

export function getGhidraMcpCatalogBlock(): string {
  return cachedCatalogBlock;
}

export async function connectGhidraMcp(force = false): Promise<boolean> {
  if (!mcpEnabled()) {
    return false;
  }
  if (!force && client && cachedTools.length > 0) {
    return true;
  }
  if (!force && connectPromise) {
    return connectPromise;
  }

  connectPromise = (async () => {
    if (force) {
      invalidateGhidraMcpClient();
    }
    const cfg = getConfig().ghidra.mcp;
    const launch = await resolveMcpLaunch();
    const command = launch.command;
    if (!command) {
      connectPromise = null;
      return false;
    }

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ...cfg.env })) {
      if (v != null) {
        env[k] = String(v);
      }
    }

    transport = new StdioClientTransport({
      command,
      args: launch.args.length ? launch.args : cfg.args.filter(Boolean),
      env,
      stderr: "pipe",
    });

    client = new Client(
      { name: "blossom-assistant", version: "0.1.51" },
      { capabilities: {} }
    );

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      cachedTools = listed.tools ?? [];
      rebuildCatalogBlock(cachedTools);
      connectPromise = null;
      return cachedTools.length > 0;
    } catch {
      invalidateGhidraMcpClient();
      connectPromise = null;
      return false;
    }
  })();

  return connectPromise;
}

export async function listGhidraMcpTools(): Promise<string[]> {
  if (!(await connectGhidraMcp())) {
    return [];
  }
  const allow = allowedToolNames();
  return cachedTools.map((t) => t.name).filter((n) => allow.has(n));
}

export async function callGhidraMcpTool(opts: {
  tool: string;
  arguments?: Record<string, unknown>;
}): Promise<{ ok: boolean; content: string }> {
  if (!mcpEnabled()) {
    return {
      ok: false,
      content:
        "Ghidra MCP disabled. Set blossom.ghidra.mcp.enabled and configure command/args (stdio bridge).",
    };
  }

  const toolName = (opts.tool || "").trim();
  if (!toolName) {
    return { ok: false, content: "ghidra_mcp requires tool (MCP tool name)." };
  }

  const allow = allowedToolNames();
  if (!allow.has(toolName)) {
    return {
      ok: false,
      content:
        `Tool "${toolName}" not in allowlist. Allowed: ${[...allow].sort().join(", ")}`,
    };
  }

  if (!(await connectGhidraMcp())) {
    return {
      ok: false,
      content:
        "Ghidra MCP bridge failed to start. Check blossom.ghidra.mcp.command/args " +
        "(default: python + bridge_mcp_ghidra.py). Ghidra plugin must be running.",
    };
  }

  if (!client) {
    return { ok: false, content: "Ghidra MCP client not connected." };
  }

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`ghidra_mcp timed out after ${CALL_TIMEOUT_MS}ms`)),
      CALL_TIMEOUT_MS
    );
  });

  try {
    const result = await Promise.race([
      client.callTool({
        name: toolName,
        arguments: opts.arguments ?? {},
      }),
      timeoutPromise,
    ]);
    const text = formatToolResultContent(result);
    const ok = !(result as { isError?: boolean }).isError;
    return {
      ok,
      content: `[ghidra_mcp ${toolName}]\n${text}`,
    };
  } catch (err) {
    invalidateGhidraMcpClient();
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, content: `ghidra_mcp failed (${toolName}): ${msg}` };
  }
}

export async function buildGhidraMcpHintBlock(): Promise<string> {
  if (!mcpEnabled()) {
    return "";
  }
  const ok = await connectGhidraMcp();
  if (!ok) {
    return "";
  }
  return (
    cachedCatalogBlock ||
    "[GHIDRA MCP] Connected — use ghidra_mcp with tool=list_instances first."
  );
}
