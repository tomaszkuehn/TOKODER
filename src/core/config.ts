import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

export type ModelConfig = {
  id: string;
  provider: "anthropic" | "openai" | "openrouter" | "ollama";
  model: string;
  apiKeyEnv?: string;
  baseURL?: string;
  contextWindow?: number;
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

function configPath(cwd = process.cwd()): string {
  for (const name of CANDIDATES) {
    const p = resolve(cwd, name);
    if (existsSync(p)) return p;
  }
  return resolve(cwd, "tokoder.config.json");
}

export function loadConfig(cwd = process.cwd()): TokoderConfig {
  for (const name of CANDIDATES) {
    const p = resolve(cwd, name);
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, "utf-8");
        const parsed = JSON.parse(raw) as TokoderConfig;
        if (parsed.models?.length) return { ...DEFAULTS, ...parsed, models: parsed.models };
      } catch {}
    }
  }
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (home) {
    const p = join(home, ".config", "tokoder", "config.json");
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf-8")) as TokoderConfig;
      } catch {}
    }
  }
  return DEFAULTS;
}

export function saveConfig(cfg: TokoderConfig, cwd = process.cwd()): void {
  const p = configPath(cwd);
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

export function getModelConfig(id: string, cfg = loadConfig()): ModelConfig | undefined {
  return cfg.models.find((m) => m.id === id);
}
