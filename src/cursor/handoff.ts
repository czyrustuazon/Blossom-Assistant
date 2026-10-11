import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { compressConversationForHandoff } from "../escalate/compressHandoff";
import { buildCloudHandoffPrompt } from "../escalate/buildCloudHandoff";
import { ensureRepoKnowledge } from "../agent/repoKnowledge";
import { resolveWorkspaceRoot } from "./client";
import type { AgentOrchestrator } from "../agent/orchestrator";

export interface HandoffPacket {
  version: 2;
  created_at: string;
  user_prompt: string;
  local_attempt: string;
  conversation_summary: string;
  compression: { raw_chars: number; compressed_chars: number };
  image_attachments: Array<{ path: string; metadata?: string }>;
  reason: string;
  workspace: string;
  source: string;
  markdown: string;
}

export async function buildHandoffPacket(
  context: vscode.ExtensionContext,
  orchestrator: AgentOrchestrator,
  opts?: { reason?: string; localAttempt?: string }
): Promise<HandoffPacket | undefined> {
  const workspace = resolveWorkspaceRoot();
  if (!workspace) {
    void vscode.window.showWarningMessage("Open a workspace folder first.");
    return undefined;
  }

  const handoffCtx = orchestrator.getHandoffContext();
  const userText = handoffCtx.lastUserText;
  if (!userText.trim()) {
    void vscode.window.showWarningMessage(
      "No user message in this chat yet — ask Blossom something first."
    );
    return undefined;
  }

  const repo = await ensureRepoKnowledge(context, 4000);
  const compressed = await compressConversationForHandoff(context, {
    history: handoffCtx.history,
    userText,
    localAttempt: opts?.localAttempt ?? handoffCtx.lastLocalAttempt,
    escalateReason: opts?.reason,
    repoMapSnippet: repo.summary,
  });

  const markdown = buildCloudHandoffPrompt({
    provider: "cursor",
    compressed,
    userText,
    localAttempt: opts?.localAttempt ?? handoffCtx.lastLocalAttempt ?? "",
    workspace,
    repoMap: repo.summary,
    activeFile: vscode.window.activeTextEditor?.document.uri.fsPath,
  });

  return {
    version: 2,
    created_at: new Date().toISOString(),
    user_prompt: userText,
    local_attempt: opts?.localAttempt ?? handoffCtx.lastLocalAttempt ?? "",
    conversation_summary: compressed.summaryMarkdown,
    compression: {
      raw_chars: compressed.rawChars,
      compressed_chars: compressed.compressedChars,
    },
    image_attachments: [],
    reason: opts?.reason ?? "manual handoff",
    workspace,
    source: "blossom_assistant_manual",
    markdown,
  };
}

export async function copyCursorHandoff(
  context: vscode.ExtensionContext,
  orchestrator: AgentOrchestrator
): Promise<void> {
  const packet = await buildHandoffPacket(context, orchestrator);
  if (!packet) {
    return;
  }

  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (wsFolder) {
    const dir = path.join(wsFolder.uri.fsPath, ".blossom");
    await fs.mkdir(dir, { recursive: true });
    const jsonPath = path.join(dir, "handoff.json");
    const { markdown, ...jsonBody } = packet;
    await fs.writeFile(jsonPath, JSON.stringify(jsonBody, null, 2), "utf8");
  }

  await vscode.env.clipboard.writeText(packet.markdown);
  void vscode.window.showInformationMessage(
    `Handoff copied (${packet.compression.compressed_chars} chars summarized). Open Cursor in this workspace → paste into Agent chat.`
  );
}
