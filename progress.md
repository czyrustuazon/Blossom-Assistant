# Blossom Assistant — Progress

Chronological log of work on the VS Code / Cursor extension (disk owner for Blossom ChatRouter).

---

## 2026-07-12

### Product & branding
- Renamed display from “Blossom Coder” / “AI Girlfriend ChatRouter” → **Blossom Assistant** + **Blossom ChatRouter**.
- Extension description and README updated for consistent naming.
- Tab titles: first user ask becomes a one-line editor tab label (Clear resets).

### Disk truth — Apply / Auto-apply
- **Auto-apply on by default** (`blossom.edits.autoApply`).
- **Auto-save** after Apply so disk updates without Ctrl+S.
- Multi-file Apply via `path=…`, `**file.ext**` headings, HTML comments (never invent paths from `<title>`).
- CREATE vs EDIT rules so new pages aren’t dumped into attached `index.html`.

### Deletes
- **Delete-on-Apply**: `DELETE path=…`, delete fences, Ollama `delete_file`.
- **Safe-delete mode**: extension deletes `[UNUSED FILES]`; ignores model write fences that would recreate orphans or rewrite `index.html`.
- Fixed bug where user-named deletes were marked “already done” and never ran.
- **Delete targeting guard**: resolve bare names (`marks` → `marks.html`) against workspace disk; lock deletes to user-named targets so the model can’t remove the wrong file.

### Link / unused-file context
- Inject `[LINK CHECK]` (EXISTS/MISSING via `fs.access`).
- Inject `[UNUSED FILES]` + `[TASK BRIEF]` so orphan deletes ≠ stripping working links.

### Chat UI
- Structured reply rendering: Plan / Execute / Verify sections and path-labeled code boxes (Wikipedia-style).
- Empty Execute / delete headers fixed (eyebrow + compact Delete rows).
- Collapsible Prep/Thoughts trail; infra steps filtered.
- **Model reasoning ticker**: `model_reasoning` / `reasoning_content` beside the spinner, one sentence every 5s; no box; flash **Done** when the turn ends (don’t drain leftover sentences).
- **Retry on failure**: error card with original question + Retry button.

### Memory & cloud escalate
- Soft-fail `POST /v1/memory/coding` after successful Gemini escalate (`source: blossom_assistant_gemini`).
- No local Chroma in the extension; ChatRouter owns Claude/Gemini coding-path learning server-side.

### Sibling peek & tools
- Read-only capped sibling folder peek; writes only inside workspace roots.

### Packaging / repo hygiene
- Expanded `.gitignore` (`node_modules/`, `out/`, `*.vsix`, `.env`, etc.).
- Packaged builds through **0.1.44** (VSIXes gitignored).

### Commits (same day)
| Time (approx.) | Hash | Message |
|---|---|---|
| 19:24 | `96635c3` | First commit |
| 20:02 | `8078a82` | Improve Apply/delete flow, memory learning, and model reasoning UI |
| 20:41 | `6e33cfb` | Fix delete targeting and polish failure/reasoning chat UX |

### Architecture locked in
- **Extension**: editor attach, repo knowledge, disk checks, Apply / auto-apply / deletes, fence→file mapping, UI summary.
- **ChatRouter**: routing, RAG, coding_rules, GGUF hot-swap, Chroma `coding_lessons`.
- Disk truth = extension only.

---

## 2026-07-13

- Progress log created (`progress.md`).
- **Correctness feedback (thumbs)**: parse ChatRouter `blossom.feedback` / `blossom_feedback`; show 👍/👎 under coding replies when `feedback_id` is present; `POST /v1/feedback` with `correct` | `incorrect` (soft-fail). Companion routes without an id skip the controls.

---

## 2026-10-11

### Scratchpad (workspace working notes)
- Thin overwriteable pad in `workspaceState` (`blossom.scratchpad`), capped at 4k chars.
- Injected as `[SCRATCHPAD]` on every coding turn via `enrichWithEditorContext`.
- Model can full-overwrite via a `scratchpad` code fence (stripped from history); user via **Scratchpad** chip / Edit / Show / Clear commands.
- Not durable Chroma memory — Clear chat does **not** clear the pad.
- **Necessity pipeline:** host `assessScratchpadNeed` → REQUIRED / optional / skip directives; CONTINUE-round duty hints; autofill from PLAN/Summary/tool failures if the model forgets on REQUIRED turns.

### Token-efficiency closeout (Assistant)
- **Tool profiles:** `blossom.agent.toolProfile` (`auto`|`minimal`|`research`|`full`). Tiny→minimal catalog; plan→research (no write/delete in catalog); full omits alias tools from catalog. Wired into ChatRouter wraps + Ollama native tool list.
- **Transcript compaction:** `compactToolTranscript` keeps head+tail for `run_command`, collapses repeated lines, tighter caps via `blossom.agent.toolResultMaxChars`. Compacted text is what re-enters ChatRouter + Ollama tool history.
- **Navigation:** `search_text` ranks open/active paths first; `read_file` clusters search hits into a window; unscoped reads soft-cap at 200 lines.
- **HITL step gates:** `blossom.agent.stepMode` (`off`|`confirmTools`|`planSteps`) + `confirmToolsAfterRounds` / `maxToolRounds`. Continue/Stop card in chat (reuses cmd-card UX). Escalation handoff path unchanged (one `compressHandoff`).

---

### Offline vision caption (no internet escalate)
- Default `blossom.vision.onAttach`: `local-caption`.
- `src/vision/caption.ts` → Ollama VL (`moondream` default) with image bytes; cache by size/mtime/path.
- OCR fallback: `src/vision/ocr.ts` (Tesseract + optional Pillow invert).
- Orchestrator injects `[IMAGE CAPTION — local]` before the text-only coder runs.
- Roadblocks (VRAM, OCR quality, latency, ChatRouter vision gap, …) documented in `hand-off.md`.
- Agent rule: `.cursor/rules/offline-priority.mdc`.

---

### Chat history (saved / revisit)
- Auto-save each Blossom chat under workspace `.blossom/chats/` after every reply (and on Clear / tab close).
- **History** chip + commands `Blossom: Open Chat History` / `Save Current Chat` to reopen or delete archives.
- Restored chats reload UI transcript + orchestrator context so the user can continue.
- Agent tools: `list_chat_history`, `search_chat_history`, `read_chat_history` (research + full profiles) when the user asks about a past conversation.
- Gitignored; index at `.blossom/chats/index.json`.

---

## Open / later (not done)

- Optionally lock unrelated `index.html` edits when the user only asked to delete a named file.
- Optional setting `blossom.chat.showModelReasoning` (default true).
- Cloud provider order remains backend env (`CLOUD_FALLBACK_ORDER`), not the extension.
- Vision R1–R6 in `hand-off.md` (local VL VRAM, OCR dark-UI, caption latency, ChatRouter vision route, history, large images).
