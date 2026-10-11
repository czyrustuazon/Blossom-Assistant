# Blossom Assistant

VS Code **coding assistant** that talks to your **local LLM** — by default the **Blossom ChatRouter** (OpenAI-compatible), with optional native **Ollama** support.

The plugin is coding-only (no Japanese / RP mode chips). ChatRouter still may wrap answers in companion voice after the coder path. The extension always injects a **Blossom identity** + continuity layers so the IDE path stays product-shaped even without ChatRouter voice.

## Requirement: a local LLM

Blossom does **not** ship a model. Run your LLM stack, then point the extension at it.

### Recommended: Blossom ChatRouter

1. Start **ChatRouter** (from the Blossom project) so it listens on `http://127.0.0.1:8081`.
2. In Settings → Blossom Assistant:
   - `blossom.backend` = **`chatRouter`**
   - `blossom.api.baseUrl` = **`http://127.0.0.1:8081`** (or your Tailscale URL)
   - `blossom.persona.source` = **`router`**
3. Use **Blossom: Check LLM Connection** / **Ping** — you should see `ChatRouter OK`.

ChatRouter exposes:

- `GET /health`
- `POST /v1/chat/completions`
- `GET/POST /v1/memory/coding` (durable coding lessons)

The extension forces the **coding** route on ChatRouter for every plugin turn.

### Alternative: Ollama

Set `blossom.backend` = `ollama` and `blossom.api.baseUrl` = `http://localhost:11434` (or Tailscale). Native `/api/chat` + workspace tools (list/read/search/edit, sibling peek, IDE diagnostics/symbols).

## Quick start

1. Build + install (pick one):
   - **One-click install (recommended):** double-click `install.bat` — compiles, packs a `.vsix`, and installs into Cursor / VS Code. Then **Reload Window**.
   - **Debug without installing:** open this folder and press **F5** (Extension Development Host)
   - **Compile only:** `compile.bat`, `watch.bat`, `Ctrl+Shift+B`, or auto-watch on folder open
   - **Manual:** `npm install` && `npm run compile` && `npm run package` && `cursor --install-extension blossom-assistant-*.vsix`
2. Click the **cherry blossom** in the **editor title bar**, or **Blossom: Open Chat**
3. Confirm `api.baseUrl` points at a running ChatRouter / Ollama

## What Blossom remembers (continuity)

| Layer | What it is | Lifetime |
|-------|------------|----------|
| **Scratchpad** | Task working notes (Goal/Decisions/Done/Next/Blockers) | Survives Clear chat; not durable Chroma |
| **Repo knowledge** | Project map, entrypoints, fuzzy name aliases | Workspace storage |
| **Chat archives** | Past sessions under `.blossom/chats/` | Disk; agent can list/search/read |
| **Coding memory** | Durable lessons via ChatRouter `/v1/memory/coding` | Chroma; host injects hits + `search_coding_memory` |

Disk / editor truth always wins over memory.

## Agent tools (high level)

- Workspace: list/read/search, `search_replace` / `write_file` / `delete_file`, sibling peek
- **IDE:** `get_diagnostics`, `get_document_symbols`, `go_to_definition`, `find_references`
- Shell: `run_command` (optional `background=true`), `await_background_command`, `list_background_commands`
- History / memory: chat archives + `search_coding_memory`
- **Web** (default on; set `blossom.web.enabled` false for fully offline): `web_search`, `fetch_url`, `browser_*`
- **Ghidra:** `read_ghidra` / `ghidra_mcp` when a local bridge is up
- Tool profiles: `minimal` / `research` / `full` (auto from prompt tier)
- Parallel read-only tools in one round (`blossom.agent.parallelTools`)
- Local retry before cloud escalate (`blossom.agent.localRetryBeforeEscalate`)

## Edits & guards

- Fence → Apply cards, PR-style replace previews, optional side-by-side diff
- Auto-apply / auto-save (session toggle in chat)
- Content guard (block prose-into-code / gutting), dry-run gate for patch scripts, patch-script map
- LINK CHECK / UNUSED FILES from real `fs.access`

## Vision (offline)

Default `blossom.vision.onAttach` = `local-caption`:

1. Optional VRAM unload of Ollama models (`unloadCoderFirst`)
2. Local Ollama VL caption
3. Tesseract OCR fallback (+ Pillow dark-UI preprocess)
4. Inject `[IMAGE CAPTION — local]`; last captions also saved under `.blossom/last-captions.json`

See `hand-off.md` for open local roadblocks (R1–R6). **Escalate is not the offline product path.**

## Repo knowledge (persisted)

Blossom indexes your workspace (structure, manifests, entry points) into workspace storage so it does not re-scan from scratch every message.

- Fuzzy-matches mistyped file names and remembers aliases (`indx.html` → `index.html`)
- Injects a compact repo map into coding prompts
- Commands: **Blossom: Refresh Repo Knowledge**, **Blossom: Show Repo Knowledge**

## Scratchpad

Workspace-scoped working notes (not durable Chroma memory), capped at ~4k chars:

- Host decides necessity (multi-step / multi-file / plan / RE / tool failures) and injects REQUIRED vs optional vs skip
- Agent maintains the pad itself; host autofills from PLAN/Summary if it forgets on a REQUIRED turn
- **Scratchpad** chip in chat, or **Blossom: Edit / Show / Clear Scratchpad**
- Survives **Clear** chat; cleared only via Clear Scratchpad / empty overwrite

## Session controls

- **Auto-apply** — write proposed file edits to disk without clicking Apply (this chat session only)
- **Scratchpad** — workspace working notes for multi-step tasks
- **History** — browse / restore `.blossom/chats/`
- **Fast mode** — skip command / web confirm prompts
- **Ping** — recheck backend health
- **Clear** / **Stop**
- HITL: `blossom.agent.stepMode` = `confirmTools` | `planSteps`

## Cloud escalate (opt-in, not default)

Local tools first. If still stuck, the model may emit `ESCALATE_GEMINI` / `ESCALATE_CLAUDE` (Cursor escalate disabled). Host asks first when `blossom.escalate.askFirst` is true. After tool-round exhaustion, Blossom tries a **local retry** before injecting escalate.

## Requirements

- ChatRouter on `:8081` **or** Ollama reachable at the configured base URL
- Node.js 20+ only if packaging from source
- Optional: Tesseract + Pillow for OCR; Ghidra MCP bridge; Chrome/Edge for Playwright browser tools
- Optional: Gemini / Claude API keys for escalate UI
