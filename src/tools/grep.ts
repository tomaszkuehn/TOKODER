import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { checkAccess, accessRequest } from "../utils/permissions.js";

export const grepSchema = z.object({
  pattern: z.string(),
  include: z.string().optional().describe("Glob e.g. \"src/**/*.ts\""),
  path: z.string().optional(),
});

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "__pycache__", ".venv"]);
const MAX_FILES = 2000;
const MAX_MATCHES = 100;

let counter = 0;

async function walk(dir: string, base: string, acc: string[]): Promise<void> {
  if (acc.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (acc.length >= MAX_FILES) return;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(full, base, acc);
    } else if (e.isFile()) {
      acc.push(relative(base, full).replace(/\\/g, "/") || full);
    }
  }
}

function compile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

function includeRe(include: string | undefined): RegExp | null {
  if (!include) return null;
  const esc = include.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*").replace(/\u0001/g, ".*").replace(/\?/g, ".");
  try {
    return new RegExp(`(^|/)${esc}$`);
  } catch {
    return null;
  }
}

export async function grepTool({ pattern, include, path }: z.infer<typeof grepSchema>) {
  const base = resolve(isAbsolute(path ?? "") ? path! : resolve(path ?? "."));
  const cwd = path ?? process.cwd();
  const chk = checkAccess(cwd, "read");
  if (!chk.ok) return chk.reason === "system"
    ? `Error: DENIED — "${cwd}" is inside Windows system folder.`
    : accessRequest("read", cwd, `read outside project denied by rules: ${cwd}`);
  const re = compile(pattern);
  if (!re) return `Error: invalid regex: ${pattern}`;
  const inc = includeRe(include);
  const files: string[] = [];
  await walk(base, base, files);
  if (!files.length) return "(no matches)";
  const out: string[] = [];
  let scanned = 0;
  for (const f of files) {
    if (out.length >= MAX_MATCHES) break;
    if (scanned >= MAX_FILES) break;
    scanned++;
    if (inc && !inc.test(f)) continue;
    let text: string;
    try {
      const buf = await readFile(join(base, f));
      if (buf.includes(0)) continue;
      text = buf.toString("utf-8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        out.push(`${f}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        if (out.length >= MAX_MATCHES) break;
      }
    }
  }
  if (out.length >= MAX_MATCHES) out.push(`(truncated at ${MAX_MATCHES} matches)`);
  return out.join("\n") || "(no matches)";
}