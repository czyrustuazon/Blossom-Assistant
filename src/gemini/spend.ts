import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { getConfig } from "../config";

export interface SpendEntry {
  at: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  reason: string;
}

export interface SpendSummary {
  todayUsd: number;
  allTimeUsd: number;
  todayCalls: number;
  allTimeCalls: number;
  entries: SpendEntry[];
}

function spendFile(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "gemini-spend.json");
}

async function ensureStorage(context: vscode.ExtensionContext): Promise<void> {
  await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });
}

async function readEntries(context: vscode.ExtensionContext): Promise<SpendEntry[]> {
  await ensureStorage(context);
  try {
    const raw = await fs.readFile(spendFile(context), "utf8");
    const data = JSON.parse(raw) as { entries?: SpendEntry[] };
    return data.entries ?? [];
  } catch {
    return [];
  }
}

async function writeEntries(
  context: vscode.ExtensionContext,
  entries: SpendEntry[]
): Promise<void> {
  await ensureStorage(context);
  await fs.writeFile(
    spendFile(context),
    JSON.stringify({ entries }, null, 2),
    "utf8"
  );
}

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export function estimateCost(inputTokens: number, outputTokens: number): number {
  const cfg = getConfig();
  return (
    (inputTokens / 1_000_000) * cfg.geminiInputPricePer1M +
    (outputTokens / 1_000_000) * cfg.geminiOutputPricePer1M
  );
}

export async function getSpendSummary(
  context: vscode.ExtensionContext
): Promise<SpendSummary> {
  const entries = await readEntries(context);
  const today = entries.filter((e) => isToday(e.at));
  return {
    todayUsd: today.reduce((s, e) => s + e.estimatedUsd, 0),
    allTimeUsd: entries.reduce((s, e) => s + e.estimatedUsd, 0),
    todayCalls: today.length,
    allTimeCalls: entries.length,
    entries,
  };
}

export async function recordSpend(
  context: vscode.ExtensionContext,
  entry: Omit<SpendEntry, "at" | "estimatedUsd"> & { estimatedUsd?: number }
): Promise<SpendEntry> {
  const estimatedUsd =
    entry.estimatedUsd ?? estimateCost(entry.inputTokens, entry.outputTokens);
  const full: SpendEntry = {
    at: new Date().toISOString(),
    model: entry.model,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    estimatedUsd,
    reason: entry.reason,
  };
  const entries = await readEntries(context);
  entries.push(full);
  await writeEntries(context, entries);
  return full;
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}
