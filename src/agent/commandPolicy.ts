import * as vscode from "vscode";
import { getConfig } from "../config";

/** Decision from the chat UI for a pending shell command. */
export type CommandDecision = "run" | "always" | "deny";

/**
 * True when `command` matches an allowlist entry:
 * - exact match
 * - entry ending in `*` → prefix match (`git *`, `npm test*`)
 * - single-token entry → first argv token match (`ls`, `cat`)
 * - other entry → prefix match at a word boundary
 */
export function isCommandAllowlisted(
  command: string,
  allowlist: string[] = getConfig().commands.allowlist
): boolean {
  const cmd = (command || "").trim();
  if (!cmd) {
    return false;
  }
  const first = cmd.split(/\s+/)[0] ?? "";
  return allowlist.some((raw) => {
    const e = (raw || "").trim();
    if (!e) {
      return false;
    }
    if (e.endsWith("*")) {
      const prefix = e.slice(0, -1);
      return cmd.startsWith(prefix);
    }
    if (cmd === e) {
      return true;
    }
    if (!/\s/.test(e)) {
      return first === e;
    }
    return cmd.startsWith(e) && (cmd.length === e.length || /\s/.test(cmd[e.length] ?? ""));
  });
}

/** Pattern stored by "Always allow" — first shell token (e.g. `ls`, `git`). */
export function allowlistPatternFor(command: string): string {
  const first = (command || "").trim().split(/\s+/)[0] ?? "";
  return first;
}

export async function addCommandToAllowlist(command: string): Promise<string> {
  const pattern = allowlistPatternFor(command);
  if (!pattern) {
    return "";
  }
  const cfg = vscode.workspace.getConfiguration("blossom");
  const current = cfg.get<string[]>("commands.allowlist") ?? [];
  if (current.some((e) => (e || "").trim() === pattern)) {
    return pattern;
  }
  await cfg.update(
    "commands.allowlist",
    [...current, pattern],
    vscode.ConfigurationTarget.Global
  );
  return pattern;
}

/** Extract workspace path from a fence info line (path= / file=). */
export function pathFromFenceInfo(info: string): string | undefined {
  const m = (info || "")
    .trim()
    .match(/\b(?:path|file)\s*[=:]\s*["']?([^\s"'`]+)/i);
  return m?.[1]?.replace(/\\/g, "/");
}

/** True when a fence info line is a path-labeled file write (show as diff card, not dump). */
export function isPathLabeledWriteFence(info: string): boolean {
  const i = (info || "").trim();
  if (!i) {
    return false;
  }
  if (/^tool_call$/i.test(i.split(/\s+/)[0] || "")) {
    return false;
  }
  if (/\b(?:delete|remove)(?:_file)?\b/i.test(i)) {
    return false;
  }
  return /\b(?:path|file)\s*[=:]/i.test(i);
}

/**
 * Filters streamed tokens so tool_call fences and path-labeled file dumps
 * never appear as giant Code boxes. Diff cards carry the real changes.
 */
export function createToolCallTokenFilter(): {
  push: (delta: string) => string;
  flush: () => string;
} {
  let buf = "";

  const holdPartial = (s: string): number => {
    // Hold a trailing partial ``` so we can classify the fence once complete.
    for (let n = Math.min(3, s.length); n > 0; n--) {
      if ("```".startsWith(s.slice(-n))) {
        return n;
      }
    }
    return 0;
  };

  const shouldDropFence = (infoLine: string): boolean => {
    const info = (infoLine || "").trim();
    const first = (info.split(/\s+/)[0] || "").toLowerCase();
    if (first === "tool_call") {
      return true;
    }
    return isPathLabeledWriteFence(info);
  };

  const consume = (): string => {
    let emit = "";
    for (;;) {
      const start = buf.indexOf("```");
      if (start < 0) {
        const hold = holdPartial(buf);
        if (hold > 0) {
          emit += buf.slice(0, buf.length - hold);
          buf = buf.slice(buf.length - hold);
        } else {
          emit += buf;
          buf = "";
        }
        break;
      }
      emit += buf.slice(0, start);
      const after = buf.slice(start);
      // Need a full info line (newline after opener) to classify.
      const nl = after.indexOf("\n", 3);
      if (nl < 0) {
        buf = after;
        break;
      }
      const info = after.slice(3, nl);
      const afterOpen = after.slice(nl + 1);
      const closeRel = afterOpen.search(/```/);
      if (closeRel < 0) {
        buf = after;
        break;
      }
      const fenceEnd = nl + 1 + closeRel + 3;
      if (shouldDropFence(info)) {
        const pathHint = pathFromFenceInfo(info);
        if (pathHint) {
          emit += `\n**Edit:** \`${pathHint}\`\n`;
        } else if (!emit.endsWith("\n")) {
          emit += "\n";
        }
      } else {
        emit += after.slice(0, fenceEnd);
      }
      buf = after.slice(fenceEnd);
    }
    return emit;
  };

  return {
    push(delta: string): string {
      if (!delta) {
        return "";
      }
      buf += delta;
      return consume();
    },
    flush(): string {
      // Drop incomplete suppressible fences; emit the rest.
      const start = buf.indexOf("```");
      if (start >= 0) {
        const after = buf.slice(start);
        const nl = after.indexOf("\n", 3);
        if (nl >= 0 && shouldDropFence(after.slice(3, nl))) {
          const kept = buf.slice(0, start);
          buf = "";
          return kept;
        }
      }
      const out = buf;
      buf = "";
      return out;
    },
  };
}
