import * as vscode from "vscode";
import { clearPersonaCache, resolvePersona } from "./agent/prompts";
import { startEditorTracking } from "./agent/editorTracker";
import {
  clearRepoKnowledgeCache,
  ensureRepoKnowledge,
  rebuildRepoKnowledge,
} from "./agent/repoKnowledge";
import { BlossomChatPanel } from "./chat/ChatPanel";
import { checkHealth } from "./ollama/client";
import { promptForGeminiApiKey } from "./gemini/client";
import { showSpendReport } from "./gemini/escalate";

export function activate(context: vscode.ExtensionContext): void {
  startEditorTracking(context);
  const chat = new BlossomChatPanel(context);

  if (vscode.workspace.workspaceFolders?.length) {
    void rebuildRepoKnowledge(context).then(
      (k) =>
        console.log(
          `[Blossom] Repo knowledge ready: ${k.files.length} files indexed`
        ),
      () => undefined
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("blossom.openChat", () => {
      chat.reveal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blossom.setGeminiApiKey", async () => {
      await promptForGeminiApiKey(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blossom.showGeminiSpend", async () => {
      await showSpendReport(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blossom.checkOllama", async () => {
      const health = await checkHealth();
      if (health.ok) {
        void vscode.window.showInformationMessage(`Blossom: ${health.detail}`);
      } else {
        void vscode.window.showErrorMessage(`Blossom: ${health.detail}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blossom.refreshPersona", async () => {
      clearPersonaCache();
      const persona = await resolvePersona();
      if (!persona.text && persona.source !== "router") {
        void vscode.window.showWarningMessage(
          `Blossom: no SYSTEM prompt found on model "${persona.model ?? "(none)"}".`
        );
        return;
      }
      void vscode.window.showInformationMessage(
        `Blossom persona: ${persona.source}${persona.model ? ` (${persona.model})` : ""}${
          persona.text ? ` — ${persona.text.length} chars` : " (ChatRouter owns voice)"
        }.`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blossom.showPersona", async () => {
      const persona = await resolvePersona();
      const doc = await vscode.workspace.openTextDocument({
        content: [
          `Source: ${persona.source}`,
          `Model: ${persona.model ?? "(n/a)"}`,
          "",
          persona.text ||
            "(empty — ChatRouter / CompanionEngine owns personality, or no SYSTEM loaded)",
        ].join("\n"),
        language: "markdown",
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blossom.refreshRepoKnowledge", async () => {
      try {
        clearRepoKnowledgeCache();
        const k = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Blossom: indexing workspace…",
          },
          async () => rebuildRepoKnowledge(context)
        );
        void vscode.window.showInformationMessage(
          `Blossom indexed ${k.files.length} files across ${k.rootNames.join(", ")}.`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Blossom: ${msg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blossom.showRepoKnowledge", async () => {
      try {
        const k = await ensureRepoKnowledge(context, Number.POSITIVE_INFINITY);
        const doc = await vscode.workspace.openTextDocument({
          content: [
            `# Repo knowledge`,
            `Updated: ${k.updatedAt}`,
            `Files: ${k.files.length}`,
            `Aliases: ${Object.keys(k.aliases).length}`,
            `Notes: ${k.notes.length}`,
            "",
            k.summary,
            "",
            "## Aliases",
            ...Object.entries(k.aliases).map(([a, b]) => `- ${a} → ${b}`),
            "",
            "## Notes",
            ...k.notes.map((n) => `- (${n.at}) ${n.text}`),
          ].join("\n"),
          language: "markdown",
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Blossom: ${msg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("blossom.persona") ||
        e.affectsConfiguration("blossom.models.coding") ||
        e.affectsConfiguration("blossom.ollama.baseUrl") ||
        e.affectsConfiguration("blossom.api.baseUrl") ||
        e.affectsConfiguration("blossom.backend")
      ) {
        clearPersonaCache();
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      clearRepoKnowledgeCache();
      void rebuildRepoKnowledge(context).catch(() => undefined);
    })
  );
}

export function deactivate(): void {
  // no-op
}
