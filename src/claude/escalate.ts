import * as vscode from "vscode";
import { getConfig } from "../config";
import { callClaude, getClaudeApiKey, promptForClaudeApiKey } from "./client";
import { formatUsd, getSpendSummary, recordSpend } from "./spend";

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

export async function escalateToClaude(
  context: vscode.ExtensionContext,
  req: EscalateRequest
): Promise<EscalateResult> {
  if (!getConfig().claude.enabled) {
    return { accepted: false, cancelledReason: "Claude escalate disabled" };
  }

  let apiKey = await getClaudeApiKey(context);
  if (!apiKey) {
    const set = await vscode.window.showWarningMessage(
      "No Claude API key stored. Set one to escalate?",
      "Set API Key",
      "Cancel"
    );
    if (set !== "Set API Key") {
      return { accepted: false, cancelledReason: "No API key" };
    }
    apiKey = await promptForClaudeApiKey(context);
    if (!apiKey) {
      return { accepted: false, cancelledReason: "No API key" };
    }
  }

  const summary = await getSpendSummary(context);
  const model = getConfig().claude.model;
  const estIn = Math.ceil(req.contextPrompt.length / 4);
  const estOut = 800;
  const handoffNote =
    req.handoffChars != null
      ? `Handoff: ~${req.handoffChars} chars compressed${req.rawChars != null ? ` (from ${req.rawChars} raw)` : ""}.`
      : "";

  const choice = await vscode.window.showWarningMessage(
    [
      `Blossom wants to call Claude (${model}).`,
      `Reason: ${req.reason}`,
      handoffNote,
      `Est. tokens: ~${estIn} in / ~${estOut} out`,
      `Claude spend today: ${formatUsd(summary.todayUsd)} (${summary.todayCalls} calls)`,
    ]
      .filter(Boolean)
      .join("\n"),
    { modal: true },
    "Allow Claude",
    "Cancel"
  );

  if (choice !== "Allow Claude") {
    return { accepted: false, cancelledReason: "User declined" };
  }

  try {
    const result = await callClaude({
      apiKey,
      prompt: req.contextPrompt,
      system: req.systemPrompt,
    });
    await recordSpend(context, {
      model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      reason: req.reason,
    });
    return { accepted: true, text: result.text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Claude call failed: ${msg}`);
    return { accepted: false, cancelledReason: msg };
  }
}

export async function showSpendReport(
  context: vscode.ExtensionContext
): Promise<void> {
  const summary = await getSpendSummary(context);
  await vscode.window.showInformationMessage(
    `Claude spend — today: ${formatUsd(summary.todayUsd)} (${summary.todayCalls} calls), all-time: ${formatUsd(summary.allTimeUsd)} (${summary.allTimeCalls} calls).`,
    { modal: true }
  );
}
