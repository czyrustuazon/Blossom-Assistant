import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { getConfig } from "../config";
import type { ImageAttachment } from "../chat/attachments";
import { formatImageMetadataBlock } from "../chat/attachments";
import { runLocalOcr } from "./ocr";
import { notifyChatRouterVisionPause, unloadOllamaModels } from "./unload";

export type CaptionSource = "vl" | "ocr" | "metadata";

export interface ImageCaption {
  path: string;
  fileName: string;
  source: CaptionSource;
  text: string;
  error?: string;
}

export interface CaptionBatchResult {
  captions: ImageCaption[];
  block: string;
  /** True when at least one image got VL or OCR text. */
  usable: boolean;
}

const cache = new Map<string, { key: string; caption: ImageCaption }>();

const CAPTION_PROMPT = [
  "You are a local vision captioner for a coding assistant.",
  "Read the screenshot carefully.",
  "Reply in this exact format (no markdown fences):",
  "Exact UI text: <quote every readable error/status string verbatim>",
  "Kind: <one short label, e.g. error toast, dialog, terminal, editor>",
  "Notes: <one short line; ignore decorative chrome>",
  "If text is unreadable, say Exact UI text: (unreadable) and explain in Notes.",
].join("\n");

async function cacheKeyFor(filePath: string): Promise<string> {
  const st = await fs.stat(filePath);
  return `${st.size}:${st.mtimeMs}:${filePath}`;
}

async function captionWithOllamaVl(
  filePath: string,
  opts: { model: string; baseUrl: string; timeoutMs: number; signal?: AbortSignal }
): Promise<string> {
  const buf = await fs.readFile(filePath);
  const b64 = buf.toString("base64");
  const url = `${opts.baseUrl.replace(/\/$/, "")}/api/chat`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        stream: false,
        messages: [
          {
            role: "user",
            content: CAPTION_PROMPT,
            images: [b64],
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Ollama VL failed (${res.status}): ${text || res.statusText}`
      );
    }
    const data = (await res.json()) as {
      message?: { content?: string };
      error?: string;
    };
    if (data.error) {
      throw new Error(`Ollama VL error: ${data.error}`);
    }
    const content = (data.message?.content ?? "").trim();
    if (!content) {
      throw new Error("Ollama VL returned empty caption");
    }
    return content;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

function formatCaptionBlock(captions: ImageCaption[]): string {
  if (!captions.length) {
    return "";
  }
  const parts = ["[IMAGE CAPTION — local]"];
  for (const c of captions) {
    parts.push(`file: ${c.fileName}`);
    parts.push(`source: ${c.source}`);
    if (c.error) {
      parts.push(`error: ${c.error}`);
    }
    parts.push(c.text.trim());
    parts.push("---");
  }
  if (parts[parts.length - 1] === "---") {
    parts.pop();
  }
  parts.push(
    "Local coder is text-only — treat Exact UI text above as ground truth for the screenshot."
  );
  return parts.join("\n");
}

async function captionOne(
  att: ImageAttachment,
  opts: {
    model: string;
    baseUrl: string;
    timeoutMs: number;
    ocrFallback: boolean;
    ocrCommand: string;
    signal?: AbortSignal;
  }
): Promise<ImageCaption> {
  const key = await cacheKeyFor(att.path);
  const hit = cache.get(att.path);
  if (hit && hit.key === key) {
    return hit.caption;
  }

  let lastError = "";
  try {
    const text = await captionWithOllamaVl(att.path, opts);
    const caption: ImageCaption = {
      path: att.path,
      fileName: att.fileName,
      source: "vl",
      text,
    };
    cache.set(att.path, { key, caption });
    return caption;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  if (opts.ocrFallback) {
    try {
      const ocrText = await runLocalOcr(att.path, {
        command: opts.ocrCommand,
        signal: opts.signal,
      });
      if (ocrText.trim()) {
        const caption: ImageCaption = {
          path: att.path,
          fileName: att.fileName,
          source: "ocr",
          text: [
            `Exact UI text: ${ocrText.trim().replace(/\s+/g, " ")}`,
            "Kind: (ocr fallback — verify carefully)",
            "Notes: classic OCR; dark UI may be noisy",
          ].join("\n"),
          error: lastError || undefined,
        };
        cache.set(att.path, { key, caption });
        return caption;
      }
      lastError = lastError
        ? `${lastError}; OCR returned empty`
        : "OCR returned empty";
    } catch (err) {
      const ocrErr = err instanceof Error ? err.message : String(err);
      lastError = lastError ? `${lastError}; OCR: ${ocrErr}` : `OCR: ${ocrErr}`;
    }
  }

  const meta = att.metadata ?? `path: ${att.path}`;
  const caption: ImageCaption = {
    path: att.path,
    fileName: att.fileName,
    source: "metadata",
    text: [
      "Exact UI text: (unavailable — local VL/OCR failed)",
      "Kind: unknown",
      `Notes: ${meta}`,
    ].join("\n"),
    error: lastError || "no local vision path available",
  };
  cache.set(att.path, { key, caption });
  return caption;
}

/**
 * Offline image → text for the local coder. Uses Ollama VL, then optional OCR.
 * Never calls cloud APIs.
 */
export async function captionImageAttachments(
  attachments: ImageAttachment[],
  opts?: {
    signal?: AbortSignal;
    onStatus?: (msg: string) => void;
  }
): Promise<CaptionBatchResult> {
  const cfg = getConfig().vision.caption;
  const max = Math.max(1, cfg.maxImages);
  const slice = attachments.slice(0, max);
  if (!slice.length) {
    return { captions: [], block: "", usable: false };
  }

  if (!cfg.enabled) {
    const block = formatImageMetadataBlock(attachments);
    return {
      captions: attachments.map((a) => ({
        path: a.path,
        fileName: a.fileName,
        source: "metadata" as const,
        text: a.metadata ?? a.path,
        error: "local caption disabled",
      })),
      block,
      usable: false,
    };
  }

  opts?.onStatus?.(
    `Local vision caption (${slice.length} image${slice.length === 1 ? "" : "s"}) via Ollama…`
  );

  const fullCfg = getConfig();
  if (cfg.unloadCoderFirst !== false) {
    opts?.onStatus?.("Freeing VRAM for local VL (unload Ollama models)…");
    await notifyChatRouterVisionPause(fullCfg.baseUrl);
    const prefer = [
      fullCfg.models.coding,
      cfg.model,
    ].filter(Boolean);
    const { unloaded, errors } = await unloadOllamaModels({
      baseUrl: cfg.ollamaBaseUrl,
      preferUnload: prefer,
    });
    if (unloaded.length) {
      opts?.onStatus?.(
        `Unloaded ${unloaded.length} Ollama model(s) before VL caption.`
      );
    } else if (errors.length) {
      opts?.onStatus?.(
        `VRAM unload soft-failed (${errors[0]}) — continuing caption.`
      );
    }
  }

  const captions: ImageCaption[] = [];
  // Parallel captions when multiple images (R3 mitigation).
  const captionOpts = {
    model: cfg.model,
    baseUrl: cfg.ollamaBaseUrl,
    timeoutMs: cfg.timeoutMs,
    ocrFallback: cfg.ocrFallback,
    ocrCommand: cfg.ocrCommand,
    signal: opts?.signal,
  };
  if (slice.length === 1) {
    opts?.onStatus?.(`Captioning ${slice[0].fileName}…`);
    captions.push(await captionOne(slice[0], captionOpts));
  } else {
    opts?.onStatus?.(`Captioning ${slice.length} images in parallel…`);
    const results = await Promise.all(
      slice.map((att) => captionOne(att, captionOpts))
    );
    captions.push(...results);
  }

  const usable = captions.some((c) => c.source === "vl" || c.source === "ocr");
  let block = formatCaptionBlock(captions);
  if (!usable) {
    const meta = formatImageMetadataBlock(attachments);
    block = [
      block,
      "",
      "[VISION ROADBLOCK — local]",
      "VL and OCR produced no usable text. See hand-off.md.",
      meta,
    ]
      .filter(Boolean)
      .join("\n");
  }

  await persistLastCaptions(captions, block).catch(() => {
    // best-effort R5
  });

  return { captions, block, usable };
}

/** Persist last caption block under .blossom/ for history re-asks (R5). */
async function persistLastCaptions(
  captions: ImageCaption[],
  block: string
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || !block.trim()) {
    return;
  }
  const dir = path.join(folder.uri.fsPath, ".blossom");
  await fs.mkdir(dir, { recursive: true });
  const payload = {
    savedAt: new Date().toISOString(),
    captions: captions.map((c) => ({
      fileName: c.fileName,
      source: c.source,
      text: c.text,
      error: c.error,
    })),
    block,
  };
  await fs.writeFile(
    path.join(dir, "last-captions.json"),
    JSON.stringify(payload, null, 2),
    "utf8"
  );
}

/** Load last persisted caption block (empty if none). */
export async function loadLastCaptionBlock(): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return "";
  }
  try {
    const raw = await fs.readFile(
      path.join(folder.uri.fsPath, ".blossom", "last-captions.json"),
      "utf8"
    );
    const data = JSON.parse(raw) as { block?: string };
    return (data.block || "").trim();
  } catch {
    return "";
  }
}

/** Clear in-memory caption cache (file mtime/size keyed). */
export function clearCaptionCache(): void {
  cache.clear();
}
