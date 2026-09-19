import React, { useEffect, useState, useRef } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { runAgent, testConnection } from "../core/agent.js";
import { loadConfig, saveConfig } from "../core/config.js";
import { countLOC, detectEnvs, formatDuration, estimateTokens } from "../utils/stats.js";
import { setEnvKey, maskKey } from "../utils/env.js";

export function App({ initialPrompt, initialModel }: { initialPrompt?: string; initialModel?: string }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [cfg, setCfg] = useState(() => loadConfig());
  const [modelId, setModelId] = useState(initialModel ?? cfg.defaultModel);
  const [input, setInput] = useState(initialPrompt ?? "");
  const [messages, setMessages] = useState<{ role: "user" | "assistant" | "system" | "error"; text: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(0);
  const [recv, setRecv] = useState(0);
  const [loc, setLoc] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [lastErr, setLastErr] = useState<string | null>(null);
  const [envs] = useState(() => detectEnvs());
  const startRef = useRef(Date.now());

  const reloadCfg = () => {
    const c = loadConfig();
    setCfg(c);
    return c;
  };

  useEffect(() => {
    countLOC().then(setLoc);
    const id = setInterval(() => setElapsed(Date.now() - startRef.current), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!stdout.isTTY) return;
    stdout.write("\x1b[?1049h\x1b[?25l");
    const restore = () => stdout.write("\x1b[?1049l\x1b[?25h");
    const onExit = () => restore();
    process.on("exit", onExit);
    return () => {
      process.off("exit", onExit);
      restore();
    };
  }, [stdout]);

  const cycleModel = (dir: 1 | -1) => {
    const idx = cfg.models.findIndex((m) => m.id === modelId);
    const next = cfg.models[(idx + dir + cfg.models.length) % cfg.models.length];
    setModelId(next.id);
  };

  const pushSystem = (text: string) => setMessages((m) => [...m, { role: "system", text }]);
  const pushError = (text: string) => {
    setLastErr(text);
    setMessages((m) => [...m, { role: "error", text }]);
  };

  const formatModels = (c = cfg) =>
    c.models
      .map((m) => {
        const key = m.apiKeyEnv ? process.env[m.apiKeyEnv] ?? "" : "";
        const hasKey = key ? maskKey(key) : "— no key";
        const active = m.id === modelId ? "●" : "○";
        const def = m.id === c.defaultModel ? " [default]" : "";
        return `${active} ${m.id.padEnd(16)} ${m.provider.padEnd(10)} ${m.model}  key:${hasKey} ${m.baseURL ?? ""}${def}`;
      })
      .join("\n");

  const handleCommand = async (raw: string): Promise<boolean> => {
    if (!raw.startsWith(":")) return false;
    const parts = raw.slice(1).trim().split(/\s+/);
    const c = parts[0]?.toLowerCase() ?? "";
    const args = parts.slice(1);
    if (["exit", "quit", "q", "x", "wq"].includes(c)) {
      exit();
      return true;
    }
    if (["compact", "clear", "compress"].includes(c)) {
      if (messages.length <= 2) pushSystem("Nothing to compact.");
      else {
        const keep = 2;
        const removed = messages.length - keep;
        setMessages((m) => [{ role: "system", text: `[COMPACT] Removed ${removed} messages.` }, ...m.slice(-keep)]);
        setSent(0);
        setRecv(0);
      }
      return true;
    }
    if (["models", "model", "providers"].includes(c)) {
      const sub = args[0]?.toLowerCase();
      const cur = reloadCfg();
      if (!sub) {
        pushSystem(`MODELS (${cur.models.length}):\n${formatModels(cur)}\n\n:models <id> — switch\n:models add <id> <provider> <model> [baseURL]\n:models rm <id>\n:models default <id>\n:models key <id> <API_KEY>\n:models test <id>\n:models set <id> <field> <value>`);
        return true;
      }
      if (sub === "test") {
        const id = args[1] ?? modelId;
        const m = cur.models.find((x) => x.id === id);
        if (!m) { pushSystem(`Not found: ${id}`); return true; }
        pushSystem(`Testing ${id} (${m.baseURL ?? m.provider})…`);
        const res = await testConnection(m);
        if (res.ok) pushSystem(`✓ ${id}: ${res.msg}`);
        else pushError(`✗ ${id}: ${res.msg}`);
        return true;
      }
      if (!["add", "rm", "remove", "del", "default", "key", "set", "test"].includes(sub) && cur.models.find((m) => m.id === sub)) {
        const found = cur.models.find((m) => m.id === sub)!;
        setModelId(found.id);
        pushSystem(`Switched to ${found.id} (${found.provider}/${found.model})`);
        return true;
      }
      if (sub === "add") {
        const [id, provider, model, baseURL] = args.slice(1);
        if (!id || !provider || !model) { pushSystem("Usage: :models add <id> <provider> <model> [baseURL]"); return true; }
        if (!["anthropic", "openai", "openrouter", "ollama"].includes(provider)) { pushSystem(`Invalid provider "${provider}"`); return true; }
        if (cur.models.find((m) => m.id === id)) { pushSystem(`Model "${id}" already exists`); return true; }
        const apiKeyEnv = provider === "anthropic" ? "ANTHROPIC_API_KEY" : provider === "openai" ? "OPENAI_API_KEY" : provider === "openrouter" ? "OPENROUTER_API_KEY" : undefined;
        cur.models.push({ id, provider: provider as any, model, apiKeyEnv, baseURL });
        saveConfig(cur); reloadCfg();
        pushSystem(`Added ${id}. Now: :models key ${id} <API_KEY>  and  :models test ${id}`);
        return true;
      }
      if (["rm", "remove", "del"].includes(sub)) {
        const id = args[1]; if (!id) { pushSystem("Usage: :models rm <id>"); return true; }
        const idx = cur.models.findIndex((m) => m.id === id);
        if (idx === -1) { pushSystem(`Not found: ${id}`); return true; }
        cur.models.splice(idx, 1);
        if (cur.defaultModel === id) cur.defaultModel = cur.models[0]?.id ?? "";
        if (modelId === id) setModelId(cur.defaultModel);
        saveConfig(cur); reloadCfg(); pushSystem(`Removed ${id}`); return true;
      }
      if (sub === "default") {
        const id = args[1];
        if (!id || !cur.models.find((m) => m.id === id)) { pushSystem(`Usage: :models default <id> — available: ${cur.models.map((m) => m.id).join(", ")}`); return true; }
        cur.defaultModel = id; saveConfig(cur); reloadCfg(); pushSystem(`Default set to ${id}`); return true;
      }
      if (sub === "key") {
        const id = args[1]; const key = args.slice(2).join(" ");
        if (!id || !key) { pushSystem("Usage: :models key <id> <API_KEY>"); return true; }
        const m = cur.models.find((x) => x.id === id);
        if (!m) { pushSystem(`Not found: ${id}`); return true; }
        const envKey = m.apiKeyEnv ?? `${id.toUpperCase().replace(/-/g, "_")}_API_KEY`;
        if (!m.apiKeyEnv) { m.apiKeyEnv = envKey; saveConfig(cur); }
        setEnvKey(envKey, key.trim()); reloadCfg();
        pushSystem(`Key saved for ${id} → ${envKey} (${maskKey(key)}) in .env — run :models test ${id}`);
        return true;
      }
      if (sub === "set") {
        const [id, field, ...rest] = args.slice(1);
        const value = rest.join(" ");
        if (!id || !field || !value) { pushSystem("Usage: :models set <id> <provider|model|baseURL|apiKeyEnv> <value>"); return true; }
        const m = cur.models.find((x) => x.id === id);
        if (!m) { pushSystem(`Not found: ${id}`); return true; }
        if (field === "provider" && !["anthropic", "openai", "openrouter", "ollama"].includes(value)) { pushSystem(`Invalid provider`); return true; }
        (m as any)[field] = value; saveConfig(cur); reloadCfg(); pushSystem(`Updated ${id} ${field}=${value}`); return true;
      }
      pushSystem(`Unknown subcommand "${sub}". Try :models`);
      return true;
    }
    if (["help", "h", "?"].includes(c)) {
      pushSystem(`Commands:\n:exit / :q — exit\n:compact — compact history\n:models — list\n:models test <id> — diagnose local model\n:models key <id> <KEY>\n:models add/rm/default/set`);
      return true;
    }
    pushSystem(`Unknown command ":${c}". Try :help`);
    return true;
  };

  useInput(async (char, key) => {
    if (key.escape || (key.ctrl && char === "c")) exit();
    if (key.tab) { cycleModel(key.shift ? -1 : 1); return; }
    if (key.return && !busy && input.trim()) {
      const prompt = input;
      setInput("");
      if (await handleCommand(prompt)) return;
      setMessages((m) => [...m, { role: "user", text: prompt }]);
      setBusy(true);
      setLastErr(null);
      setSent((s) => s + estimateTokens(prompt));
      let acc = "";
      setMessages((m) => [...m, { role: "assistant", text: "" }]);
      try {
        for await (const chunk of runAgent(prompt, { modelId, timeoutMs: 60000 }, (u) => {
          setSent((s) => s + u.inputTokens - estimateTokens(prompt));
          setRecv((r) => r + u.outputTokens);
        })) {
          acc += chunk;
          setMessages((m) => {
            const copy = [...m];
            copy[copy.length - 1] = { role: "assistant", text: acc };
            return copy;
          });
        }
        if (!acc) pushError(`[${modelId}] empty response — try :models test ${modelId} to diagnose`);
        else setRecv((r) => r + estimateTokens(acc));
      } catch (e: any) {
        const msg = e.message ?? String(e);
        pushError(msg);
        setMessages((m) => {
          const copy = [...m];
          if (copy[copy.length - 1]?.role === "assistant" && !copy[copy.length - 1].text) copy.pop();
          return copy;
        });
      } finally {
        countLOC().then(setLoc);
        setBusy(false);
      }
    } else if (key.backspace || key.delete) setInput((s) => s.slice(0, -1));
    else if (!key.ctrl && !key.meta && char) setInput((s) => s + char);
  });

  const active = cfg.models.find((m) => m.id === modelId)!;

  const isCmd = input.startsWith(":");

  return (
    <Box flexDirection="column" paddingX={1} width={stdout.columns} height={stdout.rows}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Box><Text bold color="cyan">tocoder</Text><Text dimColor> — :exit :compact :models | Tab model | Esc quit</Text></Box>
        <Box gap={1} flexWrap="wrap">
          {cfg.models.map((m) => (
            <Text key={m.id} color={m.id === modelId ? "green" : "gray"} bold={m.id === modelId}>{m.id === modelId ? "●" : "○"} {m.id}</Text>
          ))}
        </Box>
      </Box>

      <Box borderStyle="round" borderColor={lastErr ? "red" : "yellow"} marginTop={1} paddingX={1} flexDirection="column">
        <Text bold color={lastErr ? "red" : "yellow"}>● STATUS {lastErr ? "— ERROR" : ""}</Text>
        <Text><Text color="cyan">Model: </Text><Text bold>{active.id}</Text><Text dimColor> ({active.provider}/{active.model})</Text><Text>  │  </Text><Text color="green">↑ {sent}</Text><Text dimColor> sent</Text><Text> </Text><Text color="magenta">↓ {recv}</Text><Text dimColor> recv</Text></Text>
        <Text><Text color="cyan">LOC: </Text><Text>{loc === null ? "…" : loc.toLocaleString("pl-PL")}</Text><Text>  │  </Text><Text color="cyan">Czas: </Text><Text>{formatDuration(elapsed)}</Text><Text>  │  </Text><Text color="cyan">Env: </Text>{envs.map((e, i) => <Text key={e.label} color={e.ok ? "green" : "gray"}>{i ? " " : ""}{e.ok ? "✓" : "✗"}{e.label}</Text>)}</Text>
        {lastErr && <Text color="red">✗ {lastErr}</Text>}
      </Box>

      <Box borderStyle="round" borderColor="green" marginTop={1} paddingX={1} flexDirection="column" minHeight={8}>
        <Text bold color="green">● ODPOWIEDŹ MODELU {busy ? "(pisze… 60s timeout)" : ""}</Text>
        {messages.length === 0 && !busy && <Text dimColor> Brak wiadomości — wpisz polecenie lub :help  •  :models test {modelId} diagnozuje lokalny model</Text>}
        {messages.map((m, i) => (
          <Box key={i} flexDirection="column" marginTop={m.role === "user" ? 1 : 0}>
            <Text color={m.role === "user" ? "blue" : m.role === "system" ? "yellow" : m.role === "error" ? "red" : "white"} bold>{m.role === "user" ? "› TY:" : m.role === "system" ? "◆ SYS:" : m.role === "error" ? "✗ ERR:" : "● AI:"}</Text>
            <Text color={m.role === "error" ? "red" : m.role === "system" ? "yellow" : undefined}>{m.text || (busy && i === messages.length - 1 ? "…" : "")}</Text>
          </Box>
        ))}
      </Box>

      <Box borderStyle="round" borderColor={isCmd ? "yellow" : lastErr ? "red" : "magenta"} marginTop={1} paddingX={1}>
        <Text color={isCmd ? "yellow" : "magenta"} bold>{isCmd ? ":" : "›"} </Text>
        <Text color={busy ? "gray" : isCmd ? "yellow" : "yellow"}>{busy ? "(zajęty…)" : isCmd ? input.slice(1) : input}<Text backgroundColor={busy ? undefined : isCmd ? "yellow" : "white"} color={isCmd ? "black" : "white"}> </Text></Text>
      </Box>
      <Box><Text dimColor> :models test {modelId} → diagnoza lokalnego | :models key &lt;id&gt; &lt;key&gt;</Text></Box>
    </Box>
  );
}
