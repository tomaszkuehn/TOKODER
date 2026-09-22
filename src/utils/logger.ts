import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const LOG_PATH = process.env.TOCODER_LOG
  ? resolve(process.env.TOCODER_LOG)
  : resolve(process.cwd(), ".tokoder", "tocoder.log");

/**
 * Logging is OFF by default. Enabled by either:
 * - config: { "logging": true } in tokoder.config.json (global or project-local)
 * - env: TOCODER_LOGGING=1 (overrides config)
 * The config result is injected by the TUI/CLI at startup (setLogging).
 */
let enabled = false;

export function setLogging(on: boolean): void {
  enabled = on || process.env.TOCODER_LOGGING === "1";
}

export function loggingEnabled(): boolean {
  return enabled;
}

export function logPath(): string {
  return LOG_PATH;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}kB`;
  return `${bytes}B`;
}

export function logEntry(label: string, model: string, content: string): void {
  if (!enabled) return;
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `[${stamp()}] [${label}] [model=${model}] [size=${size(Buffer.byteLength(content, "utf-8"))}]\n${content}\n\n`, "utf-8");
  } catch {}
}