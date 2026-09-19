import { resolve, relative, isAbsolute } from "node:path";

const allowed = new Set<string>();

export function getProjectRoot(): string {
  return resolve(process.cwd());
}

export function isInsideRoot(target: string, root = getProjectRoot()): boolean {
  const abs = isAbsolute(target) ? resolve(target) : resolve(root, target);
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function isAllowed(target: string): boolean {
  if (isInsideRoot(target)) return true;
  const abs = resolve(target);
  for (const a of allowed) if (abs === a || abs.startsWith(a + "\\") || abs.startsWith(a + "/")) return true;
  return false;
}

export function allowPath(p: string): string {
  const abs = resolve(p);
  allowed.add(abs);
  return abs;
}

export function denyPath(p: string): boolean {
  return allowed.delete(resolve(p));
}

export function listAllowed(): string[] {
  return [...allowed];
}

export function guard(target: string): string | null {
  if (isAllowed(target)) return null;
  const root = getProjectRoot();
  return `DENIED: "${target}" is outside project "${root}". Ask user: :allow ${resolve(target)} to permit, or keep files inside project.`;
}
