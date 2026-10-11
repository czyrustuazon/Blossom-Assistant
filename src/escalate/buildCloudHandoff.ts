import type { HandoffCompression } from "./compressHandoff";

export type CloudHandoffProvider = "cursor" | "gemini" | "claude";

const PREAMBLES: Record<CloudHandoffProvider, string> = {
  cursor: [
    "You are Cursor Agent with full workspace tools (shell, file read/write, MCP when configured).",
    "Read attached image paths from disk when listed. Prefer script evidence over guessing.",
    "When your reply includes code for Blossom to apply, use fenced blocks with path= labels (e.g. ```typescript path=src/foo.ts).",
  ].join(" "),
  gemini: [
    "You are a text-only coding advisor (no tools).",
    "Provide a clear, actionable answer. Use fenced code blocks with path= when edits are needed.",
  ].join(" "),
  claude: [
    "You are a text-only coding advisor (no tools).",
    "Provide a clear, actionable answer. Use fenced code blocks with path= when edits are needed.",
  ].join(" "),
};

export function buildCloudHandoffPrompt(opts: {
  provider: CloudHandoffProvider;
  compressed: HandoffCompression;
  userText: string;
  localAttempt: string;
  workspace: string;
  repoMap?: string;
  activeFile?: string;
  toolErrors?: string;
  imageAttachments?: Array<{ path: string; metadata?: string }>;
  priorProviderAttempt?: { provider: string; text: string };
}): string {
  const parts = [
    PREAMBLES[opts.provider],
    "",
    opts.compressed.summaryMarkdown,
    "",
    `Workspace: ${opts.workspace}`,
  ];

  if (opts.activeFile) {
    parts.push(`Active file: ${opts.activeFile}`);
  }
  if (opts.repoMap?.trim()) {
    parts.push(`Repo knowledge snippet:\n${opts.repoMap.trim().slice(0, 2000)}`);
  }
  if (opts.toolErrors?.trim()) {
    parts.push(`Tool errors:\n${opts.toolErrors.trim().slice(0, 2000)}`);
  }

  parts.push("", `Current user ask (verbatim):\n${opts.userText}`);

  if (opts.localAttempt.trim()) {
    parts.push("", `Local Blossom attempt:\n${opts.localAttempt}`);
  }

  if (opts.priorProviderAttempt?.text) {
    parts.push(
      "",
      `[PRIOR ESCALATION ATTEMPT — ${opts.priorProviderAttempt.provider}]`,
      "The user already tried the provider below. Continue from the session summary; do not restart.",
      opts.priorProviderAttempt.text.slice(0, 3000)
    );
  }

  if (opts.imageAttachments?.length) {
    parts.push(
      "",
      "Attached images (read these files from disk):",
      ...opts.imageAttachments.map(
        (i) => `- ${i.path}${i.metadata ? ` — ${i.metadata}` : ""}`
      )
    );
  }

  if (opts.provider === "cursor") {
    parts.push(
      "",
      "Use workspace tools as needed. If code edits are required, show full file contents or precise patches.",
      "For Blossom Apply cards, include path= on every code fence you want written to disk."
    );
  }

  return parts.join("\n");
}
