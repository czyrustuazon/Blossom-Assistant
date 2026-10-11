import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import type { OllamaMessage } from "../ollama/client";

/** Workspace-relative folder for saved Blossom chats. */
export const CHAT_ARCHIVE_DIR = ".blossom/chats";

const INDEX_NAME = "index.json";
const MAX_ARCHIVES = 80;
/** Soft cap per archived chat file (chars of JSON-ish content). */
const MAX_ARCHIVE_CHARS = 400_000;
const MAX_MESSAGE_CONTENT = 12_000;
const LIST_PREVIEW_CHARS = 120;

export interface ChatArchiveMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ChatArchive {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  historySummary?: string;
  messages: ChatArchiveMessage[];
}

export interface ChatArchiveIndexEntry {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
}

interface ChatArchiveIndex {
  version: 1;
  chats: ChatArchiveIndexEntry[];
}

function primaryWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function chatArchiveRoot(): string | undefined {
  const root = primaryWorkspaceRoot();
  return root ? path.join(root, CHAT_ARCHIVE_DIR) : undefined;
}

async function ensureArchiveDir(): Promise<string | undefined> {
  const dir = chatArchiveRoot();
  if (!dir) {
    return undefined;
  }
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function archivePath(dir: string, id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return path.join(dir, `${safe || "chat"}.json`);
}

function indexPath(dir: string): string {
  return path.join(dir, INDEX_NAME);
}

function trimContent(content: string, max = MAX_MESSAGE_CONTENT): string {
  const t = (content || "").replace(/\r\n/g, "\n");
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, max - 1)}…`;
}

function previewFromMessages(messages: ChatArchiveMessage[]): string {
  for (const m of messages) {
    if (m.role === "user" && m.content.trim()) {
      const line = m.content.trim().split("\n")[0] || "";
      return line.length > LIST_PREVIEW_CHARS
        ? `${line.slice(0, LIST_PREVIEW_CHARS - 1)}…`
        : line;
    }
  }
  return "(empty chat)";
}

export function newChatArchiveId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `chat-${stamp}-${rand}`;
}

export function titleFromMessages(
  messages: ChatArchiveMessage[],
  fallback = "Blossom chat"
): string {
  for (const m of messages) {
    if (m.role === "user" && m.content.trim()) {
      const line = m.content.trim().replace(/\s+/g, " ").split("\n")[0] || "";
      if (!line) {
        continue;
      }
      return line.length > 64 ? `${line.slice(0, 63)}…` : line;
    }
  }
  return fallback;
}

/** Normalize orchestrator history for durable storage (drop empty / cap size). */
export function messagesFromHistory(
  history: OllamaMessage[],
  historySummary?: string
): ChatArchiveMessage[] {
  const out: ChatArchiveMessage[] = [];
  if (historySummary?.trim()) {
    out.push({
      role: "assistant",
      content: `[Prior session summary]\n${historySummary.trim()}`,
    });
  }
  for (const m of history) {
    if (!m?.content?.trim()) {
      continue;
    }
    if (
      m.role !== "user" &&
      m.role !== "assistant" &&
      m.role !== "system" &&
      m.role !== "tool"
    ) {
      continue;
    }
    // Skip duplicate summary bubble if already prepended.
    if (
      historySummary?.trim() &&
      m.role === "assistant" &&
      m.content.startsWith("[Prior session summary]")
    ) {
      continue;
    }
    out.push({
      role: m.role,
      content: trimContent(m.content),
    });
  }
  return out;
}

/** Messages suitable for replaying into the chat UI. */
export function uiMessagesFromArchive(
  archive: ChatArchive
): Array<{ role: "user" | "assistant"; content: string }> {
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of archive.messages) {
    if (m.role !== "user" && m.role !== "assistant") {
      continue;
    }
    const content = m.content.trim();
    if (!content) {
      continue;
    }
    // Tool breadcrumbs / quiet write notes stay in agent history, not UI spam.
    if (
      m.role === "assistant" &&
      (content.startsWith("[Prior session summary]") ||
        content.startsWith("[Applied edit]") ||
        content.startsWith("[Context added mid-turn"))
    ) {
      continue;
    }
    out.push({ role: m.role, content });
  }
  return out;
}

/** History to restore into the orchestrator (user/assistant/system; drop tool spam). */
export function historyForRestore(archive: ChatArchive): {
  history: OllamaMessage[];
  historySummary?: string;
} {
  let historySummary: string | undefined;
  const history: OllamaMessage[] = [];
  for (const m of archive.messages) {
    if (
      m.role === "assistant" &&
      m.content.startsWith("[Prior session summary]")
    ) {
      historySummary = m.content
        .replace(/^\[Prior session summary\]\s*/i, "")
        .trim();
      continue;
    }
    if (m.role === "tool") {
      continue;
    }
    if (m.role === "user" || m.role === "assistant" || m.role === "system") {
      history.push({ role: m.role, content: m.content });
    }
  }
  if (!historySummary && archive.historySummary?.trim()) {
    historySummary = archive.historySummary.trim();
  }
  return { history, historySummary };
}

async function readIndex(dir: string): Promise<ChatArchiveIndex> {
  try {
    const raw = await fs.readFile(indexPath(dir), "utf8");
    const parsed = JSON.parse(raw) as ChatArchiveIndex;
    if (parsed?.version === 1 && Array.isArray(parsed.chats)) {
      return parsed;
    }
  } catch {
    // missing or corrupt — rebuild from files below
  }
  return { version: 1, chats: [] };
}

async function writeIndex(dir: string, index: ChatArchiveIndex): Promise<void> {
  await fs.writeFile(
    indexPath(dir),
    JSON.stringify(index, null, 2),
    "utf8"
  );
}

function entryFromArchive(archive: ChatArchive): ChatArchiveIndexEntry {
  return {
    id: archive.id,
    title: archive.title,
    createdAt: archive.createdAt,
    updatedAt: archive.updatedAt,
    messageCount: archive.messages.length,
    preview: previewFromMessages(archive.messages),
  };
}

async function pruneArchives(
  dir: string,
  index: ChatArchiveIndex
): Promise<ChatArchiveIndex> {
  if (index.chats.length <= MAX_ARCHIVES) {
    return index;
  }
  const sorted = [...index.chats].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  );
  const keep = sorted.slice(0, MAX_ARCHIVES);
  const keepIds = new Set(keep.map((c) => c.id));
  for (const drop of sorted.slice(MAX_ARCHIVES)) {
    try {
      await fs.unlink(archivePath(dir, drop.id));
    } catch {
      // ignore
    }
  }
  return { version: 1, chats: keep.filter((c) => keepIds.has(c.id)) };
}

/**
 * Upsert a chat archive on disk. No-op (returns undefined) without a workspace.
 */
export async function saveChatArchive(opts: {
  id: string;
  title?: string;
  history: OllamaMessage[];
  historySummary?: string;
  createdAt?: string;
}): Promise<ChatArchive | undefined> {
  const dir = await ensureArchiveDir();
  if (!dir) {
    return undefined;
  }

  const messages = messagesFromHistory(opts.history, opts.historySummary);
  if (messages.length === 0) {
    return undefined;
  }

  const now = new Date().toISOString();
  let createdAt = opts.createdAt || now;
  try {
    const existing = await loadChatArchive(opts.id);
    if (existing?.createdAt) {
      createdAt = existing.createdAt;
    }
  } catch {
    // new archive
  }

  const archive: ChatArchive = {
    id: opts.id,
    title: (opts.title || titleFromMessages(messages)).trim() || "Blossom chat",
    createdAt,
    updatedAt: now,
    historySummary: opts.historySummary?.trim() || undefined,
    messages,
  };

  let payload = JSON.stringify(archive, null, 2);
  if (payload.length > MAX_ARCHIVE_CHARS) {
    // Drop oldest non-summary messages until under cap.
    const trimmed = { ...archive, messages: [...archive.messages] };
    while (
      trimmed.messages.length > 4 &&
      JSON.stringify(trimmed).length > MAX_ARCHIVE_CHARS
    ) {
      const idx = trimmed.messages.findIndex(
        (m) => !m.content.startsWith("[Prior session summary]")
      );
      if (idx < 0) {
        break;
      }
      trimmed.messages.splice(idx, 1);
    }
    trimmed.messages.unshift({
      role: "assistant",
      content:
        "[Archive note] Older turns were truncated to keep this saved chat under size limits.",
    });
    Object.assign(archive, trimmed);
    payload = JSON.stringify(archive, null, 2);
  }

  await fs.writeFile(archivePath(dir, archive.id), payload, "utf8");

  let index = await readIndex(dir);
  const entry = entryFromArchive(archive);
  index.chats = [
    entry,
    ...index.chats.filter((c) => c.id !== archive.id),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  index = await pruneArchives(dir, index);
  await writeIndex(dir, index);

  return archive;
}

export async function loadChatArchive(
  id: string
): Promise<ChatArchive | undefined> {
  const dir = chatArchiveRoot();
  if (!dir || !id.trim()) {
    return undefined;
  }
  try {
    const raw = await fs.readFile(archivePath(dir, id.trim()), "utf8");
    const parsed = JSON.parse(raw) as ChatArchive;
    if (!parsed?.id || !Array.isArray(parsed.messages)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export async function listChatArchives(): Promise<ChatArchiveIndexEntry[]> {
  const dir = chatArchiveRoot();
  if (!dir) {
    return [];
  }
  try {
    await fs.access(dir);
  } catch {
    return [];
  }

  let index = await readIndex(dir);
  if (index.chats.length === 0) {
    // Rebuild from loose JSON files if index missing.
    try {
      const names = await fs.readdir(dir);
      const rebuilt: ChatArchiveIndexEntry[] = [];
      for (const name of names) {
        if (!name.endsWith(".json") || name === INDEX_NAME) {
          continue;
        }
        try {
          const raw = await fs.readFile(path.join(dir, name), "utf8");
          const arch = JSON.parse(raw) as ChatArchive;
          if (arch?.id && Array.isArray(arch.messages)) {
            rebuilt.push(entryFromArchive(arch));
          }
        } catch {
          // skip bad file
        }
      }
      rebuilt.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      index = { version: 1, chats: rebuilt };
      if (rebuilt.length) {
        await writeIndex(dir, index);
      }
    } catch {
      return [];
    }
  }
  return index.chats;
}

export async function deleteChatArchive(id: string): Promise<boolean> {
  const dir = chatArchiveRoot();
  if (!dir || !id.trim()) {
    return false;
  }
  try {
    await fs.unlink(archivePath(dir, id.trim()));
  } catch {
    // may already be gone
  }
  const index = await readIndex(dir);
  const next = {
    version: 1 as const,
    chats: index.chats.filter((c) => c.id !== id.trim()),
  };
  await writeIndex(dir, next);
  return true;
}

/** Format archive list for the agent tool. */
export function formatArchiveList(
  entries: ChatArchiveIndexEntry[],
  limit = 30
): string {
  if (!entries.length) {
    return "No saved Blossom chats in this workspace yet.";
  }
  const slice = entries.slice(0, limit);
  const lines = slice.map((e, i) => {
    const when = e.updatedAt.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
    return `${i + 1}. id=${e.id}\n   title: ${e.title}\n   updated: ${when} · ${e.messageCount} msgs\n   preview: ${e.preview}`;
  });
  const more =
    entries.length > limit
      ? `\n… ${entries.length - limit} more (raise limit or search_chat_history).`
      : "";
  return (
    `Saved Blossom chats (${entries.length}) under ${CHAT_ARCHIVE_DIR}/:\n\n` +
    lines.join("\n\n") +
    more
  );
}

/** Format one archive for the agent (capped). */
export function formatArchiveForAgent(
  archive: ChatArchive,
  opts?: { maxChars?: number; query?: string }
): string {
  const maxChars = opts?.maxChars ?? 12_000;
  const query = opts?.query?.trim().toLowerCase();
  const header = [
    `Chat id: ${archive.id}`,
    `Title: ${archive.title}`,
    `Created: ${archive.createdAt}`,
    `Updated: ${archive.updatedAt}`,
    `Messages: ${archive.messages.length}`,
    "",
  ].join("\n");

  const parts: string[] = [header];
  let used = header.length;

  for (const m of archive.messages) {
    if (query && !m.content.toLowerCase().includes(query)) {
      continue;
    }
    const label =
      m.role === "user"
        ? "User"
        : m.role === "assistant"
          ? "Assistant"
          : m.role === "tool"
            ? "Tool"
            : "System";
    const block = `${label}:\n${trimContent(m.content, 4000)}\n`;
    if (used + block.length > maxChars) {
      parts.push("\n… truncated (use a tighter query or smaller maxChars).");
      break;
    }
    parts.push(block);
    used += block.length;
  }

  if (parts.length === 1 && query) {
    return `${header}No messages matched query "${opts?.query}".`;
  }
  return parts.join("\n");
}

export async function searchChatArchives(
  query: string,
  opts?: { maxChats?: number; maxChars?: number }
): Promise<string> {
  const q = query.trim().toLowerCase();
  if (!q) {
    return "search_chat_history requires a non-empty query.";
  }
  const entries = await listChatArchives();
  if (!entries.length) {
    return "No saved Blossom chats in this workspace yet.";
  }

  const maxChats = opts?.maxChats ?? 8;
  const maxChars = opts?.maxChars ?? 10_000;
  const hits: string[] = [];
  let used = 0;

  for (const entry of entries) {
    if (hits.length >= maxChats) {
      break;
    }
    const arch = await loadChatArchive(entry.id);
    if (!arch) {
      continue;
    }
    const titleHit = arch.title.toLowerCase().includes(q);
    const matching = arch.messages.filter((m) =>
      m.content.toLowerCase().includes(q)
    );
    if (!titleHit && !matching.length) {
      continue;
    }
    const snippets = (matching.length ? matching : arch.messages.slice(0, 2))
      .slice(0, 3)
      .map((m) => {
        const idx = m.content.toLowerCase().indexOf(q);
        const start = Math.max(0, idx - 60);
        const slice = m.content.slice(start, start + 200).replace(/\s+/g, " ");
        return `  - ${m.role}: ${start > 0 ? "…" : ""}${slice}${
          start + 200 < m.content.length ? "…" : ""
        }`;
      });
    const block = [
      `id=${arch.id}`,
      `title: ${arch.title}`,
      `updated: ${arch.updatedAt}`,
      `matches: ${matching.length}${titleHit ? " (+ title)" : ""}`,
      ...snippets,
      "",
    ].join("\n");
    if (used + block.length > maxChars) {
      hits.push("… truncated.");
      break;
    }
    hits.push(block);
    used += block.length;
  }

  if (!hits.length) {
    return `No saved chats matched "${query}".`;
  }
  return `Chat history search for "${query}":\n\n${hits.join("\n")}`;
}
