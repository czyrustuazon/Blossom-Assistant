import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

interface SpendEntry {
  at: string;
  model: string;
  reason: string;
}

interface SpendFile {
  entries: SpendEntry[];
}

function spendPath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "cursor-spend.json");
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
  opts: { model: string; reason: string }
): Promise<void> {
  const data = await loadSpend(context);
  data.entries.push({
    at: new Date().toISOString(),
    model: opts.model,
    reason: opts.reason.slice(0, 200),
  });
  if (data.entries.length > 500) {
    data.entries = data.entries.slice(-500);
  }
  await saveSpend(context, data);
}

export async function getSpendSummary(context: vscode.ExtensionContext): Promise<{
  todayCalls: number;
  allTimeCalls: number;
}> {
  const data = await loadSpend(context);
  const today = new Date().toISOString().slice(0, 10);
  const todayCalls = data.entries.filter((e) => e.at.startsWith(today)).length;
  return { todayCalls, allTimeCalls: data.entries.length };
}
