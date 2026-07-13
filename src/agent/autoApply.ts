/**
 * Session / one-shot auto-apply intent from user text or UI.
 */

export interface AutoApplyIntent {
  /** Enable auto-apply for the rest of this chat session. */
  enableSession?: boolean;
  /** Disable session auto-apply. */
  disableSession?: boolean;
  /** Apply proposed edits for this turn only. */
  applyOnce?: boolean;
}

const ENABLE_SESSION =
  /\b(auto[- ]?apply|automatically apply|apply automatically|always apply|apply (?:edits |changes )?without (?:asking|confirming)|enable auto[- ]?apply)\b/i;

const DISABLE_SESSION =
  /\b(stop auto[- ]?apply(?:ing)?|disable auto[- ]?apply|don'?t auto[- ]?apply|no auto[- ]?apply|ask before apply(?:ing)?)\b/i;

const APPLY_ONCE =
  /\b(?:and |then )?(?:please )?apply (?:it|this|the (?:fix|change|changes|edit|edits|patch))(?: (?:to|on) (?:disk|the file|my file))?\b|\bwrite (?:it|this|the fix) (?:to|onto) (?:disk|the file)\b|\bsave (?:the )?(?:fix|change|changes|edit)(?: to (?:disk|the file))?\b/i;

export function parseAutoApplyIntent(userText: string): AutoApplyIntent {
  const intent: AutoApplyIntent = {};
  if (DISABLE_SESSION.test(userText)) {
    intent.disableSession = true;
  } else if (ENABLE_SESSION.test(userText)) {
    intent.enableSession = true;
  }
  if (APPLY_ONCE.test(userText) || intent.enableSession) {
    intent.applyOnce = true;
  }
  return intent;
}
