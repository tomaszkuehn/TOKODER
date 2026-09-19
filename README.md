# tocoder

AI coding agent for the terminal — clone of [opencode](https://github.com/anomalyco/opencode) / Claude Code. TypeScript + Ink TUI + Vercel AI SDK.

## Features

- **Agent loop** with tool calling (`read`, `write`, `edit`, `bash`, `glob`, `grep`) — `maxSteps: 20`
- **Multi-model** — 3+ models simultaneously via `tokoder.config.json` (Anthropic / OpenAI / OpenRouter / Ollama)
- **3-panel TUI**: command input, AI response, status bar (tokens, model, LOC, session time, envs)
- **CLI** — `tocoder` (also `tokoder` alias), `models`, `--all` parallel compare, `--no-tui`
- **WSL + Android Studio** aware — env detection in status bar

## Requirements

- Node.js 18+ (tested 24.21.0)
- WSL available on Windows (optional)

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
    { "id": "ollama-local", "provider": "ollama", "model": "llama3", "baseURL": "http://localhost:11434/v1" }
  ],
  "defaultModel": "claude-sonnet"
}
```

Providers: `anthropic` | `openai` | `openrouter` | `ollama`. `baseURL` enables any OpenAI-compatible endpoint.

## Usage

```bash
tocoder                          # TUI, default model
tocoder -m gpt-4o "fix tests"    # TUI with prompt + model
tocoder --no-tui "explain src/"  # plain stdout
tocoder --all "compare answers"  # run all 3 models in parallel
tocoder models                   # list configured models

# inside TUI:
# Tab / Shift+Tab  cycle model
# Enter            send
# Esc / Ctrl+C     exit

# scripts (Windows / WSL)
powershell -ExecutionPolicy Bypass -File scripts/tocoder.ps1 "prompt" -Model gpt-4o -All -NoTui
bash scripts/tocoder.sh --model gemini-flash "prompt"
scripts/tocoder.bat "prompt"
```

## TUI Layout

```
┌─ tocoder ─ Tab cycle ─────────────────────┐
│ ● claude-sonnet ○ gpt-4o ○ gemini-flash   │
├─ STATUS ──────────────────────────────────┤
│ Model: claude-sonnet (...) │ ↑ 1234 ↓ 567 │
│ LOC: 2,069 │ Time: 00:05:23 │ Env: ✓WSL ✓Android ✓Node │
├─ AI RESPONSE ─────────────────────────────┤
│ ● AI: ...                                 │
├─ INPUT ───────────────────────────────────┤
│ › your command ▌                          │
└───────────────────────────────────────────┘
```

- **LOC**: counted from `src/utils/stats.ts` (ignores `node_modules`, `dist`, `.git`)
- **Tokens**: from AI SDK `usage` + `len/4` fallback
- **Envs**: WSL (`WSL_DISTRO_NAME` / `/proc/version`), Android (`ANDROID_HOME` / `adb`), Node

## Project Structure

```
src/
  cli.ts              # commander CLI (tocoder)
  core/
    agent.ts          # streamText loop
    config.ts         # load tokoder.config.json
    providers.ts      # getModelFromConfig
  tools/              # read / write / edit / bash / glob / grep
  tui/App.tsx         # Ink 3-panel UI
  utils/stats.ts      # LOC + env + duration
scripts/
  tocoder.ps1 / .sh / .bat
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
