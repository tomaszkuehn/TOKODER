import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { appDir, appFile } from "../utils/paths.js";
import { validateConfig, ConfigError } from "./config.js";

const QUICK_DEFAULT: Record<string, never> = {};

function defaultQuick(): object {
  return {};
}

function defaultRules(): object {
  return { read: true, write: false, execute: false, paths: [] };
}

function defaultEnvTemplate(): string {
  return `# tokoder project-local env (auto-created)
# Add API keys for :models key <id> - or manage keys globally in ~/.config/tokoder/.env
`;
}

/**
 * Idempotent bootstrap of the per-project .tokoder/ app dir.
 * Called once at CLI startup; never overwrites existing files.
 * Config validation runs first: on ConfigError print the offending file + reason and exit(1).
 */
export function bootstrapProject(cwd = process.cwd()): void {
  try {
    validateConfig(cwd);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`\n${e.message}\n\nFix the file and run tokoder again. Docs: README.md → "Custom OpenAI-compatible providers".`);
      process.exit(1);
    }
    throw e;
  }
  try {
    mkdirSync(appDir(cwd), { recursive: true });
    for (const [file, content] of [
      ["quick.json", JSON.stringify(defaultQuick(), null, 2) + "\n"],
      ["access-rules.json", JSON.stringify(defaultRules(), null, 2) + "\n"],
      [".env", defaultEnvTemplate()],
    ] as const) {
      const p = appFile(file, cwd);
      if (!existsSync(p)) writeFileSync(p, content, "utf-8");
    }
    mkdirSync(appFile("sessions", cwd), { recursive: true });
  } catch {}
}

export { QUICK_DEFAULT };