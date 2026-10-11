import { proposeEditsFromAssistantReply } from "../agent/applyFromResponse";
import type { PendingEdit } from "../agent/tools";

/**
 * Normalize common Cursor / Gemini / Claude fence styles into Blossom path= format.
 */
export function normalizeCloudAnswerForEdits(text: string): string {
  if (!text?.trim()) {
    return text;
  }

  let out = text;

  // ```typescript:src/foo.ts → ```typescript path=src/foo.ts
  out = out.replace(
    /```(\w[\w-]*):([^\n`]+)\n/g,
    (_match, lang: string, rawPath: string) => {
      const path = rawPath.trim().replace(/^["']|["']$/g, "");
      if (/\.[a-z0-9]{1,8}$/i.test(path) || /[\\/]/.test(path)) {
        return `\`\`\`${lang} path=${path}\n`;
      }
      return `\`\`\`${lang}:${rawPath}\n`;
    }
  );

  // ```lang file=path → ```lang path=path
  out = out.replace(
    /```([^\n`]*?\b)file=([^\s\n`]+)([^\n`]*)?\n/gi,
    (match, pre: string, filePath: string, post?: string) => {
      const info = `${pre}${post ?? ""}`;
      if (/\bpath\s*=/i.test(info)) {
        return match;
      }
      return `\`\`\`${pre}path=${filePath}${post ?? ""}\n`;
    }
  );

  // "Update File: path" / **Edit `path`** immediately before an unlabeled fence
  out = out.replace(
    /(?:^|\n)(?:#{1,6}\s*)?(?:\*{0,2})?(?:Update|Edit|Create|Modify)\s+(?:File\s*[:：]?\s*)[`"']?([^\n`*]+?)[`"']?\s*(?:\*{0,2})?\s*\n(```(?![^\n]*\bpath\s*=)[^\n]*\n)/gim,
    (_match, filePath: string, fenceOpen: string) => {
      const path = filePath.trim().replace(/^["']|["']$/g, "");
      return `\n${path}\n${fenceOpen}`;
    }
  );

  return out;
}

export async function proposeEditsFromCloudAnswer(opts: {
  cloudText: string;
  attachedPaths: string[];
  preDeletePaths?: string[];
  lockDeletesToUserTargets?: boolean;
  onPendingEdit: (
    edit: PendingEdit
  ) => boolean | void | Promise<boolean | void>;
  onSkippedDelete?: (path: string, reason: string) => void;
  onSkippedWrite?: (path: string, reason: string) => void;
}): Promise<{ count: number; edits: PendingEdit[] }> {
  const normalized = normalizeCloudAnswerForEdits(opts.cloudText);
  return proposeEditsFromAssistantReply(
    normalized,
    opts.attachedPaths,
    opts.onPendingEdit,
    opts.preDeletePaths ?? [],
    {
      lockDeletesToUserTargets: opts.lockDeletesToUserTargets,
      onSkippedDelete: opts.onSkippedDelete,
      onSkippedWrite: opts.onSkippedWrite,
    }
  );
}
