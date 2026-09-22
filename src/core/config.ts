import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";

export type ModelConfig = {
  id: string;
  provider: "anthropic" | "openai" | "openrouter" | "ollama" | "custom";
  model: string;
  apiKeyEnv?: string;
  baseURL?: string;
  contextWindow?: number;
  /** extra HTTP headers (custom OpenAI-compatible providers) */
  headers?: Record<string, string>;
  /** where the model was loaded from — set by loadConfig, stripped on save */
  source?: "global" | "local";
};

/** OpenAI-compatible provider definition (e.g. cheaperinference.com) — expanded to models on load */
export type ProviderConfig = {
  /** display name (default: provider key) */
  name?: string;
  /** env var holding the API key (default: CUSTOM_API_KEY) */
  apiKeyEnv?: string;
  /** OpenAI-compatible API base URL, e.g. https://api.cheaperinference.com/v1 */
  baseURL: string;
  /** extra HTTP headers sent with every request */
  headers?: Record<string, string>;
  /** models offered by this provider */
  models?: Record<string, { name?: string }>;
};

export type CompactMode = "reduce" | "balance" | "value";

export type CompactConfig = {
  mode: CompactMode;
  autoTrigger: boolean;
  /** compact when estimated history tokens exceed this % of the model context window */
  thresholdPercent: number;
  /** compact when estimated history tokens exceed this absolute limit (0 = disabled) */
  maxTokens: number;
};

export const COMPACT_DEFAULTS: CompactConfig = { mode: "balance", autoTrigger: true, thresholdPercent: 70, maxTokens: 0 };
export const DEFAULT_CONTEXT_WINDOW = 128000;

// legacy Polish mode names → English
const MODE_ALIASES: Record<string, CompactMode> = { redukcja: "reduce", balans: "balance", wartosc: "value", reduce: "reduce", balance: "balance", value: "value" };

export function normalizeCompact(c?: Partial<CompactConfig>): CompactConfig {
  const mode = MODE_ALIASES[String(c?.mode ?? "").toLowerCase()] ?? COMPACT_DEFAULTS.mode;
  return {
    mode,
    autoTrigger: c?.autoTrigger ?? COMPACT_DEFAULTS.autoTrigger,
    thresholdPercent: typeof c?.thresholdPercent === "number" ? c!.thresholdPercent! : COMPACT_DEFAULTS.thresholdPercent,
    maxTokens: typeof c?.maxTokens === "number" && c!.maxTokens! >= 0 ? c!.maxTokens! : COMPACT_DEFAULTS.maxTokens,
  };
}

/** auto-compact fires when EITHER limit is exceeded (percent of context window OR absolute maxTokens) */
export function compactLimit(cc: CompactConfig, contextWindow: number): { limit: number; reason: "percent" | "tokens" | "both" } {
  const pctLimit = Math.round((contextWindow * cc.thresholdPercent) / 100);
  const tokLimit = cc.maxTokens > 0 ? cc.maxTokens : Infinity;
  const limit = Math.min(pctLimit, tokLimit);
  const reason = tokLimit < pctLimit ? "tokens" : pctLimit < tokLimit ? "percent" : tokLimit !== Infinity ? "both" : "percent";
  return { limit, reason };
}

export type TokoderConfig = {
  models: ModelConfig[];
  defaultModel: string;
  /** OpenAI-compatible providers (key = provider id); expanded into models on load */
  providers?: Record<string, ProviderConfig>;
  compact?: Partial<CompactConfig>;
  /** agent loop step budget (0 = unlimited) */
  maxSteps?: number;
  /** read-only mode: write/edit removed from tools, plan-only system prompt */
  planMode?: boolean;
};

export const DEFAULT_MAX_STEPS = 100;

export function normalizeMaxSteps(v: unknown): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_STEPS;
  return Math.floor(n);
}

const DEFAULTS: TokoderConfig = {
  models: [
    { id: "claude-sonnet", provider: "anthropic", model: "claude-sonnet-4-20250514", apiKeyEnv: "ANTHROPIC_API_KEY" },
    { id: "gpt-4o", provider: "openai", model: "gpt-4o", apiKeyEnv: "OPENAI_API_KEY" },
    { id: "gemini-flash", provider: "openrouter", model: "google/gemini-2.0-flash-001", apiKeyEnv: "OPENROUTER_API_KEY", baseURL: "https://openrouter.ai/api/v1" },
  ],
  defaultModel: "claude-sonnet",
};

/**
 * Expand "providers" section (OpenAI-compatible endpoints, e.g. cheaperinference.com)
 * into flat ModelConfig entries. Model ids: "<providerKey>-<modelId>" (or display name slug).
 */
export function expandProviders(providers?: Record<string, ProviderConfig>): ModelConfig[] {
  if (!providers) return [];
  const out: ModelConfig[] = [];
  for (const [key, p] of Object.entries(providers)) {
    const baseURL = p.baseURL?.replace(/\/$/, "");
    if (!baseURL) continue;
    const apiKeyEnv = p.apiKeyEnv ?? "CUSTOM_API_KEY";
    for (const [modelId, m] of Object.entries(p.models ?? {})) {
      const slug = m.name ? m.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : modelId;
      out.push({
        id: `${key}-${slug}`,
        provider: "custom",
        model: modelId,
        apiKeyEnv,
        baseURL,
        ...(Object.keys(p.headers ?? {}).length ? { headers: p.headers } : {}),
      });
    }
    if (!p.models || !Object.keys(p.models).length) {
      out.push({ id: `${key}-${key}`, provider: "custom", model: key, apiKeyEnv, baseURL, ...(Object.keys(p.headers ?? {}).length ? { headers: p.headers } : {}) });
    }
  }
  return out;
}

const CANDIDATES = ["tokoder.config.json", ".tokoder.json"];

/** local config: project root first (committed with the repo), .tokoder/ fallback */
export const LOCAL_CONFIG_PATH = (cwd = process.cwd()) => resolve(cwd, CANDIDATES[0]);

export function globalConfigPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ".";
  return join(home, ".config", "tokoder", "config.json");
}

export function localConfigPath(cwd = process.cwd()): string | null {
  for (const name of CANDIDATES) {
    const p = resolve(cwd, name);
    if (existsSync(p)) return p;
  }
  const hidden = resolve(cwd, ".tokoder", "config.json");
  return existsSync(hidden) ? hidden : null;
}

function readJson(p: string): any | null {
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch (e: any) {
    if (e instanceof SyntaxError) throw new ConfigError(`Invalid JSON in "${p}": ${e.message}`);
    return null;
  }
}

export class ConfigError extends Error {}

const KNOWN_PROVIDERS = ["anthropic", "openai", "openrouter", "ollama", "custom"];

/** Validate global + local config files. Throws ConfigError with file path + reason; returns list of parsed files checked. */
export function validateConfig(cwd = process.cwd()): { checked: string[] } {
  const checked: string[] = [];
  const err = (file: string, msg: string): never => {
    throw new ConfigError(`Config error in "${file}": ${msg}`);
  };
  const checkModels = (file: string, models: unknown) => {
    if (!Array.isArray(models)) err(file, '"models" must be an array');
    (models as any[]).forEach((m: any, i: number) => {
      const at = `models[${i}]`;
      if (!m || typeof m !== "object") err(file, `${at} must be an object`);
      if (typeof m.id !== "string" || !m.id.trim()) err(file, `${at}.id must be a non-empty string`);
      if (typeof m.model !== "string" || !m.model.trim()) err(file, `${at}.model must be a non-empty string`);
      if (!KNOWN_PROVIDERS.includes(m.provider)) err(file, `${at}.provider "${m.provider}" unknown — use: ${KNOWN_PROVIDERS.join(" | ")}`);
      if (m.provider === "custom" && typeof m.baseURL !== "string") err(file, `${at} (custom) requires "baseURL"`);
      if (m.apiKeyEnv !== undefined && (typeof m.apiKeyEnv !== "string" || !m.apiKeyEnv.trim()))
        err(file, `${at}.apiKeyEnv must be a non-empty string or omitted`);
      if (m.apiKeyEnv && /^[A-Za-z0-9_]*={0,2}$/.test(m.apiKeyEnv) === false)
        err(file, `${at}.apiKeyEnv "${m.apiKeyEnv}" looks like a literal API key, not an env var name — move the key to ~/.config/tokoder/.env and put the variable name here`);
      if (m.contextWindow !== undefined && (typeof m.contextWindow !== "number" || m.contextWindow < 1))
        err(file, `${at}.contextWindow must be a positive number`);
    });
  };
  const checkProviders = (file: string, providers: any) => {
    if (providers === undefined) return;
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) err(file, '"providers" must be an object');
    for (const [key, p] of Object.entries<any>(providers)) {
      const at = `providers.${key}`;
      if (!p || typeof p !== "object") err(file, `${at} must be an object`);
      if (typeof p.baseURL !== "string" || !/^https?:\/\//.test(p.baseURL)) err(file, `${at}.baseURL must be an http(s) URL`);
      if (p.apiKeyEnv !== undefined && (typeof p.apiKeyEnv !== "string" || !p.apiKeyEnv.trim()))
        err(file, `${at}.apiKeyEnv must be a non-empty string or omitted`);
      if (p.apiKeyEnv && /:/i.test(String(p.apiKeyEnv)))
        err(file, `${at}.apiKeyEnv "${p.apiKeyEnv}" looks like a literal API key, not an env var name — move the key to ~/.config/tokoder/.env and put the variable name here`);
      if (p.headers !== undefined && (typeof p.headers !== "object" || p.headers === null || Array.isArray(p.headers)))
        err(file, `${at}.headers must be an object`);
      if (p.models !== undefined) {
        if (typeof p.models !== "object" || p.models === null || Array.isArray(p.models)) err(file, `${at}.models must be an object`);
        for (const [mid, mv] of Object.entries<any>(p.models)) {
          if (!mv || typeof mv !== "object") err(file, `${at}.models.${mid} must be an object like { "name": "..." }`);
        }
      }
    }
  };
  const gp = globalConfigPath();
  if (existsSync(gp)) {
    checked.push(gp);
    const g = JSON.parse(readFileSync(gp, "utf-8"));
    if (typeof g !== "object" || g === null || Array.isArray(g)) err(gp, "root must be an object");
    checkModels(gp, g.models);
    checkProviders(gp, g.providers);
    if (g.maxSteps !== undefined && (typeof g.maxSteps !== "number" || g.maxSteps < 0)) err(gp, '"maxSteps" must be a number >= 0');
    if (g.planMode !== undefined && typeof g.planMode !== "boolean") err(gp, '"planMode" must be a boolean');
    if (g.compact !== undefined && (typeof g.compact !== "object" || g.compact === null)) err(gp, '"compact" must be an object');
  }
  for (const name of CANDIDATES) {
    const p = resolve(cwd, name);
    if (!existsSync(p)) continue;
    checked.push(p);
    const l = JSON.parse(readFileSync(p, "utf-8"));
    if (typeof l !== "object" || l === null || Array.isArray(l)) err(p, "root must be an existing object");
    checkModels(p, l.models);
    checkProviders(p, l.providers);
    if (l.maxSteps !== undefined && (typeof l.maxSteps !== "number" || l.maxSteps < 0)) err(p, '"maxSteps" must be a number >= 0');
    if (l.planMode !== undefined && typeof l.planMode !== "boolean") err(p, '"planMode" must be a boolean');
    if (l.compact !== undefined && (typeof l.compact !== "object" || l.compact === null)) err(p, '"compact" must be an object');
  }
  const hidden = resolve(cwd, ".tokoder", "config.json");
  if (existsSync(hidden)) {
    checked.push(hidden);
    const l = JSON.parse(readFileSync(hidden, "utf-8"));
    if (typeof l !== "object" || l === null || Array.isArray(l)) err(hidden, "root must be an existing object");
    checkModels(hidden, l.models);
    checkProviders(hidden, l.providers);
  }
  return { checked };
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
  // expand OpenAI-compatible "providers" (global + local) and append; local wins on id clash
  for (const m of expandProviders(g?.providers)) models.push({ ...m, source: "global" as const });
  for (const m of expandProviders(l?.providers)) {
    const i = models.findIndex((x) => x.id === m.id);
    if (i !== -1) models[i] = { ...m, source: "local" as const };
    else models.push({ ...m, source: "local" as const });
  }
  const defaultModel =
    l?.defaultModel ?? g?.defaultModel ?? (models.find((m) => m.id === DEFAULTS.defaultModel)?.id ?? models[0]?.id ?? DEFAULTS.defaultModel);
  const compact = { ...(g?.compact ?? {}), ...(l?.compact ?? {}) };
  const maxSteps = normalizeMaxSteps(l?.maxSteps ?? g?.maxSteps);
  const planMode = l?.planMode ?? g?.planMode ?? false;
  return { models, defaultModel: models.find((m) => m.id === defaultModel) ? defaultModel : models[0]?.id ?? defaultModel, compact, maxSteps, planMode };
}

export function saveConfig(cfg: TokoderConfig, cwd = process.cwd(), scope?: "global" | "local"): string {
  const lp = localConfigPath(cwd);
  const s = scope ?? (lp && !lp.includes(".tokoder") ? "local" : existsSync(resolve(cwd, ".tokoder", "config.json")) ? "local" : "global");
  const p = s === "global" ? globalConfigPath() : (lp && !lp.includes(".tokoder") ? lp : resolve(cwd, ".tokoder", "config.json"));
  mkdirSync(dirname(p), { recursive: true });
  if (s === "global") mkdirSync(dirname(p), { recursive: true });
  const clean = { ...cfg, models: cfg.models.map((m) => { const { source: _src, ...rest } = m; return rest; }) };
  writeFileSync(p, JSON.stringify(clean, null, 2) + "\n", "utf-8");
  return p;
}

export function getModelConfig(id: string, cfg = loadConfig()): ModelConfig | undefined {
  return cfg.models.find((m) => m.id === id);
}
