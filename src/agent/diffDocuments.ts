import * as vscode from "vscode";
import type { PendingEdit } from "./tools";

const SCHEME = "blossom-diff";

/**
 * Virtual docs for vscode.diff — before/after of a pending (or just-applied) edit.
 */
export class BlossomDiffDocuments implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  set(uri: vscode.Uri, text: string): void {
    this.contents.set(uri.toString(), text);
    this._onDidChange.fire(uri);
  }

  clear(id: string): void {
    for (const key of [...this.contents.keys()]) {
      if (key.includes(`/${id}`)) {
        this.contents.delete(key);
      }
    }
  }
}

let singleton: BlossomDiffDocuments | undefined;

export function registerBlossomDiffDocuments(
  context: vscode.ExtensionContext
): BlossomDiffDocuments {
  const docs = new BlossomDiffDocuments();
  singleton = docs;
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, docs),
    { dispose: () => {
      if (singleton === docs) {
        singleton = undefined;
      }
    } }
  );
  return docs;
}

function sideUri(side: "before" | "after", edit: PendingEdit): vscode.Uri {
  const safePath = edit.relativePath.replace(/\\/g, "/");
  return vscode.Uri.from({
    scheme: SCHEME,
    path: `/${side}/${edit.id}/${safePath}`,
  });
}

/** Open a GitHub-style side-by-side diff for this edit (beside the active editor). */
export async function openPendingEditDiff(edit: PendingEdit): Promise<void> {
  const docs = singleton;
  if (!docs) {
    throw new Error("Blossom diff provider is not registered.");
  }
  const before = sideUri("before", edit);
  const after = sideUri("after", edit);
  docs.set(before, edit.oldContent ?? "");
  docs.set(after, edit.kind === "delete" ? "" : edit.newContent ?? "");
  const label =
    edit.kind === "delete"
      ? `${edit.relativePath} (delete)`
      : !edit.oldContent
        ? `${edit.relativePath} (new)`
        : edit.source === "search_replace"
          ? `${edit.relativePath} (replace)`
          : `${edit.relativePath} (Blossom)`;
  await vscode.commands.executeCommand(
    "vscode.diff",
    before,
    after,
    label,
    {
      preview: true,
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
    }
  );
}

export function openDiffOnReplaceEnabled(): boolean {
  return (
    vscode.workspace
      .getConfiguration("blossom")
      .get<boolean>("edits.openDiffOnReplace", true) ?? true
  );
}
