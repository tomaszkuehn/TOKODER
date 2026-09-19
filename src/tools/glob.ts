import { glob } from "node:fs/promises";
import { z } from "zod";

export const globSchema = z.object({
  pattern: z.string().describe('Glob e.g. "src/**/*.ts"'),
  path: z.string().optional().describe("Base dir"),
});

export async function globTool({ pattern, path }: z.infer<typeof globSchema>) {
  try {
    const results: string[] = [];
    for await (const entry of glob(pattern, { cwd: path })) {
      results.push(entry as string);
      if (results.length >= 100) break;
    }
    return results.length ? results.join("\n") : "(no matches)";
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}
