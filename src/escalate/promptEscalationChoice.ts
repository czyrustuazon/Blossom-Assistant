import * as vscode from "vscode";
import { getConfig } from "../config";
import type { EscalateTarget } from "../agent/prompts";

export type CloudProvider = EscalateTarget;

export type EscalationChoiceResult =
  | { action: "provider"; provider: CloudProvider }
  | { action: "local" }
  | { action: "cancel" };

interface EscalationPickItem extends vscode.QuickPickItem {
  result: EscalationChoiceResult;
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

/**
 * Ask the user how to proceed when local Blossom is uncertain — before any
 * cloud API call (Claude-style "pick what to do next").
 */
export async function promptEscalationChoice(opts: {
  reason: string;
  suggested?: CloudProvider;
  forVision?: boolean;
  handoffChars?: number;
}): Promise<EscalationChoiceResult> {
  const cfg = getConfig();
  const suggested = opts.suggested ?? "gemini";
  const handoff =
    opts.handoffChars != null
      ? ` Session summary ready (~${opts.handoffChars} chars).`
      : "";

  const items: EscalationPickItem[] = [];

  if (providerEnabled("cursor")) {
    items.push({
      label: `$(${opts.forVision ? "eye" : "rocket"}) Cursor Agent`,
      description: opts.forVision
        ? "Read images from disk · tools · MCP · subscription"
        : "Tools · MCP · shell · subscription tokens",
      detail:
        suggested === "cursor"
          ? "Recommended for this escalation"
          : "Best when tools or repo access are needed",
      result: { action: "provider", provider: "cursor" },
    });
  }

  if (providerEnabled("gemini")) {
    items.push({
      label: "$(sparkle) Gemini",
      description: opts.forVision
        ? "Text-only — image paths in prompt, no pixels"
        : "Text-only · fast · Google API key",
      detail:
        suggested === "gemini"
          ? "Recommended for this escalation"
          : "Cheaper text-only second opinion",
      result: { action: "provider", provider: "gemini" },
    });
  }

  if (providerEnabled("claude")) {
    items.push({
      label: "$(comment-discussion) Claude",
      description: opts.forVision
        ? "Text-only — image paths in prompt, no pixels"
        : `Text-only · ${cfg.claude.model} · Anthropic API key`,
      detail:
        suggested === "claude"
          ? "Recommended for this escalation"
          : "Stronger text reasoning when local attempt failed",
      result: { action: "provider", provider: "claude" },
    });
  }

  items.push({
    label: "$(home) Stay with local Blossom",
    description: "Keep the local attempt — no cloud call",
    result: { action: "local" },
  });

  items.push({
    label: "$(close) Cancel",
    description: "Dismiss escalation for this turn",
    result: { action: "cancel" },
  });

  const pick = await vscode.window.showQuickPick(items, {
    title: opts.forVision
      ? "Blossom is unsure — image attached (local coder is text-only)"
      : "Blossom is unsure — how should we continue?",
    placeHolder: `Reason: ${opts.reason.slice(0, 120)}${handoff}`,
    ignoreFocusOut: true,
  });

  if (!pick) {
    return { action: "cancel" };
  }
  return pick.result;
}
