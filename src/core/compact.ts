import { generateText } from "ai";
import { getModelFromConfig } from "./providers.js";
import { logEntry } from "../utils/logger.js";
import type { ModelConfig } from "./config.js";
import type { Usage } from "./agent.js";

export type CompactMode = "reduce" | "balance" | "value";

export const COMPACT_MODES: CompactMode[] = ["reduce", "balance", "value"];

export type HistoryMsg = { role: "user" | "assistant"; content: string };

export type CompactResult = {
  summary: string;
  kept: HistoryMsg[];
  removed: number;
  mode: CompactMode;
  instruction?: string;
};

// how many LAST messages stay verbatim (user+assistant pair = 1 turn)
const KEEP_MESSAGES: Record<CompactMode, number> = { reduce: 6, balance: 8, value: 16 };

const PROMPTS: Record<CompactMode, string> = {
  balance: `Summarize this coding-agent conversation so work can continue seamlessly. Include: task goal, key decisions, files modified, current state, next steps. Max 250 words. Reply ONLY with the summary text.`,
  value: `Extract maximum-value context from this coding-agent conversation. Reply with EXACTLY these sections (skip a section only if truly empty; max 400 words total):
GOAL: what the user is trying to achieve
DECISIONS: decisions made and why
PROJECT FACTS: learned facts (stack, paths, commands, constraints)
FILES CHANGED: files touched + what changed
OPEN THREADS: unfinished discussions / pending user choices
NEXT STEPS: concrete next actions`,
  reduce: "",
};

function keepEven(history: HistoryMsg[], n: number): HistoryMsg[] {
  const kept = history.slice(-n);
  const i = kept.findIndex((m) => m.role === "user");
  return i === -1 ? kept : kept.slice(i);
}

export async function compactHistory(opts: {
  history: HistoryMsg[];
  mode: CompactMode;
  modelConfig: ModelConfig;
  instruction?: string;
  timeoutMs?: number;
  onUsage?: (u: Usage) => void;
}): Promise<CompactResult> {
  const { mode, modelConfig, instruction } = opts;
  const keep = KEEP_MESSAGES[mode];
  const kept = keepEven(opts.history, keep);
  const removed = opts.history.length - kept.length;
  if (mode === "reduce") {
    const dropped = opts.history.slice(0, removed);
    const summary = `[MECHANICAL COMPACT] Dropped ${removed} oldest messages. First lines of what was dropped:\n${dropped.map((m) => `${m.role}: ${m.content.slice(0, 120).replace(/\n/g, " ")}`).join("\n") || "-"}`;
    return { summary, kept, removed, mode, instruction };
  }
  const transcript = opts.history.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
  const prompt = `${PROMPTS[mode]}${instruction ? `\n\nAdditional user instruction - honor it in the summary: "${instruction}"` : ""}\n\n=== CONVERSATION ===\n${transcript}`;
  logEntry("COMPACT-REQUEST", modelConfig.id, prompt.slice(0, 4000));
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
  try {
    const res: any = await generateText({
      model: getModelFromConfig(modelConfig) as any,
      prompt,
      abortSignal: controller.signal,
    } as any);
    let u: any = res?.usage;
    if (u && typeof u.then === "function") { try { u = await u; } catch { u = null; } }
    if (u && opts.onUsage) opts.onUsage({ inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, totalTokens: u.totalTokens ?? 0 });
    const summary = String(res?.text ?? "").trim() || "(empty summary)";
    logEntry("COMPACT-RESULT", modelConfig.id, summary);
    return { summary, kept, removed, mode, instruction };
  } catch (e: any) {
    if (e.name === "AbortError") throw new Error(`compact timeout after ${(opts.timeoutMs ?? 120000) / 1000}s`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export function estimateHistoryTokens(history: HistoryMsg[]): number {
  return history.reduce((a, m) => a + Math.ceil(m.content.length / 4) + 8, 0);
}
