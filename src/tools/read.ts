import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { isAllowed, getProjectRoot } from "../utils/permissions.js";

export const readSchema = z.object({
  path: z.string().describe("Absolute or relative path to file"),
  offset: z.number().optional().describe("Start line (1-indexed)"),
  limit: z.number().optional().describe("Max lines"),
});

export async function readTool({ path, offset, limit }: z.infer<typeof readSchema>) {
  if (!isAllowed(path)) return `Error: DENIED read outside project "${getProjectRoot()}": ${path} — :allow ${path} to permit`;
  try {
    const s = await stat(path);
    if (s.isDirectory()) {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n");
    }
    const content = await readFile(path, "utf-8");
    const lines = content.split("\n");
    const start = offset ? offset - 1 : 0;
    const end = limit ? start + limit : undefined;
    const sliced = lines.slice(start, end);
    return sliced.map((l, i) => `${start + i + 1}: ${l}`).join("\n").slice(0, 40000);
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}
