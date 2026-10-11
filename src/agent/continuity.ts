/**
 * One mental model for what Blossom remembers — injected into prompts / status.
 */

export const CONTINUITY_LAYERS_PROMPT = `════════════════════════════════════
CONTINUITY LAYERS (what Blossom remembers)
════════════════════════════════════
These are different stores — do not confuse them:

1) **Scratchpad** — short working notes for *this* multi-step task (Goal/Decisions/Done/Next/Blockers). Cap ~4k. Survives Clear chat; not durable project memory.
2) **Repo knowledge** — workspace structure / entrypoints / name aliases. Host-maintained map of the project.
3) **Chat archives** — past Blossom sessions under \`.blossom/chats/\`. Use list/search/read_chat_history when the user refers to an earlier conversation.
4) **Coding memory** — durable lessons in ChatRouter Chroma (\`search_coding_memory\`). Host may also inject [CODING MEMORY] hits. Prefer editor/repo truth over memory when they conflict.

Use the smallest layer that answers the need. Disk + tools beat memory guesses.`;

/** Compact host-side reminder for status / light injects. */
export function formatContinuityBrief(opts?: {
  hasScratchpad?: boolean;
  memoryHitCount?: number;
  archiveHint?: boolean;
}): string {
  const bits = [
    "scratchpad = task notes",
    "repo knowledge = project map",
    "chat archives = past sessions",
    "coding memory = durable lessons",
  ];
  const live: string[] = [];
  if (opts?.hasScratchpad) {
    live.push("scratchpad active");
  }
  if (opts?.memoryHitCount && opts.memoryHitCount > 0) {
    live.push(`${opts.memoryHitCount} memory hit(s)`);
  }
  if (opts?.archiveHint) {
    live.push("archives available");
  }
  return [
    "[CONTINUITY]",
    bits.join(" · "),
    live.length ? `This turn: ${live.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
