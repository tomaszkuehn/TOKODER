import { glob } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { checkAccess } from "../utils/permissions.js";

export const globSchema = z.object({
  pattern: z.string().describe('Glob e.g. "src/**/*.ts"'),
  path: z.string().optional().describe("Base dir"),
});

export async function globTool({ pattern, path }: z.infer<typeof globSchema>) {
  const base = path ?? process.cwd();
  const chk = checkAccess(base, "read");
  if (!chk.ok) return chk.reason === "system"
    ? `Error: DENIED — "${base}" is inside Windows system folder.`
    : `Error: PENDING-APPROVAL read outside project: ${base}`;
  try {
    const results: string[] = [];
    for await (const entry of glob(pattern, { cwd: base })) {
      results.push(entry as string);
      if (results.length >= 100) break;
    }
    return results.length ? results.join("\n") : "(no matches)";
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}
