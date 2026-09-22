import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { checkAccess, accessRequest } from "../utils/permissions.js";

export const readSchema = z.object({
  path: z.string().describe("Absolute or relative path to file"),
  offset: z.number().optional().describe("Start line (1-indexed)"),
  limit: z.number().optional().describe("Max lines"),
});

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

export async function readTool({ path, offset, limit }: z.infer<typeof readSchema>) {
  const chk = checkAccess(path, "read");
  if (!chk.ok) return chk.reason === "system"
    ? `Error: DENIED — "${path}" is inside Windows system folder.`
    : accessRequest("read", path, `read outside project "${chk.needs ? "" : ""}${path}" denied by rules — user decision required`);
  try {
    const s = await stat(path);
    if (s.isDirectory()) {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n");
    }
    if (IMG_EXT.test(path)) {
      const { imageSize } = await import("./image-size.js");
      const info = await imageSize(path);
      return `Image file: ${path} (${info.w}x${info.h} px, ${(s.size / 1024).toFixed(1)} KB, ${info.ext}). NOTE: this agent reads image metadata only - image content reaches the model only if it supports vision; ask the user to describe the image if needed.`;
    }
    const content = await readFile(path, "utf-8");
    const lines = content.split("\n");
    const start = offset ? offset - 1 : 0;
    const end = limit ? start + limit : undefined;
    const sliced = lines.slice(start, end);
    return sliced.map((l, i) => `${start + i + 1}: ${l}`).join("\n").slice(0, 8000);
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}
