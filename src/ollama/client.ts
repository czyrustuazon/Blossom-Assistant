import { getConfig, type ApiBackend } from "../config";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
}

/** @deprecated alias */
export type OllamaMessage = ChatMessage;

export interface ToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

/** @deprecated alias */
export type OllamaToolCall = ToolCall;

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** @deprecated alias */
export type OllamaTool = ChatTool;

export interface BlossomThought {
  step?: string;
  message: string;
  ts?: number;
  /** ChatRouter coding intel: local_coder | claude | gemini | … */
  source?: string;
  /** Cloud provider when present */
  provider?: string;
}

export interface ChatStreamChunk {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: ToolCall[];
  };
  done?: boolean;
  error?: string;
  /** Live ChatRouter thought (object: blossom.thought) */
  thought?: BlossomThought;
  /** Full trail (object: blossom.thoughts) */
  thoughts?: BlossomThought[];
  /** Which brain answered (local_coder / claude / gemini / persona) */
  intelSource?: string;
  intelLabel?: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** @deprecated alias */
export const OllamaError = LlmError;

function normalizeThought(data: Record<string, unknown>): BlossomThought {
  const message = String(data.message ?? data.step ?? "…");
  let source =
    data.source != null
      ? String(data.source)
      : data.provider != null
        ? String(data.provider)
        : undefined;
  if (!source) {
    const m =
      message.match(/\bsource\s*=\s*([a-z0-9_]+)/i) ||
      message.match(/\bprovider\s*=\s*([a-z0-9_]+)/i);
    if (m) {
      source = m[1];
    }
  }
  const provider =
    data.provider != null ? String(data.provider) : undefined;
  return {
    step: data.step != null ? String(data.step) : undefined,
    message,
    ts: typeof data.ts === "number" ? data.ts : undefined,
    source,
    provider,
  };
}

/** Human label for ChatRouter intel source ids. */
export function labelIntelSource(source: string): string {
  const s = source.toLowerCase();
  if (s === "local_coder" || s === "local" || s === "coder") {
    return "Local coder";
  }
  if (s === "claude" || s.startsWith("claude")) {
    return "Claude";
  }
  if (s === "gemini" || s === "google") {
    return "Gemini";
  }
  if (s === "ollama") {
    return "Ollama";
  }
  return source;
}

function baseUrl(): string {
  return getConfig().baseUrl;
}

function backend(): ApiBackend {
  return getConfig().backend;
}

export async function checkHealth(): Promise<{ ok: boolean; detail: string }> {
  if (backend() === "chatRouter") {
    return checkChatRouterHealth();
  }
  return checkOllamaHealth();
}

async function checkChatRouterHealth(): Promise<{ ok: boolean; detail: string }> {
  const url = `${baseUrl()}/health`;
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      return { ok: false, detail: `HTTP ${res.status} from ${url}` };
    }
    const data = (await res.json()) as {
      ok?: boolean;
      active_role?: string;
      model_voice?: string;
      model_coder?: string;
      cloud_enabled?: boolean;
    };
    if (!data.ok) {
      return { ok: false, detail: `ChatRouter reported not ok at ${url}` };
    }
    const parts = [
      `ChatRouter OK`,
      data.active_role ? `role=${data.active_role}` : "",
      data.model_voice ? `voice=${data.model_voice}` : "",
      data.model_coder ? `coder=${data.model_coder}` : "",
      data.cloud_enabled ? "gemini=on" : "gemini=off",
    ].filter(Boolean);
    return { ok: true, detail: parts.join(" · ") };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `Failed to reach ${url}: ${msg}` };
  }
}

async function checkOllamaHealth(): Promise<{ ok: boolean; detail: string }> {
  const url = `${baseUrl()}/api/tags`;
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      return { ok: false, detail: `HTTP ${res.status} from ${url}` };
    }
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const names = (data.models ?? []).map((m) => m.name);
    return {
      ok: true,
      detail:
        names.length > 0
          ? `Ollama connected. Models: ${names.slice(0, 12).join(", ")}${names.length > 12 ? "…" : ""}`
          : "Ollama connected, but no models listed.",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `Failed to reach ${url}: ${msg}` };
  }
}

export interface ModelInfo {
  name: string;
  system: string;
  modelfile: string;
}

export async function showModel(model: string): Promise<ModelInfo> {
  if (backend() === "chatRouter") {
    return { name: model, system: "", modelfile: "" };
  }
  const res = await fetch(`${baseUrl()}/api/show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: model, model }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LlmError(
      `Ollama show failed for "${model}" (${res.status}): ${text || res.statusText}`,
      res.status
    );
  }
  const data = (await res.json()) as {
    system?: string;
    modelfile?: string;
  };
  const fromField = (data.system ?? "").trim();
  const fromModelfile = extractSystemFromModelfile(data.modelfile ?? "");
  return {
    name: model,
    system: fromField || fromModelfile,
    modelfile: data.modelfile ?? "",
  };
}

function extractSystemFromModelfile(modelfile: string): string {
  if (!modelfile.trim()) {
    return "";
  }
  const triple = modelfile.match(/SYSTEM\s+"""([\s\S]*?)"""/i);
  if (triple) {
    return triple[1].trim();
  }
  const single = modelfile.match(/SYSTEM\s+"([^"]*)"/i);
  if (single) {
    return single[1].trim();
  }
  const lines: string[] = [];
  let inSystem = false;
  for (const line of modelfile.split(/\r?\n/)) {
    if (/^\s*SYSTEM\s+/i.test(line)) {
      inSystem = true;
      const rest = line.replace(/^\s*SYSTEM\s+/i, "");
      if (rest) {
        lines.push(rest);
      }
      continue;
    }
    if (inSystem) {
      if (/^\s*(FROM|PARAMETER|TEMPLATE|ADAPTER|LICENSE|MESSAGE)\b/i.test(line)) {
        break;
      }
      lines.push(line);
    }
  }
  return lines.join("\n").trim();
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  stream?: boolean;
  signal?: AbortSignal;
}

export async function* streamChat(
  req: ChatRequest
): AsyncGenerator<ChatStreamChunk> {
  if (backend() === "chatRouter") {
    yield* streamChatRouter(req);
    return;
  }
  yield* streamChatOllama(req);
}

export async function chatOnce(req: ChatRequest): Promise<{
  content: string;
  toolCalls: ToolCall[];
  thoughts?: BlossomThought[];
}> {
  if (backend() === "chatRouter") {
    return chatCompletionsOpenAI({ ...req, tools: undefined, stream: false });
  }
  return chatOnceOllama(req);
}

async function* streamChatRouter(
  req: ChatRequest
): AsyncGenerator<ChatStreamChunk> {
  const url = `${baseUrl()}/v1/chat/completions`;
  const openaiMessages = req.messages
    .filter((m) => m.role === "system" || m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: req.model,
      messages: openaiMessages,
      stream: true,
      temperature: 0.82,
    }),
    signal: req.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LlmError(
      `ChatRouter stream failed (${res.status}): ${text || res.statusText}`,
      res.status
    );
  }
  if (!res.body) {
    throw new LlmError("ChatRouter stream had no body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const emitPayload = function* (raw: string): Generator<ChatStreamChunk> {
    const trimmed = raw.trim();
    if (!trimmed) {
      return;
    }
    if (trimmed === "[DONE]") {
      yield { done: true };
      return;
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }

    const object = String(data.object ?? "");

    if (object === "error" || data.error != null) {
      const errObj = data.error;
      const detail =
        typeof errObj === "string"
          ? errObj
          : errObj && typeof errObj === "object" && "message" in (errObj as object)
            ? String((errObj as { message?: unknown }).message ?? "")
            : "";
      const message =
        detail ||
        (data.message != null ? String(data.message) : "") ||
        "ChatRouter stream error";
      const code =
        typeof data.code === "number"
          ? data.code
          : typeof data.status_code === "number"
            ? data.status_code
            : undefined;
      throw new LlmError(
        code != null ? `ChatRouter error (${code}): ${message}` : `ChatRouter error: ${message}`,
        code
      );
    }

    if (object === "blossom.intel") {
      const source =
        data.source != null
          ? String(data.source)
          : data.provider != null
            ? String(data.provider)
            : undefined;
      const label =
        data.label != null
          ? String(data.label)
          : source
            ? labelIntelSource(source)
            : undefined;
      yield { intelSource: source, intelLabel: label };
      return;
    }

    if (object === "blossom.thought") {
      yield {
        thought: normalizeThought(data),
      };
      return;
    }

    if (object === "blossom.thoughts") {
      const rawThoughts = Array.isArray(data.thoughts) ? data.thoughts : [];
      const source =
        data.source != null ? String(data.source) : undefined;
      const label =
        data.label != null
          ? String(data.label)
          : source
            ? labelIntelSource(source)
            : undefined;
      yield {
        thoughts: rawThoughts.map((t) =>
          normalizeThought(t as Record<string, unknown>)
        ),
        intelSource: source,
        intelLabel: label,
      };
      return;
    }

    const choices = data.choices as
      | Array<{
          delta?: { content?: string; reasoning_content?: string };
          message?: { content?: string; reasoning_content?: string };
        }>
      | undefined;
    const deltaObj = choices?.[0]?.delta;
    const reasoningDelta =
      typeof deltaObj?.reasoning_content === "string"
        ? deltaObj.reasoning_content
        : "";
    if (reasoningDelta) {
      yield {
        thought: {
          step: "model_reasoning",
          message: reasoningDelta,
        },
      };
    }
    const delta =
      choices?.[0]?.delta?.content ??
      (typeof choices?.[0]?.message?.content === "string"
        ? choices[0].message!.content
        : "");
    if (delta) {
      yield { message: { role: "assistant", content: delta } };
    }
  };

  while (true) {
    let done: boolean;
    let value: Uint8Array | undefined;
    try {
      ({ done, value } = await reader.read());
    } catch (err) {
      if (req.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new LlmError(`ChatRouter stream interrupted: ${msg}`);
    }
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    let dataBuf: string[] = [];
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed) {
        if (dataBuf.length) {
          yield* emitPayload(dataBuf.join("\n"));
          dataBuf = [];
        }
        continue;
      }
      if (trimmed.startsWith("data:")) {
        dataBuf.push(trimmed.slice(5).trimStart());
        continue;
      }
      if (trimmed.startsWith(":") || trimmed.startsWith("event:") || trimmed.startsWith("id:")) {
        continue;
      }
      // NDJSON line
      yield* emitPayload(trimmed);
    }
  }

  if (buffer.trim()) {
    const left = buffer.trim();
    if (left.startsWith("data:")) {
      yield* emitPayload(left.replace(/^data:\s*/gm, "").trim());
    } else {
      yield* emitPayload(left);
    }
  }

  yield { done: true };
}

async function chatCompletionsOpenAI(req: ChatRequest): Promise<{
  content: string;
  toolCalls: ToolCall[];
  thoughts?: BlossomThought[];
}> {
  const url = `${baseUrl()}/v1/chat/completions`;
  const openaiMessages = req.messages
    .filter((m) => m.role === "system" || m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: req.model,
      messages: openaiMessages,
      stream: false,
      temperature: 0.82,
    }),
    signal: req.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LlmError(
      `ChatRouter failed (${res.status}): ${text || res.statusText}`,
      res.status
    );
  }

  const data = (await res.json()) as {
    blossom_thoughts?: Array<Record<string, unknown>>;
    choices?: Array<{
      message?: {
        content?: string | Array<{ type?: string; text?: string }>;
        reasoning_content?: string;
        tool_calls?: Array<{
          function?: { name?: string; arguments?: string | Record<string, unknown> };
        }>;
      };
    }>;
  };

  const message = data.choices?.[0]?.message;
  const content = normalizeContent(message?.content);
  const toolCalls: ToolCall[] = (message?.tool_calls ?? [])
    .map((tc) => ({
      function: {
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments ?? {},
      },
    }))
    .filter((tc) => tc.function.name);

  const thoughts = (data.blossom_thoughts ?? []).map((t) => normalizeThought(t));
  const reasoning =
    message?.reasoning_content?.trim() ?? "";
  if (
    reasoning &&
    !thoughts.some(
      (t) =>
        t.step === "model_reasoning" &&
        (t.message === reasoning ||
          t.message?.includes(reasoning.slice(0, 80)) ||
          reasoning.startsWith(t.message?.slice(0, 80) ?? ""))
    )
  ) {
    thoughts.push({ step: "model_reasoning", message: reasoning });
  }

  return {
    content,
    toolCalls,
    thoughts: thoughts.length > 0 ? thoughts : undefined,
  };
}

function normalizeContent(
  content: string | Array<{ type?: string; text?: string }> | undefined
): string {
  if (!content) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((p) => (typeof p === "string" ? p : p.text ?? ""))
    .join("\n")
    .trim();
}

async function* streamChatOllama(
  req: ChatRequest
): AsyncGenerator<ChatStreamChunk> {
  const res = await fetch(`${baseUrl()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      tools: req.tools,
      stream: true,
    }),
    signal: req.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LlmError(
      `Ollama chat failed (${res.status}): ${text || res.statusText}`,
      res.status
    );
  }
  if (!res.body) {
    throw new LlmError("Ollama response had no body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const chunk = JSON.parse(trimmed) as ChatStreamChunk & {
          error?: string;
        };
        if (chunk.error) {
          throw new LlmError(`Ollama error: ${chunk.error}`);
        }
        yield chunk;
      } catch (err) {
        if (err instanceof LlmError) {
          throw err;
        }
        // ignore malformed lines
      }
    }
  }

  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer.trim()) as ChatStreamChunk;
    } catch {
      // ignore
    }
  }
}

async function chatOnceOllama(req: ChatRequest): Promise<{
  content: string;
  toolCalls: ToolCall[];
  thoughts?: BlossomThought[];
}> {
  const res = await fetch(`${baseUrl()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      tools: req.tools,
      stream: false,
    }),
    signal: req.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LlmError(
      `Ollama chat failed (${res.status}): ${text || res.statusText}`,
      res.status
    );
  }

  const data = (await res.json()) as {
    message?: { content?: string; tool_calls?: ToolCall[] };
  };

  return {
    content: data.message?.content ?? "",
    toolCalls: data.message?.tool_calls ?? [],
  };
}
