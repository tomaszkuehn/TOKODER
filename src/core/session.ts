import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { appDir } from "../utils/paths.js";

export type SessionState = {
  version: 1;
  cwd: string;
  modelId: string;
  startedAt: string;
  updatedAt: string;
  /** per-folder step budget consumed (0 = full budget available); reset with :steps reset or when budget exhausted+continued */
  stepsUsed?: number;
  /** cumulative sent/recv tokens per model id (persisted so restart+resume keeps counters) */
  tokenStats?: Record<string, { sent: number; recv: number }>;
  history: { role: "user" | "assistant"; content: string }[];
};

const SESSIONS_DIR = (cwd = process.cwd()) => join(appDir(cwd), "sessions");

const hashKey = (cwd: string) => createHash("sha256").update(resolve(cwd).toLowerCase()).digest("hex").slice(0, 16);

export function sessionPath(cwd = process.cwd()): string {
  return join(SESSIONS_DIR(cwd), `${hashKey(cwd)}.json`);
}

export function sessionExists(cwd = process.cwd()): boolean {
  return existsSync(sessionPath(cwd));
}

export function loadSession(cwd = process.cwd()): SessionState | null {
  try {
    const raw = JSON.parse(readFileSync(sessionPath(cwd), "utf-8"));
    if (raw?.version !== 1 || !Array.isArray(raw.history)) return null;
    return raw as SessionState;
  } catch {
    return null;
  }
}

export function saveSession(s: Omit<SessionState, "version" | "cwd" | "updatedAt">, cwd = process.cwd()): string {
  const dir = SESSIONS_DIR(cwd);
  mkdirSync(dir, { recursive: true });
  const state: SessionState = {
    version: 1,
    cwd: resolve(cwd),
    updatedAt: new Date().toISOString(),
    modelId: s.modelId,
    startedAt: s.startedAt,
    stepsUsed: s.stepsUsed ?? 0,
    tokenStats: s.tokenStats ?? {},
    history: s.history.slice(-40),
  };
  const p = sessionPath(cwd);
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n", "utf-8");
  return p;
}

export function clearSession(cwd = process.cwd()): boolean {
  try {
    unlinkSync(sessionPath(cwd));
    return true;
  } catch {
    return false;
  }
}

export function listSessions(): { cwd: string; updatedAt: string; modelId: string; msgs: number; file: string }[] {
  const dir = SESSIONS_DIR();
  if (!existsSync(dir)) return [];
  const out: { cwd: string; updatedAt: string; modelId: string; msgs: number; file: string }[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const p = join(dir, f);
    try {
      const s = JSON.parse(readFileSync(p, "utf-8"));
      if (s?.version === 1) out.push({ cwd: s.cwd, updatedAt: s.updatedAt, modelId: s.modelId, msgs: s.history?.length ?? 0, file: p });
    } catch {}
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function cleanupOldSessions(keep = 50): number {
  const all = listSessions();
  let removed = 0;
  for (let i = keep; i < all.length; i++) {
    try {
      if (statSync(all[i].file).isFile()) { unlinkSync(all[i].file); removed++; }
    } catch {}
  }
  return removed;
}