import * as vscode from "vscode";
import { getConfig } from "../config";
import type { HandoffCompression } from "../escalate/compressHandoff";
import { buildCloudHandoffPrompt } from "../escalate/buildCloudHandoff";
import type { EscalateTarget } from "../agent/prompts";
import { escalateToCursor, type EscalateRequest, type EscalateResult } from "../cursor/escalate";
import { escalateToGemini } from "../gemini/escalate";
import { escalateToClaude } from "../claude/escalate";

export type CloudProvider = EscalateTarget;

export interface CloudEscalationContext {
  compressed: HandoffCompression;
  userText: string;
  localAttempt: string;
  workspace: string;
  systemPrompt: string;
  reason: string;
  repoMap?: string;
  activeFile?: string;
  toolErrors?: string;
  imageAttachments?: Array<{ path: string; metadata?: string }>;
}

export interface CloudEscalationOutcome {
  accepted: boolean;
  text?: string;
  provider?: CloudProvider;
  cancelledReason?: string;
  feedbackSource?: string;
}

const FEEDBACK_SOURCE: Record<CloudProvider, string> = {
  cursor: "blossom_assistant_cursor",
  gemini: "blossom_assistant_gemini",
  claude: "blossom_assistant_claude",
};

function parseFallbackOrder(): CloudProvider[] {
  const raw = getConfig().escalate.fallbackOrder;
  const order: CloudProvider[] = [];
  for (const part of raw.split(",")) {
    const key = part.trim().toLowerCase();
    if (key === "cursor" || key === "gemini" || key === "claude") {
      if (!order.includes(key)) {
        order.push(key);
      }
    }
  }
  return order.length ? order : ["gemini", "claude"];
}

function providerEnabled(provider: CloudProvider): boolean {
  const cfg = getConfig();
  if (provider === "cursor") {
    return cfg.cursor.enabled;
  }
  if (provider === "claude") {
    return cfg.claude.enabled;
  }
  return true;
}

function providerLabel(provider: CloudProvider): string {
  if (provider === "cursor") {
    return "Cursor";
  }
  if (provider === "claude") {
    return "Claude";
  }
  return "Gemini";
}

async function callProvider(
  context: vscode.ExtensionContext,
  provider: CloudProvider,
  req: EscalateRequest
): Promise<EscalateResult> {
  if (provider === "cursor") {
    return escalateToCursor(context, req);
  }
  if (provider === "claude") {
    return escalateToClaude(context, req);
  }
  return escalateToGemini(context, req);
}

export async function runCloudEscalation(
  context: vscode.ExtensionContext,
  opts: {
    target: CloudProvider;
    ctx: CloudEscalationContext;
    onStatus?: (text: string) => void;
  }
): Promise<CloudEscalationOutcome> {
  const cfg = getConfig();
  const order = parseFallbackOrder();
  const startIdx = Math.max(0, order.indexOf(opts.target));
  const tryOrder = order.slice(startIdx >= 0 ? startIdx : 0);

  let priorAttempt: { provider: string; text: string } | undefined;

  for (const provider of tryOrder) {
    if (!providerEnabled(provider)) {
      opts.onStatus?.(
        `${providerLabel(provider)} escalate disabled — trying next provider…`
      );
      continue;
    }

    const handoffPrompt = buildCloudHandoffPrompt({
      provider,
      compressed: opts.ctx.compressed,
      userText: opts.ctx.userText,
      localAttempt: opts.ctx.localAttempt,
      workspace: opts.ctx.workspace,
      repoMap: opts.ctx.repoMap,
      activeFile: opts.ctx.activeFile,
      toolErrors: opts.ctx.toolErrors,
      imageAttachments: opts.ctx.imageAttachments,
      priorProviderAttempt: priorAttempt,
    });

    const req: EscalateRequest = {
      reason: opts.ctx.reason,
      contextPrompt: handoffPrompt,
      systemPrompt: opts.ctx.systemPrompt,
      handoffChars: opts.ctx.compressed.compressedChars,
      rawChars: opts.ctx.compressed.rawChars,
    };

    opts.onStatus?.(`Calling ${providerLabel(provider)}…`);
    const result = await callProvider(context, provider, req);

    if (result.accepted && result.text) {
      return {
        accepted: true,
        text: result.text,
        provider,
        feedbackSource: FEEDBACK_SOURCE[provider],
      };
    }

    if (result.cancelledReason) {
      opts.onStatus?.(
        `${providerLabel(provider)} skipped: ${result.cancelledReason}`
      );
    }

    if (result.text) {
      priorAttempt = { provider, text: result.text };
    }

    if (!cfg.escalate.fallbackEnabled) {
      return {
        accepted: false,
        cancelledReason: result.cancelledReason || "User declined",
      };
    }
  }

  return {
    accepted: false,
    cancelledReason: "All escalation providers declined or failed",
  };
}

export function cloudProviderDisplayName(provider: CloudProvider): string {
  return providerLabel(provider);
}
