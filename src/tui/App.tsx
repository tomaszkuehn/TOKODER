import React, { useEffect, useState, useRef } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { runAgent } from "../core/agent.js";
import { listModels } from "../core/providers.js";
import { countLOC, detectEnvs, formatDuration, estimateTokens } from "../utils/stats.js";

export function App({ initialPrompt, initialModel }: { initialPrompt?: string; initialModel?: string }) {
  const { exit } = useApp();
  const cfg = listModels();
  const [modelId, setModelId] = useState(initialModel ?? cfg.defaultModel);
  const [input, setInput] = useState(initialPrompt ?? "");
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; text: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(0);
  const [recv, setRecv] = useState(0);
  const [loc, setLoc] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [envs] = useState(() => detectEnvs());
  const startRef = useRef(Date.now());

  useEffect(() => {
    countLOC().then(setLoc);
    const id = setInterval(() => setElapsed(Date.now() - startRef.current), 1000);
    return () => clearInterval(id);
  }, []);

  const cycleModel = (dir: 1 | -1) => {
    const idx = cfg.models.findIndex((m) => m.id === modelId);
    const next = cfg.models[(idx + dir + cfg.models.length) % cfg.models.length];
    setModelId(next.id);
  };

  useInput(async (char, key) => {
    if (key.escape || (key.ctrl && char === "c")) exit();
    if (key.tab) {
      cycleModel(key.shift ? -1 : 1);
      return;
    }
    if (key.return && !busy && input.trim()) {
      const prompt = input;
      setInput("");
      setMessages((m) => [...m, { role: "user", text: prompt }]);
      setBusy(true);
      setSent((s) => s + estimateTokens(prompt));
      let acc = "";
      setMessages((m) => [...m, { role: "assistant", text: "" }]);
      for await (const chunk of runAgent(prompt, { modelId }, (u) => {
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
      if (acc) setRecv((r) => r + estimateTokens(acc));
      countLOC().then(setLoc);
      setBusy(false);
    } else if (key.backspace || key.delete) {
      setInput((s) => s.slice(0, -1));
    } else if (!key.ctrl && !key.meta && char) {
      setInput((s) => s + char);
    }
  });

  const active = cfg.models.find((m) => m.id === modelId)!;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Box>
          <Text bold color="cyan">tocoder</Text>
          <Text dimColor> — Esc wyjście | Enter wyślij | Tab zmiana modelu</Text>
        </Box>
        <Box gap={1} flexWrap="wrap">
          {cfg.models.map((m) => (
            <Text key={m.id} color={m.id === modelId ? "green" : "gray"} bold={m.id === modelId}>
              {m.id === modelId ? "●" : "○"} {m.id}
            </Text>
          ))}
        </Box>
      </Box>

      <Box borderStyle="round" borderColor="yellow" marginTop={1} paddingX={1} flexDirection="column">
        <Text bold color="yellow">● STATUS</Text>
        <Text>
          <Text color="cyan">Model: </Text><Text bold>{active.id}</Text><Text dimColor> ({active.provider}/{active.model})</Text>
          <Text>  │  </Text><Text color="green">↑ {sent}</Text><Text dimColor> sent</Text><Text> </Text><Text color="magenta">↓ {recv}</Text><Text dimColor> recv</Text>
        </Text>
        <Text>
          <Text color="cyan">LOC: </Text><Text>{loc === null ? "…" : loc.toLocaleString("pl-PL")}</Text>
          <Text>  │  </Text><Text color="cyan">Czas: </Text><Text>{formatDuration(elapsed)}</Text>
          <Text>  │  </Text><Text color="cyan">Env: </Text>
          {envs.map((e, i) => (
            <Text key={e.label} color={e.ok ? "green" : "gray"}>{i ? " " : ""}{e.ok ? "✓" : "✗"}{e.label}</Text>
          ))}
        </Text>
      </Box>

      <Box borderStyle="round" borderColor="green" marginTop={1} paddingX={1} flexDirection="column" minHeight={8}>
        <Text bold color="green">● ODPOWIEDŹ MODELU {busy ? "(pisze…)" : ""}</Text>
        {messages.length === 0 && !busy && <Text dimColor> Brak wiadomości — wpisz polecenie poniżej</Text>}
        {messages.map((m, i) => (
          <Box key={i} flexDirection="column" marginTop={m.role === "user" ? 1 : 0}>
            <Text color={m.role === "user" ? "blue" : "white"} bold>{m.role === "user" ? "› TY:" : "● AI:"}</Text>
            <Text>{m.text || (busy && i === messages.length - 1 ? "…" : "")}</Text>
          </Box>
        ))}
      </Box>

      <Box borderStyle="round" borderColor="magenta" marginTop={1} paddingX={1}>
        <Text color="magenta" bold>› </Text>
        <Text color={busy ? "gray" : "yellow"}>{busy ? "(zajęty…)" : input}<Text backgroundColor={busy ? undefined : "white"} color="white"> </Text></Text>
      </Box>
      <Box><Text dimColor> Tab = model │ Enter = wyślij │ Esc = wyjście │ {cfg.models.length} modeli</Text></Box>
    </Box>
  );
}
