import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

export const editSchema = z.object({
  path: z.string(),
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional().default(false),
});

export async function editTool({ path, oldString, newString, replaceAll }: z.infer<typeof editSchema>) {
  try {
    const content = await readFile(path, "utf-8");
    if (!content.includes(oldString)) return `Error: oldString not found in ${path}`;
    const next = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString);
    await writeFile(path, next, "utf-8");
    return `Edited ${path}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}
