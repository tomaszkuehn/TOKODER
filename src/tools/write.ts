import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

export const writeSchema = z.object({
  path: z.string(),
  content: z.string(),
});

export async function writeTool({ path, content }: z.infer<typeof writeSchema>) {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf-8");
    return `Wrote ${content.length} chars to ${path}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}
