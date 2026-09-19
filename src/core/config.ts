import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";

export type ModelConfig = {
  id: string;
  provider: "anthropic" | "openai" | "openrouter" | "ollama";
  model: string;
  apiKeyEnv?: string;
  baseURL?: string;
  contextWindow?: number;
  /** where the model was loaded from — set by loadConfig, stripped on save */
  source?: "global" | "local";
};

export type CompactMode = "reduce" | "balance" | "value";

export type CompactConfig = {
  mode: CompactMode;
  autoTrigger: boolean;
  thresholdPercent: number;
};

export const COMPACT_DEFAULTS: CompactConfig = { mode: "balance", autoTrigger: true, thresholdPercent: 70 };
export const DEFAULT_CONTEXT_WINDOW = 128000;

// legacy Polish mode names → English
const MODE_ALIASES: Record<string, CompactMode> = { redukcja: "reduce", balans: "balance", wartosc: "value", reduce: "reduce", balance: "balance", value: "value" };

export function normalizeCompact(c?: Partial<CompactConfig>): CompactConfig {
  const mode = MODE_ALIASES[String(c?.mode ?? "").toLowerCase()] ?? COMPACT_DEFAULTS.mode;
  return {
    mode,
    autoTrigger: c?.autoTrigger ?? COMPACT_DEFAULTS.autoTrigger,
    thresholdPercent: typeof c?.thresholdPercent === "number" ? c!.thresholdPercent! : COMPACT_DEFAULTS.thresholdPercent,
  };
}

export type TokoderConfig = {
  models: ModelConfig[];
  defaultModel: string;
  compact?: Partial<CompactConfig>;
};

const DEFAULTS: TokoderConfig = {
  models: [
    { id: "claude-sonnet", provider: "anthropic", model: "claude-sonnet-4-20250514", apiKeyEnv: "ANTHROPIC_API_KEY" },
    { id: "gpt-4o", provider: "openai", model: "gpt-4o", apiKeyEnv: "OPENAI_API_KEY" },
    { id: "gemini-flash", provider: "openrouter", model: "google/gemini-2.0-flash-001", apiKeyEnv: "OPENROUTER_API_KEY", baseURL: "https://openrouter.ai/api/v1" },
  ],
  defaultModel: "claude-sonnet",
};

const CANDIDATES = ["tokoder.config.json", ".tokoder.json", "tokoder.config.jsonc"];

export function globalConfigPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ".";
  return join(home, ".config", "tokoder", "config.json");
}

export function localConfigPath(cwd = process.cwd()): string | null {
  for (const name of CANDIDATES) {
    const p = resolve(cwd, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function readJson(p: string): any | null {
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Models config = GLOBAL (~/.config/tokoder/config.json) + LOCAL (tokoder.config.json in cwd).
 * Merge: global first, local models override same-id entries and append new ones;
 * local wins for defaultModel and compact when declared.
 * Instructions stay project-local (AGENTS.md).
 */
export function loadConfig(cwd = process.cwd()): TokoderConfig {
  const g = readJson(globalConfigPath()) as TokoderConfig | null;
  const lp = localConfigPath(cwd);
  const l = lp ? (readJson(lp) as TokoderConfig | null) : null;

  const gModels: ModelConfig[] = g?.models?.length ? g.models.map((m) => ({ ...m, source: "global" as const })) : [];
  let models: ModelConfig[];
  if (!gModels.length && !l) {
    models = DEFAULTS.models.map((m) => ({ ...m, source: "global" as const }));
  } else {
    models = [...gModels];
    for (const m of l?.models ?? []) {
      const i = models.findIndex((x) => x.id === m.id);
      if (i !== -1) models[i] = { ...m, source: "local" as const };
      else models.push({ ...m, source: "local" as const });
    }
  }
  const defaultModel =
    l?.defaultModel ?? g?.defaultModel ?? (models.find((m) => m.id === DEFAULTS.defaultModel)?.id ?? models[0]?.id ?? DEFAULTS.defaultModel);
  const compact = { ...(g?.compact ?? {}), ...(l?.compact ?? {}) };
  return { models, defaultModel: models.find((m) => m.id === defaultModel) ? defaultModel : models[0]?.id ?? defaultModel, compact };
}

export function saveConfig(cfg: TokoderConfig, cwd = process.cwd(), scope?: "global" | "local"): string {
  const lp = localConfigPath(cwd);
  const s = scope ?? (lp ? "local" : "global");
  const p = s === "global" ? globalConfigPath() : lp ?? resolve(cwd, "tokoder.config.json");
  if (s === "global") mkdirSync(dirname(p), { recursive: true });
  const clean = { ...cfg, models: cfg.models.map((m) => { const { source: _src, ...rest } = m; return rest; }) };
  writeFileSync(p, JSON.stringify(clean, null, 2) + "\n", "utf-8");
  return p;
}

export function getModelConfig(id: string, cfg = loadConfig()): ModelConfig | undefined {
  return cfg.models.find((m) => m.id === id);
}
