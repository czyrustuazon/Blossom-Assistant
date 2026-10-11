# Blossom Assistant — Vision hand-off

Offline image → text for the local coder. **No internet escalation** on this path.

## What shipped (2026-10-11)

### Pipeline

```
attach image(s)
  → blossom.vision.onAttach = local-caption (default)
  → Ollama VL (bytes to local model)
  → on failure: Tesseract OCR (+ optional Pillow invert/autocontrast)
  → inject [IMAGE CAPTION — local] into the coding prompt
  → local text coder (ChatRouter / Ollama) — still cannot see pixels
```

### Key files

| File | Role |
|------|------|
| `src/vision/caption.ts` | Ollama VL caption + cache + caption block formatting |
| `src/vision/ocr.ts` | Local Tesseract + optional Python/Pillow preprocess |
| `src/vision/metadata.ts` | Dimensions / channels / mean RGB (fallback only) |
| `src/agent/orchestrator.ts` | Wires `local-caption` before the coding turn |
| `src/config.ts` / `package.json` | Settings under `blossom.vision.*` |
| `.cursor/rules/offline-priority.mdc` | Always-on: stay offline; hardware gaps = open problems |

### Settings

| Setting | Default | Meaning |
|---------|---------|---------|
| `blossom.vision.onAttach` | `local-caption` | Offline caption path |
| `blossom.vision.caption.enabled` | `true` | Master switch for caption step |
| `blossom.vision.caption.model` | `moondream` | Ollama multimodal tag |
| `blossom.vision.caption.ollamaBaseUrl` | `http://127.0.0.1:11434` | Vision Ollama (may differ from ChatRouter `:8081`) |
| `blossom.vision.caption.timeoutMs` | `120000` | Per-image VL timeout |
| `blossom.vision.caption.ocrFallback` | `true` | Try Tesseract if VL fails |
| `blossom.vision.caption.ocrCommand` | `tesseract` | OCR binary |
| `blossom.vision.caption.maxImages` | `3` | Cap per turn |

`metadata-only` and `escalate` remain available; **escalate is not the offline product path.**

### Caption block shape

```text
[IMAGE CAPTION — local]
file: shot.png
source: vl
Exact UI text: command 'blossom.openChat' not found
Kind: error toast
Notes: ignore decorative chrome
Local coder is text-only — treat Exact UI text above as ground truth for the screenshot.
```

`source` is `vl` | `ocr` | `metadata`.

### Local setup checklist

1. Ollama running on `127.0.0.1:11434` (or your `ollamaBaseUrl`).
2. Pull a VL model, e.g. `ollama pull moondream` (or `llava` / `qwen2-vl` and set `blossom.vision.caption.model`).
3. Optional OCR: install [Tesseract](https://github.com/tesseract-ocr/tesseract) on PATH.
4. Optional OCR preprocess: `pip install pillow` (invert + autocontrast for dark UI).
5. Reload the extension; attach a screenshot; confirm status shows local caption ready.

---

## Open roadblocks (problems to solve — locally)

Do **not** close these by calling Gemini / Claude / Cursor cloud.

### R1 — VRAM / model load for VL

**Problem:** A usable multimodal model (Moondream / LLaVA / Qwen2-VL) may not fit beside the coding GGUF, or may fail to load on this GPU/RAM.

**Symptoms:** Caption status → VL error; falls through to OCR or metadata; chat shows `[VISION ROADBLOCK — local]`.

**Local mitigations to try:**

- Smaller VL (`moondream`) and unload coder during caption (ChatRouter/Ollama process policy — not implemented yet).
- CPU-only VL with long `timeoutMs` (slow but offline).
- Caption-only Ollama instance on another port; keep ChatRouter on `:8081`.

**Owner gap:** Extension does not yet coordinate model unload/swap with ChatRouter.

### R2 — OCR quality on dark IDE toasts

**Problem:** Classic OCR on dark VS Code/Cursor chrome (icons, anti-aliased fonts, overlapping status text) often returns jumbled strings — the failure mode that motivated VL-first.

**Symptoms:** `source: ocr` with garbled `Exact UI text`; coder trusts bad text.

**Local mitigations to try:**

- Improve preprocess (crop to toast bbox, larger upscale, threshold) before Tesseract.
- Prefer VL; treat OCR as untrusted (`Kind: (ocr fallback — verify carefully)` already labeled).
- UI-specific templates (toast region heuristics) — not implemented.

### R3 — Caption latency

**Problem:** Cold VL load can take tens of seconds; every attach adds a round-trip.

**Local mitigations:**

- In-memory cache keyed by `size:mtime:path` (implemented).
- Keep VL model hot in Ollama (`keep_alive`).
- Parallel caption for multi-image (currently sequential).

### R4 — ChatRouter has no first-class vision route

**Problem:** Coding goes through ChatRouter OpenAI text completions; caption uses a **separate** Ollama VL call. ChatRouter does not yet own a `vision` role / hot-swap for screenshots.

**Local mitigations:**

- Keep dual-endpoint design (coding `:8081`, vision `:11434`) until ChatRouter grows a local vision route.
- Document model tags on both sides so they do not fight for VRAM (see R1).

### R5 — No image bytes in session history

**Problem:** History only stores “N image(s) attached” / caption text. Re-asking without re-attach relies on caption text quality.

**Local mitigations:** Persist last caption in scratchpad or a small vision cache file under `.blossom/` — not implemented.

### R6 — GIF / animated / huge screenshots

**Problem:** Large images or multi-frame GIFs may blow VL context or timeout.

**Local mitigations:** Downscale before VL; reject/skip oversize files with a clear roadblock line — only soft timeout exists today.

---

## Web research

Public-internet tools for the local agent — **on by default** (set `blossom.web.enabled` false for fully offline). Not vision and not cloud LLM escalate.

| Setting | Default | Meaning |
|---------|---------|---------|
| `blossom.web.enabled` | `true` | Expose `web_search`, `fetch_url`, `browser_*` in research/full tool profiles |
| `blossom.web.askBeforeUse` | `true` | Confirm before the first network tool of a turn |
| `blossom.web.fetchMaxChars` | `20000` | Cap on `fetch_url` text |
| `blossom.web.browser.channel` | `chrome` | Playwright system browser (`chrome` or `msedge`) |
| `blossom.web.browser.headless` | `true` | Headless Playwright |

**Backends:** DuckDuckGo HTML search, HTTP fetch (HTML→text), `playwright-core` against installed Chrome/Edge (no Chromium download). Screenshots land under `.blossom/web/`.

**Routing:** Need-based (local vs search vs fetch vs browser) — not “try local N times then web.” When `blossom.web.enabled` is on, Blossom searches/fetches on its own; no “search the web” phrase gate.

**Key files:** `src/web/{search,fetchUrl,browser,gate}.ts`, wiring in `src/agent/tools.ts`, `prompts.ts`, `toolProtocol.ts`, `orchestrator.ts`.

---

## Explicit non-goals (this hand-off)

- Cloud vision (Gemini / Claude / Cursor Agent online) as the default fix for screenshots.
- Changing the local coding GGUF into a multimodal model without a dedicated VL step.
- Shipping OCR as the primary path for IDE UI.
- Cloud LLM/vision as the default for stuck coding or screenshots (web research tools are separate and user-disableable).

---

## Next implementer tasks (suggested order)

1. Verify on machine: `ollama pull moondream` → attach the `blossom.openChat` toast → confirm `source: vl` and exact string in the prompt.
2. If R1 hits: pick smallest VL that quotes UI text reliably; note VRAM numbers here.
3. If only OCR works: tighten preprocess (crop + upscale) in `src/vision/ocr.ts`.
4. Optional: ChatRouter `/v1/vision/caption` so the extension stops talking to Ollama directly.
5. Optional: unload/reload policy between coder and VL to clear R1.
