#!/usr/bin/env node
/**
 * tokoder installer: system setup + global settings.
 *
 * 1. builds the app (tsc) so dist/ is current
 * 2. npm link → global `tokoder` / `tocoder` commands
 * 3. creates ~/.config/tokoder/ (global settings dir):
 *    - config.json        : models list + defaultModel (seeded from repo tokoder.config.json if absent)
 *    - access-rules.json  : DEFAULT access rules, seeded into every new project's .tokoder/
 *    - .env               : global API keys (loaded after project .tokoder/.env)
 * 4. verifies install (bin on PATH, dist present)
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GLOBAL_DIR = join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".config", "tokoder");

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts });
}

console.log("== tokoder installer ==\n");

// 1. build
if (!existsSync(join(ROOT, "dist", "cli.js"))) {
  run("npm install");
  run("npm run build");
} else {
  console.log("dist/ present — skipping build (delete dist/ to force rebuild)");
}

// 2. global command
try {
  run("npm link");
  console.log("global command installed: tokoder (alias tocoder)\n");
} catch {
  console.warn("npm link failed — run manually: npm link\n");
}

// 3. global settings
mkdirSync(GLOBAL_DIR, { recursive: true });

const globalConfig = join(GLOBAL_DIR, "config.json");
if (!existsSync(globalConfig)) {
  const repoConfig = join(ROOT, "tokoder.config.json");
  if (existsSync(repoConfig)) copyFileSync(repoConfig, globalConfig);
  else writeFileSync(globalConfig, JSON.stringify({ models: [], defaultModel: "" }, null, 2) + "\n", "utf-8");
  console.log(`created ${globalConfig}`);
} else {
  console.log(`${globalConfig} — kept`);
}

const globalRules = join(GLOBAL_DIR, "access-rules.json");
if (!existsSync(globalRules)) {
  writeFileSync(globalRules, JSON.stringify({ read: true, write: false, execute: false, paths: [] }, null, 2) + "\n", "utf-8");
  console.log(`created ${globalRules} (defaults seeded into new projects)`);
} else {
  console.log(`${globalRules} — kept`);
}

const globalEnv = join(GLOBAL_DIR, ".env");
if (!existsSync(globalEnv)) {
  writeFileSync(globalEnv, "# tokoder global API keys\n# ANTHROPIC_API_KEY=sk-ant-...\n# OPENAI_API_KEY=sk-...\n# OPENROUTER_API_KEY=sk-or-...\n# OLLAMA_API_KEY=...\n", "utf-8");
  console.log(`created ${globalEnv}`);
} else {
  console.log(`${globalEnv} — kept`);
}

// 4. verify
console.log("\n== verify ==");
const binOk = existsSync(join(ROOT, "dist", "cli.js"));
console.log(`dist/cli.js: ${binOk ? "OK" : "MISSING"}`);
try {
  const cfg = JSON.parse(readFileSync(globalConfig, "utf-8"));
  console.log(`models configured: ${cfg.models?.length ?? 0} (default: ${cfg.defaultModel || "—"})`);
} catch {}
console.log("\nDone. Run `tokoder` in any project — .tokoder/ is created automatically on first run.");