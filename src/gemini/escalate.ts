import * as vscode from "vscode";
import { getConfig } from "../config";
import { callGemini, getGeminiApiKey, promptForGeminiApiKey } from "./client";
import {
  estimateCost,
  formatUsd,
  getSpendSummary,
  recordSpend,
} from "./spend";

export interface EscalateRequest {
  reason: string;
  contextPrompt: string;
  systemPrompt: string;
  estimatedInputTokens?: number;
}

export interface EscalateResult {
  accepted: boolean;
  text?: string;
  cancelledReason?: string;
}

/**
 * Always ask the user first and show current spend before calling Gemini.
 */
export async function escalateToGemini(
  context: vscode.ExtensionContext,
  req: EscalateRequest
): Promise<EscalateResult> {
  let apiKey = await getGeminiApiKey(context);
  if (!apiKey) {
    const set = await vscode.window.showWarningMessage(
      "No Gemini API key stored. Set one to escalate?",
      "Set API Key",
      "Cancel"
    );
    if (set !== "Set API Key") {
      return { accepted: false, cancelledReason: "No API key" };
    }
    apiKey = await promptForGeminiApiKey(context);
    if (!apiKey) {
      return { accepted: false, cancelledReason: "No API key" };
    }
  }

  const summary = await getSpendSummary(context);
  const estIn =
    req.estimatedInputTokens ?? Math.ceil(req.contextPrompt.length / 4);
  const estOut = 800;
  const estCall = estimateCost(estIn, estOut);
  const model = getConfig().geminiModel;

  const choice = await vscode.window.showWarningMessage(
    [
      `Blossom wants to call Gemini (${model}).`,
      `Reason: ${req.reason}`,
      `Est. this call: ~${formatUsd(estCall)} (~${estIn} in / ~${estOut} out tokens)`,
      `Spend today: ${formatUsd(summary.todayUsd)} (${summary.todayCalls} calls)`,
      `Spend all-time: ${formatUsd(summary.allTimeUsd)} (${summary.allTimeCalls} calls)`,
    ].join("\n"),
    { modal: true },
    "Allow Gemini",
    "Cancel"
  );

  if (choice !== "Allow Gemini") {
    return { accepted: false, cancelledReason: "User declined" };
  }

  try {
    const result = await callGemini({
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
    void vscode.window.showErrorMessage(`Gemini call failed: ${msg}`);
    return { accepted: false, cancelledReason: msg };
  }
}

export async function showSpendReport(
  context: vscode.ExtensionContext
): Promise<void> {
  const summary = await getSpendSummary(context);
  const recent = summary.entries
    .slice(-8)
    .reverse()
    .map(
      (e) =>
        `${e.at.slice(0, 19)}  ${formatUsd(e.estimatedUsd)}  ${e.model}  ${e.reason}`
    )
    .join("\n");

  await vscode.window.showInformationMessage(
    [
      `Gemini spend — today ${formatUsd(summary.todayUsd)} (${summary.todayCalls} calls), all-time ${formatUsd(summary.allTimeUsd)} (${summary.allTimeCalls} calls).`,
      recent ? `Recent:\n${recent}` : "No Gemini calls recorded yet.",
    ].join("\n"),
    { modal: true }
  );
}
