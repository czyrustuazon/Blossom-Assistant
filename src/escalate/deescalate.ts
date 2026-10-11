import { ensureChatRouterCodingRoute } from "../agent/prompts";
import { cloudProviderDisplayName } from "./fallbackChain";
import type { EscalateTarget } from "../agent/prompts";

export interface CloudEscalationSnapshot {
  userText: string;
  localAttempt: string;
  provider: EscalateTarget;
  providerLabel: string;
  cloudAnswer: string;
  /** Full text shown in chat before de-escalate (local + cloud sections). */
  displayedAnswer: string;
}

export function buildDeescalateRetryPrompt(snap: CloudEscalationSnapshot): string {
  const body = [
    "[DEESCALATE — local Blossom retry after cloud escalation]",
    "",
    `Original user ask:\n${snap.userText}`,
  ];
  if (snap.localAttempt.trim()) {
    body.push("", `Prior local attempt:\n${snap.localAttempt.trim()}`);
  }
  body.push(
    "",
    `[CLOUD ${snap.providerLabel} ANSWER — read-only reference; verify on disk and implement locally]`,
    snap.cloudAnswer.trim().slice(0, 8000),
    "",
    "Using the cloud answer only as reference, finish or correct the task with local workspace tools.",
    "Prefer evidence from the repo over trusting the cloud text blindly.",
    "Do not emit ESCALATE_GEMINI / ESCALATE_CLAUDE unless truly stuck after tools. Never emit ESCALATE_CURSOR."
  );
  return ensureChatRouterCodingRoute(body.join("\n"));
}

export function mergeDeescalateAnswer(
  snap: CloudEscalationSnapshot,
  localRetry: string
): string {
  const parts: string[] = [];
  if (snap.localAttempt.trim()) {
    parts.push(snap.localAttempt.trim());
  }
  parts.push(
    `---\n*${snap.providerLabel}:*\n${snap.cloudAnswer.trim()}`,
    `---\n*Local retry:*\n${localRetry.trim()}`
  );
  return parts.join("\n\n");
}

export function createCloudSnapshot(opts: {
  userText: string;
  localAttempt: string;
  provider: EscalateTarget;
  cloudAnswer: string;
  displayedAnswer: string;
}): CloudEscalationSnapshot {
  return {
    userText: opts.userText,
    localAttempt: opts.localAttempt,
    provider: opts.provider,
    providerLabel: cloudProviderDisplayName(opts.provider),
    cloudAnswer: opts.cloudAnswer,
    displayedAnswer: opts.displayedAnswer,
  };
}
