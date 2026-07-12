/**
 * Blossom Assistant (VS Code plugin) is coding-only.
 * Mode switching (Japanese / RP) lives in ChatRouter for other clients — not here.
 */

export type ModeOverride = null;

/** Always coding for the extension. */
export function resolveMode(_userText: string, _sessionOverride?: ModeOverride): {
  mode: "coding";
  source: "default";
} {
  return { mode: "coding", source: "default" };
}

/** Strip legacy slash tokens if someone still types them. */
export function stripSlashCommand(userText: string): string {
  return userText
    .replace(/^\/(code|coding|jp|japanese|rp|roleplay)\b\s*/i, "")
    .trim();
}
