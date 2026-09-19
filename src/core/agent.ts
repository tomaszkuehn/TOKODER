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

export type Usage = { promptTokens: number; completionTokens: number; totalTokens: number };

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
    const usage = await result.usage;
    if (usage && onUsage) onUsage({ promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens });
  } catch {}
  try {
    const total = await (result as any).totalUsage;
    if (total && onUsage) onUsage({ promptTokens: total.promptTokens, completionTokens: total.completionTokens, totalTokens: total.totalTokens });
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
