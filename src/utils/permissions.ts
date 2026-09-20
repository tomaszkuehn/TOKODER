import { resolve, relative, isAbsolute, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { appDir, appFile, globalAppDir } from "./paths.js";

export type AccessMode = "read" | "write" | "execute";

export type AccessRules = {
  read: boolean;
  write: boolean;
  execute: boolean;
  paths: { path: string; mode: AccessMode }[];
};

/** access rules are project-local (in .tokoder/); global defaults seed new projects */
const LOCAL_RULES_FILE = "access-rules.json";
const rulesFile = (cwd = process.cwd()): string => appFile(LOCAL_RULES_FILE, cwd);
const globalRulesPath = (): string => resolve(globalAppDir(), LOCAL_RULES_FILE);

let rules: AccessRules | null = null;

function seedRules(cwd: string): Partial<AccessRules> | null {
  const local = rulesFile(cwd);
  if (existsSync(local)) {
    try {
      return JSON.parse(readFileSync(local, "utf-8"));
    } catch {}
  }
  // first run in this project → seed from global defaults, then persist locally
  let seeded: Partial<AccessRules> | null = null;
  try {
    seeded = JSON.parse(readFileSync(globalRulesPath(), "utf-8"));
  } catch {}
  const r = {
    read: seeded?.read ?? true,
    write: seeded?.write ?? false,
    execute: seeded?.execute ?? false,
    paths: seeded?.paths ?? [],
  };
  try {
    mkdirSync(appDir(cwd), { recursive: true });
    writeFileSync(local, JSON.stringify(r, null, 2) + "\n", "utf-8");
  } catch {}
  return r;
}

export function loadRules(cwd = process.cwd()): AccessRules {
  if (rules) return rules;
  const parsed = seedRules(cwd);
  rules = {
    read: parsed?.read ?? true,
    write: parsed?.write ?? false,
    execute: parsed?.execute ?? false,
    paths: parsed?.paths ?? [],
  };
  return rules;
}

export function saveRules(cwd = process.cwd()): void {
  const r = loadRules(cwd);
  const p = rulesFile(cwd);
  mkdirSync(appDir(cwd), { recursive: true });
  writeFileSync(p, JSON.stringify(r, null, 2) + "\n", "utf-8");
}

export function rulesPath(cwd = process.cwd()): string {
  return rulesFile(cwd);
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

/** marker prefix for an access request embedded in tool output (NUL-delimited, cannot appear in file text) */
export const ACL_MARK = "\u0000TOCODER_ACL_REQ\u0000";

export function accessRequest(mode: AccessMode, target: string, message: string): string {
  return `${ACL_MARK}${mode}\u0000${target}\u0000${message}`;
}

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
  return accessRequest("write", target, `PENDING-APPROVAL: "${target}" outside project (write=NO by default). User decision required via approval prompt or :acl.`);
}
