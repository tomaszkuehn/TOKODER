import { readdir, stat, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".css", ".md", ".py", ".go", ".rs", ".java", ".kt"]);
const IGNORE = new Set(["node_modules", "dist", ".git", ".ijfw", "build", ".next", "coverage", "__pycache__"]);

export async function countLOC(root = process.cwd()): Promise<number> {
  let total = 0;
  async function walk(dir: string) {
    let entries: any[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (CODE_EXTS.has(extname(e.name))) {
        try {
          const s = await stat(p);
          if (s.size > 500_000) continue;
          const content = await readFile(p, "utf-8");
          total += content.split("\n").length;
        } catch {}
      }
    }
  }
  await walk(root);
  return total;
}

export function detectEnvs(): { label: string; ok: boolean }[] {
  const envs: { label: string; ok: boolean }[] = [];
  const isWSL = !!process.env.WSL_DISTRO_NAME || existsSync("/proc/version") && (() => { try { return readFileSync("/proc/version", "utf-8").toLowerCase().includes("microsoft"); } catch { return false; } })();
  envs.push({ label: "WSL", ok: isWSL });
  const androidHome = !!process.env.ANDROID_HOME || !!process.env.ANDROID_SDK_ROOT || existsSync("C:\\Users\\pantomas\\AppData\\Local\\Android\\Sdk") || existsSync(join(process.env.HOME ?? "", "Android/Sdk"));
  let adbOk = false;
  try {
    execSync("adb --version", { stdio: "ignore", timeout: 2000 });
    adbOk = true;
  } catch {}
  envs.push({ label: "Android", ok: androidHome || adbOk });
  envs.push({ label: "Node", ok: true });
  return envs;
}

import { readFileSync } from "node:fs";

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${sec}`;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
