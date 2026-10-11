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
  cursor: {
    enabled: boolean;
    model: string;
  };
  claude: {
    enabled: boolean;
    model: string;
    inputPricePer1M: number;
    outputPricePer1M: number;
  };
  handoff: {
    maxSummaryChars: number;
    summarizeThresholdChars: number;
    summarizeProvider: "local" | "gemini" | "rules-only";
  };
  escalate: {
    fallbackOrder: string;
    fallbackEnabled: boolean;
    /** Show picker before cloud calls when local model requests escalation. */
    askFirst: boolean;
    /** Parse cloud escalation answers into Apply cards when fenced edits are present. */
    applyFromCloud: boolean;
  };
  deescalate: {
    /** Offer "Retry with local Blossom" after a cloud escalation answer. */
    enabled: boolean;
  };
  vision: {
    /**
     * local-caption = offline VL/OCR → inject [IMAGE CAPTION] (preferred).
     * metadata-only = dimensions/RGB only.
     * escalate = cloud/Cursor path (not the offline product default).
     */
    onAttach: "local-caption" | "metadata-only" | "escalate";
    caption: {
      enabled: boolean;
      /** Ollama multimodal model tag (e.g. moondream, llava, qwen2-vl). */
      model: string;
      /** Local Ollama base URL for vision (may differ from ChatRouter coding URL). */
      ollamaBaseUrl: string;
      timeoutMs: number;
      ocrFallback: boolean;
      ocrCommand: string;
      maxImages: number;
      /** Unload Ollama models before VL to free VRAM (R1). */
      unloadCoderFirst: boolean;
    };
  };
  siblingPeek: {
    enabled: boolean;
    maxFiles: number;
    maxBytes: number;
  };
  commands: {
    /** Pause the agent and ask before running shell commands. */
    askBeforeRun: boolean;
    /**
     * Allowlisted commands skip the prompt.
     * Entries: exact command, first-token (`ls`), or prefix with `*` (`git *`).
     */
    allowlist: string[];
  };
  agent: {
    /**
     * Which tool definitions to inject into the prompt.
     * auto = derive from prompt tier (tiny→minimal, plan→research, full→full).
     */
    toolProfile: "auto" | "minimal" | "research" | "full";
    /** Max chars for the latest tool result in the agent transcript. */
    toolResultMaxChars: number;
    /** Hard cap on agent tool rounds per turn. */
    maxToolRounds: number;
    /**
     * Human-in-the-loop gates:
     * off | confirmTools (pause every N rounds) | planSteps (pause after edits).
     */
    stepMode: "off" | "confirmTools" | "planSteps";
    /** When stepMode=confirmTools, pause after this many tool rounds. */
    confirmToolsAfterRounds: number;
    /** After tool-round cap, run one local self-critique pass before ESCALATE_*. */
    localRetryBeforeEscalate: boolean;
    /** Run independent read-only tools in parallel within a round. */
    parallelTools: boolean;
  };
  /** Durable ChatRouter coding_lessons memory (search inject + learn). */
  memory: {
    enabled: boolean;
    /** Auto-learn from a successful local turn summary. */
    autoLearn: boolean;
  };
  /**
   * Matching-decomp workspace pack (nlpp-decomp): policy inject, attach compress,
   * append-only TOML / relink edit gates. Distinct from EngPatcher patch guards.
   */
  decomp: {
    enabled: boolean;
    /** Max chars for a single attached file when in a decomp workspace. */
    attachMaxChars: number;
    /** Soft budget for all FILE attaches in a decomp turn. */
    totalAttachBudget: number;
    /** Block Apply while `ctrdecomp relink` is running. */
    blockDuringRelink: boolean;
  };
  ui: {
    displayName: string;
    /** Absolute path, workspace-relative path, or empty for built-in media/icon.png */
    iconPath: string;
  };
  ghidra: {
    enabled: boolean;
    baseUrl: string;
    autoDiscover: boolean;
    discoveryPorts: number[];
    cacheTtlMs: number;
    /** http = read_ghidra only; mcp = stdio MCP bridge; both = prefer MCP when connected */
    transport: "http" | "mcp" | "both";
    mcp: {
      enabled: boolean;
      command: string;
      args: string[];
      env: Record<string, string>;
      toolAllowlist: string[];
    };
  };
  /**
   * Public-internet research tools (web_search / fetch_url / browser_*).
   * Default on; set false for fully offline. Distinct from cloud LLM escalate.
   */
  web: {
    enabled: boolean;
    /** Pause before the first network tool call of a turn. */
    askBeforeUse: boolean;
    fetchMaxChars: number;
    browser: {
      channel: "chrome" | "msedge";
      headless: boolean;
    };
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
    cursor: {
      enabled: cfg.get<boolean>("cursor.enabled") ?? false,
      model: cfg.get<string>("cursor.model") ?? "composer-2.5",
    },
    claude: {
      enabled: cfg.get<boolean>("claude.enabled") ?? true,
      model: cfg.get<string>("claude.model") ?? "claude-sonnet-4-20250514",
      inputPricePer1M: cfg.get<number>("claude.inputPricePer1M") ?? 3.0,
      outputPricePer1M: cfg.get<number>("claude.outputPricePer1M") ?? 15.0,
    },
    handoff: {
      maxSummaryChars: cfg.get<number>("handoff.maxSummaryChars") ?? 6000,
      summarizeThresholdChars:
        cfg.get<number>("handoff.summarizeThresholdChars") ?? 12000,
      summarizeProvider:
        (cfg.get<string>("handoff.summarizeProvider") as
          | "local"
          | "gemini"
          | "rules-only") ?? "local",
    },
    escalate: {
      fallbackOrder:
        cfg.get<string>("escalate.fallbackOrder") ?? "gemini,claude",
      fallbackEnabled: cfg.get<boolean>("escalate.fallbackEnabled") ?? true,
      askFirst: cfg.get<boolean>("escalate.askFirst") ?? true,
      applyFromCloud: cfg.get<boolean>("escalate.applyFromCloud") ?? true,
    },
    deescalate: {
      enabled: cfg.get<boolean>("deescalate.enabled") ?? true,
    },
    vision: {
      onAttach:
        (cfg.get<string>("vision.onAttach") as
          | "local-caption"
          | "metadata-only"
          | "escalate") ?? "local-caption",
      caption: {
        enabled: cfg.get<boolean>("vision.caption.enabled") ?? true,
        model: (cfg.get<string>("vision.caption.model") ?? "moondream").trim() || "moondream",
        ollamaBaseUrl: (
          cfg.get<string>("vision.caption.ollamaBaseUrl") ??
          "http://127.0.0.1:11434"
        )
          .trim()
          .replace(/\/$/, "") || "http://127.0.0.1:11434",
        timeoutMs: cfg.get<number>("vision.caption.timeoutMs") ?? 120_000,
        ocrFallback: cfg.get<boolean>("vision.caption.ocrFallback") ?? true,
        ocrCommand:
          (cfg.get<string>("vision.caption.ocrCommand") ?? "tesseract").trim() ||
          "tesseract",
        maxImages: cfg.get<number>("vision.caption.maxImages") ?? 3,
        unloadCoderFirst:
          cfg.get<boolean>("vision.caption.unloadCoderFirst") ?? true,
      },
    },
    memory: {
      enabled: cfg.get<boolean>("memory.enabled") ?? true,
      autoLearn: cfg.get<boolean>("memory.autoLearn") ?? true,
    },
    decomp: {
      enabled: cfg.get<boolean>("decomp.enabled") ?? true,
      attachMaxChars: cfg.get<number>("decomp.attachMaxChars") ?? 3500,
      totalAttachBudget: cfg.get<number>("decomp.totalAttachBudget") ?? 14_000,
      blockDuringRelink: cfg.get<boolean>("decomp.blockDuringRelink") ?? true,
    },
    siblingPeek: {
      enabled: cfg.get<boolean>("siblingPeek.enabled") ?? true,
      maxFiles: cfg.get<number>("siblingPeek.maxFiles") ?? 20,
      maxBytes: cfg.get<number>("siblingPeek.maxBytes") ?? 100_000,
    },
    commands: {
      askBeforeRun: cfg.get<boolean>("commands.askBeforeRun") ?? true,
      allowlist: (cfg.get<string[]>("commands.allowlist") ?? [])
        .map((s) => String(s || "").trim())
        .filter(Boolean),
    },
    agent: {
      toolProfile: (cfg.get<string>("agent.toolProfile") as
        | "auto"
        | "minimal"
        | "research"
        | "full") ?? "auto",
      toolResultMaxChars: cfg.get<number>("agent.toolResultMaxChars") ?? 2500,
      maxToolRounds: cfg.get<number>("agent.maxToolRounds") ?? 12,
      stepMode: (cfg.get<string>("agent.stepMode") as
        | "off"
        | "confirmTools"
        | "planSteps") ?? "off",
      confirmToolsAfterRounds:
        cfg.get<number>("agent.confirmToolsAfterRounds") ?? 3,
      localRetryBeforeEscalate:
        cfg.get<boolean>("agent.localRetryBeforeEscalate") ?? true,
      parallelTools: cfg.get<boolean>("agent.parallelTools") ?? true,
    },
    ui: {
      displayName: (cfg.get<string>("ui.displayName") ?? "Blossom Assistant").trim() || "Blossom Assistant",
      iconPath: (cfg.get<string>("ui.iconPath") ?? "").trim(),
    },
    ghidra: {
      enabled: cfg.get<boolean>("ghidra.enabled") ?? true,
      baseUrl: (cfg.get<string>("ghidra.baseUrl") ?? "").trim(),
      autoDiscover: cfg.get<boolean>("ghidra.autoDiscover") ?? true,
      discoveryPorts: (cfg.get<number[]>("ghidra.discoveryPorts") ?? [8089, 8192, 8080, 9090])
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n > 0),
      cacheTtlMs: cfg.get<number>("ghidra.cacheTtlMs") ?? 60_000,
      transport:
        (cfg.get<string>("ghidra.transport") as "http" | "mcp" | "both") ?? "both",
      mcp: {
        enabled: cfg.get<boolean>("ghidra.mcp.enabled") ?? true,
        command: (cfg.get<string>("ghidra.mcp.command") ?? "").trim(),
        args: (cfg.get<string[]>("ghidra.mcp.args") ?? [])
          .map((s) => String(s || "").trim())
          .filter(Boolean),
        env: parseEnvRecord(cfg.get<Record<string, string>>("ghidra.mcp.env") ?? {}),
        toolAllowlist: (cfg.get<string[]>("ghidra.mcp.toolAllowlist") ?? [])
          .map((s) => String(s || "").trim())
          .filter(Boolean),
      },
    },
    web: {
      enabled: cfg.get<boolean>("web.enabled") ?? true,
      askBeforeUse: cfg.get<boolean>("web.askBeforeUse") ?? true,
      fetchMaxChars: cfg.get<number>("web.fetchMaxChars") ?? 20_000,
      browser: {
        channel:
          (cfg.get<string>("web.browser.channel") as "chrome" | "msedge") ??
          "chrome",
        headless: cfg.get<boolean>("web.browser.headless") ?? true,
      },
    },
  };
}

function parseEnvRecord(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.trim()) {
      out[k.trim()] = String(v ?? "");
    }
  }
  return out;
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
