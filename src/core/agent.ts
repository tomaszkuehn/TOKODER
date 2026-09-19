import { streamText, stepCountIs } from "ai";
import { getModelFromConfig, resolveModel, listModels } from "./providers.js";
import { agentTools, executors } from "../tools/index.js";
import { logEntry } from "../utils/logger.js";
import type { ModelConfig } from "./config.js";

const SYSTEM = `You are tokoder, an AI coding agent like opencode/claude-code.
- Be concise, use tools to inspect and modify code.
- Prefer read -> edit/write loop, verify with bash.
- Use glob/grep to explore codebase.
- Always explain what you did in final text answer, even if you used tools.
- CRITICAL: Only write/edit files INSIDE the current project directory (${process.cwd()}). Never write outside it unless user explicitly allows with :allow. If you need a new app, create it under ./ or ./apps/.
- Environment: OS=${process.platform} ${process.env.WSL_DISTRO_NAME ? `(WSL:${process.env.WSL_DISTRO_NAME})` : ""} cwd=${process.cwd()} WSL=${process.env.WSL_DISTRO_NAME ? "yes" : "available on Windows"}. On Windows use PowerShell syntax (mkdir, dir) or WSL bash via "bash" tool (it auto-routes Linux cmds to wsl).`;

export type ToolDecision = "yes" | "always" | "no";

export type AccessDecision = "allow-file" | "allow-dir" | "deny";

export type AgentOpts = {
  modelId?: string;
  modelConfig?: ModelConfig;
  cwd?: string;
  timeoutMs?: number;
  maxSteps?: number;
  onToolApproval?: (name: string, args: any) => Promise<ToolDecision>;
  onAccessRequest?: (tool: string, args: any, mode: "read" | "write" | "execute", target: string) => Promise<AccessDecision>;
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
  let timeoutFired = false;
  let timeout = setTimeout(() => { timeoutFired = true; controller.abort(); }, opts.timeoutMs ?? 300_000);
  const restartTimer = () => {
    clearTimeout(timeout);
    timeoutFired = false;
    timeout = setTimeout(() => { timeoutFired = true; controller.abort(); }, opts.timeoutMs ?? 300_000);
  };
  const maxSteps = opts.maxSteps ?? 20;
  const msgs: any[] = opts.history?.length
    ? [...opts.history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })), { role: "user", content: prompt }]
    : [{ role: "user", content: prompt }];
  let sawText = false;
  const stepText: string[] = [];
  try {
    for (let step = 0; step < maxSteps; step++) {
      logEntry("DO MODELU", cfg.id, JSON.stringify({ step, messages: msgs }, null, 2));
      let result: any;
      try {
        result = streamText({
          model: mdl,
          system: SYSTEM,
          messages: msgs,
          tools: agentTools,
          stopWhen: stepCountIs(1),
          abortSignal: controller.signal,
        } as any);
      } catch (e: any) {
        throw new AgentError(`[${cfg.id}] init failed: ${e.message} (check baseURL/model/key)`, e.code);
      }
      const pendingCalls: { toolCallId: string; toolName: string; input: any }[] = [];
      stepText.length = 0;
      try {
        for await (const part of result.fullStream as AsyncIterable<any>) {
          if (part.type === "text-delta") {
            sawText = true;
            stepText.push(part.text as string);
            yield part.text as string;
          } else if (part.type === "tool-call") {
            pendingCalls.push({ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
          } else if (part.type === "error") {
            throw part.error;
          }
        }
      } catch (e: any) {
        if (e.name === "AbortError") throw new AgentError(`[${cfg.id}] timeout after ${(opts.timeoutMs ?? 300000) / 1000}s — model was still working (tools). Retry with higher --timeout`, "TIMEOUT");
        const msg = e.message ?? String(e);
        if (msg.includes("Missing Authentication") || msg.includes("No auth") || msg.includes("API key"))
          throw new AgentError(`[${cfg.id}] Missing Authentication — no key for ${cfg.apiKeyEnv ?? "OPENROUTER_API_KEY"}. Fix: :models key ${cfg.id} sk-or-...  then :models test ${cfg.id}`, "401");
        if (msg.includes("ECONNREFUSED") || msg.includes("Failed to fetch") || msg.includes("fetch failed"))
          throw new AgentError(`[${cfg.id}] connection failed → ${cfg.baseURL ?? cfg.provider} not reachable. Is Ollama running? (ollama serve)`, "ECONNREFUSED");
        if (msg.includes("401") || msg.includes("Unauthorized")) throw new AgentError(`[${cfg.id}] 401 Unauthorized — wrong API key (${cfg.apiKeyEnv}) — :models key ${cfg.id} <key>`, "401");
        if (msg.includes("404")) throw new AgentError(`[${cfg.id}] 404 model "${cfg.model}" not found on ${cfg.baseURL ?? cfg.provider}`, "404");
        throw new AgentError(`[${cfg.id}] ${msg}`, e.code);
      }
      if (timeoutFired) throw new AgentError(`[${cfg.id}] timeout after ${(opts.timeoutMs ?? 300000) / 1000}s — model was still working (tools). Retry with higher --timeout`, "TIMEOUT");
      {
        const parts: any[] = [];
        if (stepText.length) parts.push({ text: stepText.join("") });
        for (const c of pendingCalls) parts.push({ toolCall: { toolName: c.toolName, input: c.input } });
        if (parts.length) logEntry("ODPOWIEDZ", cfg.id, JSON.stringify(parts, null, 2));
        if (parts.length > 1) logEntry("ODPOWIEDZ-CZESCI", cfg.id, parts.map((p, i) => `--- część ${i + 1} (${p.text !== undefined ? "tekst" : `tool:${p.toolCall.toolName}`}) ---\n${p.text !== undefined ? p.text : JSON.stringify(p.toolCall, null, 2)}`).join("\n"));
        const txt = stepText.join("");
        if (txt) {
          const opts2 = [...txt.matchAll(/^\s{0,4}(\d{1,2})[.)\-]\s+(\S.*)$/gm)].map((m) => `${m[1]}. ${m[2]}`);
          if (opts2.length >= 2) logEntry("ODPOWIEDZ-LISTA", cfg.id, JSON.stringify({ detectedOptions: opts2, hint: "user może odpowiedzieć numerem 1-N" }, null, 2));
        }
      }
      let fr: any = null;
      try { fr = await result.finishReason; } catch {}
      if (process.env.TOCODER_DEBUG) console.error(`[debug] step=${step} finishReason=${JSON.stringify(fr)} toolCalls=${pendingCalls.length}`);
      if (fr === "length") yield "\n[⚠ output truncated — max tokens reached; ask to continue]";
      try {
        const usage: any = await result.usage;
        if (usage && onUsage) onUsage({ inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, totalTokens: usage.totalTokens ?? 0 });
      } catch {}
      if (!pendingCalls.length || fr === "length") break;
      msgs.push({ role: "assistant", content: pendingCalls.map((c) => ({ type: "tool-call", toolCallId: c.toolCallId, toolName: c.toolName, input: c.input })) });
      const results: any[] = [];
      for (const c of pendingCalls) {
        const decision = opts.onToolApproval ? await opts.onToolApproval(c.toolName, c.input) : "yes";
        let output: string;
        if (decision === "no") {
          output = `DENIED by user: "${c.toolName}" was not executed. Ask the user how to proceed.`;
        } else {
          opts.onToolCall?.(c.toolName, c.input);
          try {
            const ex = executors[c.toolName];
            output = ex ? String(await ex(c.input)) : `Error: unknown tool "${c.toolName}"`;
            if (output.includes("PENDING-APPROVAL") && opts.onAccessRequest) {
              const target = String(c.input?.path ?? c.input?.workdir ?? c.input?.pattern ?? "?");
              const mode: any = output.includes("read") ? "read" : output.includes("workdir") || output.includes("execute") ? "execute" : "write";
              const decision = await opts.onAccessRequest(c.toolName, c.input, mode, target);
              if (decision === "deny") {
                output = `DENIED by user: access to "${target}" not granted. Ask the user how to proceed.`;
              } else {
                const { applyAskDecision } = await import("../utils/permissions.js");
                applyAskDecision(target, mode, decision);
                output = ex ? String(await ex(c.input)) : output;
              }
            }
          } catch (e: any) {
            output = `Error: ${e.message ?? String(e)}`;
          }
          opts.onToolResult?.(c.toolName, output.slice(0, 500));
        }
        results.push({ type: "tool-result", toolCallId: c.toolCallId, toolName: c.toolName, output: { type: "text", value: output } });
      }
      msgs.push({ role: "tool", content: results });
      restartTimer();
    }
  } finally {
    clearTimeout(timeout);
  }
  if (process.env.TOCODER_DEBUG) console.error(`[debug] done sawText=${sawText}`);
  if (!sawText) {
    yield "\n[tools used: no text produced]";
  }
}

export async function runAgentFull(prompt: string, opts: AgentOpts = {}, onUsage?: (u: Usage) => void) {
  let out = "";
  for await (const c of runAgent(prompt, opts, onUsage)) out += c;
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
