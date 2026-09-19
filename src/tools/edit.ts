import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { guard } from "../utils/permissions.js";

export const editSchema = z.object({
  path: z.string(),
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional().default(false),
});

export async function editTool({ path, oldString, newString, replaceAll }: z.infer<typeof editSchema>) {
  const block = guard(path);
  if (block) return `Error: ${block}`;
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
