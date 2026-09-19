import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { checkAccess } from "../utils/permissions.js";

const execAsync = promisify(exec);

export const grepSchema = z.object({
  pattern: z.string(),
  include: z.string().optional(),
  path: z.string().optional(),
});

export async function grepTool({ pattern, include, path }: z.infer<typeof grepSchema>) {
  const cwd = path ?? process.cwd();
  const chk = checkAccess(cwd, "read");
  if (!chk.ok) return chk.reason === "system"
    ? `Error: DENIED — "${cwd}" is inside Windows system folder.`
    : `Error: PENDING-APPROVAL read outside project: ${cwd}`;
  try {
    const filter = include ? `--include="${include}"` : "";
    const cmd = `grep -r -n ${filter} "${pattern.replace(/"/g, '\\"')}" . 2>&1 | head -n 100`;
    const { stdout } = await execAsync(cmd, { cwd, timeout: 15000, maxBuffer: 1024 * 1024 });
    return stdout.slice(0, 30000) || "(no matches)";
  } catch (e: any) {
    return (e.stdout ?? e.message ?? "").slice(0, 30000) || "(no matches)";
  }
}
