# tocoder

AI coding agent for the terminal — clone of [opencode](https://github.com/anomalyco/opencode) / Claude Code. TypeScript + Ink TUI + Vercel AI SDK.

## Features

- **Agent loop** with tool calling (`read`, `write`, `edit`, `bash`, `glob`, `grep`) — manual multi-step loop (`stepCountIs`), 300s timeout per step, typed errors, always replies even if text empty
- **Session memory** — model + conversation context + **command history (↑/↓)** + **per-model token counters** are auto-saved per project after each turn (`.tokoder/sessions/`). Start `tocoder -c` to resume the last session in this folder (restores model, history, tokens, commands); `:session reset` clears it
- **CP437-safe UI** — all chrome (frames, labels, system messages) and **model output** are sanitized to ASCII (`✅→[OK]`, `⚠️→[!]`, `❌→[X]`, emoji dropped), so conhost on codepage 437 never renders garbage; arrows `↑↓` stay (render fine); spinner styles via `TOCODER_SPINNER` (`ascii` default | `dots` | `braille` | `arrow`)
- **Tool approval** — in-project targets run automatically; only `bash` commands touching absolute/`~`/`$env:` paths or out-of-project workdirs ask `[Y]es / [N]o / [A]bort run` (Shift+A = always for that tool this session); Esc aborts the run. **Read-only bash commands** (`cat`, `type`, `dir`, `git log`, `npm test`, …) don't prompt — they go through `read` rules (unlimited read by default); mutating commands (`>` redirect, `Remove-Item`, `git commit`, `npm install`, `curl`, …) prompt only when they reference paths outside the project
- **Markdown rendering** — model answers render as colored markdown in the terminal: headings (`|` cyan bold), bold/italic, `inline code` + fenced code blocks (green), bullet/numbered lists, blockquotes, tables, links; ANSI-aware wrapping keeps colors intact across wrapped lines; transcript dump keeps colors too
- **Live supplements** — while the agent is working, type in the input and press Enter: the text is queued and injected into the conversation at the next step boundary (`[user supplement while working] …`), without aborting the run; queued items show in the input panel, undelivered ones are reported when the run ends
- **ACL sandbox** — full access inside `cwd`; outside: Windows system folders always denied, per-mode rules (read/write/execute) persisted per project in `.tokoder/access-rules.json` (first run seeds from global `~/.config/tokoder/access-rules.json`); on first access outside rules the app asks `[P]File / [F]Parent folder / [N]o / [A]bort` and auto-retries the tool. Manage with `:acl`, `:acl set <mode> <yes|no>`, `:allow <path> [read|write|execute]`, `:deny <path>`
- **Multi-model** — models via `tokoder.config.json` (Anthropic / OpenAI / OpenRouter / Ollama local + Ollama Cloud / any OpenAI-compatible provider e.g. cheaperinference.com)
- **Anti-flicker spinner** — spinner is an isolated component with its own 80ms timer; only it rerenders during work, the rest of the UI stays static (no full-frame flicker)
- **Interactive `:models add` wizard** — local/cloud Ollama with live model listing (`/api/tags`), auto-suggested free id (overridable); cloud requires key set first via `:key`
- **Per-model token counters** — `id (1.1k↑/3.4k↓)` next to every model in header (0↑/0↓ when unused); STATUS shows **total sent/recv across all models**; counters persist in the session file (`.tokoder/sessions/`) and survive resume (`-c`) and mid-run aborts; real `usage` from provider per agent step (proxies reporting `totalTokens` with 0 `outputTokens` are derived as `total - input`), `len/4` estimate fallback on abort
- **3-panel TUI** — fixed header/status/input (`flexShrink:0`), auto-scrolling output with scrollbar (`PgUp`/`PgDn` pauses, PgDn returns to bottom), editable `↑`/`↓` command history (incl. commands), wrap-aware flex status panel (responsive on narrow terminals), alt buffer with sync transcript dump (`TOCODER_ALT_SCREEN=0` disables), cwd shown in header, Esc cancels (exit only via `:exit`)
- **Vim-style commands** — `:exit` `:compact` `:key` `:models` `:acl` `:allow`/`:deny` with ghost autocomplete (`Tab`/`Enter` completes)
- **Project instructions (`AGENTS.md`)** — file appended to the system prompt on every call: output-discipline rules (token savings) + tool cheat-sheet. `:agents init` creates it with defaults, `:agents edit` opens `$EDITOR` (default notepad), `:agents add <text>` appends, `:agents rm <n>` deletes a numbered line; changes apply from the next prompt
- **Compact** — 3 strategies (`reduce`/`balance`/`value`), optional steering instruction, auto-trigger at % of context window or absolute token limit (see below)
- **Chat history** — keeps 20 turns, `1`-`9` auto-expands quoting the actual option text from the model's list
- **CLI** — `tocoder` (also `tokoder` alias), `models`, `--all` parallel compare, `--no-tui` (prints `[tokens] ↑ ↓`), `--timeout <seconds>`
- **Diagnostics** — `:models test <id>` checks Ollama `/api/tags` / `/v1/models`, shows `ECONNREFUSED`/`401`/`404` instead of silent hang; `TOCODER_DEBUG=1` logs per-step `finishReason`
- **WSL + Android Studio** aware — env detection in status bar, Linux-style commands auto-routed to `wsl bash`

## Requirements

- Node.js 18+ (tested 24.21.0)
- WSL available on Windows (optional)
- Ollama (optional, for local models)

## Install

```bash
git clone <repo-url> && cd tokoder
npm install
npm run install:global   # build + npm link + global settings (~/.config/tokoder)
```

`npm run install:global` (= `node scripts/install.mjs`):
1. builds the app (`tsc`) if `dist/` missing
2. `npm link` → global commands `tokoder` / `tocoder`
3. creates `~/.config/tokoder/` with:
   - `config.json` — global model roster (seeded from repo `tokoder.config.json`)
   - `access-rules.json` — default ACL rules (seeded into every new project)
   - `.env` — global API keys template
4. verifies install; re-runs are idempotent (nothing is overwritten)

Update: `git pull && npm run install:global` (or `npm install && npm run build` if only code changed).

## Configuration

### Settings layout

| Scope | Location | Contents |
|-------|----------|----------|
| **Global** | `~/.config/tokoder/` | `config.json` (models + defaultModel), `access-rules.json` (defaults for new projects), `.env` (API keys) |
| **Per-project** | `<project>/.tokoder/` | `.env`, `access-rules.json`, `quick.json`, `sessions/`, `tocoder.log` |

Running `tokoder` in any folder **auto-creates `.tokoder/`** on first run, pre-filled with defaults (rules seeded from global; existing files never overwritten). Add `.tokoder/` to `.gitignore`.

### API keys — `.tokoder/.env` (project) + `~/.config/tokoder/.env` (global)

Loaded at startup: project file first, global second (project wins on conflicts). Keys saved via `:models key` go to `.tokoder/.env` in the current project.

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
OPENROUTER_API_KEY=sk-or-...
```

### Models — global + project-local

Config loads from **two places** and merges:

1. **Global** — `~/.config/tokoder/config.json` (shared model roster; `tocoder` runs anywhere)
2. **Project-local** — `tokoder.config.json` in the folder root (committed with the repo, shared by the team; fallback: `.tokoder/config.json`)

Local models override global entries with the same id and can add new ones; local also wins for `defaultModel` and `compact`. Writes go to the local file when one exists in the project, otherwise to the global file — `:models save global|local` copies the merged config explicitly.

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

Providers: `anthropic` | `openai` | `openrouter` | `ollama` | `custom`. `baseURL` enables any OpenAI-compatible endpoint.

### Custom OpenAI-compatible providers (e.g. cheaperinference.com)

Any provider speaking the OpenAI format works via the `providers` section — each entry expands into `models` automatically (ids: `<providerKey>-<modelSlug>`):

```json
{
  "providers": {
    "cheaper-inference": {
      "name": "Cheaper Inference",
      "baseURL": "https://api.cheaperinference.com/v1",
      "apiKeyEnv": "CHEAPER_INFERENCE_API_KEY",
      "models": {
        "gpt-5.4": { "name": "GPT-5.4" }
      }
    }
  },
  "defaultModel": "cheaper-inference-gpt-5-4"
}
```

Then set the key and test:
```bash
:models key cheaper-inference-gpt-5-4 <API_KEY>   # → CHEAPER_INFERENCE_API_KEY in .tokoder/.env
:models test cheaper-inference-gpt-5-4
```

Or add a single model ad-hoc (`custom` provider, baseURL required):
```bash
:models add cheaper-gpt54 custom gpt-5.4 https://api.cheaperinference.com/v1 CHEAPER_INFERENCE_API_KEY
:models key cheaper-gpt54 <API_KEY>
```

`apiKeyEnv` defaults to `CUSTOM_API_KEY` when omitted; endpoints without a key (local gateways) work with no key if `apiKeyEnv` is not set. Extra `headers` are supported in the `providers` entry.

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
tocoder                          # TUI, last-used model for this folder (fallback: config default)
tocoder -c                       # resume last session in this folder (model + context)
tocoder -c "continue the task"   # resume and immediately send a prompt
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
# Y / N / A        approve / deny / abort pending tool call (Shift+A = always)
# Ctrl+V           paste image from clipboard -> PNG in .tokoder/tmp/ + path chip in input
#                  (model reads it via the read tool; vision models could use the file directly)
# P / F / N / A    grant access outside project: file / parent dir / deny / abort
# Enter            send (prefix :comp → :compact auto-completes)
# Esc              cancel wizard / prompt (exit only via :exit or Ctrl+C)

# scripts (Windows / WSL)
powershell -ExecutionPolicy Bypass -File scripts/tocoder.ps1 "prompt" -Model gpt-4o -All -NoTui
bash scripts/tocoder.sh --model gemini-flash "prompt"
scripts/tocoder.bat "prompt"
```

### Vim commands

| Command | Action |
|---------|--------|
| `:exit`, `:q`, `:quit` | exit (transcript dumped) |
| `:compact [instruction]` | compact history — mode-dependent (see below); instruction focuses the summary |
| `:compact-mode <reduce\|balance\|value>` | compact strategy (default `balance`), persisted in config |
| `:compact-auto <on\|off\|percent <n>\|10-100\|tokens <n>>` | auto-compact fires at **whichever comes first**: N% of model context window (default 70%) or absolute token limit (`:compact-auto tokens 40000`; 0 = off) |
| `:agents` | show `AGENTS.md` with line numbers + token cost per prompt |
| `:agents init` / `:init` | create `AGENTS.md` with default instructions |
| `:agents edit` | open in `$EDITOR` (default notepad) |
| `:agents add <text>` | append an instruction line |
| `:agents rm <n>` | delete line n |
| `:key` | interactive Ollama Cloud API key setup |
| `:models` | list models |
| `:models <id>` | switch model |
| `:models add` | **interactive wizard** — local/cloud Ollama, live model list, auto id |
| `:models add <id> <provider> <model> [baseURL]` | manual add |
| `:models rm` | **interactive remove** — pick from list, `y/n` confirm |
| `:models default <id>` | set default |
| `:models key <id> <API_KEY>` | save to `.tokoder/.env` |
| `:models test [id]` | diagnose connection (`/api/tags`) |
| `:models save <global\|local>` | copy the merged config to the chosen file |
| `:models set <id> <field> <value>` | edit field |
| `:acl` | show access rules + path to rules file |
| `:acl set <read\|write\|execute> <yes\|no>` | toggle global outside-access default |
| `:allow <path> [read\|write\|execute]` | permit path outside `cwd` |
| `:deny <path>` | revoke |
| `:session` | session info (saved file, resume hint) |
| `:session reset` | clear saved session for this folder |
| **Ctrl+V** | **paste clipboard image** — saves PNG to `.tokoder/tmp/clipboard-*.png` and inserts `[image: <path> WxH]` chip into the input; the model can read the file with the `read` tool (metadata: dimensions, size) |
| `:help` | help |

Typing `:` shows ghost hint when prefix is unambiguous — `Enter` executes, `Tab` completes (e.g. `:comp` → `:compact`).

## Project Instructions (AGENTS.md)

A file appended to the system prompt with **every** model call — always project-local (`AGENTS.md` in the folder), keeps answers terse (output-token savings) and documents available tools/conventions.

```bash
:agents init    # create AGENTS.md with defaults
:agents         # view (numbered) + token cost
:agents edit    # $EDITOR (default notepad on Windows)
:agents add Verify with npm test before answering.
:agents rm 7    # delete line 7
```

Default content covers output discipline (no preamble, short final answers), the tool set, and conventions. If the file doesn't exist, only the built-in system prompt is sent.

## Compact

History compaction replaces old turns with a model-generated summary + keeps recent turns verbatim. Active mode is shown in the STATUS panel (`Compact: …`).

| Mode | Mechanism | Cost |
|------|-----------|------|
| `reduce` | hard-trim history, keep last turns verbatim, no LLM | 0 tokens |
| `balance` (default) | LLM summary (goal/decisions/files/state/next) + last 4 turns verbatim | 1 call |
| `value` | structured extraction: GOAL/DECISIONS/PROJECT FACTS/FILES CHANGED/OPEN THREADS/NEXT STEPS + last 8 turns verbatim | 1 call |

- `:compact <instruction>` — steer the summary, e.g. `:compact keep the implementation plan`, `:compact focus on decisions and file paths`, `:compact keep open threads and next steps`.
- **Auto-compact**: fires when estimated history tokens exceed **whichever limit comes first** — `thresholdPercent` of the model context window **or** the absolute `maxTokens` limit. Set a model's window with `:models set <id> contextWindow <tokens>` (default 128000). Config: `"compact": { "autoTrigger": true, "thresholdPercent": 70, "maxTokens": 40000 }` (`maxTokens: 0` = percent only).
- Config: `"compact": { "mode": "balance", "autoTrigger": true, "thresholdPercent": 70 }` in `tokoder.config.json`.

## Access Control (ACL)

- **Inside `cwd`** (incl. subfolders): always full access (read/write/execute) — no prompts.
- **Outside `cwd`**:
  - Windows system folders (`C:\Windows`, `Program Files`, `ProgramData`) — never accessible (even read)
  - Defaults: **unlimited `read` everywhere** (`read=YES`), `write=NO`, `execute=NO`
  - Per-path exceptions with mode (`r:`/`w:`/`x:`)
- **Bash commands are mode-classified** (`src/tools/bash.ts`): read-only commands (`cat`, `type`, `dir`, `git log|diff|status`, `npm run/test`, `ollama list`, …) are checked against `read` rules → no prompt anywhere by default; mutating commands (`>`/`Out-File` redirects, `Remove-Item`/`rm`/`del`, `Move-Item`, `git add|commit|push`, `npm install`, `curl`, `taskkill`, …) and unknown commands are checked against `write` rules → prompt when they reference paths outside the project
- When a tool hits a path outside rules, the app asks: `[P]File` (this file only), `[F]Parent folder` (parent dir), `[N]o`, `[A]bort run` — then auto-retries the tool call on grant.
- Access requests use an internal NUL-delimited marker protocol (`TOCODER_ACL_REQ`), not text sniffing — reading files that mention ACL internals never triggers false prompts.
- All rules persist per project in `.tokoder/access-rules.json` (first run seeds from `~/.config/tokoder/access-rules.json`).

## TUI Layout

```
┌─ TOKODER - D:\projects\app ────────────────┐
│ * claude-sonnet (1.1k↑/3.4k↓) o gpt-4o (0↑/0↓) │  ← per-model tokens (1k precision), * = active
├─ * STATUS ─────────────────────────────────┤
│ Model: claude-sonnet (...)  [spinner]      │
│ Tokens: ↑2,345 sent ↓789 recv              │  ← total across all models
│ LOC: 2,069  Time: 00:05:23  Env: +WSL +Android +Node │
├─ * MODEL RESPONSE (auto-scroll + scrollbar) ┤
│ • AI: ...                               #  │  ← PgUp/PgDn pauses
├─ INPUT ────────────────────────────────────┤
│ › your command                             │
│ -> Tool: bash {"command":"g++ ..."}        │  ← pending approval (out-of-project / risky cmd only)
│ [Y]es  [N]o  [A]bort  (Shift+A = always)   │
│ [ACL] ACCESS OUTSIDE PROJECT (write)       │  ← ACL prompt
│    D:\outside\file.txt                     │
│ [P]File  [F]Parent  [N]o  [A]bort run      │
└────────────────────────────────────────────┘
```

- **Header**: `TOKODER` + cwd (bold yellow), per-model token counters
- **Status**: `Model:` + spinner; `Tokens:` = **sum over all models** (green sent / yellow recv); second row `LOC`/`Time`/`Env`/`Compact` flex-wraps on narrow terminals
- **Output**: flat line-viewport (wrap-aware), auto-follows bottom during streaming; scrollbar column `#` on the right; PgDn returns to live bottom
- **Input**: `flexWrap="wrap"`, `↑`/`↓` history `(n/N)` — editable without losing position, ghost `suggestion`
- **LOC**: `src/utils/stats.ts` (ignores `node_modules`, `dist`, `.git`)
- **Tokens**: per-model `usage` per agent step + `len/4` fallback; persisted per session; reset only on exit or `:session reset`
- **Envs**: WSL / Android / Node
- **Alt buffer**: `\x1b[?1049h/l`, sync `writeSync` dump on unmount

## Troubleshooting

**Model stops after one tool call / stream cut silently** — was 60s timeout; now 300s per step (timer restarts after each tool batch). Raise with `--timeout 900` or `TOCODER_DEBUG=1` to see `finishReason` per step. `finishReason="length"` shows a truncation warning.

**Free OpenRouter models** — check https://openrouter.ai/models (filter `:free`); id must match exactly (e.g. `poolside/laguna-s-2.1:free`, not `laguna-m.1:free`). `:models set <id> model <slug>`.

**No visible response** — tool calls log `-> tool`/`<- result`, `SYSTEM` forces final answer, empty `text` shows `[tools used]` fallback.

**Choice `1`-`9` ignored** — now expands quoting the option text from the model's last list, with 20-turn history.

**Builds outside folder** — ACL: system folders always denied; outside rules → app asks `[P]File/[F]Parent/[N]o/[A]bort` and auto-retries. Defaults `read=YES, write=NO, execute=NO`; change via `:acl set <mode> <yes|no>`, per-path `:allow <path> [mode]`. Rules live per project in `.tokoder/access-rules.json`.

**bash killed instantly, empty `Error (exit ?)`** — the bash tool `timeout` is in **seconds** (default 30, cap 600). Older builds treated it as ms. Killed commands now return an explicit "killed after Ns timeout" hint.

**Agent stuck asking `[Y]es` for every tool** — in-project tool targets (and plain bash commands) are auto-approved; prompts appear only for out-of-project paths or bash referencing absolute/home/`$env:` paths. Tool prompt `[A]` aborts the whole run; Shift+A whitelists the tool for the session.

**Local model no response**

```bash
:models test qwen-local   # check Ollama/LM Studio reachable + model exists
ollama list                # if 404: ollama pull qwen3:8b
ollama serve               # if ECONNREFUSED
# LM Studio: ensure http://localhost:1234/v1 + model qwen/qwen3.5-9b
```

Common: `404` → wrong `model`; `ECONNREFUSED` → not running; `401` → wrong `apiKeyEnv`.

**Garbled glyphs in output (`✅ ⚠️ ◆ █` as junk)** — console is on codepage 437: all UI chrome and model output are sanitized to ASCII (`sanitizeCp437` in `src/utils/markdown.ts`); emoji become `[OK]`/`[!]`/`[X]`, everything non-ASCII is stripped. Spinner font: `TOCODER_SPINNER=ascii`.

**Wraps / history gone off edge** — fixed `wrap="wrap"` + `innerW`, `↑`/`↓` for history, `PgUp`/`PgDn` for scroll.

**Terminal closes on exit** — sync `writeSync` dump, `TOCODER_ALT_SCREEN=0` to disable alt buffer.

## Project Structure

```
src/
  cli.ts              # commander CLI (tocoder), dotenv (project+global), bootstrap, -c/--continue, --timeout
  core/
    agent.ts          # manual step loop (stepCountIs 1 + msgs re-feed), tool approval + abort, ACL marker protocol, timeout per step, testConnection
    bootstrap.ts      # idempotent .tokoder/ creation with default settings at CLI startup
    config.ts         # load/save tokoder.config.json (global+local merge), compact config + limits
    compact.ts        # compactHistory (reduce/balance/value), estimateHistoryTokens
    instructions.ts   # AGENTS.md — read/init/append/remove + system-prompt injection
    providers.ts      # getModelFromConfig
    session.ts        # per-project session persistence (.tokoder/sessions/)
    quick.ts          # quick commands slots 1-5 (.tokoder/quick.json)
  tools/              # read / write / edit / bash / glob / grep (ACL-guarded); agentTools (schemas) + executors; bash screenCommand mode-classifies commands (read vs write rules); image-size.ts sniffs PNG/JPEG/GIF/WEBP/BMP dimensions; read returns image metadata instead of binary garbage
  tui/App.tsx         # Ink 3-panel, vim, autocomplete, editable history, auto-scroll + scrollbar, tool approval + ACL prompt (abort), per-model token stats (persisted, summed in STATUS), :models add/rm wizards, auto-compact, markdown output, live supplements, isolated anti-flicker spinner
  utils/
    paths.ts          # appDir/appFile (.tokoder/) + globalAppDir (~/.config/tokoder)
    stats.ts          # LOC + env + duration + spinner styles (TOCODER_SPINNER) (ignores .tokoder)
    env.ts            # .tokoder/.env set/mask
    logger.ts         # .tokoder/tocoder.log
    markdown.ts       # terminal markdown renderer with ANSI colors (headings/code/lists/tables/quotes/links) + sanitizeCp437 (emoji → ASCII, non-ASCII stripped)
    ollama.ts         # listOllamaModels (local/cloud), id suggestion
    permissions.ts    # checkAccess (ACL modes), per-project rules (seeded from global), accessRequest marker, guard(mode), allow/deny
scripts/
  install.mjs         # installer: build + npm link + global settings (~/.config/tokoder)
  paste-image.ps1     # clipboard image -> PNG (Ctrl+V in TUI; copied to dist/scripts on build)
  tocoder.ps1 / .sh / .bat (and tokoder aliases)
tokoder.config.json
```

## Development

```bash
npm run dev            # tsx src/cli.ts
npm run dev:all        # --all
npm run typecheck
npm run build
npm test               # vitest
npm run install:global # installer (build + link + global settings)
```

## License

MIT — see [LICENSE](LICENSE)
