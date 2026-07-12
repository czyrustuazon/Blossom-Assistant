# Blossom Assistant

VS Code **coding assistant** that talks to your **local LLM** — by default the **Blossom ChatRouter** (OpenAI-compatible), with optional native **Ollama** support.

The plugin is coding-only (no Japanese / RP mode chips). ChatRouter still may wrap answers in companion voice after the coder path.

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

The extension forces the **coding** route on ChatRouter for every plugin turn.

### Alternative: Ollama

Set `blossom.backend` = `ollama` and `blossom.api.baseUrl` = `http://localhost:11434` (or Tailscale). Native `/api/chat` + workspace tools (list/read/search/edit, sibling peek).

## Quick start

1. `npm install` && `npm run compile` (if building from source)
2. Install the `.vsix`, or `F5` to debug
3. Click the **cherry blossom** in the **editor title bar**, or **Blossom: Open Chat**
4. Confirm `api.baseUrl` points at a running ChatRouter / Ollama

## Repo knowledge (persisted)

Blossom indexes your workspace (structure, manifests, entry points) into workspace storage so it does not re-scan from scratch every message.

- Fuzzy-matches mistyped file names and remembers aliases (`indx.html` → `index.html`)
- Injects a compact repo map into coding prompts
- Commands: **Blossom: Refresh Repo Knowledge**, **Blossom: Show Repo Knowledge**

## Session controls

- **Auto-apply** — write proposed file edits to disk without clicking Apply (this chat session only)
- **Ping** — recheck backend health
- **Clear** / **Stop**

## Requirements

- ChatRouter on `:8081` **or** Ollama reachable at the configured base URL
- Node.js 20+ only if packaging from source
- Optional: Gemini (ChatRouter env and/or Blossom escalate UI)
