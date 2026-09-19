import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { ModelConfig } from "./config.js";
import { loadConfig, getModelConfig } from "./config.js";

export type ProviderName = ModelConfig["provider"];

export function getModelFromConfig(cfg: ModelConfig): LanguageModel {
  const key = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
  if (cfg.baseURL) {
    const client = createOpenAI({ apiKey: key ?? "sk-dummy", baseURL: cfg.baseURL });
    return client(cfg.model);
  }
  switch (cfg.provider) {
    case "anthropic":
      return anthropic(cfg.model);
    case "openai":
      return openai(cfg.model);
    case "openrouter": {
      const client = createOpenAI({
        apiKey: key ?? process.env.OPENROUTER_API_KEY ?? "sk-dummy",
        baseURL: cfg.baseURL ?? "https://openrouter.ai/api/v1",
      });
      return client(cfg.model);
    }
    case "ollama": {
      const client = createOpenAI({
        apiKey: "ollama",
        baseURL: cfg.baseURL ?? "http://localhost:11434/v1",
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
