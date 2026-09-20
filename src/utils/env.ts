import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

export function getEnvPath(cwd = process.cwd()): string {
  return resolve(cwd, ".tokoder", ".env");
}

export function setEnvKey(key: string, value: string, cwd = process.cwd()): void {
  const p = getEnvPath(cwd);
  if (!existsSync(p)) mkdirSync(dirname(p), { recursive: true });
  const content = existsSync(p) ? readFileSync(p, "utf-8") : "";
  const lines = content.split("\n");
  const keyRe = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s*=)`);
  let found = false;
  const next: string[] = [];
  for (const l of lines) {
    if (!found && keyRe.test(l)) {
      found = true;
      next.push(`${key}=${value}`);
    } else if (found && keyRe.test(l)) {
      continue;
    } else {
      next.push(l);
    }
  }
  if (!found) {
    while (next.length && next[next.length - 1].trim() === "") next.pop();
    next.push(`${key}=${value}`, "");
  }
  const out = next.join("\n");
  writeFileSync(p, out, "utf-8");
  process.env[key] = value;
}

export function maskKey(v: string): string {
  if (!v) return "—";
  if (v.length <= 8) return "•".repeat(v.length);
  return v.slice(0, 4) + "•".repeat(Math.min(12, v.length - 8)) + v.slice(-4);
}