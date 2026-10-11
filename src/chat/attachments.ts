import * as path from "path";
import * as vscode from "vscode";
import { buildImageMetadataLine, type ImageMetadata } from "../vision/metadata";

export interface ImageAttachment {
  /** Absolute path on disk (Cursor SDK reads from here). */
  path: string;
  fileName: string;
  metadata?: string;
  meta?: ImageMetadata;
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export function isImageFilePath(filePath: string): boolean {
  return IMAGE_EXT.has(path.extname(filePath).toLowerCase());
}

export async function pickImageAttachments(): Promise<ImageAttachment[]> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: "Attach images",
    filters: {
      Images: ["png", "jpg", "jpeg", "webp", "gif"],
    },
  });
  if (!uris?.length) {
    return [];
  }
  const out: ImageAttachment[] = [];
  for (const uri of uris) {
    const att = await buildImageAttachment(uri.fsPath);
    if (att) {
      out.push(att);
    }
  }
  return out;
}

export async function buildImageAttachment(
  filePath: string
): Promise<ImageAttachment | undefined> {
  const normalized = path.normalize(filePath);
  if (!isImageFilePath(normalized)) {
    return undefined;
  }
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(normalized));
  } catch {
    void vscode.window.showWarningMessage(`Image not found: ${normalized}`);
    return undefined;
  }
  const meta = await buildImageMetadataLine(normalized);
  return {
    path: normalized,
    fileName: path.basename(normalized),
    metadata: meta.summary,
    meta,
  };
}

export function formatImageMetadataBlock(attachments: ImageAttachment[]): string {
  if (!attachments.length) {
    return "";
  }
  const lines = attachments.map(
    (a) => a.metadata ?? `[image] ${a.path}`
  );
  return ["[IMAGE METADATA — local coder cannot see pixels]", ...lines].join(
    "\n"
  );
}

export function attachmentPathsForHandoff(
  attachments: ImageAttachment[]
): Array<{ path: string; metadata?: string }> {
  return attachments.map((a) => ({
    path: a.path,
    metadata: a.metadata,
  }));
}
