import { streamText } from "ai";
import { getModelFromConfig, resolveModel, listModels } from "./providers.js";
import { tools } from "../tools/index.js";
import type { ModelConfig } from "./config.js";

const SYSTEM = `You are tokoder, an AI coding agent like opencode/claude-code.
- Be concise, use tools to inspect and modify code.
- Prefer read -> edit/write loop, verify with bash.
- Use glob/grep to explore codebase.`;

export type AgentOpts = {
  modelId?: string;
  modelConfig?: ModelConfig;
  cwd?: string;
};

export type Usage = { inputTokens: number; outputTokens: number; totalTokens: number };

export async function* runAgent(prompt: string, opts: AgentOpts = {}, onUsage?: (u: Usage) => void) {
  const cfg = opts.modelConfig ?? resolveModel(opts.modelId);
  const mdl = getModelFromConfig(cfg);
  const result = streamText({
    model: mdl,
    system: SYSTEM,
    prompt,
    tools,
    maxSteps: 20,
  } as any);
  for await (const chunk of result.textStream) yield chunk;
  try {
    const usage: any = await (result as any).usage;
    if (usage && onUsage) onUsage({ inputTokens: usage.inputTokens ?? usage.promptTokens ?? 0, outputTokens: usage.outputTokens ?? usage.completionTokens ?? 0, totalTokens: usage.totalTokens ?? 0 });
  } catch {}
  try {
    const total: any = await (result as any).totalUsage;
    if (total && onUsage) onUsage({ inputTokens: total.inputTokens ?? total.promptTokens ?? 0, outputTokens: total.outputTokens ?? total.completionTokens ?? 0, totalTokens: total.totalTokens ?? 0 });
  } catch {}
}

export async function runAgentFull(prompt: string, opts: AgentOpts = {}) {
  let out = "";
  for await (const c of runAgent(prompt, opts)) out += c;
  return out;
}

export async function runParallel(prompt: string, modelIds: string[]): Promise<Record<string, string>> {
  const entries = await Promise.all(modelIds.map(async (id) => [id, await runAgentFull(prompt, { modelId: id })] as const));
  return Object.fromEntries(entries);
}

export { listModels };
