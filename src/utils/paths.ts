import { resolve } from "node:path";

/** per-project app dir: all local runtime state lives here (git-ignored by convention) */
export const APP_DIR_NAME = ".tokoder";

export function appDir(cwd = process.cwd()): string {
  return resolve(cwd, APP_DIR_NAME);
}

export function appFile(name: string, cwd = process.cwd()): string {
  return resolve(cwd, APP_DIR_NAME, name);
}

/** global app dir: API keys config + models list (installer-managed) */
export function globalAppDir(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ".";
  return resolve(home, ".config", "tokoder");
}