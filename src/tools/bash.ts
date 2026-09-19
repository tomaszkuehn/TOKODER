import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { isAllowed, getProjectRoot } from "../utils/permissions.js";

const execAsync = promisify(exec);

export const bashSchema = z.object({
  command: z.string(),
  workdir: z.string().optional(),
  timeout: z.number().optional().default(30000),
});

export async function bashTool({ command, workdir, timeout }: z.infer<typeof bashSchema>) {
  if (workdir && !isAllowed(workdir)) return `Error: DENIED workdir outside project "${getProjectRoot()}": ${workdir} — :allow ${workdir}`;
  if (/(?:\.\.\/|\.\.\\|[A-Z]:\\|\/tmp\/|\/home\/)/i.test(command) && /[<>|]/.test(command)) {
    // heuristic for suspicious redirections outside project
  }
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: workdir ?? process.cwd(),
      timeout,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const out = [stdout, stderr].filter(Boolean).join("\n").slice(0, 30000);
    return out || "(no output)";
  } catch (e: any) {
    return `Error (exit ${e.code ?? "?"}): ${(e.stdout ?? "") + (e.stderr ?? e.message)}`.slice(0, 30000);
  }
}
