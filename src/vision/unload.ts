/**
 * Best-effort VRAM relief before local VL caption (R1).
 * Unloads models on the vision Ollama instance via keep_alive=0.
 * Soft-fails — caption still runs if unload fails.
 */

export async function unloadOllamaModels(opts: {
  baseUrl: string;
  /** Prefer unloading these tags first (e.g. coding GGUF if shared host). */
  preferUnload?: string[];
  timeoutMs?: number;
}): Promise<{ unloaded: string[]; errors: string[] }> {
  const base = opts.baseUrl.replace(/\/$/, "");
  const unloaded: string[] = [];
  const errors: string[] = [];
  const timeoutMs = opts.timeoutMs ?? 15_000;

  let tags: string[] = [];
  try {
    const res = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        models?: Array<{ name?: string; model?: string }>;
      };
      tags = (data.models ?? [])
        .map((m) => String(m.name || m.model || "").trim())
        .filter(Boolean);
    }
  } catch (err) {
    errors.push(
      `list models: ${err instanceof Error ? err.message : String(err)}`
    );
    return { unloaded, errors };
  }

  const prefer = (opts.preferUnload ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
  const preferSet = new Set(prefer.map((p) => p.toLowerCase()));

  // Unload preferred first, then everything else currently listed.
  const ordered = [
    ...tags.filter((t) => preferSet.has(t.toLowerCase()) || prefer.some((p) => t.toLowerCase().startsWith(p.toLowerCase()))),
    ...tags.filter(
      (t) =>
        !preferSet.has(t.toLowerCase()) &&
        !prefer.some((p) => t.toLowerCase().startsWith(p.toLowerCase()))
    ),
  ];
  // Dedupe
  const seen = new Set<string>();
  const unique = ordered.filter((t) => {
    const k = t.toLowerCase();
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });

  for (const model of unique) {
    try {
      const res = await fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: "",
          keep_alive: 0,
          stream: false,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        unloaded.push(model);
      } else {
        // Also try /api/chat unload style
        const res2 = await fetch(`${base}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [],
            keep_alive: 0,
            stream: false,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res2.ok) {
          unloaded.push(model);
        } else {
          errors.push(`${model}: ${res.status}/${res2.status}`);
        }
      }
    } catch (err) {
      errors.push(
        `${model}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return { unloaded, errors };
}

/** Soft-fail notify ChatRouter that vision needs VRAM (optional endpoint). */
export async function notifyChatRouterVisionPause(
  chatRouterBaseUrl: string
): Promise<boolean> {
  const base = chatRouterBaseUrl.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/v1/vision/pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "local_vl_caption" }),
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
