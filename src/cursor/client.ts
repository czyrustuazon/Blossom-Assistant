import * as vscode from "vscode";

const SECRET_KEY = "blossom.cursor.apiKey";

export async function getCursorApiKey(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  return context.secrets.get(SECRET_KEY);
}

export async function setCursorApiKey(
  context: vscode.ExtensionContext,
  key: string
): Promise<void> {
  await context.secrets.store(SECRET_KEY, key.trim());
}

export async function promptForCursorApiKey(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  const key = await vscode.window.showInputBox({
    title: "Blossom: Set Cursor API Key",
    prompt: "Paste your Cursor API key (from cursor.com/settings)",
    password: true,
    ignoreFocusOut: true,
  });
  if (!key?.trim()) {
    return undefined;
  }
  await setCursorApiKey(context, key);
  void vscode.window.showInformationMessage("Cursor API key saved securely.");
  return key.trim();
}

export interface CursorAgentResult {
  text: string;
  status?: string;
}

export async function callCursorAgent(opts: {
  apiKey: string;
  prompt: string;
  cwd: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<CursorAgentResult> {
  const { Agent } = await import("@cursor/sdk");
  try {
    const result = await Agent.prompt(opts.prompt, {
      apiKey: opts.apiKey,
      model: { id: opts.model ?? "composer-2.5" },
      local: {
        cwd: opts.cwd,
        settingSources: ["all"],
      },
    });
    const text =
      typeof result.result === "string"
        ? result.result
        : result.result != null
          ? JSON.stringify(result.result)
          : "";
    if (!text.trim() && result.error?.message) {
      throw new Error(result.error.message);
    }
    return { text, status: String(result.status ?? "") };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cursor Agent failed: ${msg}`);
  }
}

export function resolveWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    return undefined;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const match = vscode.workspace.getWorkspaceFolder(active);
    if (match) {
      return match.uri.fsPath;
    }
  }
  return folders[0].uri.fsPath;
}
