import * as vscode from "vscode";
import { pathsMatch } from "./applyFromResponse";

/** Per-turn paths verified by a successful dry-run / smoke command. */
let verifiedPaths = new Set<string>();

export function resetDryRunSession(): void {
  verifiedPaths = new Set<string>();
}

export function dryRunGateEnabled(): boolean {
  return (
    vscode.workspace
      .getConfiguration("blossom")
      .get<boolean>("edits.dryRunGate", true) ?? true
  );
}

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

import { isPatchLikePath } from "./patchScriptContext";

/** patch_*.py, deploy_*.py, inject_*.py, and auto-discovered patch scripts. */
export function needsDryRunBeforeApply(relativePath: string): boolean {
  if (!dryRunGateEnabled()) {
    return false;
  }
  const norm = normPath(relativePath);
  const base = norm.split("/").pop() ?? norm;
  if (/^(patch_|deploy_|inject_|hook_|apply_|mod_).*\.py$/i.test(base)) {
    return true;
  }
  if (/^tools\/.*\.py$/i.test(norm)) {
    return true;
  }
  if (isPatchLikePath(norm)) {
    return true;
  }
  return false;
}

export function isDryRunVerified(relativePath: string): boolean {
  const norm = normPath(relativePath);
  for (const v of verifiedPaths) {
    if (pathsMatch(v, norm)) {
      return true;
    }
  }
  return false;
}

/** Extract workspace-relative .py paths referenced in a shell command. */
export function extractPyPathsFromCommand(command: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /(?:^|\s|["'])([.\w/\\-]*(?:patch_|deploy_|tools\/)[\w/\\-]*\.py)(?:["']|\s|$)/gi,
    /(?:^|\s|["'])((?:src|tools)\/[^\s"']+\.py)(?:["']|\s|$)/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(command))) {
      out.add(normPath(m[1]));
    }
  }
  return [...out];
}

function isDryRunSmokeCommand(command: string): boolean {
  if (/--dry-run\b/i.test(command)) {
    return true;
  }
  if (!/(?:^|\s)(?:python|py)(?:\s+-3)?\s+-c\b/i.test(command)) {
    return false;
  }
  return /\b(build_blob|build_romaji_blob|build_blob\(\)|import\s+patch_|from\s+patch_)/i.test(
    command
  );
}

/**
 * After a successful run_command, mark patch-script paths as verified when the
 * command was an explicit --dry-run or a python -c smoke import/build.
 */
export function markDryRunFromCommand(command: string, ok: boolean): string[] {
  if (!ok || !dryRunGateEnabled()) {
    return [];
  }
  if (!/--dry-run\b/i.test(command) && !isDryRunSmokeCommand(command)) {
    return [];
  }
  const marked: string[] = [];
  for (const p of extractPyPathsFromCommand(command)) {
    if (needsDryRunBeforeApply(p)) {
      verifiedPaths.add(p);
      marked.push(p);
    }
  }
  if (marked.length === 0 && isDryRunSmokeCommand(command)) {
    const mod = command.match(
      /(?:from|import)\s+(patch_[\w]+|tools\.[\w.]+)/i
    )?.[1];
    if (mod) {
      const guess = mod.includes(".")
        ? normPath(mod.replace(/\./g, "/") + ".py")
        : `src/${mod}.py`;
      if (needsDryRunBeforeApply(guess)) {
        verifiedPaths.add(guess);
        marked.push(guess);
      }
    }
  }
  return marked;
}

export function dryRunGateBlockReason(relativePath: string): string {
  const norm = normPath(relativePath);
  return (
    `Dry-run gate: run \`python ${norm} --dry-run\` (or a successful python -c smoke import) ` +
    `before Apply/auto-apply on patch scripts.`
  );
}

export function validateDryRunBeforeApply(relativePath: string): {
  allowed: boolean;
  reason?: string;
} {
  if (!needsDryRunBeforeApply(relativePath)) {
    return { allowed: true };
  }
  if (isDryRunVerified(relativePath)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: dryRunGateBlockReason(relativePath),
  };
}
