import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { appFile } from "../utils/paths.js";

export type QuickSlot = { text: string; label: string; createdAt: string };
/** slots 1-5, key = slot number as string */
export type QuickMap = Record<string, QuickSlot>;

export const QUICK_SLOTS = 5;

const quickPath = (cwd = process.cwd()): string => appFile("quick.json", cwd);

export function loadQuick(cwd = process.cwd()): QuickMap {
  try {
    const raw = JSON.parse(readFileSync(quickPath(cwd), "utf-8"));
    if (!raw || typeof raw !== "object") return {};
    const out: QuickMap = {};
    for (const [k, v] of Object.entries(raw)) {
      const n = parseInt(k, 10);
      const slot = v as QuickSlot;
      if (n >= 1 && n <= QUICK_SLOTS && slot && typeof slot.text === "string" && slot.text.trim()) out[String(n)] = { text: slot.text, label: String(slot.label ?? slot.text.slice(0, 40)), createdAt: String(slot.createdAt ?? "") };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveQuick(map: QuickMap, cwd = process.cwd()): string {
  const p = quickPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(map, null, 2) + "\n", "utf-8");
  return p;
}

export function setQuickSlot(map: QuickMap, slot: number, text: string): QuickMap {
  const out = { ...map };
  if (slot < 1 || slot > QUICK_SLOTS) return out;
  const t = text.trim();
  if (!t) delete out[String(slot)];
  else out[String(slot)] = { text: t, label: t.slice(0, 40), createdAt: new Date().toISOString() };
  return out;
}

export function formatQuick(map: QuickMap): string {
  const rows = Array.from({ length: QUICK_SLOTS }, (_, i) => i + 1).map((n) => {
    const s = map[String(n)];
    return `${n}| ${s ? `${s.label}${s.text.length > 40 ? "…" : ""}` : "- empty -"}`;
  });
  return rows.join("\n");
}