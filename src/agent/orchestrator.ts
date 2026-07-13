import * as vscode from "vscode";
import type { BlossomMode } from "../config";
import { getConfig, modelForMode } from "../config";
import { escalateToGemini } from "../gemini/escalate";
import { learnCodingLesson } from "../memory/client";
import {
  chatOnce,
  labelIntelSource,
  LlmError,
  type BlossomThought,
  type OllamaMessage,
  type OllamaToolCall,
  streamChat,
} from "../ollama/client";
import { buildSystemPrompt, ensureChatRouterCodingRoute, stripEscalateMarker, wrapUserPromptForCodingAgent } from "./prompts";
import { stripSlashCommand } from "./router";
import {
  buildCodingSummaryInfo,
  type CodingSummaryInfo,
  parseModelSummaryNotes,
  proposeEditsFromAssistantReply,
  stripCodingSummarySection,
} from "./applyFromResponse";
import { parseAutoApplyIntent } from "./autoApply";
import { enrichWithEditorContext } from "./editorContext";
import {
  AGENT_TOOLS,
  applyPendingEdit,
  proposeFileDelete,
  rejectPendingEdit,
  runTool,
  suggestRelatedFolders,
  type PendingEdit,
} from "./tools";

export interface ChatHistoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface OrchestratorEvents {
  onStatus: (text: string) => void;
  onMode: (mode: BlossomMode, model: string, source: string) => void;
  onToken: (delta: string) => void;
  onThought: (thought: BlossomThought) => void;
  onTool: (name: string, detail: string) => void;
  onPendingEdit: (edit: PendingEdit) => void;
  onEditApplied: (id: string, path: string) => void;
  onCodingSummary: (summary: CodingSummaryInfo) => void;
  onDone: (finalText: string) => void;
  onError: (message: string) => void;
}

const MAX_TOOL_ROUNDS = 8;

function isAbortLike(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const name = (err as { name?: string }).name;
  return name === "AbortError" || name === "AbortSignal";
}

function formatChatError(err: unknown): string {
  if (err instanceof LlmError) {
    return err.message;
  }
  if (err instanceof Error) {
    const m = err.message || err.name;
    if (/failed to fetch|networkerror|econnrefused|fetch failed/i.test(m)) {
      const url = getConfig().baseUrl;
      return `Could not reach the LLM at ${url}. Is ChatRouter / Ollama running? (${m})`;
    }
    return m;
  }
  return String(err);
}

/** ChatRouter emits pipeline/infra steps; keep the trail closer to useful reasoning. */
function isUsefulThought(thought: BlossomThought): boolean {
  const step = (thought.step ?? "").toLowerCase();
  if (!step) {
    return Boolean(thought.message?.trim());
  }
  // Always surface failure-related thoughts and which backend answered
  if (
    step.includes("error") ||
    step === "fallback" ||
    step === "cloud_error" ||
    step === "cloud" ||
    step === "intel_ready" ||
    step === "model_reasoning"
  ) {
    return true;
  }
  // Hide model swap / RAG / learn plumbing — that's backend ops, not "thinking".
  if (
    step.startsWith("swap_") ||
    step === "web_memory" ||
    step === "web_search" ||
    step === "coding_lessons" ||
    step === "coder_infer" ||
    step === "learn" ||
    step === "persona" ||
    step.startsWith("swap")
  ) {
    return false;
  }
  return true;
}

export class AgentOrchestrator {
  private history: OllamaMessage[] = [];
  private autoApply = true;
  private abort?: AbortController;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.autoApply = this.readConfiguredAutoApply();
  }

  private readConfiguredAutoApply(): boolean {
    return (
      vscode.workspace
        .getConfiguration("blossom")
        .get<boolean>("edits.autoApply", true) ?? true
    );
  }

  getAutoApply(): boolean {
    return this.autoApply;
  }

  setAutoApply(enabled: boolean): void {
    this.autoApply = enabled;
    // Persist so the next session / window starts with the same preference.
    void vscode.workspace
      .getConfiguration("blossom")
      .update("edits.autoApply", enabled, vscode.ConfigurationTarget.Global);
  }

  clearHistory(): void {
    this.history = [];
    this.autoApply = this.readConfiguredAutoApply();
  }

  cancel(): void {
    this.abort?.abort();
  }

  async applyEdit(id: string): Promise<string> {
    return applyPendingEdit(id);
  }

  async rejectEdit(id: string): Promise<void> {
    return rejectPendingEdit(id);
  }

  /** Quiet history breadcrumb after a write — do NOT spam the chat with "Done". */
  noteFileApplied(path: string, auto: boolean): string {
    // Keep a short memory for the model; return empty so the UI does not print "Done".
    this.history.push({
      role: "assistant",
      content: auto
        ? `(Saved \`${path}\` to disk.)`
        : `(User applied \`${path}\`.)`,
    });
    if (this.history.length > 40) {
      this.history = this.history.slice(-40);
    }
    return "";
  }

  private async deliverPendingEdit(
    edit: PendingEdit,
    events: OrchestratorEvents,
    applyNow: boolean
  ): Promise<void> {
    if (!applyNow) {
      events.onPendingEdit(edit);
      return;
    }
    try {
      const path = await applyPendingEdit(edit.id);
      events.onStatus(`Auto-applied: ${path}`);
      events.onEditApplied(edit.id, path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      events.onStatus(`Auto-apply failed (${msg}); awaiting manual Apply.`);
      events.onPendingEdit(edit);
    }
  }

  async handleUserMessage(
    rawText: string,
    events: OrchestratorEvents
  ): Promise<void> {
    this.abort?.abort();
    this.abort = new AbortController();
    const signal = this.abort.signal;

    try {
      const mode: BlossomMode = "coding";
      const userText = stripSlashCommand(rawText) || rawText;
      const autoIntent = parseAutoApplyIntent(userText);
      if (autoIntent.disableSession) {
        this.autoApply = false;
        events.onStatus("Auto-apply off for this session.");
      } else if (autoIntent.enableSession) {
        this.autoApply = true;
        events.onStatus("Auto-apply on for this session.");
      }
      const applyNow = this.autoApply || !!autoIntent.applyOnce;

      const model = modelForMode(mode);
      events.onMode(mode, model, "coding");

      const enriched = await enrichWithEditorContext(userText, {
        forceActiveEditor: true,
        extensionContext: this.context,
        includeRepoKnowledge: true,
      });
      if (enriched.attached.length > 0) {
        events.onTool("editor_context", enriched.attached.join(", "));
      } else {
        events.onStatus(
          "No editor file attached — open the file in a tab, then ask again."
        );
      }

      const system = await buildSystemPrompt();
      const cfg = getConfig();
      let promptUser = enriched.promptText;
      if (cfg.backend === "chatRouter") {
        // ChatRouter drops extension system prompts — inject protocol into the user turn.
        promptUser = wrapUserPromptForCodingAgent(promptUser);
        promptUser = ensureChatRouterCodingRoute(promptUser);
        events.onStatus("Waiting on ChatRouter (coding)…");
      }

      // ChatRouter only uses the last user message for routing — put editor
      // context there and force the coding keyword path.
      const messages: OllamaMessage[] =
        cfg.backend === "chatRouter"
          ? [...this.history, { role: "user", content: promptUser }]
          : [
              { role: "system", content: await this.augmentSystem(system) },
              ...this.history,
              { role: "user", content: promptUser },
            ];

      this.history.push({ role: "user", content: userText });

      const useTools = cfg.backend === "ollama";
      let assistantText = "";
      let codingEdits: PendingEdit[] = [];
      let intelSource: string | undefined;

      if (useTools) {
        assistantText = await this.runToolLoop(
          model,
          messages,
          events,
          signal,
          applyNow,
          (edit) => {
            codingEdits.push(edit);
          }
        );
        intelSource = "ollama";
      } else {
        const streamed = await this.streamPlain(model, messages, events, signal);
        assistantText = streamed.content;
        intelSource = streamed.intelSource;

        // Safe-delete asks: extension deletes [UNUSED FILES] for real.
        // Skip model fences entirely in that mode — the coder often recreates
        // orphans or adds unused links back into index.html.
        const deletePaths = enriched.safeDeleteIntent
          ? enriched.unusedPaths ?? []
          : [];
        const deleted: string[] = [];
        for (const rel of deletePaths) {
          const result = await proposeFileDelete(rel);
          if (result.ok && result.pendingEdit) {
            await this.deliverPendingEdit(result.pendingEdit, events, applyNow);
            deleted.push(rel);
            codingEdits.push(result.pendingEdit);
          }
        }
        if (deleted.length > 0) {
          events.onStatus(
            applyNow
              ? `Deleted unused file(s): ${deleted.join(", ")}`
              : `Proposed delete(s): ${deleted.join(", ")} — click Delete to confirm.`
          );
        } else if (enriched.safeDeleteIntent) {
          events.onStatus(
            "No unused sibling files to delete (all are linked or none found)."
          );
        }

        if (!enriched.safeDeleteIntent) {
          const proposed = await proposeEditsFromAssistantReply(
            assistantText,
            enriched.attachedPaths,
            async (edit) => {
              await this.deliverPendingEdit(edit, events, applyNow);
            }
          );
          codingEdits = proposed.edits;
          if (proposed.count > 0 && !applyNow) {
            const deletes = proposed.edits.filter((e) => e.kind === "delete").length;
            const writes = proposed.count - deletes;
            events.onStatus(
              proposed.count === 1
                ? deletes
                  ? "Proposed file delete — click Delete to remove it from disk."
                  : "Proposed file edit — click Apply to write it to disk."
                : `Proposed ${writes} write(s) and ${deletes} delete(s) — click Apply/Delete to confirm.`
            );
          }
        }
      }

      const backendLabel = intelSource
        ? labelIntelSource(intelSource)
        : undefined;
      if (backendLabel) {
        events.onMode(mode, model, backendLabel);
        events.onStatus(`Backend: ${backendLabel}`);
      }

      // Keep the reply clean — summary is a separate UI card at the end
      const modelNotes = parseModelSummaryNotes(assistantText);
      assistantText = stripCodingSummarySection(assistantText);

      const { clean, escalateReason } = stripEscalateMarker(assistantText);
      let finalText = clean;

      if (escalateReason) {
        events.onStatus(`Escalation suggested: ${escalateReason}`);
        const gemini = await escalateToGemini(this.context, {
          reason: escalateReason,
          systemPrompt: system,
          contextPrompt: this.buildEscalatePrompt(userText, clean),
        });
        if (gemini.accepted && gemini.text) {
          finalText = `${clean}\n\n---\n*Gemini:*\n${gemini.text}`.trim();
          events.onToken(`\n\n---\n*Gemini:*\n${gemini.text}`);
          const learned = await learnCodingLesson({
            userPrompt: userText,
            answer: gemini.text,
            source: "blossom_assistant_gemini",
          });
          if (learned.stored) {
            events.onStatus(
              `Saved Gemini answer to coding memory${learned.id ? ` (${learned.id.slice(0, 8)}…)` : ""}.`
            );
          } else if (learned.error) {
            events.onStatus(`Could not save to coding memory: ${learned.error}`);
          } else if (learned.reason) {
            events.onStatus(`Coding memory skipped: ${learned.reason}`);
          }
        } else if (gemini.cancelledReason) {
          events.onStatus(`Gemini skipped: ${gemini.cancelledReason}`);
        }
      }

      const summary = buildCodingSummaryInfo(codingEdits, {
        autoApplied: applyNow && codingEdits.length > 0,
        backend: backendLabel,
        modelNotes,
      });
      if (summary) {
        events.onCodingSummary(summary);
      }

      this.history.push({ role: "assistant", content: finalText });
      // Keep history bounded
      if (this.history.length > 40) {
        this.history = this.history.slice(-40);
      }
      events.onDone(finalText);
    } catch (err) {
      // User hit Stop (or fetch aborted) — not a backend failure.
      if (isAbortLike(err) && !(err instanceof LlmError)) {
        events.onStatus("Cancelled");
        events.onDone("");
        return;
      }

      const msg = formatChatError(err);
      try {
        this.abort?.abort();
      } catch {
        // ignore
      }
      events.onStatus(`Error: ${msg}`);
      events.onError(msg);
      events.onDone("");
    }
  }

  private async augmentSystem(system: string): Promise<string> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const related = await suggestRelatedFolders();
    const rootLines =
      folders.length > 1
        ? `Multi-root workspace (${folders.length}): ${folders.map((f) => f.name).join(", ")}. Prefer paths like RootName/relative/path. Use list_workspace_roots / list_related / peek_related for other folders.`
        : folders.length === 1
          ? `Workspace root: ${folders[0].name}. Use list_related / peek_related for sibling dependency folders.`
          : "";
    const relatedLine =
      related.length > 0
        ? `Likely related folders: ${related.join(", ")}`
        : "";
    return [system, rootLines, relatedLine].filter(Boolean).join("\n\n");
  }

  private buildEscalatePrompt(userText: string, localAttempt: string): string {
    const recent = this.history
      .slice(-6)
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n\n");
    return [
      "The local coding assistant is stuck and the user approved a Gemini escalation.",
      `User request:\n${userText}`,
      `Local attempt:\n${localAttempt || "(empty)"}`,
      `Recent conversation:\n${recent}`,
      "Provide a clear, actionable answer. If code edits are needed, show full file contents or precise patches.",
    ].join("\n\n");
  }

  private async streamPlain(
    model: string,
    messages: OllamaMessage[],
    events: OrchestratorEvents,
    signal: AbortSignal
  ): Promise<{ content: string; intelSource?: string; intelLabel?: string }> {
    const cfg = getConfig();
    events.onStatus(
      cfg.backend === "chatRouter"
        ? "ChatRouter thinking…"
        : `Streaming from ${model}…`
    );
    let content = "";
    let intelSource: string | undefined;
    let intelLabel: string | undefined;
    const seenThoughts = new Set<string>();
    let reasoningAccum = "";

    const mergeReasoning = (incoming: string): string => {
      const msg = incoming;
      if (!msg) {
        return reasoningAccum;
      }
      if (!reasoningAccum) {
        return msg;
      }
      if (msg === reasoningAccum || reasoningAccum.endsWith(msg)) {
        return reasoningAccum;
      }
      if (msg.startsWith(reasoningAccum)) {
        return msg;
      }
      if (reasoningAccum.startsWith(msg)) {
        return reasoningAccum;
      }
      // Streaming delta from reasoning_content
      return reasoningAccum + msg;
    };

    const noteThought = (t: BlossomThought): void => {
      const fromFields = t.source || t.provider;
      if (fromFields) {
        intelSource = fromFields;
        intelLabel = labelIntelSource(fromFields);
      }
      const step = (t.step ?? "").toLowerCase();
      if (step === "intel_ready" || step === "cloud" || step === "learn" || step === "done") {
        const m =
          t.message.match(/\bsource\s*=\s*([a-z0-9_]+)/i) ||
          t.message.match(/\bprovider\s*=\s*([a-z0-9_]+)/i);
        if (m) {
          intelSource = m[1];
          intelLabel = labelIntelSource(m[1]);
        }
      }

      if (step === "model_reasoning") {
        const merged = mergeReasoning(t.message || "");
        if (!merged || merged === reasoningAccum) {
          return;
        }
        reasoningAccum = merged;
        events.onThought({
          step: "model_reasoning",
          message: reasoningAccum,
          source: t.source,
          provider: t.provider,
        });
        return;
      }

      const prefix = (t.message || "").slice(0, 80);
      const key = `${t.step ?? ""}:${prefix}`;
      if (!seenThoughts.has(key) && isUsefulThought(t)) {
        seenThoughts.add(key);
        events.onThought(t);
      }
    };

    for await (const chunk of streamChat({ model, messages, signal })) {
      if (chunk.intelSource) {
        intelSource = chunk.intelSource;
        intelLabel = chunk.intelLabel || labelIntelSource(chunk.intelSource);
      }
      if (chunk.thought) {
        noteThought(chunk.thought);
      }
      if (chunk.thoughts?.length) {
        for (const t of chunk.thoughts) {
          noteThought(t);
        }
      }
      const delta = chunk.message?.content ?? "";
      if (delta) {
        content += delta;
        events.onToken(delta);
      }
    }
    return { content, intelSource, intelLabel };
  }

  private async runToolLoop(
    model: string,
    messages: OllamaMessage[],
    events: OrchestratorEvents,
    signal: AbortSignal,
    applyNow: boolean,
    onEditCollected?: (edit: PendingEdit) => void
  ): Promise<string> {
    events.onStatus(`Agent loop on ${model}…`);
    let lastContent = "";

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (signal.aborted) {
        break;
      }

      // Prefer non-streaming when tools are present so we get complete tool_calls.
      // If the model/server rejects tools, fall back to plain streaming once.
      let result: { content: string; toolCalls: OllamaToolCall[] };
      try {
        result = await chatOnce({
          model,
          messages,
          tools: AGENT_TOOLS,
          signal,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        events.onStatus(`Tools unavailable (${msg}); streaming without tools…`);
        const streamed = await this.streamPlain(model, messages, events, signal);
        return streamed.content;
      }

      if (result.toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: result.content || "",
          tool_calls: result.toolCalls,
        });
        if (result.content) {
          lastContent += result.content;
          events.onToken(result.content);
        }

        for (const call of result.toolCalls) {
          const name = call.function.name;
          const args = call.function.arguments;
          events.onTool(name, typeof args === "string" ? args : JSON.stringify(args));
          events.onStatus(`Running ${name}…`);
          const toolResult = await runTool(name, args);
          if (toolResult.pendingEdit) {
            onEditCollected?.(toolResult.pendingEdit);
            await this.deliverPendingEdit(toolResult.pendingEdit, events, applyNow);
          }
          messages.push({
            role: "tool",
            content: toolResult.content,
          });
        }
        continue;
      }

      // No tools — stream final reply for nicer UX
      if (!result.content) {
        const streamed = await this.streamPlain(model, messages, events, signal);
        lastContent = streamed.content;
        return streamed.content;
      }

      lastContent = result.content;
      events.onToken(result.content);
      return lastContent;
    }

    events.onStatus("Tool round limit reached");
    // Offer escalation hint in text if still looping
    if (!/ESCALATE_GEMINI:/i.test(lastContent)) {
      lastContent +=
        "\n\nESCALATE_GEMINI: Reached tool round limit without a complete answer.";
    }
    return lastContent;
  }
}

export function normalizeToolCalls(
  calls: OllamaToolCall[] | undefined
): OllamaToolCall[] {
  return calls ?? [];
}
