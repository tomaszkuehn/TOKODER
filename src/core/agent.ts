import { streamText } from "ai";
import { getModelFromConfig, resolveModel, listModels } from "./providers.js";
import { tools } from "../tools/index.js";
import type { ModelConfig } from "./config.js";

const SYSTEM = `You are tokoder, an AI coding agent like opencode/claude-code.
- Be concise, use tools to inspect and modify code.
- Prefer read -> edit/write loop, verify with bash.
- Use glob/grep to explore codebase.
- Always explain what you did in final text answer, even if you used tools.
- CRITICAL: Only write/edit files INSIDE the current project directory (${process.cwd()}). Never write outside it unless user explicitly allows with :allow. If you need a new app, create it under ./ or ./apps/.`;

export type AgentOpts = {
  modelId?: string;
  modelConfig?: ModelConfig;
  cwd?: string;
  timeoutMs?: number;
  onToolCall?: (name: string, args: any) => void;
  onToolResult?: (name: string, result: string) => void;
};

export type Usage = { inputTokens: number; outputTokens: number; totalTokens: number };

export class AgentError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export async function* runAgent(prompt: string, opts: AgentOpts & { history?: { role: "user" | "assistant"; content: string }[] } = {}, onUsage?: (u: Usage) => void) {
  const cfg = opts.modelConfig ?? resolveModel(opts.modelId);
  const mdl = getModelFromConfig(cfg);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  let result: any;
  try {
    const msgs = opts.history?.length
      ? [...opts.history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })), { role: "user" as const, content: prompt }]
      : undefined;
    result = streamText({
      model: mdl,
      system: SYSTEM,
      ...(msgs ? { messages: msgs } : { prompt }),
      tools,
      maxSteps: 20,
      abortSignal: controller.signal,
    } as any);
  } catch (e: any) {
    clearTimeout(timeout);
    throw new AgentError(`[${cfg.id}] init failed: ${e.message} (check baseURL/model/key)`, e.code);
  }
  let sawText = false;
  try {
    for await (const part of result.fullStream as AsyncIterable<any>) {
      if (part.type === "text-delta") {
        sawText = true;
        yield part.text as string;
      } else if (part.type === "tool-call") {
        opts.onToolCall?.(part.toolName, part.input);
      } else if (part.type === "tool-result") {
        const out = typeof part.output === "string" ? part.output : JSON.stringify(part.output);
        opts.onToolResult?.(part.toolName, out.slice(0, 500));
      } else if (part.type === "error") {
        throw part.error;
      }
    }
  } catch (e: any) {
    if (e.name === "AbortError") throw new AgentError(`[${cfg.id}] timeout after ${(opts.timeoutMs ?? 60000) / 1000}s — is ${cfg.baseURL ?? cfg.provider} reachable?`, "TIMEOUT");
    const msg = e.message ?? String(e);
    if (msg.includes("ECONNREFUSED") || msg.includes("Failed to fetch") || msg.includes("fetch failed"))
      throw new AgentError(`[${cfg.id}] connection failed → ${cfg.baseURL ?? cfg.provider} not reachable. Is Ollama running? (ollama serve)`, "ECONNREFUSED");
    if (msg.includes("401") || msg.includes("Unauthorized")) throw new AgentError(`[${cfg.id}] 401 Unauthorized — wrong API key (${cfg.apiKeyEnv})`, "401");
    if (msg.includes("404")) throw new AgentError(`[${cfg.id}] 404 model "${cfg.model}" not found on ${cfg.baseURL ?? cfg.provider}`, "404");
    throw new AgentError(`[${cfg.id}] ${msg}`, e.code);
  } finally {
    clearTimeout(timeout);
  }
  if (!sawText) {
    try {
      const steps: any[] = await result.steps;
      const last = steps?.[steps.length - 1];
      if (last?.toolCalls?.length) yield `\n[tools used: ${last.toolCalls.map((t: any) => t.toolName).join(", ")}]\n`;
    } catch {}
  }
  try {
    const usage: any = await (result as any).usage;
    if (usage && onUsage) onUsage({ inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, totalTokens: usage.totalTokens ?? 0 });
  } catch {}
  try {
    const total: any = await (result as any).totalUsage;
    if (total && onUsage) onUsage({ inputTokens: total.inputTokens ?? 0, outputTokens: total.outputTokens ?? 0, totalTokens: total.totalTokens ?? 0 });
  } catch {}
}

export async function runAgentFull(prompt: string, opts: AgentOpts = {}) {
  let out = "";
  for await (const c of runAgent(prompt, opts)) out += c;
  return out;
}

export async function testConnection(cfg: ModelConfig, timeoutMs = 5000): Promise<{ ok: boolean; msg: string }> {
  const base = cfg.baseURL ?? (cfg.provider === "ollama" ? "http://localhost:11434/v1" : "");
  if (cfg.provider === "ollama" || base.includes("11434")) {
    const url = base.replace("/v1", "") + "/api/tags";
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { ok: false, msg: `HTTP ${res.status} ${res.statusText}` };
      const j: any = await res.json();
      const models = (j.models ?? []).map((m: any) => m.name);
      if (models.length && !models.includes(cfg.model) && !models.some((n: string) => cfg.model.startsWith(n)))
        return { ok: false, msg: `Connected but model "${cfg.model}" not found. Available: ${models.join(", ") || "—"}` };
      return { ok: true, msg: `OK — ${models.length ? models.join(", ") : "no models listed"}` };
    } catch (e: any) {
      return { ok: false, msg: e.name === "TimeoutError" ? `timeout ${timeoutMs}ms → ${url}` : `${e.message} → ${url} (is ollama running?)` };
    }
  }
  if (base) {
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/models`, {
        headers: cfg.apiKeyEnv && process.env[cfg.apiKeyEnv] ? { Authorization: `Bearer ${process.env[cfg.apiKeyEnv]}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { ok: false, msg: `HTTP ${res.status} ${res.statusText} → ${base}` };
      return { ok: true, msg: `OK → ${base}` };
    } catch (e: any) {
      return { ok: false, msg: `${e.message} → ${base}` };
    }
  }
  const key = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : "";
  if (!key) return { ok: false, msg: `No API key for ${cfg.apiKeyEnv}` };
  return { ok: true, msg: `Key present for ${cfg.apiKeyEnv}, no baseURL to test` };
}

export async function runParallel(prompt: string, modelIds: string[]): Promise<Record<string, string>> {
  const entries = await Promise.all(modelIds.map(async (id) => [id, await runAgentFull(prompt, { modelId: id })] as const));
  return Object.fromEntries(entries);
}

export { listModels };
