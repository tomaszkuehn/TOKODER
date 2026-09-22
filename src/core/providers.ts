import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ModelConfig } from "./config.js";
import { loadConfig, getModelConfig } from "./config.js";

export type ProviderName = ModelConfig["provider"];

function requireKey(cfg: ModelConfig): string {
  const key = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv]?.trim() : undefined;
  const fallback = process.env.OPENROUTER_API_KEY?.trim();
  const v = key || (cfg.provider === "openrouter" ? fallback : undefined);
  if (!v || v === "sk-dummy" || v.length < 8) {
    throw new Error(`Missing API key for "${cfg.id}" (${cfg.apiKeyEnv ?? "OPENROUTER_API_KEY"}). Fix: :models key ${cfg.id} sk-or-...  or set ${cfg.apiKeyEnv ?? "OPENROUTER_API_KEY"} in .env then :models test ${cfg.id}`);
  }
  return v;
}

function requireCustomKey(cfg: ModelConfig): string {
  const key = (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv]?.trim() : undefined) || process.env.CUSTOM_API_KEY?.trim();
  // explicit apiKeyEnv = key required; otherwise keyless endpoints (local gateways) get a dummy
  if (cfg.apiKeyEnv && (!key || key.length < 8)) {
    throw new Error(`Missing API key for "${cfg.id}" (${cfg.apiKeyEnv}). Fix: :models key ${cfg.id} <key>  or set ${cfg.apiKeyEnv} in .env then :models test ${cfg.id}`);
  }
  return key ?? "sk-dummy";
}

export function getModelFromConfig(cfg: ModelConfig): LanguageModel {
  if (cfg.baseURL) {
    const isOpenRouter = cfg.provider === "openrouter" || cfg.baseURL.includes("openrouter.ai");
    const key = isOpenRouter ? requireKey(cfg) : (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined) ?? "sk-dummy";
    const client = createOpenAI({
      apiKey: key,
      baseURL: cfg.baseURL,
      headers: isOpenRouter ? { "HTTP-Referer": "https://github.com/tokoder", "X-Title": "tokoder" } : undefined,
    } as any);
    return client(cfg.model);
  }
  switch (cfg.provider) {
    case "anthropic": {
      requireKey(cfg);
      return anthropic(cfg.model);
    }
    case "openai": {
      requireKey(cfg);
      return openai(cfg.model);
    }
    case "openrouter": {
      const key = requireKey(cfg);
      const client = createOpenAI({
        apiKey: key,
        baseURL: cfg.baseURL ?? "https://openrouter.ai/api/v1",
        headers: { "HTTP-Referer": "https://github.com/tokoder", "X-Title": "tokoder" },
      } as any);
      return client(cfg.model);
    }
    case "ollama": {
      const key = cfg.apiKeyEnv ? requireKey(cfg) : "ollama";
      const client = createOpenAI({
        apiKey: key,
        baseURL: cfg.baseURL ?? "http://localhost:11434/v1",
      });
      return client(cfg.model);
    }
    case "custom": {
      if (!cfg.baseURL) throw new Error(`Model "${cfg.id}" (provider "custom") requires baseURL - fix tokoder.config.json`);
      const key = requireCustomKey(cfg);
      const client = createOpenAICompatible({
        name: cfg.id,
        baseURL: cfg.baseURL,
        apiKey: key,
        headers: cfg.headers,
      });
      return client(cfg.model);
    }
    default:
      throw new Error(`Unknown provider: ${cfg.provider}`);
  }
}

export function getModel(provider: ProviderName, modelId: string): LanguageModel {
  return getModelFromConfig({ id: modelId, provider, model: modelId });
}

export function resolveModel(id?: string): ModelConfig {
  const cfg = loadConfig();
  if (id) {
    const found = getModelConfig(id, cfg);
    if (!found) throw new Error(`Model "${id}" not found. Available: ${cfg.models.map((m) => m.id).join(", ")}`);
    return found;
  }
  const def = getModelConfig(cfg.defaultModel, cfg);
  if (def) return def;
  return cfg.models[0];
}

export function listModels() {
  return loadConfig();
}
