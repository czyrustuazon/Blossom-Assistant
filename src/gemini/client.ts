import * as vscode from "vscode";
import { getConfig } from "../config";

const SECRET_KEY = "blossom.gemini.apiKey";

export async function getGeminiApiKey(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  return context.secrets.get(SECRET_KEY);
}

export async function setGeminiApiKey(
  context: vscode.ExtensionContext,
  key: string
): Promise<void> {
  await context.secrets.store(SECRET_KEY, key.trim());
}

export async function clearGeminiApiKey(
  context: vscode.ExtensionContext
): Promise<void> {
  await context.secrets.delete(SECRET_KEY);
}

export interface GeminiResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export async function callGemini(opts: {
  apiKey: string;
  prompt: string;
  system?: string;
  signal?: AbortSignal;
}): Promise<GeminiResult> {
  const model = getConfig().geminiModel;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;

  const body = {
    systemInstruction: opts.system
      ? { parts: [{ text: opts.system }] }
      : undefined,
    contents: [
      {
        role: "user",
        parts: [{ text: opts.prompt }],
      },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini error (${res.status}): ${text || res.statusText}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
    };
  };

  const text =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ??
    "";

  return {
    text,
    inputTokens: data.usageMetadata?.promptTokenCount ?? Math.ceil(opts.prompt.length / 4),
    outputTokens:
      data.usageMetadata?.candidatesTokenCount ?? Math.ceil(text.length / 4),
  };
}

export async function promptForGeminiApiKey(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  const key = await vscode.window.showInputBox({
    title: "Blossom: Set Gemini API Key",
    prompt: "Paste your Google AI Studio / Gemini API key",
    password: true,
    ignoreFocusOut: true,
  });
  if (!key?.trim()) {
    return undefined;
  }
  await setGeminiApiKey(context, key);
  void vscode.window.showInformationMessage("Gemini API key saved securely.");
  return key.trim();
}
