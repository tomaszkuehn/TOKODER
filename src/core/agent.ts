import { streamText, stepCountIs } from "ai";
import { getModelFromConfig, resolveModel, listModels } from "./providers.js";
import { agentTools, executors } from "../tools/index.js";
import { logEntry } from "../utils/logger.js";
import { ACL_MARK } from "../utils/permissions.js";
import { buildSystemPrompt } from "./instructions.js";
import type { ModelConfig } from "./config.js";

const SYSTEM = `You are tokoder, an AI coding agent like opencode/claude-code.
- Be concise, use tools to inspect and modify code.
- Prefer read -> edit/write loop, verify with bash.
- Use glob/grep to explore codebase.
- Always explain what you did in final text answer, even if you used tools.
- CRITICAL: Only write/edit files INSIDE the current project directory (${process.cwd()}). Never write outside it unless user explicitly allows with :allow. If you need a new app, create it under ./ or ./apps/.
- Environment: OS=${process.platform} ${process.env.WSL_DISTRO_NAME ? `(WSL:${process.env.WSL_DISTRO_NAME})` : ""} cwd=${process.cwd()} WSL=${process.env.WSL_DISTRO_NAME ? "yes" : "available on Windows"}. On Windows use PowerShell syntax (mkdir, dir) or WSL bash via "bash" tool (it auto-routes Linux cmds to wsl).`;

export type ToolDecision = "yes" | "always" | "no" | "abort";

export type AccessDecision = "allow-file" | "allow-dir" | "deny" | "abort";

export type AgentOpts = {
  modelId?: string;
  modelConfig?: ModelConfig;
  cwd?: string;
  timeoutMs?: number;
  maxSteps?: number;
  onToolApproval?: (name: string, args: any) => Promise<ToolDecision>;
  onAccessRequest?: (tool: string, args: any, mode: "read" | "write" | "execute", target: string) => Promise<AccessDecision>;
  abortSignal?: AbortSignal;
  onToolCall?: (name: string, args: any) => void;
  onToolResult?: (name: string, result: string) => void;
  onContext?: (usedTokens: number) => void;
};

export type Usage = { inputTokens: number; outputTokens: number; totalTokens: number };

/** rough context estimate actually sent to the model (chars/4 + overhead per message + per tool result) */
function estimateMsgsTokens(msgs: any[]): number {
  let chars = 0;
  let count = 0;
  for (const m of msgs) {
    count++;
    if (typeof m.content === "string") chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (typeof p === "string") chars += p.length;
        else if (p?.text) chars += p.text.length;
        else if (p?.toolCall) chars += JSON.stringify(p.toolCall.input ?? "").length + 40;
        else if (p?.output?.value != null) chars += String(p.output.value).length;
        else if (p?.content != null) chars += String(p.content).length;
      }
    }
  }
  return Math.ceil(chars / 4) + count * 8 + 24; // +24: system prompt floor
}

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
  const onExternalAbort = () => controller.abort();
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) onExternalAbort();
    else opts.abortSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  let timeoutFired = false;
  let timeout = setTimeout(() => { timeoutFired = true; controller.abort(); }, opts.timeoutMs ?? 300_000);
  const restartTimer = () => {
    clearTimeout(timeout);
    timeoutFired = false;
    timeout = setTimeout(() => { timeoutFired = true; controller.abort(); }, opts.timeoutMs ?? 300_000);
  };
  const maxSteps = opts.maxSteps ?? 0; // 0 = unlimited; budget enforced via stepsUsed + opts.maxSteps
  const msgs: any[] = opts.history?.length
    ? [...opts.history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })), { role: "user", content: prompt }]
    : [{ role: "user", content: prompt }];
  let sawText = false;
  const stepText: string[] = [];
  let lastHadTools = false;
  let nudged = false;
  let stepsUsed = 0;
  try {
    for (let step = 0; ; step++) {
      if (maxSteps > 0 && stepsUsed >= maxSteps) break;
      stepsUsed++;
      logEntry("TO-MODEL", cfg.id, JSON.stringify({ step, messages: msgs }, null, 2));
      opts.onContext?.(estimateMsgsTokens(msgs));
      let result: any;
      try {
        result = streamText({
          model: mdl,
          system: buildSystemPrompt(SYSTEM, opts.cwd ?? process.cwd()),
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
      lastHadTools = false;
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
        if (parts.length) logEntry("RESPONSE", cfg.id, JSON.stringify(parts, null, 2));
        if (parts.length > 1) logEntry("RESPONSE-PARTS", cfg.id, parts.map((p, i) => `--- part ${i + 1} (${p.text !== undefined ? "text" : `tool:${p.toolCall.toolName}`}) ---\n${p.text !== undefined ? p.text : JSON.stringify(p.toolCall, null, 2)}`).join("\n"));
        const txt = stepText.join("");
        if (txt) {
          const opts2 = [...txt.matchAll(/^\s{0,4}(\d{1,2})[.)\-]\s+(\S.*)$/gm)].map((m) => `${m[1]}. ${m[2]}`);
          if (opts2.length >= 2) logEntry("RESPONSE-LIST", cfg.id, JSON.stringify({ detectedOptions: opts2, hint: "user can answer with number 1-N" }, null, 2));
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
      if (!pendingCalls.length || fr === "length") {
        if (!pendingCalls.length && !stepText.length && lastHadTools && !nudged) {
          nudged = true;
          yield "\n[no final summary from model — nudging to finish]";
          msgs.push({ role: "assistant", content: [{ type: "text", text: "(no text)" }] });
          msgs.push({
            role: "user",
            content: "[system] The previous turn ended with tool calls but no final text. The tools already ran. Reply with a SHORT final summary now (what was done, files touched, how to verify). Do not call any tools unless something failed.",
          });
          logEntry("NUDGE", cfg.id, "empty final response after tool step — retrying once with continuation prompt");
          continue;
        }
        break;
      }
      msgs.push({ role: "assistant", content: pendingCalls.map((c) => ({ type: "tool-call", toolCallId: c.toolCallId, toolName: c.toolName, input: c.input })) });
      const results: any[] = [];
      for (const c of pendingCalls) {
        const decision = opts.onToolApproval ? await opts.onToolApproval(c.toolName, c.input) : "yes";
        if (decision === "abort") throw new AgentError("Aborted by user ([A]bort on tool approval)", "ABORTED");
        let output: string;
        if (decision === "no") {
          output = `DENIED by user: "${c.toolName}" was not executed. Ask the user how to proceed.`;
        } else {
          opts.onToolCall?.(c.toolName, c.input);
          try {
            const ex = executors[c.toolName];
            output = ex ? String(await ex(c.input, { signal: controller.signal })) : `Error: unknown tool "${c.toolName}"`;
            if (output.startsWith(ACL_MARK) && opts.onAccessRequest) {
              const [, , mode, target, message] = output.split("\u0000");
              const decision = await opts.onAccessRequest(c.toolName, c.input, mode as any, target);
              if (decision === "abort") throw new AgentError(`Aborted by user ([A]bort on ACL prompt for ${target})`, "ABORTED");
              if (decision === "deny") {
                output = `DENIED by user: access to "${target}" not granted (${message ?? "access request"}). Ask the user how to proceed.`;
              } else {
                const { applyAskDecision } = await import("../utils/permissions.js");
                applyAskDecision(target, mode as any, decision);
                output = ex ? String(await ex(c.input, { signal: controller.signal })) : output;
              }
            }
          } catch (e: any) {
            if (e instanceof AgentError) throw e;
            output = `Error: ${e.message ?? String(e)}`;
          }
          opts.onToolResult?.(c.toolName, output.slice(0, 500));
        }
        results.push({ type: "tool-result", toolCallId: c.toolCallId, toolName: c.toolName, output: { type: "text", value: output } });
      }
      msgs.push({ role: "tool", content: results });
      restartTimer();
      lastHadTools = true;
    }
    logEntry("TOOL-LIMIT", cfg.id, `maxSteps=${maxSteps} reached — agent stopped after tool results with no final text. User should say "continue" to reset the budget or raise maxSteps.`);
    yield `\n[⚠ stopped: step limit (${maxSteps}) reached after tool calls — say "continue" to reset and resume]`;
  } finally {
    clearTimeout(timeout);
    if (opts.abortSignal) opts.abortSignal.removeEventListener("abort", onExternalAbort);
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
  const settled = await Promise.allSettled(modelIds.map(async (id) => [id, await runAgentFull(prompt, { modelId: id })] as const));
  const out: Record<string, string> = {};
  for (const s of settled) {
    if (s.status === "fulfilled") out[s.value[0]] = s.value[1];
    else out[modelIds[settled.indexOf(s)]] = `Error: ${s.reason?.message ?? String(s.reason)}`;
  }
  return out;
}

export { listModels };
