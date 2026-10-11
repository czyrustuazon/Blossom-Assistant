import * as vscode from "vscode";
import { getConfig } from "../config";

/** Tool names that touch the public internet. */
export const WEB_TOOL_NAMES = new Set([
  "web_search",
  "fetch_url",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_scroll",
  "browser_screenshot",
]);

/** First network approval for the current agent turn (when askBeforeUse). */
let turnNetworkApproved = false;

export function isWebTool(name: string): boolean {
  return WEB_TOOL_NAMES.has(name);
}

export function isWebConfigEnabled(): boolean {
  return getConfig().web.enabled;
}

/** Web tools are available only when blossom.web.enabled is on. */
export function isWebEffectivelyEnabled(): boolean {
  return isWebConfigEnabled();
}

export function resetWebTurnGate(): void {
  turnNetworkApproved = false;
}

export function webDisabledMessage(): string {
  return (
    "Web tools are disabled (blossom.web.enabled is false). " +
    "Re-enable that setting to let Blossom search/fetch/browse on its own when needed. " +
    "Do not invent search/fetch results."
  );
}

/**
 * Ask before the first network tool of a turn when askBeforeUse is on.
 * Returns false if the user denied.
 */
export async function confirmWebUse(
  toolName: string,
  detail: string,
  opts?: { fastMode?: boolean; signal?: AbortSignal }
): Promise<boolean> {
  if (!isWebEffectivelyEnabled()) {
    return false;
  }
  const cfg = getConfig().web;
  if (opts?.fastMode || !cfg.askBeforeUse || turnNetworkApproved) {
    turnNetworkApproved = true;
    return true;
  }
  if (opts?.signal?.aborted) {
    return false;
  }

  const clipped = detail.replace(/\s+/g, " ").trim().slice(0, 120);
  const choice = await vscode.window.showInformationMessage(
    `Blossom wants network access for ${toolName}${clipped ? `: ${clipped}` : ""}`,
    { modal: true },
    "Allow this turn",
    "Always allow (disable ask)",
    "Deny"
  );

  if (opts?.signal?.aborted || !choice || choice === "Deny") {
    return false;
  }

  if (choice === "Always allow (disable ask)") {
    await vscode.workspace
      .getConfiguration("blossom")
      .update("web.askBeforeUse", false, vscode.ConfigurationTarget.Global);
  }

  turnNetworkApproved = true;
  return true;
}

export function webStatusLabel(toolName: string): string {
  switch (toolName) {
    case "web_search":
      return "Web search…";
    case "fetch_url":
      return "Fetching URL…";
    case "browser_navigate":
    case "browser_snapshot":
    case "browser_click":
    case "browser_type":
    case "browser_scroll":
    case "browser_screenshot":
      return "Browser…";
    default:
      return `Running ${toolName}…`;
  }
}
