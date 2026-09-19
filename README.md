# tocoder

AI coding agent for the terminal — clone of [opencode](https://github.com/anomalyco/opencode) / Claude Code. TypeScript + Ink TUI + Vercel AI SDK.

## Features

- **Agent loop** with tool calling (`read`, `write`, `edit`, `bash`, `glob`, `grep`) — manual multi-step loop (`stepCountIs`), 300s timeout per step, typed errors, always replies even if text empty
- **Tool approval** — every tool call asks `[T]ak / [N]ie / [A]zawsze` (A whitelists tool for the session); denied calls report back to the model
- **Multi-model** — 3+ models simultaneously via `tokoder.config.json` (Anthropic / OpenAI / OpenRouter / Ollama)
- **Per-model token counters** — `↑ sent ↓ recv` for the active model + `∑` total, counted until app exit (`:compact` keeps them); real `usage` from provider, `len/4` fallback
- **3-panel TUI** — fixed header/status/input (`flexShrink:0`), auto-scrolling output with scrollbar (`PgUp`/`PgDn` pauses, PgDn returns to bottom), editable `↑`/`↓` command history (incl. commands), alt buffer with sync transcript dump (`TOCODER_ALT_SCREEN=0` disables)
- **Vim-style commands** — `:exit` `:compact` `:models` `:allow`/`:deny` with ghost autocomplete (`Tab`/`Enter` completes)
- **Sandbox** — blocks writes/reads outside `cwd` unless `:allow <path>`, `SYSTEM` guard
- **Chat history** — keeps 20 turns, `1`-`9` auto-expands quoting the actual option text from the model's list
- **CLI** — `tocoder` (also `tokoder` alias), `models`, `--all` parallel compare, `--no-tui`, `--timeout <seconds>`
- **Diagnostics** — `:models test <id>` checks Ollama `/api/tags` / `/v1/models`, shows `ECONNREFUSED`/`401`/`404` instead of silent hang; `TOCODER_DEBUG=1` logs per-step `finishReason`
- **WSL + Android Studio** aware — env detection in status bar, Linux-style commands auto-routed to `wsl bash`

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
tocoder --no-tui --timeout 900 "big refactor"  # longer timeout
tocoder --all "compare answers"  # run all 3 models in parallel
tocoder models                   # list configured models
TOCODER_ALT_SCREEN=0 tocoder     # stay in buffer without alt screen
TOCODER_DEBUG=1 tocoder          # per-step finishReason diagnostics

# inside TUI:
# Tab / Shift+Tab  cycle model
# :e + Tab/Enter   autocomplete vim commands (ghost hint)
# PgUp/PgDn        scroll output (auto-scroll pauses; PgDn returns to bottom)
# ↑/↓              previous prompts & commands — editable (Backspace works)
# T / N / A        approve / deny / always-allow pending tool call
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
| `:compact` | keep last 2 messages (token counters preserved) |
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
│ Model: claude-sonnet (...) │ ↑ 1,234 ↓ 567│  ← per-model + ∑ total
│ LOC: 2,069 │ Time: 00:05:23 │ Env: ✓WSL ✓Android ✓Node │
├─ AI RESPONSE (auto-scroll + scrollbar) ───┤
│ ● AI: ...                              █  │  ← PgUp/PgDn pauses
├─ INPUT ───────────────────────────────────┤
│ › your command ▌  (or :exit with hint)    │
│ ⚡ Tool: bash {"command":"g++ ..."}        │  ← pending approval
│ [T]ak  [N]ie  [A]zawsze dla bash          │
└───────────────────────────────────────────┘
```

- **Header/Status/Input**: `flexShrink: 0` — never shrink
- **Output**: flat line-viewport (wrap-aware), auto-follows bottom during streaming; scrollbar column `█/│` on the right; `scroll` offset from PgUp; PgDn returns to live bottom
- **Input**: `flexWrap="wrap"`, `↑`/`↓` history `(n/N)` — editable without losing position, ghost `suggestion`
- **LOC**: `src/utils/stats.ts` (ignores `node_modules`, `dist`, `.git`)
- **Tokens**: per-model `usage` per agent step + `len/4` fallback; reset only on exit
- **Envs**: WSL / Android / Node
- **Alt buffer**: `\x1b[?1049h/l`, sync `writeSync` dump on unmount

## Troubleshooting

**Model stops after one tool call / stream cut silently** — was 60s timeout; now 300s per step (timer restarts after each tool batch). Raise with `--timeout 900` or `TOCODER_DEBUG=1` to see `finishReason` per step. `finishReason="length"` shows a truncation warning.

**Free OpenRouter models** — check https://openrouter.ai/models (filter `:free`); id must match exactly (e.g. `poolside/laguna-s-2.1:free`, not `laguna-m.1:free`). `:models set <id> model <slug>`.

**No visible response** — tool calls log `→ tool`/`← result`, `SYSTEM` forces final answer, empty `text` shows `[tools used]` fallback.

**Choice `1`-`9` ignored** — now expands quoting the option text from the model's last list, with 20-turn history.

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
  cli.ts              # commander CLI (tocoder), dotenv, --timeout
  core/
    agent.ts          # manual step loop (stepCountIs 1 + msgs re-feed), tool approval, timeout per step, testConnection
    config.ts         # load/save tokoder.config.json
    providers.ts      # getModelFromConfig
  tools/              # read / write / edit / bash / glob / grep (guarded); agentTools (schemas) + executors
  tui/App.tsx         # Ink 3-panel, vim, autocomplete, editable history, auto-scroll + scrollbar, tool approval, token stats
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
