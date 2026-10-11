import * as path from "path";
import * as vscode from "vscode";

function workspaceRelative(fsPath: string): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const f of folders) {
    const root = f.uri.fsPath;
    if (fsPath === root || fsPath.startsWith(root + path.sep)) {
      const rel = path.relative(root, fsPath).replace(/\\/g, "/");
      return folders.length > 1 ? `${f.name}/${rel}` : rel;
    }
  }
  return fsPath.replace(/\\/g, "/");
}

async function resolveUri(
  relPath: string
): Promise<{ uri: vscode.Uri; display: string } | null> {
  const trimmed = (relPath || "").trim().replace(/\\/g, "/");
  if (!trimmed) {
    return null;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    return null;
  }

  let folder = folders[0];
  let rest = trimmed;
  if (folders.length > 1) {
    const slash = trimmed.indexOf("/");
    const head = slash >= 0 ? trimmed.slice(0, slash) : trimmed;
    const match = folders.find((f) => f.name === head);
    if (match) {
      folder = match;
      rest = slash >= 0 ? trimmed.slice(slash + 1) : "";
    }
  }

  const uri = rest
    ? vscode.Uri.joinPath(folder.uri, ...rest.split("/").filter(Boolean))
    : folder.uri;
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    // still allow open editors / language service for unsaved paths
  }
  return { uri, display: workspaceRelative(uri.fsPath) };
}

function rangeLine(r: vscode.Range): string {
  return `${r.start.line + 1}:${r.start.character + 1}-${r.end.line + 1}:${r.end.character + 1}`;
}

/** VS Code Problems / diagnostics for a file or the whole workspace. */
export async function getDiagnostics(relPath?: string): Promise<string> {
  const all = vscode.languages.getDiagnostics();
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    return "No workspace open.";
  }

  let filterUri: string | undefined;
  if (relPath?.trim()) {
    const resolved = await resolveUri(relPath);
    if (resolved) {
      filterUri = resolved.uri.toString();
    }
  }

  const lines: string[] = [];
  for (const [uri, diags] of all) {
    if (filterUri && uri.toString() !== filterUri) {
      continue;
    }
    if (!diags.length) {
      continue;
    }
    const display = workspaceRelative(uri.fsPath);
    for (const d of diags) {
      const sev =
        d.severity === vscode.DiagnosticSeverity.Error
          ? "error"
          : d.severity === vscode.DiagnosticSeverity.Warning
            ? "warning"
            : d.severity === vscode.DiagnosticSeverity.Information
              ? "info"
              : "hint";
      const src = d.source ? ` [${d.source}]` : "";
      lines.push(
        `${display}:${d.range.start.line + 1}:${d.range.start.character + 1} ${sev}${src}: ${d.message}`
      );
    }
  }

  if (!lines.length) {
    return filterUri
      ? `No diagnostics for ${relPath}.`
      : "No diagnostics in the workspace.";
  }
  const capped = lines.slice(0, 80);
  return [
    `Diagnostics (${lines.length}${lines.length > capped.length ? `, showing ${capped.length}` : ""}):`,
    ...capped,
  ].join("\n");
}

function symbolKindName(kind: vscode.SymbolKind): string {
  return vscode.SymbolKind[kind] ?? String(kind);
}

function flattenSymbols(
  symbols: vscode.DocumentSymbol[],
  display: string,
  depth = 0,
  out: string[] = []
): string[] {
  for (const s of symbols) {
    const pad = "  ".repeat(depth);
    out.push(
      `${pad}${symbolKindName(s.kind)} ${s.name} @ ${display}:${rangeLine(s.range)}`
    );
    if (s.children?.length) {
      flattenSymbols(s.children, display, depth + 1, out);
    }
  }
  return out;
}

/** Outline / document symbols for a file. */
export async function getDocumentSymbols(relPath: string): Promise<string> {
  const resolved = await resolveUri(relPath);
  if (!resolved) {
    return "get_document_symbols requires a workspace-relative path.";
  }
  const symbols = await vscode.commands.executeCommand<
    vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined
  >("vscode.executeDocumentSymbolProvider", resolved.uri);
  if (!symbols?.length) {
    return `No document symbols for ${resolved.display} (language service may be unavailable).`;
  }
  if ("range" in symbols[0] && "children" in symbols[0]) {
    const lines = flattenSymbols(
      symbols as vscode.DocumentSymbol[],
      resolved.display
    ).slice(0, 120);
    return [`Document symbols — ${resolved.display}:`, ...lines].join("\n");
  }
  const infos = symbols as vscode.SymbolInformation[];
  const lines = infos.slice(0, 120).map((s) => {
    const loc = s.location;
    return `${symbolKindName(s.kind)} ${s.name} @ ${workspaceRelative(loc.uri.fsPath)}:${rangeLine(loc.range)}`;
  });
  return [`Document symbols — ${resolved.display}:`, ...lines].join("\n");
}

/** Go to definition at path:line:character (1-based line). */
export async function goToDefinition(
  relPath: string,
  line: number,
  character?: number
): Promise<string> {
  const resolved = await resolveUri(relPath);
  if (!resolved) {
    return "go_to_definition requires path.";
  }
  const ln = Math.max(1, Math.floor(line || 1)) - 1;
  const col = Math.max(0, Math.floor(character ?? 1) - 1);
  const pos = new vscode.Position(ln, col);
  const locs = await vscode.commands.executeCommand<
    vscode.Location | vscode.Location[] | vscode.LocationLink[] | undefined
  >("vscode.executeDefinitionProvider", resolved.uri, pos);

  const list = normalizeLocations(locs);
  if (!list.length) {
    return `No definition at ${resolved.display}:${ln + 1}:${col + 1}.`;
  }
  const lines = list.slice(0, 20).map((l) => {
    const preview = l.preview ? ` — ${l.preview}` : "";
    return `${l.display}:${rangeLine(l.range)}${preview}`;
  });
  return [
    `Definition(s) from ${resolved.display}:${ln + 1}:${col + 1}:`,
    ...lines,
  ].join("\n");
}

/** Find references at path:line:character. */
export async function findReferences(
  relPath: string,
  line: number,
  character?: number
): Promise<string> {
  const resolved = await resolveUri(relPath);
  if (!resolved) {
    return "find_references requires path.";
  }
  const ln = Math.max(1, Math.floor(line || 1)) - 1;
  const col = Math.max(0, Math.floor(character ?? 1) - 1);
  const pos = new vscode.Position(ln, col);
  const locs = await vscode.commands.executeCommand<
    vscode.Location[] | undefined
  >("vscode.executeReferenceProvider", resolved.uri, pos);

  const list = normalizeLocations(locs);
  if (!list.length) {
    return `No references at ${resolved.display}:${ln + 1}:${col + 1}.`;
  }
  const lines = list.slice(0, 40).map((l) => `${l.display}:${rangeLine(l.range)}`);
  return [
    `References (${list.length}${list.length > lines.length ? `, showing ${lines.length}` : ""}) from ${resolved.display}:${ln + 1}:${col + 1}:`,
    ...lines,
  ].join("\n");
}

function normalizeLocations(
  locs:
    | vscode.Location
    | vscode.Location[]
    | vscode.LocationLink[]
    | undefined
    | null
): Array<{ display: string; range: vscode.Range; preview?: string }> {
  if (!locs) {
    return [];
  }
  const arr = Array.isArray(locs) ? locs : [locs];
  const out: Array<{ display: string; range: vscode.Range; preview?: string }> =
    [];
  for (const item of arr) {
    if (!item) {
      continue;
    }
    if ("targetUri" in item) {
      const link = item as vscode.LocationLink;
      out.push({
        display: workspaceRelative(link.targetUri.fsPath),
        range: link.targetSelectionRange ?? link.targetRange,
      });
    } else if ("uri" in item && "range" in item) {
      const loc = item as vscode.Location;
      out.push({
        display: workspaceRelative(loc.uri.fsPath),
        range: loc.range,
      });
    }
  }
  return out;
}
