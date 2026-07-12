import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { getOpenFileDocuments, getPreferredTextEditor } from "./editorTracker";
import {
  ensureRepoKnowledge,
  formatKnowledgeForPrompt,
  fuzzyFindFiles,
  rememberAlias,
  rememberNote,
  type RepoKnowledge,
} from "./repoKnowledge";

const MAX_FILE_CHARS = 24_000;
const MAX_TOTAL_CHARS = 60_000;

const FILE_REF =
  /(?:^|[\s`'"(])((?:[\w.-]+\/)*[\w.-]+\.(?:html?|css|js|jsx|ts|tsx|mjs|cjs|json|md|py|go|rs|java|kt|cs|php|rb|vue|svelte|sql|yml|yaml|toml|xml|svg|sh|ps1))(?=$|[\s`'"),:;!?]|\.(?:\s|$))/gi;

const BARE_NAME =
  /(?:^|[\s`'"(])((?:index|main|app|server|style|script|config|readme)(?:\.\w+)?|(?:[\w-]+)\.(?:html?|css|js|ts|tsx|json|py|md))(?=$|[\s`'"),:;!?])/gi;

const WANTS_EDITOR =
  /\b(this file|the file|current file|open file|in the editor|my (?:code|file)|fix (?:it|this)|look at|see (?:my|the) code)\b/i;

const WANTS_LINK_CHECK =
  /\b(link|links|href|dead link|broken link|missing file|files? that (?:aren'?t|are not|arent) present|delete any files that aren'?t|check the links)\b/i;

/** Local href="/path") or href='path' — skip http(s), mailto, #anchors. */
const HREF_RE =
  /\bhref\s*=\s*["'](?!https?:|mailto:|tel:|javascript:|#)([^"']+)["']/gi;

async function buildLinkCheckReport(
  htmlBodies: Array<{ relPath: string; body: string }>
): Promise<string> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0 || htmlBodies.length === 0) {
    return "";
  }

  const lines: string[] = [
    "[LINK CHECK — verified against the workspace disk, not guesses]",
    "Use ONLY this list when deciding whether a local link target exists.",
    "Do NOT remove a link if it is marked EXISTS. Only remove/fix links marked MISSING.",
  ];

  let any = false;
  for (const { relPath, body } of htmlBodies) {
    const hrefs = new Set<string>();
    for (const m of body.matchAll(HREF_RE)) {
      const raw = (m[1] || "").trim();
      if (!raw || raw.startsWith("data:")) {
        continue;
      }
      // strip query/hash
      const clean = raw.split(/[?#]/)[0];
      if (clean) {
        hrefs.add(clean.replace(/\\/g, "/"));
      }
    }
    if (hrefs.size === 0) {
      continue;
    }
    any = true;
    lines.push(`From ${relPath}:`);
    const baseDir = path.posix.dirname(relPath.replace(/\\/g, "/"));
    for (const href of [...hrefs].sort()) {
      const joined =
        href.startsWith("/")
          ? href.replace(/^\//, "")
          : baseDir === "."
            ? href
            : path.posix.normalize(`${baseDir}/${href}`);
      let exists = false;
      for (const folder of folders) {
        const abs = path.join(folder.uri.fsPath, joined.replace(/\//g, path.sep));
        try {
          await fs.access(abs);
          exists = true;
          break;
        } catch {
          // try next root
        }
      }
      lines.push(
        exists
          ? `- ${href} → ${joined} — EXISTS (keep this link)`
          : `- ${href} → ${joined} — MISSING (safe to remove or fix)`
      );
    }
  }

  return any ? lines.join("\n") : "";
}

/**
 * Clarify ambiguous asks like "delete files that aren't being used" vs "remove dead links".
 */
function buildLinkTaskBrief(userText: string): string {
  const text = userText || "";
  const wantsDeadLinks = WANTS_LINK_CHECK.test(text);
  const wantsOrphans = detectSafeDeleteIntent(text);

  if (!wantsDeadLinks && !wantsOrphans) {
    return "";
  }

  const lines = [
    "[TASK BRIEF — link / unused-file cleanup]",
    "Interpret carefully — these are DIFFERENT jobs:",
    "",
    "EXISTS (from [LINK CHECK]): keep the link. Never remove EXISTS links.",
    "MISSING (from [LINK CHECK]): fix or remove that href only.",
    "UNUSED FILES (from [UNUSED FILES]): those paths are safe to DELETE on disk.",
  ];
  if (wantsOrphans) {
    lines.push(
      "",
      "THIS ASK = find/delete unused FILES using index.html links as the keep-set.",
      "- Do NOT add new <a href> links to index.html.",
      "- Do NOT create about.html / contacts.html / end.html (or any new files).",
      "- Do NOT rewrite index.html except to remove MISSING hrefs.",
      "- Do NOT claim a file was deleted in prose — the extension deletes [UNUSED FILES].",
      "- Leave referenced files alone."
    );
  }
  if (wantsDeadLinks && !wantsOrphans) {
    lines.push(
      "",
      "- Dead links = href targets marked MISSING in [LINK CHECK].",
      "- Remove or fix ONLY those MISSING links inside the HTML.",
      "- NEVER remove a link marked EXISTS — those files are on disk."
    );
  }
  lines.push(
    "",
    "- Prefer [LINK CHECK] and [UNUSED FILES] over repo-knowledge summaries or guesses.",
    "- Disk truth comes from this extension's fs checks, not from ChatRouter memory."
  );
  return lines.join("\n");
}

/** Sibling files in the same folder as the HTML that no local href references. */
async function buildUnusedFilesReport(
  htmlBodies: Array<{ relPath: string; body: string }>
): Promise<{ report: string; paths: string[] }> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0 || htmlBodies.length === 0) {
    return { report: "", paths: [] };
  }

  const referenced = new Set<string>();
  const dirs = new Set<string>();
  for (const { relPath, body } of htmlBodies) {
    const normRel = relPath.replace(/\\/g, "/");
    referenced.add(path.posix.basename(normRel).toLowerCase());
    dirs.add(path.posix.dirname(normRel));
    for (const m of body.matchAll(HREF_RE)) {
      const raw = (m[1] || "").trim().split(/[?#]/)[0];
      if (!raw || /^https?:|^mailto:|^tel:|^javascript:|^#|^data:/i.test(raw)) {
        continue;
      }
      const baseDir = path.posix.dirname(normRel);
      const joined = raw.startsWith("/")
        ? raw.replace(/^\//, "")
        : baseDir === "."
          ? raw
          : path.posix.normalize(`${baseDir}/${raw}`);
      referenced.add(path.posix.basename(joined).toLowerCase());
      referenced.add(joined.toLowerCase());
    }
  }

  const unused: string[] = [];
  for (const dir of dirs) {
    for (const folder of folders) {
      const absDir =
        dir === "."
          ? folder.uri.fsPath
          : path.join(folder.uri.fsPath, dir.replace(/\//g, path.sep));
      let entries: string[] = [];
      try {
        entries = await fs.readdir(absDir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!/\.(html?|css|js|mjs|cjs)$/i.test(name)) {
          continue;
        }
        const rel =
          dir === "." ? name : path.posix.normalize(`${dir}/${name}`);
        const key = name.toLowerCase();
        const relKey = rel.toLowerCase();
        if (referenced.has(key) || referenced.has(relKey)) {
          continue;
        }
        unused.push(rel.replace(/\\/g, "/"));
      }
    }
  }

  const paths = [...new Set(unused)].sort();
  if (paths.length === 0) {
    return {
      paths: [],
      report: [
        "[UNUSED FILES]",
        "No obvious unused sibling web assets next to the attached HTML",
        "(everything in the folder is referenced by a local href or is the open file).",
      ].join("\n"),
    };
  }

  return {
    paths,
    report: [
      "[UNUSED FILES — extension will delete these when Auto-apply is on]",
      "These sibling files are NOT referenced by local hrefs in the attached HTML:",
      ...paths.map((p) => `- ${p}`),
      "Do NOT recreate these files. Do NOT add links to them in index.html.",
    ].join("\n"),
  };
}

export interface EditorContextResult {
  displayText: string;
  promptText: string;
  attached: string[];
  /** Clean workspace-relative paths that were attached as full files. */
  attachedPaths: string[];
  /** Sibling files not referenced by local hrefs (safe-delete candidates). */
  unusedPaths: string[];
  /** User asked to find/delete unused files using links as the keep-set. */
  safeDeleteIntent: boolean;
}

/** True when the user wants orphan files deleted using links as the keep-set. */
export function detectSafeDeleteIntent(userText: string): boolean {
  const t = userText || "";
  if (
    /\b(safe to delete|unused|orphan|not (?:being )?used|aren't being used|arent being used)\b/i.test(
      t
    )
  ) {
    return true;
  }
  // "use links as a reference to see which files should be safe to delete"
  if (
    /\blinks?\b/i.test(t) &&
    /\b(reference|refererence|refer)\b/i.test(t) &&
    /\b(delete|safe)\b/i.test(t)
  ) {
    return true;
  }
  // "which files should be safe to delete in this repo"
  if (/\bwhich files?\b/i.test(t) && /\b(safe to delete|delete)\b/i.test(t)) {
    return true;
  }
  if (
    /\b(delete|remove)\s+files?\b/i.test(t) &&
    /\b(not|unused|anymore|any more)\b/i.test(t)
  ) {
    return true;
  }
  return false;
}

/**
 * Attach preferred editor / selection / named files (with fuzzy fallback) and
 * persisted repo knowledge so ChatRouter can see the project.
 */
export async function enrichWithEditorContext(
  userText: string,
  opts?: {
    forceActiveEditor?: boolean;
    extensionContext?: vscode.ExtensionContext;
    includeRepoKnowledge?: boolean;
  }
): Promise<EditorContextResult> {
  const attached: string[] = [];
  const attachedPaths: string[] = [];
  const blocks: string[] = [];
  let total = 0;
  let knowledge: RepoKnowledge | null = null;

  if (opts?.extensionContext) {
    try {
      knowledge = await ensureRepoKnowledge(opts.extensionContext);
    } catch {
      knowledge = null;
    }
  }

  const addBlock = (label: string, body: string, tag: string, asPath?: string): void => {
    if (!body.trim() || total >= MAX_TOTAL_CHARS) {
      return;
    }
    const clipped =
      body.length > MAX_FILE_CHARS
        ? `${body.slice(0, MAX_FILE_CHARS)}\n\n… truncated (${body.length} chars)`
        : body;
    blocks.push(`<<<FILE path="${label}">>>\n${clipped}\n<<<END_FILE>>>`);
    attached.push(tag);
    if (asPath && !asPath.includes(":")) {
      const clean = asPath.replace(/\\/g, "/");
      if (!attachedPaths.includes(clean)) {
        attachedPaths.push(clean);
      }
    }
    total += clipped.length;
  };

  const alreadyHas = (name: string): boolean =>
    attached.some(
      (a) =>
        a.replace(/\\/g, "/").toLowerCase().includes(name.replace(/\\/g, "/").toLowerCase()) ||
        a.toLowerCase().endsWith(path.basename(name).toLowerCase())
    );

  const force =
    opts?.forceActiveEditor ||
    WANTS_EDITOR.test(userText) ||
    /\b(fix|bug|error|broken|wrong|html|css|javascript|typescript|repo|project|codebase)\b/i.test(
      userText
    );

  // Prefer last real code editor (chat panel focus clears activeTextEditor)
  const editor = getPreferredTextEditor();

  if (editor && !editor.document.isUntitled) {
    const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
    const sel = editor.selection;
    const hasSelection = Boolean(sel && !sel.isEmpty);
    const shouldAttachActive =
      force ||
      hasSelection ||
      mentionsPath(userText, rel) ||
      mentionsPath(userText, path.basename(rel));

    if (shouldAttachActive) {
      if (hasSelection) {
        addBlock(
          `${rel}:${sel.start.line + 1}-${sel.end.line + 1}`,
          editor.document.getText(sel),
          `${rel} (selection)`,
          rel
        );
      } else {
        addBlock(rel, editor.document.getText(), `${rel} (editor)`, rel);
      }
    }
  } else if (editor?.document.isUntitled && force) {
    addBlock(
      editor.document.fileName || "Untitled",
      editor.document.getText(),
      "Untitled (editor)"
    );
  }

  // Named files in the message — always try workspace + open tabs
  const named = [
    ...userText.matchAll(FILE_REF),
    ...userText.matchAll(BARE_NAME),
  ].map((m) => m[1]);
  const uniqueNames = [...new Set(named.map((n) => n.replace(/\\/g, "/")))];

  for (const name of uniqueNames) {
    if (total >= MAX_TOTAL_CHARS) {
      break;
    }
    if (alreadyHas(name)) {
      continue;
    }

    let doc = await findAmongOpenDocs(name);
    let tagSuffix = "";

    if (!doc) {
      doc = await findWorkspaceFileExact(name);
    }

    if (!doc && knowledge) {
      const hits = fuzzyFindFiles(knowledge, name, 5);
      // Require a strong match; never learn aliases from weak fuzzy hits.
      if (hits.length > 0 && hits[0].score >= 520) {
        doc = await openRel(hits[0].path);
        tagSuffix = ` (fuzzy: ${name}→${hits[0].path})`;
        if (
          opts?.extensionContext &&
          hits[0].path &&
          hits[0].score >= 700
        ) {
          await rememberAlias(opts.extensionContext, name, hits[0].path);
        }
      }
    }

    if (!doc) {
      attached.push(`MISSING:${name}`);
      continue;
    }
    const rel = vscode.workspace.asRelativePath(doc.uri, false);
    addBlock(rel, doc.getText(), `${rel}${tagSuffix}`, rel);
  }

  // Coding with nothing attached: use preferred editor or guess
  if (force && blocks.length === 0) {
    const preferred = getPreferredTextEditor();
    if (preferred && !preferred.document.isUntitled) {
      const rel = vscode.workspace.asRelativePath(preferred.document.uri, false);
      addBlock(rel, preferred.document.getText(), `${rel} (fallback editor)`, rel);
    } else if (knowledge) {
      const tokens = userText
        .split(/[^\w.-]+/)
        .filter((t) => t.length >= 3 && t.length <= 40)
        .slice(0, 12);
      for (const token of tokens) {
        const hits = fuzzyFindFiles(knowledge, token, 1);
        if (hits[0] && hits[0].score >= 650) {
          const doc = await openRel(hits[0].path);
          if (doc) {
            const rel = vscode.workspace.asRelativePath(doc.uri, false);
            addBlock(rel, doc.getText(), `${rel} (guessed from "${token}")`, rel);
            if (opts?.extensionContext && hits[0].score >= 700) {
              await rememberAlias(opts.extensionContext, token, hits[0].path);
            }
            break;
          }
        }
      }
    }
  }

  // Put code FIRST so ChatRouter / coder cannot miss it
  const parts: string[] = [];
  const htmlBodies: Array<{ relPath: string; body: string }> = [];
  for (const block of blocks) {
    const m = block.match(/^<<<FILE path="([^"]+)">>>\r?\n([\s\S]*?)\r?\n<<<END_FILE>>>$/);
    if (m && /\.html?$/i.test(m[1])) {
      htmlBodies.push({ relPath: m[1], body: m[2] });
    }
  }
  // Always verify local hrefs when HTML is attached (cheap + prevents false "missing")
  const linkReport =
    htmlBodies.length > 0 ? await buildLinkCheckReport(htmlBodies) : "";
  const safeDeleteIntent = detectSafeDeleteIntent(userText);
  const unusedBundle =
    htmlBodies.length > 0 &&
    (safeDeleteIntent ||
      WANTS_LINK_CHECK.test(userText) ||
      /\b(unused|not (?:being )?used|orphan|safe to delete)\b/i.test(userText))
      ? await buildUnusedFilesReport(htmlBodies)
      : { report: "", paths: [] as string[] };
  const unusedReport = unusedBundle.report;
  const unusedPaths = unusedBundle.paths;
  const linkBrief = buildLinkTaskBrief(userText);

  if (blocks.length > 0) {
    parts.push(
      "The user already has these files open in VS Code. Their contents are included below.",
      "Fix or discuss THIS code directly. Do NOT ask them to paste or share the file.",
      "",
      "FILE EDITS — important:",
      "- If the user wants a NEW file, create it. Do NOT put the new file's contents into an attached file.",
      "- If editing an attached file, keep its existing purpose/content and make only the requested change.",
      "- For each file you change or create, output a COMPLETE file in its own markdown fence.",
      "- Label every fence with the path, e.g. ```html path=about.html or ```html path=index.html",
      "- Multi-file tasks need multiple path-labeled fences (one per file).",
      "- The editor will offer Apply per file. Do not claim a file was saved until Apply confirms.",
      "- When checking links: trust [LINK CHECK] over guesses or incomplete repo knowledge.",
      "- EXISTS links must be kept. \"Delete unused files\" ≠ remove working links.",
      ""
    );
    if (linkBrief) {
      parts.push(linkBrief, "");
    }
    parts.push(
      "[EDITOR CONTEXT]",
      ...blocks,
      "",
      "[USER REQUEST]",
      userText
    );
    if (linkReport) {
      parts.push("", linkReport);
    } else if (WANTS_LINK_CHECK.test(userText)) {
      parts.push(
        "",
        "[LINK CHECK]",
        "No local href= targets were found in the attached HTML."
      );
    }
    if (unusedReport) {
      parts.push("", unusedReport);
    }
  } else {
    parts.push(
      "You are the VS Code coding assistant.",
      "When creating or editing files, use one complete markdown fence per file labeled with path=...",
      "e.g. ```html path=about.html",
      "",
      "[USER REQUEST]",
      userText
    );
    if (uniqueNames.length > 0) {
      parts.push(
        "",
        `(Blossom could not load: ${uniqueNames.join(", ")}. Workspace may not contain those paths.)`
      );
    }
  }

  if (opts?.includeRepoKnowledge !== false && knowledge && force) {
    parts.push(
      "",
      "[REPO KNOWLEDGE — durable map of this workspace]",
      formatKnowledgeForPrompt(knowledge, 2500)
    );
    if (!attached.includes("repo knowledge")) {
      attached.push("repo knowledge");
    }
  }

  if (opts?.extensionContext && force && userText.length > 20 && userText.length < 240) {
    void rememberNote(
      opts.extensionContext,
      `User focus: ${userText.replace(/\s+/g, " ").slice(0, 180)}`
    );
  }

  return {
    displayText: userText,
    promptText: parts.join("\n"),
    attached: attached.filter((a) => !a.startsWith("MISSING:")),
    attachedPaths,
    unusedPaths,
    safeDeleteIntent,
  };
}

function mentionsPath(text: string, candidate: string): boolean {
  if (!candidate) {
    return false;
  }
  const needle = candidate.replace(/\\/g, "/").toLowerCase();
  const hay = text.replace(/\\/g, "/").toLowerCase();
  return hay.includes(needle) || hay.includes(path.basename(needle));
}

async function findAmongOpenDocs(
  name: string
): Promise<vscode.TextDocument | undefined> {
  const base = path.posix.basename(name.replace(/\\/g, "/")).toLowerCase();
  const needle = name.replace(/\\/g, "/").toLowerCase();
  for (const doc of getOpenFileDocuments()) {
    const rel = vscode.workspace.asRelativePath(doc.uri, false).replace(/\\/g, "/");
    if (
      rel.toLowerCase() === needle ||
      rel.toLowerCase().endsWith("/" + needle) ||
      path.posix.basename(rel).toLowerCase() === base
    ) {
      return doc;
    }
  }
  return undefined;
}

async function findWorkspaceFileExact(
  name: string
): Promise<vscode.TextDocument | undefined> {
  const cleaned = name.replace(/\\/g, "/").replace(/^\.\//, "");
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const uri = vscode.Uri.joinPath(folder.uri, cleaned);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat) {
        return await vscode.workspace.openTextDocument(uri);
      }
    } catch {
      // continue
    }
  }

  const base = path.posix.basename(cleaned);
  const hits = await vscode.workspace.findFiles(
    `**/${base}`,
    "**/{node_modules,.git,dist,out,build}/**",
    20
  );
  if (hits.length === 0) {
    return undefined;
  }
  // Prefer exact relative end match, then shortest path
  hits.sort((a, b) => {
    const ar = vscode.workspace.asRelativePath(a, false).replace(/\\/g, "/");
    const br = vscode.workspace.asRelativePath(b, false).replace(/\\/g, "/");
    const aExact = ar === cleaned || ar.endsWith("/" + cleaned) ? 0 : 1;
    const bExact = br === cleaned || br.endsWith("/" + cleaned) ? 0 : 1;
    if (aExact !== bExact) {
      return aExact - bExact;
    }
    return ar.length - br.length;
  });
  try {
    return await vscode.workspace.openTextDocument(hits[0]);
  } catch {
    return undefined;
  }
}

async function openRel(rel: string): Promise<vscode.TextDocument | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const candidates = [
      vscode.Uri.joinPath(folder.uri, rel),
      vscode.Uri.joinPath(folder.uri, rel.replace(new RegExp(`^${folder.name}/`), "")),
    ];
    for (const uri of candidates) {
      try {
        await vscode.workspace.fs.stat(uri);
        return await vscode.workspace.openTextDocument(uri);
      } catch {
        // try next
      }
    }
  }
  const hits = await vscode.workspace.findFiles(
    `**/${path.posix.basename(rel)}`,
    "**/{node_modules,.git,dist,out}/**",
    10
  );
  const match = hits.find((h) => {
    const r = vscode.workspace.asRelativePath(h, false).replace(/\\/g, "/");
    return r === rel || r.endsWith("/" + rel) || h.fsPath.replace(/\\/g, "/").endsWith("/" + rel);
  });
  if (match) {
    try {
      return await vscode.workspace.openTextDocument(match);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
