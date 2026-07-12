import * as vscode from "vscode";

/** Remembers the last real text editor — chat webview focus clears activeTextEditor. */
let lastEditor: vscode.TextEditor | undefined;

export function startEditorTracking(context: vscode.ExtensionContext): void {
  if (vscode.window.activeTextEditor) {
    lastEditor = vscode.window.activeTextEditor;
  }
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document.uri.scheme === "file") {
        lastEditor = editor;
      }
    })
  );
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (lastEditor && lastEditor.document.uri.toString() === doc.uri.toString()) {
        lastEditor = vscode.window.visibleTextEditors.find(
          (e) => e.document.uri.scheme === "file"
        );
      }
    })
  );
}

export function getPreferredTextEditor(): vscode.TextEditor | undefined {
  const active = vscode.window.activeTextEditor;
  if (active && active.document.uri.scheme === "file") {
    return active;
  }
  if (lastEditor && !lastEditor.document.isClosed) {
    return lastEditor;
  }
  return vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.scheme === "file"
  );
}

export function getOpenFileDocuments(): vscode.TextDocument[] {
  const seen = new Set<string>();
  const out: vscode.TextDocument[] = [];
  const prefer = getPreferredTextEditor();
  if (prefer) {
    seen.add(prefer.document.uri.toString());
    out.push(prefer.document);
  }
  for (const e of vscode.window.visibleTextEditors) {
    const key = e.document.uri.toString();
    if (e.document.uri.scheme !== "file" || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(e.document);
  }
  for (const doc of vscode.workspace.textDocuments) {
    const key = doc.uri.toString();
    if (doc.uri.scheme !== "file" || doc.isUntitled || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(doc);
  }
  return out;
}
