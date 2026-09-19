import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export const INSTRUCTIONS_FILE = "AGENTS.md";

export const DEFAULT_INSTRUCTIONS = `# Agent instructions

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
`;

export function instructionsPath(cwd = process.cwd()): string {
  return resolve(cwd, INSTRUCTIONS_FILE);
}

export function readInstructions(cwd = process.cwd()): string | null {
  const p = instructionsPath(cwd);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

export function initInstructions(cwd = process.cwd(), overwrite = false): { path: string; created: boolean } {
  const p = instructionsPath(cwd);
  if (existsSync(p) && !overwrite) return { path: p, created: false };
  writeFileSync(p, DEFAULT_INSTRUCTIONS, "utf-8");
  return { path: p, created: true };
}

export function appendInstruction(text: string, cwd = process.cwd()): void {
  const p = instructionsPath(cwd);
  const cur = existsSync(p) ? readFileSync(p, "utf-8") : DEFAULT_INSTRUCTIONS;
  writeFileSync(p, cur.replace(/\n*$/, "\n\n") + text.trim() + "\n", "utf-8");
}

export function removeInstructionLine(n: number, cwd = process.cwd()): string | null {
  const p = instructionsPath(cwd);
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, "utf-8").split("\n");
  const idx = n - 1;
  if (idx < 0 || idx >= lines.length) return null;
  const [removed] = lines.splice(idx, 1);
  writeFileSync(p, lines.join("\n"), "utf-8");
  return removed;
}

export function buildSystemPrompt(base: string, cwd = process.cwd()): string {
  const instr = readInstructions(cwd);
  if (!instr?.trim()) return base;
  return `${base}\n\n# PROJECT INSTRUCTIONS (from ${INSTRUCTIONS_FILE} in project root — follow them)\n${instr}`;
}
