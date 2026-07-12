import * as vscode from "vscode";

export type BlossomMode = "coding";

/** chatRouter = Blossom ChatRouter (OpenAI-compatible). ollama = native Ollama. */
export type ApiBackend = "chatRouter" | "ollama";

export type PersonaSource =
  | "router"
  | "ollama"
  | "settings"
  | "ollama+settings";

export interface BlossomConfig {
  backend: ApiBackend;
  baseUrl: string;
  models: {
    coding: string;
    /** @deprecated unused by coding-only plugin; kept for settings compatibility */
    rp: string;
    /** @deprecated unused by coding-only plugin; kept for settings compatibility */
    japanese: string;
  };
  personaSource: PersonaSource;
  personaModel: string;
  personaSystemPrompt: string;
  geminiModel: string;
  geminiInputPricePer1M: number;
  geminiOutputPricePer1M: number;
  siblingPeek: {
    enabled: boolean;
    maxFiles: number;
    maxBytes: number;
  };
  ui: {
    displayName: string;
    /** Absolute path, workspace-relative path, or empty for built-in media/icon.png */
    iconPath: string;
  };
}

export function getConfig(): BlossomConfig {
  const cfg = vscode.workspace.getConfiguration("blossom");
  const backend = (cfg.get<ApiBackend>("backend") ?? "chatRouter") as ApiBackend;
  const defaultUrl =
    backend === "chatRouter" ? "http://127.0.0.1:8081" : "http://localhost:11434";
  return {
    backend,
    baseUrl: (cfg.get<string>("api.baseUrl") ??
      cfg.get<string>("ollama.baseUrl") ??
      defaultUrl).replace(/\/$/, ""),
    models: {
      coding: cfg.get<string>("models.coding") ?? "local-coder",
      rp: cfg.get<string>("models.rp") ?? "local-voice",
      japanese: cfg.get<string>("models.japanese") ?? "local-voice",
    },
    personaSource: (cfg.get<PersonaSource>("persona.source") ??
      (backend === "chatRouter" ? "router" : "ollama")) as PersonaSource,
    personaModel: cfg.get<string>("persona.model") ?? "",
    personaSystemPrompt: cfg.get<string>("persona.systemPrompt") ?? "",
    geminiModel: cfg.get<string>("gemini.model") ?? "gemini-2.0-flash",
    geminiInputPricePer1M: cfg.get<number>("gemini.inputPricePer1M") ?? 0.1,
    geminiOutputPricePer1M: cfg.get<number>("gemini.outputPricePer1M") ?? 0.4,
    siblingPeek: {
      enabled: cfg.get<boolean>("siblingPeek.enabled") ?? true,
      maxFiles: cfg.get<number>("siblingPeek.maxFiles") ?? 20,
      maxBytes: cfg.get<number>("siblingPeek.maxBytes") ?? 100_000,
    },
    ui: {
      displayName: (cfg.get<string>("ui.displayName") ?? "Blossom Assistant").trim() || "Blossom Assistant",
      iconPath: (cfg.get<string>("ui.iconPath") ?? "").trim(),
    },
  };
}

/** Resolve the configured brand icon to a file URI (falls back to extension media/icon.png). */
export function resolveBrandIconUri(
  extensionUri: vscode.Uri
): vscode.Uri {
  const configured = getConfig().ui.iconPath;
  if (!configured) {
    return vscode.Uri.joinPath(extensionUri, "media", "icon.png");
  }

  // Absolute Windows/Unix path
  if (
    /^[a-zA-Z]:[\\/]/.test(configured) ||
    configured.startsWith("\\\\") ||
    configured.startsWith("/")
  ) {
    return vscode.Uri.file(configured);
  }

  // Workspace-relative
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    return vscode.Uri.joinPath(folder.uri, configured);
  }

  return vscode.Uri.joinPath(extensionUri, "media", "icon.png");
}

export function modelForMode(_mode: BlossomMode = "coding", config = getConfig()): string {
  return config.models.coding;
}
