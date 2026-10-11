import * as vscode from "vscode";
import { getConfig } from "../config";

const SECRET_KEY = "blossom.claude.apiKey";

export async function getClaudeApiKey(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  return context.secrets.get(SECRET_KEY);
}

export async function setClaudeApiKey(
  context: vscode.ExtensionContext,
  key: string
): Promise<void> {
  await context.secrets.store(SECRET_KEY, key.trim());
}

export interface ClaudeResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export async function callClaude(opts: {
  apiKey: string;
  prompt: string;
  system?: string;
  signal?: AbortSignal;
}): Promise<ClaudeResult> {
  const model = getConfig().claude.model;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system: opts.system?.trim() || undefined,
      messages: [{ role: "user", content: opts.prompt }],
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Claude error (${res.status}): ${text || res.statusText}`);
  }

  const data = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const text =
    data.content
      ?.filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("") ?? "";

  return {
    text,
    inputTokens: data.usage?.input_tokens ?? Math.ceil(opts.prompt.length / 4),
    outputTokens: data.usage?.output_tokens ?? Math.ceil(text.length / 4),
  };
}

export async function promptForClaudeApiKey(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  const key = await vscode.window.showInputBox({
    title: "Blossom: Set Claude API Key",
    prompt: "Paste your Anthropic API key",
    password: true,
    ignoreFocusOut: true,
  });
  if (!key?.trim()) {
    return undefined;
  }
  await setClaudeApiKey(context, key);
  void vscode.window.showInformationMessage("Claude API key saved securely.");
  return key.trim();
}
