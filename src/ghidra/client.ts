import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { getConfig } from "../config";

const DEFAULT_DISCOVERY_PORTS = [8089, 8192, 8080, 9090];
const PROBE_TIMEOUT_MS = 2500;
const REQUEST_TIMEOUT_MS = 65_000;
const MAX_OUTPUT_CHARS = 48_000;

export interface GhidraProgramInfo {
  name: string;
  path?: string;
  is_current?: boolean;
  executable_path?: string;
  language?: string;
  compiler?: string;
  image_base?: string;
  function_count?: number;
}

export interface GhidraConnectionInfo {
  baseUrl: string;
  programs: GhidraProgramInfo[];
  currentProgram?: string;
  discoveredAt: number;
}

let cachedConnection: GhidraConnectionInfo | null = null;
let discoveryPromise: Promise<GhidraConnectionInfo | null> | null = null;

export function ghidraEnabled(): boolean {
  return getConfig().ghidra.enabled;
}

export function invalidateGhidraCache(): void {
  cachedConnection = null;
  discoveryPromise = null;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

async function probeBaseUrl(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${normalizeBaseUrl(baseUrl)}/mcp/schema`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function discoverBaseUrl(): Promise<string | null> {
  const cfg = getConfig().ghidra;
  if (cfg.baseUrl.trim()) {
    const url = normalizeBaseUrl(cfg.baseUrl.trim());
    if (await probeBaseUrl(url)) {
      return url;
    }
  }
  if (!cfg.autoDiscover) {
    return null;
  }
  const ports =
    cfg.discoveryPorts.length > 0 ? cfg.discoveryPorts : DEFAULT_DISCOVERY_PORTS;
  for (const port of ports) {
    const url = `http://127.0.0.1:${port}`;
    if (await probeBaseUrl(url)) {
      return url;
    }
  }
  return null;
}

async function ghidraGet<T = unknown>(
  baseUrl: string,
  endpoint: string,
  query: Record<string, string | number | undefined> = {}
): Promise<T> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value != null && String(value).trim() !== "") {
      qs.set(key, String(value));
    }
  }
  const suffix = qs.toString();
  const url = `${normalizeBaseUrl(baseUrl)}${endpoint}${suffix ? `?${suffix}` : ""}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `Ghidra HTTP ${res.status} on ${endpoint}: ${text.slice(0, 600)}`
      );
    }
    const trimmed = text.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return JSON.parse(trimmed) as T;
      } catch {
        return text as T;
      }
    }
    return text as T;
  } finally {
    clearTimeout(timer);
  }
}

function clipOutput(text: string, label: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }
  return (
    text.slice(0, MAX_OUTPUT_CHARS) +
    `\n\n… truncated (${label}: ${text.length} chars)`
  );
}

/** Best-effort match of an open Ghidra program to binaries referenced in workspace. */
export async function guessProgramForWorkspace(
  programs: GhidraProgramInfo[]
): Promise<string | undefined> {
  if (programs.length === 0) {
    return undefined;
  }
  const current = programs.find((p) => p.is_current);
  if (current?.name) {
    return current.name;
  }

  const basenames = new Set<string>();
  const folders = vscode.workspace.workspaceFolders ?? [];
  const candidates = [
    "code.bin",
    "exefs/code.bin",
    "Extracted/code.bin",
    "rom.bin",
    "main.exe",
  ];

  for (const folder of folders) {
    for (const rel of candidates) {
      try {
        await fs.access(path.join(folder.uri.fsPath, rel));
        basenames.add(path.basename(rel).toLowerCase());
      } catch {
        // not here
      }
    }
    try {
      const entries = await fs.readdir(folder.uri.fsPath, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isFile() && /\.(bin|exe|elf|dll|so)$/i.test(ent.name)) {
          basenames.add(ent.name.toLowerCase());
        }
      }
    } catch {
      // ignore
    }
  }

  for (const prog of programs) {
    const name = prog.name?.toLowerCase() ?? "";
    if (basenames.has(name)) {
      return prog.name;
    }
    const exe = (prog.executable_path ?? "").replace(/\\/g, "/").toLowerCase();
    for (const base of basenames) {
      if (exe.endsWith(`/${base}`) || exe.endsWith(base)) {
        return prog.name;
      }
    }
  }

  return programs[0]?.name;
}

export async function connectGhidra(force = false): Promise<GhidraConnectionInfo | null> {
  if (!ghidraEnabled()) {
    return null;
  }
  if (
    !force &&
    cachedConnection &&
    Date.now() - cachedConnection.discoveredAt < getConfig().ghidra.cacheTtlMs
  ) {
    return cachedConnection;
  }
  if (!force && discoveryPromise) {
    return discoveryPromise;
  }

  discoveryPromise = (async () => {
    const baseUrl = await discoverBaseUrl();
    if (!baseUrl) {
      cachedConnection = null;
      discoveryPromise = null;
      return null;
    }
    let programs: GhidraProgramInfo[] = [];
    let currentProgram: string | undefined;
    try {
      const listed = await ghidraGet<{ programs?: GhidraProgramInfo[]; current_program?: string }>(
        baseUrl,
        "/list_open_programs"
      );
      programs = listed.programs ?? [];
      currentProgram = listed.current_program;
    } catch {
      programs = [];
    }
    cachedConnection = {
      baseUrl,
      programs,
      currentProgram,
      discoveredAt: Date.now(),
    };
    discoveryPromise = null;
    return cachedConnection;
  })();

  return discoveryPromise;
}

export type ReadGhidraAction =
  | "status"
  | "list_programs"
  | "program_info"
  | "decompile"
  | "disassemble"
  | "function_info"
  | "search_functions";

export interface ReadGhidraArgs {
  action?: ReadGhidraAction;
  address?: string;
  program?: string;
  name_pattern?: string;
  limit?: number;
  timeout?: number;
}

export interface GhidraToolResult {
  ok: boolean;
  content: string;
}

export async function readGhidra(args: ReadGhidraArgs): Promise<GhidraToolResult> {
  if (!ghidraEnabled()) {
    return {
      ok: false,
      content:
        "Ghidra integration disabled (blossom.ghidra.enabled). Enable it in settings to use read_ghidra.",
    };
  }

  const action: ReadGhidraAction = args.action ?? (args.address ? "decompile" : "status");
  const conn = await connectGhidra();
  if (!conn) {
    return {
      ok: false,
      content:
        "Ghidra not connected. Open Ghidra with the MCP/HTTP bridge running, or set blossom.ghidra.baseUrl " +
        `(auto-discover tries ports ${DEFAULT_DISCOVERY_PORTS.join(", ")}).`,
    };
  }

  const program =
    args.program?.trim() ||
    conn.currentProgram ||
    (await guessProgramForWorkspace(conn.programs));

  try {
    switch (action) {
      case "status": {
        const lines = [
          `Ghidra connected: ${conn.baseUrl}`,
          conn.currentProgram
            ? `Active program: ${conn.currentProgram}`
            : "Active program: (none set)",
        ];
        if (conn.programs.length > 0) {
          lines.push("Open programs:");
          for (const p of conn.programs) {
            lines.push(
              `  • ${p.name}${p.is_current ? " (current)" : ""}` +
                (p.language ? ` — ${p.language}` : "") +
                (p.executable_path ? `\n    ${p.executable_path}` : "")
            );
          }
        } else {
          lines.push("No open programs reported — open a binary in Ghidra first.");
        }
        if (program) {
          lines.push(`Workspace guess for program=: ${program}`);
        }
        return { ok: true, content: lines.join("\n") };
      }

      case "list_programs": {
        if (conn.programs.length === 0) {
          return {
            ok: true,
            content: "No programs open in Ghidra. Open a binary, then retry list_programs.",
          };
        }
        return {
          ok: true,
          content: JSON.stringify(
            {
              baseUrl: conn.baseUrl,
              current_program: conn.currentProgram,
              programs: conn.programs,
            },
            null,
            2
          ),
        };
      }

      case "program_info": {
        const info = await ghidraGet<Record<string, unknown>>(
          conn.baseUrl,
          "/get_current_program_info",
          { program }
        );
        return {
          ok: true,
          content: clipOutput(JSON.stringify(info, null, 2), "program_info"),
        };
      }

      case "decompile": {
        if (!args.address?.trim()) {
          return { ok: false, content: "decompile requires address (e.g. 0x001fc304)." };
        }
        const code = await ghidraGet<string>(conn.baseUrl, "/decompile_function", {
          address: args.address.trim(),
          program,
          timeout: args.timeout ?? 60,
        });
        const header = [
          `[Ghidra decompile] program=${program ?? "(default)"} address=${args.address}`,
          "",
        ].join("\n");
        return {
          ok: true,
          content: clipOutput(header + String(code), "decompile"),
        };
      }

      case "disassemble": {
        if (!args.address?.trim()) {
          return { ok: false, content: "disassemble requires address." };
        }
        const asm = await ghidraGet<string>(conn.baseUrl, "/disassemble_function", {
          address: args.address.trim(),
          program,
        });
        const header = [
          `[Ghidra disassembly] program=${program ?? "(default)"} address=${args.address}`,
          "",
        ].join("\n");
        return {
          ok: true,
          content: clipOutput(header + String(asm), "disassemble"),
        };
      }

      case "function_info": {
        if (!args.address?.trim()) {
          return { ok: false, content: "function_info requires address." };
        }
        const info = await ghidraGet<Record<string, unknown>>(
          conn.baseUrl,
          "/get_function_by_address",
          { address: args.address.trim(), program }
        );
        return {
          ok: true,
          content: clipOutput(JSON.stringify(info, null, 2), "function_info"),
        };
      }

      case "search_functions": {
        const result = await ghidraGet<unknown>(conn.baseUrl, "/search_functions", {
          name_pattern: args.name_pattern ?? "",
          limit: args.limit ?? 40,
          program,
        });
        return {
          ok: true,
          content: clipOutput(JSON.stringify(result, null, 2), "search_functions"),
        };
      }

      default:
        return {
          ok: false,
          content: `Unknown read_ghidra action: ${action}`,
        };
    }
  } catch (err) {
    invalidateGhidraCache();
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      content: `read_ghidra failed (${action}): ${msg}`,
    };
  }
}

/** Short block for prompt injection when Ghidra is reachable. */
export async function buildGhidraHintBlock(): Promise<string> {
  if (!ghidraEnabled()) {
    return "";
  }
  const conn = await connectGhidra();
  if (!conn) {
    return "";
  }
  const guess = await guessProgramForWorkspace(conn.programs);
  const lines = [
    "[GHIDRA — connected via HTTP bridge]",
    `Bridge: ${conn.baseUrl}`,
    conn.currentProgram
      ? `Active program: ${conn.currentProgram}`
      : "Active program: (open a binary in Ghidra)",
    guess ? `Suggested program= for this workspace: ${guess}` : "",
    "Use read_ghidra before proposing ARM bytes or patch caves:",
    "  action=decompile|disassemble|function_info|search_functions|program_info|status",
    "  address=0x... program=<name when multiple binaries open>",
    "",
  ].filter(Boolean);
  return lines.join("\n");
}
