import * as vscode from "vscode";
import { getConfig } from "../config";
import {
  callCursorAgent,
  getCursorApiKey,
  promptForCursorApiKey,
  resolveWorkspaceRoot,
} from "./client";
import { recordSpend, getSpendSummary } from "./spend";

export interface EscalateRequest {
  reason: string;
  contextPrompt: string;
  systemPrompt: string;
  handoffChars?: number;
  rawChars?: number;
}

export interface EscalateResult {
  accepted: boolean;
  text?: string;
  cancelledReason?: string;
}

/**
 * Always ask the user first before calling Cursor Agent (uses subscription tokens).
 */
export async function escalateToCursor(
  context: vscode.ExtensionContext,
  req: EscalateRequest
): Promise<EscalateResult> {
  const cwd = resolveWorkspaceRoot();
  if (!cwd) {
    void vscode.window.showWarningMessage(
      "Open a workspace folder before escalating to Cursor Agent."
    );
    return { accepted: false, cancelledReason: "No workspace folder" };
  }

  let apiKey = await getCursorApiKey(context);
  if (!apiKey) {
    const set = await vscode.window.showWarningMessage(
      "No Cursor API key stored. Set one to escalate?",
      "Set API Key",
      "Cancel"
    );
    if (set !== "Set API Key") {
      return { accepted: false, cancelledReason: "No API key" };
    }
    apiKey = await promptForCursorApiKey(context);
    if (!apiKey) {
      return { accepted: false, cancelledReason: "No API key" };
    }
  }

  const summary = await getSpendSummary(context);
  const model = getConfig().cursor.model;
  const handoffNote =
    req.handoffChars != null
      ? `Handoff size: ~${req.handoffChars} chars compressed${req.rawChars != null ? ` (from ${req.rawChars} raw)` : ""}.`
      : "";

  const choice = await vscode.window.showWarningMessage(
    [
      `Blossom wants to call Cursor Agent (${model}).`,
      `Reason: ${req.reason}`,
      handoffNote,
      "Uses Cursor subscription tokens (no exact $ estimate).",
      `Cursor escalations today: ${summary.todayCalls}, all-time: ${summary.allTimeCalls}.`,
    ]
      .filter(Boolean)
      .join("\n"),
    { modal: true },
    "Allow Cursor",
    "Cancel"
  );

  if (choice !== "Allow Cursor") {
    return { accepted: false, cancelledReason: "User declined" };
  }

  try {
    const result = await callCursorAgent({
      apiKey,
      prompt: req.contextPrompt,
      cwd,
      model,
    });
    await recordSpend(context, { model, reason: req.reason });
    return { accepted: true, text: result.text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Cursor call failed: ${msg}`);
    return { accepted: false, cancelledReason: msg };
  }
}

export async function showSpendReport(
  context: vscode.ExtensionContext
): Promise<void> {
  const summary = await getSpendSummary(context);
  await vscode.window.showInformationMessage(
    `Cursor escalations — today: ${summary.todayCalls}, all-time: ${summary.allTimeCalls}.`,
    { modal: true }
  );
}
