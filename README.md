# tocoder

AI coding agent for the terminal — clone of [opencode](https://github.com/anomalyco/opencode) / Claude Code. TypeScript + Ink TUI + Vercel AI SDK.

## Features

- **Agent loop** with tool calling (`read`, `write`, `edit`, `bash`, `glob`, `grep`) — `maxSteps: 20`, 60s timeout, `fullStream` + tool logs, typed errors, always replies even if text empty
- **Multi-model** — 3+ models simultaneously via `tokoder.config.json` (Anthropic / OpenAI / OpenRouter / Ollama)
- **3-panel TUI** — fixed header/status/input (`flexShrink:0`), scrollable output (`PgUp`/`PgDn`), `↑`/`↓` browses previous commands, wraps long lines (`innerW`), alt buffer with sync transcript dump (`TOCODER_ALT_SCREEN=0` disables)
- **Vim-style commands** — `:exit` `:compact` `:models` `:allow`/`:deny` with ghost autocomplete (`Tab`/`Enter` completes)
- **Sandbox** — blocks writes/reads outside `cwd` unless `:allow <path>`, `SYSTEM` guard
- **Chat history** — keeps 20 turns, `1`/`2`/`3` auto-expands to explicit choice
- **CLI** — `tocoder` (also `tokoder` alias), `models`, `--all` parallel compare, `--no-tui`
- **Diagnostics** — `:models test <id>` checks Ollama `/api/tags` / `/v1/models`, shows `ECONNREFUSED`/`401`/`404` instead of silent hang
- **WSL + Android Studio** aware — env detection in status bar

## Requirements

- Node.js 18+ (tested 24.21.0)
- WSL available on Windows (optional)
- Ollama (optional, for local models)

## Install

```bash
npm install
npm run build
npm link        # exposes `tocoder` and `tokoder` globally
```

## Configuration

### API keys — `.env` (see `.env.example`)

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
OPENROUTER_API_KEY=sk-or-...
```

### Models — `tokoder.config.json` (or `~/.config/tokoder/config.json`)

```json
{
  "models": [
    { "id": "claude-sonnet", "provider": "anthropic", "model": "claude-sonnet-4-20250514", "apiKeyEnv": "ANTHROPIC_API_KEY" },
    { "id": "gpt-4o", "provider": "openai", "model": "gpt-4o", "apiKeyEnv": "OPENAI_API_KEY" },
    { "id": "gemini-flash", "provider": "openrouter", "model": "google/gemini-2.0-flash-001", "apiKeyEnv": "OPENROUTER_API_KEY", "baseURL": "https://openrouter.ai/api/v1" },
    { "id": "qwen-local", "provider": "ollama", "model": "qwen3:8b", "baseURL": "http://localhost:11434/v1" }
  ],
  "defaultModel": "claude-sonnet"
}
```

Providers: `anthropic` | `openai` | `openrouter` | `ollama`. `baseURL` enables any OpenAI-compatible endpoint.

Local Qwen example:
```bash
ollama pull qwen3:8b
# inside tocoder
:models add qwen-local ollama qwen3:8b
:models test qwen-local
:models default qwen-local
```

## Usage

```bash
tocoder                          # TUI, default model
tocoder -m gpt-4o "fix tests"    # TUI with prompt + model
tocoder --no-tui "explain src/"  # plain stdout
tocoder --all "compare answers"  # run all 3 models in parallel
tocoder models                   # list configured models
TOCODER_ALT_SCREEN=0 tocoder     # stay in buffer without alt screen

# inside TUI:
# Tab / Shift+Tab  cycle model
# :e + Tab/Enter   autocomplete vim commands (ghost hint)
# PgUp/PgDn        scroll output
# ↑/↓              previous commands history (like shell)
# Enter            send (prefix :comp → :compact auto-completes)
# Esc / Ctrl+C     exit (transcript stays in scrollback)

# scripts (Windows / WSL)
powershell -ExecutionPolicy Bypass -File scripts/tocoder.ps1 "prompt" -Model gpt-4o -All -NoTui
bash scripts/tocoder.sh --model gemini-flash "prompt"
scripts/tocoder.bat "prompt"
```

### Vim commands

| Command | Action |
|---------|--------|
| `:exit`, `:q`, `:quit` | exit (transcript dumped) |
| `:compact` | keep last 2 messages, reset tokens |
| `:models` | list models |
| `:models <id>` | switch model |
| `:models add <id> <provider> <model> [baseURL]` | add model to `tokoder.config.json` |
| `:models rm <id>` | remove |
| `:models default <id>` | set default |
| `:models key <id> <API_KEY>` | save to `.env` |
| `:models test [id]` | diagnose connection (`/api/tags`) |
| `:models set <id> <field> <value>` | edit field |
| `:allow <path>` | permit outside `cwd` |
| `:deny <path>` | revoke |
| `:help` | help |

Typing `:` shows ghost hint when prefix is unambiguous — `Enter` executes, `Tab` completes (e.g. `:comp` → `:compact`).

## TUI Layout

```
┌─ tocoder ─ Tab cycle ─────────────────────┐
│ ● claude-sonnet ○ gpt-4o ○ gemini-flash   │
├─ STATUS ──────────────────────────────────┤
│ Model: claude-sonnet (...) │ ↑ 1234 ↓ 567 │
│ LOC: 2,069 │ Time: 00:05:23 │ Env: ✓WSL ✓Android ✓Node │
├─ AI RESPONSE (scrollable, PgUp/PgDn) ─────┤
│ ● AI: ...                                 │
├─ INPUT ───────────────────────────────────┤
│ › your command ▌  (or :exit with hint)    │
└───────────────────────────────────────────┘
```

- **Header/Status/Input**: `flexShrink: 0` — never shrink
- **Output**: `flexGrow: 1` + `overflow: hidden` + `height = rows - chrome`, sliced to fit; `scroll` offset; `wrap="wrap"` with `innerW = cols-6`
- **Input**: `flexWrap="wrap"`, `↑`/`↓` history `(n/N)`, ghost `suggestion`
- **LOC**: `src/utils/stats.ts` (ignores `node_modules`, `dist`, `.git`)
- **Tokens**: AI SDK `usage` + `len/4` fallback
- **Envs**: WSL / Android / Node
- **Alt buffer**: `\x1b[?1049h/l`, sync `writeSync` dump on unmount

## Troubleshooting

**No visible response** — `fullStream` logs `→ tool`/`← result`, `SYSTEM` forces final answer, empty `text` shows `[tools used: …]`.

**Choice `1`/`2`/`3` ignored** — now expands to `My choice is "3"...` with 20-turn history.

**Builds outside folder** — blocked by `src/utils/permissions.ts` (`isInsideRoot`), `DENIED: outside project` → `:allow <path>` to permit.

**Local model no response**

```bash
:models test qwen-local   # check Ollama/LM Studio reachable + model exists
ollama list                # if 404: ollama pull qwen3:8b
ollama serve               # if ECONNREFUSED
# LM Studio: ensure http://localhost:1234/v1 + model qwen/qwen3.5-9b
```

Common: `404` → wrong `model`; `ECONNREFUSED` → not running; `401` → wrong `apiKeyEnv`.

**Wraps / history gone off edge** — fixed `wrap="wrap"` + `innerW`, `↑`/`↓` for history, `PgUp`/`PgDn` for scroll.

**Terminal closes on exit** — sync `writeSync` dump, `TOCODER_ALT_SCREEN=0` to disable alt buffer.

## Project Structure

```
src/
  cli.ts              # commander CLI (tocoder), dotenv
  core/
    agent.ts          # streamText fullStream, history, timeout, testConnection
    config.ts         # load/save tokoder.config.json
    providers.ts      # getModelFromConfig
  tools/              # read / write / edit / bash / glob / grep (guarded)
  tui/App.tsx         # Ink 3-panel, vim, autocomplete, history, wrap, sandbox :allow
  utils/
    stats.ts          # LOC + env + duration
    env.ts            # .env set/mask
    permissions.ts    # isInsideRoot, guard, allow/deny
scripts/
  tocoder.ps1 / .sh / .bat (and tokoder aliases)
tokoder.config.json
```

## Development

```bash
npm run dev            # tsx src/cli.ts
npm run dev:all        # --all
npm run typecheck
npm run build
```

## License

MIT — see [LICENSE](LICENSE)
