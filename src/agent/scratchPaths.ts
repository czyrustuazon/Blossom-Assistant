/**
 * Agent scratch helpers — probe scripts the model may write/run during RESEARCH
 * without Apply cards or product-file edits.
 *
 * Canonical prefix: .blossom/scratch/
 */

export const AGENT_SCRATCH_PREFIX = ".blossom/scratch/";

const SCRATCH_EXTS = new Set([".py", ".ps1", ".js", ".mjs", ".cjs", ".sh"]);

/** Normalize to forward slashes, strip leading ./ */
export function normalizeWorkspaceRel(rel: string): string {
  return (rel || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}

/** Strip optional RootName/ prefix (multi-root display paths). */
export function stripRootPrefix(rel: string): string {
  const n = normalizeWorkspaceRel(rel);
  const slash = n.indexOf("/");
  if (slash <= 0) {
    return n;
  }
  // "RootName/.blossom/scratch/foo.py" → ".blossom/scratch/foo.py"
  const rest = n.slice(slash + 1);
  if (rest.startsWith(AGENT_SCRATCH_PREFIX) || rest === ".blossom/scratch") {
    return rest;
  }
  return n;
}

export function isAgentScratchPath(rel: string): boolean {
  const n = stripRootPrefix(rel);
  if (!n.startsWith(AGENT_SCRATCH_PREFIX)) {
    return false;
  }
  const base = n.slice(AGENT_SCRATCH_PREFIX.length);
  if (!base || base.includes("..")) {
    return false;
  }
  // Require a file with an allowed extension (no bare dirs as write targets).
  const dot = base.lastIndexOf(".");
  if (dot < 0) {
    return false;
  }
  const ext = base.slice(dot).toLowerCase();
  return SCRATCH_EXTS.has(ext);
}

export function scratchWriteDeniedMessage(rel: string): string {
  const shown = normalizeWorkspaceRel(rel) || "(empty)";
  return (
    `Research/minimal profile blocks product writes. ` +
    `For probe helpers use write_file under ${AGENT_SCRATCH_PREFIX}` +
    `(e.g. ${AGENT_SCRATCH_PREFIX}peek_bin.py), then run_command. ` +
    `Got: ${shown}`
  );
}
