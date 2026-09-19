#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import React from "react";
import { render } from "ink";
import { App } from "./tui/App.js";
import { runAgentFull, runParallel } from "./core/agent.js";
import { listModels, resolveModel } from "./core/providers.js";

const program = new Command();
program.name("tocoder").description("AI coding agent (Ink + AI SDK)").version("0.1.0");

program
  .command("models", { isDefault: false })
  .description("list configured models")
  .action(() => {
    const cfg = listModels();
    console.log(`default: ${cfg.defaultModel}\n`);
    for (const m of cfg.models) {
      const marker = m.id === cfg.defaultModel ? "*" : " ";
      console.log(`${marker} ${m.id.padEnd(16)} ${m.provider.padEnd(10)} ${m.model}  env:${m.apiKeyEnv ?? "-"} ${m.baseURL ?? ""}`);
    }
  });

program
  .argument("[prompt...]", "task for agent")
  .option("-m, --model <id>", "model id from tokoder.config.json")
  .option("--all", "run prompt on all configured models in parallel")
  .option("--compare", "alias for --all with labeled output")
  .option("--no-tui", "plain stdout, no Ink")
  .option("--timeout <seconds>", "agent timeout in seconds (default 300)", (v) => parseInt(v, 10))
  .action(async (promptParts: string[], opts) => {
    if (!promptParts.length) {
      const modelId = opts.model as string | undefined;
      if (modelId) resolveModel(modelId);
      const inst = render(React.createElement(App, { initialModel: modelId }), { exitOnCtrlC: false });
      await inst.waitUntilExit();
      return;
    }
    const prompt = promptParts.join(" ");
    if (opts.all || opts.compare) {
      const cfg = listModels();
      const ids = cfg.models.map((m) => m.id);
      const results = await runParallel(prompt, ids);
      for (const [id, out] of Object.entries(results)) {
        console.log(`\n===== [${id}] =====\n${out}\n`);
      }
      return;
    }
    const modelId = opts.model as string | undefined;
    if (opts.tui === false) {
      const out = await runAgentFull(prompt, { modelId, timeoutMs: (opts.timeout as number | undefined) ? (opts.timeout as number) * 1000 : undefined });
      console.log(out);
      return;
    }
    const inst = render(React.createElement(App, { initialPrompt: prompt, initialModel: modelId }), { exitOnCtrlC: false });
    await inst.waitUntilExit();
  });

program.parse();
