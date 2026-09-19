import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf("=");
    if (idx === -1) continue;
    out[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return out;
}

export function getEnvPath(cwd = process.cwd()): string {
  return resolve(cwd, ".env");
}

export function setEnvKey(key: string, value: string, cwd = process.cwd()): void {
  const p = getEnvPath(cwd);
  let content = existsSync(p) ? readFileSync(p, "utf-8") : "";
  const lines = content.split("\n");
  let found = false;
  const next = lines.map((l) => {
    if (l.trim().startsWith(`${key}=`) || l.trim().startsWith(`${key} =`)) {
      found = true;
      return `${key}=${value}`;
    }
    return l;
  });
  if (!found) {
    if (next.length && next[next.length - 1].trim() !== "") next.push("");
    next[next.length - 1] = `${key}=${value}`;
    if (!found && next.join("\n").trim() === `${key}=${value}`) {
      // already handled
    } else if (!content.includes(`${key}=`)) {
      // ensure added
      if (!found) next.push(`${key}=${value}`);
    }
  }
  // dedupe - rebuild cleanly
  const map = parseEnv(content);
  map[key] = value;
  const out = Object.entries(map).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  writeFileSync(p, out, "utf-8");
  process.env[key] = value;
}

export function maskKey(v: string): string {
  if (!v) return "—";
  if (v.length <= 8) return "•".repeat(v.length);
  return v.slice(0, 4) + "•".repeat(Math.min(12, v.length - 8)) + v.slice(-4);
}
