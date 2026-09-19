# Agent instructions

## Output discipline (token savings)
- Be terse: no preamble, no restating the task, no echoing code you just wrote.
- Final answer: what was changed + how to verify it. Keep it under ~15 lines unless asked.
- One clarifying question beats a wrong guess.

## Available tools
- read/write/edit — files (write creates dirs; edit is exact-match replace)
- bash — commands (PowerShell on Windows; Linux-style commands auto-route to WSL bash)
- glob/grep — find files / search contents
- Prefer glob/grep to locate code before editing. Verify changes with bash (typecheck/tests).

## Conventions
- Check package.json/cargo.toml before assuming a library exists.
- Match existing code style; no comments unless asked; no commits unless asked.

Every response end print "How dare you!"
