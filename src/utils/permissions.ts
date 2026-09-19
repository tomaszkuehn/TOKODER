import { resolve, relative, isAbsolute, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

export type AccessMode = "read" | "write" | "execute";

export type AccessRules = {
  read: boolean;
  write: boolean;
  execute: boolean;
  paths: { path: string; mode: AccessMode }[];
};

const RULES_PATH = resolve(homedir(), ".config", "tokoder", "access-rules.json");

let rules: AccessRules | null = null;

export function loadRules(): AccessRules {
  if (rules) return rules;
  let parsed: Partial<AccessRules> | null = null;
  try {
    parsed = JSON.parse(readFileSync(RULES_PATH, "utf-8"));
  } catch {}
  rules = {
    read: parsed?.read ?? true,
    write: parsed?.write ?? false,
    execute: parsed?.execute ?? false,
    paths: parsed?.paths ?? [],
  };
  return rules;
}

export function saveRules(): void {
  const r = loadRules();
  mkdirSync(dirname(RULES_PATH), { recursive: true });
  writeFileSync(RULES_PATH, JSON.stringify(r, null, 2) + "\n", "utf-8");
}

export function rulesPath(): string {
  return RULES_PATH;
}

function isSystemPath(abs: string): boolean {
  const low = abs.toLowerCase().replace(/\//g, "\\").replace(/\\$/, "");
  const winDir = (process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows").toLowerCase();
  const sysDirs = [winDir, "c:\\program files", "c:\\program files (x86)", "c:\\programdata"];
  for (const s of sysDirs) if (low === s || low.startsWith(s + "\\")) return true;
  return false;
}

export function getProjectRoot(): string {
  return resolve(process.cwd());
}

export function isInsideRoot(target: string, root = getProjectRoot()): boolean {
  const abs = isAbsolute(target) ? resolve(target) : resolve(root, target);
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export type CheckResult =
  | { ok: true }
  | { ok: false; reason: "system" }
  | { ok: false; reason: "ask"; needs: AccessMode };

export function checkAccess(target: string, mode: AccessMode): CheckResult {
  if (isInsideRoot(target)) return { ok: true };
  const abs = resolve(isAbsolute(target) ? target : resolve(getProjectRoot(), target));
  if (isSystemPath(abs)) return { ok: false, reason: "system" };
  const r = loadRules();
  const low = abs.toLowerCase();
  for (const e of r.paths) {
    const ep = e.path.toLowerCase();
    if (e.mode === mode && (low === ep || low.startsWith(ep + "\\") || low.startsWith(ep + "/"))) return { ok: true };
  }
  if (mode === "read" && r.read) return { ok: true };
  if (mode === "write" && r.write) return { ok: true };
  if (mode === "execute" && r.execute) return { ok: true };
  return { ok: false, reason: "ask", needs: mode };
}

export function isAllowed(target: string): boolean {
  return checkAccess(target, "write").ok || checkAccess(target, "read").ok;
}

export type AskResult = "allow-file" | "allow-dir" | "deny";

export function applyAskDecision(target: string, mode: AccessMode, decision: AskResult): string {
  const r = loadRules();
  const abs = resolve(isAbsolute(target) ? target : resolve(getProjectRoot(), target));
  const path = decision === "allow-file" ? abs : dirname(abs);
  if (!r.paths.some((e) => e.path.toLowerCase() === path.toLowerCase() && e.mode === mode)) r.paths.push({ path, mode });
  saveRules();
  return path;
}

export function allowPath(p: string, mode: AccessMode = "write"): string {
  const abs = resolve(p);
  const r = loadRules();
  if (!r.paths.some((e) => e.path.toLowerCase() === abs.toLowerCase() && e.mode === mode)) r.paths.push({ path: abs, mode });
  saveRules();
  return abs;
}

export function denyPath(p: string): boolean {
  const r = loadRules();
  const abs = resolve(p).toLowerCase();
  const before = r.paths.length;
  r.paths = r.paths.filter((e) => e.path.toLowerCase() !== abs);
  saveRules();
  return r.paths.length < before;
}

export function listAllowed(): string[] {
  return loadRules().paths.map((e) => `${e.mode === "read" ? "r" : e.mode === "write" ? "w" : "x"}:${e.path}`);
}

export function guard(target: string): string | null {
  const res = checkAccess(target, "write");
  if (res.ok) return null;
  if (res.reason === "system") return `DENIED: "${target}" is inside Windows system folder — never accessible.`;
  return `PENDING-APPROVAL: "${target}" outside project (write=NO by default). User decision required via approval prompt or :acl.`;
}
