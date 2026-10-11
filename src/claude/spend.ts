import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { getConfig } from "../config";

interface SpendEntry {
  at: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  reason: string;
}

interface SpendFile {
  entries: SpendEntry[];
}

function spendPath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "claude-spend.json");
}

function estimateCost(inputTokens: number, outputTokens: number): number {
  const cfg = getConfig();
  return (
    (inputTokens / 1_000_000) * cfg.claude.inputPricePer1M +
    (outputTokens / 1_000_000) * cfg.claude.outputPricePer1M
  );
}

export function formatUsd(n: number): string {
  return n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`;
}

async function loadSpend(context: vscode.ExtensionContext): Promise<SpendFile> {
  try {
    await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });
    const raw = await fs.readFile(spendPath(context), "utf8");
    return JSON.parse(raw) as SpendFile;
  } catch {
    return { entries: [] };
  }
}

async function saveSpend(
  context: vscode.ExtensionContext,
  data: SpendFile
): Promise<void> {
  await fs.writeFile(spendPath(context), JSON.stringify(data, null, 2), "utf8");
}

export async function recordSpend(
  context: vscode.ExtensionContext,
  opts: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    reason: string;
  }
): Promise<void> {
  const data = await loadSpend(context);
  data.entries.push({
    at: new Date().toISOString(),
    model: opts.model,
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
    estimatedUsd: estimateCost(opts.inputTokens, opts.outputTokens),
    reason: opts.reason.slice(0, 200),
  });
  if (data.entries.length > 500) {
    data.entries = data.entries.slice(-500);
  }
  await saveSpend(context, data);
}

export async function getSpendSummary(context: vscode.ExtensionContext): Promise<{
  todayUsd: number;
  allTimeUsd: number;
  todayCalls: number;
  allTimeCalls: number;
}> {
  const data = await loadSpend(context);
  const today = new Date().toISOString().slice(0, 10);
  let todayUsd = 0;
  let todayCalls = 0;
  let allTimeUsd = 0;
  for (const e of data.entries) {
    allTimeUsd += e.estimatedUsd;
    if (e.at.startsWith(today)) {
      todayUsd += e.estimatedUsd;
      todayCalls++;
    }
  }
  return {
    todayUsd,
    allTimeUsd,
    todayCalls,
    allTimeCalls: data.entries.length,
  };
}
