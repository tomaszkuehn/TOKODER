import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { guard } from "../utils/permissions.js";

export const writeSchema = z.object({
  path: z.string(),
  content: z.string(),
});

export async function writeTool({ path, content }: z.infer<typeof writeSchema>) {
  const block = guard(path);
  if (block) return `Error: ${block}`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf-8");
    return `Wrote ${content.length} chars to ${path}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}
