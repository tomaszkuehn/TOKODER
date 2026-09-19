import React, { useEffect, useState, useRef, useMemo } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { runAgent, testConnection, type ToolDecision, type AccessDecision } from "../core/agent.js";
import { loadConfig, saveConfig, normalizeCompact, compactLimit, globalConfigPath, localConfigPath, DEFAULT_CONTEXT_WINDOW } from "../core/config.js";
import { compactHistory, estimateHistoryTokens, COMPACT_MODES, type CompactMode } from "../core/compact.js";
import { countLOC, detectEnvs, formatDuration, estimateTokens } from "../utils/stats.js";
import { setEnvKey, maskKey } from "../utils/env.js";
import { logEntry } from "../utils/logger.js";
import { listOllamaModels, ollamaIdSuggestion } from "../utils/ollama.js";

export function App({ initialPrompt, initialModel }: { initialPrompt?: string; initialModel?: string }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [cfg, setCfg] = useState(() => loadConfig());
  const [modelId, setModelId] = useState(initialModel ?? cfg.defaultModel);
  const [input, setInput] = useState(initialPrompt ?? "");
  const [messages, setMessages] = useState<{ role: "user" | "assistant" | "system" | "error"; text: string }[]>([]);
  const historyRef = useRef<{ role: "user" | "assistant"; content: string }[]>([]);
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const draftRef = useRef("");
  const [busy, setBusy] = useState(false);
  const [pendingTool, setPendingTool] = useState<{ name: string; args: any } | null>(null);
  const [pendingAccess, setPendingAccess] = useState<{ tool: string; mode: string; target: string } | null>(null);
  const accessRef = useRef<((d: AccessDecision) => void) | null>(null);
  const [wizard, setWizard] = useState<null | {
    step: "kind" | "key" | "model" | "id" | "rm" | "rm-confirm";
    kind?: "local" | "cloud";
    models?: string[];
    model?: string;
    suggestedId?: string;
    rmId?: string;
  }>(null);
  const approvalRef = useRef<((d: ToolDecision) => void) | null>(null);
  const alwaysRef = useRef<Set<string>>(new Set());
  const [tokenStats, setTokenStats] = useState<Record<string, { sent: number; recv: number }>>({});
  const [loc, setLoc] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [lastErr, setLastErr] = useState<string | null>(null);
  const [envs] = useState(() => detectEnvs());
  const [scroll, setScroll] = useState(0);
  const startRef = useRef(Date.now());

  const bumpTokens = (id: string, s: number, r: number) =>
    setTokenStats((st) => {
      const cur = st[id] ?? { sent: 0, recv: 0 };
      return { ...st, [id]: { sent: cur.sent + s, recv: cur.recv + r } };
    });
  const active = cfg.models.find((m) => m.id === modelId)!;
  const compactCfg = normalizeCompact(cfg.compact);
  const usedModels = Object.keys(tokenStats);
  const curTok = tokenStats[modelId] ?? { sent: 0, recv: 0 };
  const totTok = usedModels.reduce((a, id) => ({ sent: a.sent + tokenStats[id].sent, recv: a.recv + tokenStats[id].recv }), { sent: 0, recv: 0 });

  const reloadCfg = () => {
    const c = loadConfig();
    setCfg(c);
    return c;
  };

  const cfgRef = useRef(cfg);
  useEffect(() => { cfgRef.current = cfg; }, [cfg]);
  useEffect(() => {
    const id = setInterval(() => {
      try {
        const c = loadConfig();
        if (JSON.stringify(c) !== JSON.stringify(cfgRef.current)) setCfg(c);
      } catch {}
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    countLOC().then(setLoc);
    const id = setInterval(() => setElapsed(Date.now() - startRef.current), 1000);
    return () => clearInterval(id);
  }, []);

  const altScreen = process.env.TOCODER_ALT_SCREEN !== "0";
  const transcriptRef = useRef<typeof messages>([] as any);
  useEffect(() => { transcriptRef.current = messages; }, [messages]);

  useEffect(() => {
    if (!stdout.isTTY || !altScreen) return;
    stdout.write("\x1b[?1049h\x1b[?25l");
    return () => {
      const msgs = transcriptRef.current;
      stdout.write("\x1b[?1049l\x1b[?25h");
      if (msgs.length) {
        const { writeSync } = require("node:fs");
        try {
          let out = "\n— tocoder transcript —\n";
          for (const m of msgs) {
            const tag = m.role === "user" ? "› YOU:" : m.role === "error" ? "✗ ERR:" : m.role === "system" ? "◆ SYS:" : "● AI:";
            out += `${tag} ${m.text}\n`;
          }
          out += "\n";
          writeSync(1, out);
        } catch {
          stdout.write("\n— tocoder transcript —\n");
          for (const m of msgs) {
            const tag = m.role === "user" ? "› YOU:" : m.role === "error" ? "✗ ERR:" : m.role === "system" ? "◆ SYS:" : "● AI:";
            stdout.write(`${tag} ${m.text}\n`);
          }
        }
      }
    };
  }, [stdout, altScreen]);

  useEffect(() => { setScroll(0); }, [messages.length]);

  const cols = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;
  const headerH = 3;
  const statusH = lastErr ? 5 : 4;
  const inputH = 3;
  const chromeH = headerH + statusH + inputH + 5;
  const outputH = Math.max(6, rows - chromeH);
  const innerW = Math.max(20, cols - 6);
  const viewportH = Math.max(1, outputH - 3); // borders(2) + title(1)

  const roleLabel = (r: string) => (r === "user" ? "› YOU:" : r === "system" ? "◆ SYS:" : r === "error" ? "✗ ERR:" : "● AI:");

  // flat line model: label line + wrapped text lines per message
  const flatLines = useMemo(() => {
    const arr: { role: "user" | "assistant" | "system" | "error"; text: string; isLabel: boolean }[] = [];
    messages.forEach((m, i) => {
      if (m.role === "user" && arr.length) arr.push({ role: m.role, text: "", isLabel: false });
      arr.push({ role: m.role, text: roleLabel(m.role), isLabel: true });
      const src = m.text || (busy && i === messages.length - 1 ? "…" : "");
      if (!src) { arr.push({ role: m.role, text: "", isLabel: false }); return; }
      for (const ln of src.split("\n")) {
        if (!ln) { arr.push({ role: m.role, text: "", isLabel: false }); continue; }
        for (let j = 0; j < ln.length; j += innerW) arr.push({ role: m.role, text: ln.slice(j, j + innerW), isLabel: false });
      }
    });
    return arr;
  }, [messages, innerW, busy]);

  const maxScroll = Math.max(0, flatLines.length - viewportH);
  const startIdx = Math.max(0, flatLines.length - viewportH - Math.min(scroll, maxScroll));
  const visibleLines = flatLines.slice(startIdx, startIdx + viewportH);

  const scrollChars = useMemo(() => {
    const track: { ch: string; thumb: boolean }[] = [];
    if (flatLines.length <= viewportH) return track;
    const thumbSize = Math.max(1, Math.floor((viewportH * viewportH) / flatLines.length));
    const thumbPos = Math.round((startIdx / Math.max(1, maxScroll)) * (viewportH - thumbSize));
    for (let r = 0; r < viewportH; r++) {
      const thumb = r >= thumbPos && r < thumbPos + thumbSize;
      track.push({ ch: thumb ? "█" : "│", thumb });
    }
    return track;
  }, [flatLines.length, viewportH, startIdx, maxScroll]);

  const moreAbove = maxScroll > 0 && scroll < maxScroll;
  const moreBelow = scroll > 0;

  const cycleModel = (dir: 1 | -1) => {
    const idx = cfg.models.findIndex((m) => m.id === modelId);
    const next = cfg.models[(idx + dir + cfg.models.length) % cfg.models.length];
    setModelId(next.id);
  };

  const COMMANDS = ["exit", "quit", "q", "compact", "compact-mode", "compact-auto", "agents", "init", "clear", "models", "key", "help", "allow", "deny"] as const;
  const MODEL_SUBS = ["add", "rm", "default", "key", "test", "set"] as const;

  const getSuggestion = (raw: string): string | null => {
    if (!raw.startsWith(":")) return null;
    const after = raw.slice(1);
    if (!after) return null;
    const parts = after.split(/\s+/);
    if (parts.length === 1) {
      const p = parts[0].toLowerCase();
      if ((COMMANDS as readonly string[]).includes(p)) return null;
      const hits = (COMMANDS as readonly string[]).filter((c) => c.startsWith(p));
      if (hits.length === 1) return hits[0].slice(p.length);
      return null;
    }
    if (parts[0].toLowerCase() === "models" && parts.length === 2) {
      const p = parts[1].toLowerCase();
      if ((MODEL_SUBS as readonly string[]).includes(p)) return null;
      const hits = (MODEL_SUBS as readonly string[]).filter((c) => c.startsWith(p));
      if (hits.length === 1) return hits[0].slice(p.length);
    }
    return null;
  };

  const completeInput = (raw: string): string => {
    if (!raw.startsWith(":")) return raw;
    const after = raw.slice(1);
    const parts = after.split(/\s+/);
    if (parts.length === 1) {
      const p = parts[0].toLowerCase();
      const hits = (COMMANDS as readonly string[]).filter((c) => c.startsWith(p));
      if (hits.length === 1) return ":" + hits[0];
      if (hits.length > 1 && hits.includes(p)) return raw;
    }
    if (parts[0].toLowerCase() === "models" && parts.length === 2) {
      const p = parts[1].toLowerCase();
      const hits = (MODEL_SUBS as readonly string[]).filter((c) => c.startsWith(p));
      if (hits.length === 1) return `:models ${hits[0]}`;
    }
    return raw;
  };

  const pushSystem = (text: string) => setMessages((m) => [...m, { role: "system", text }]);
  const pushError = (text: string) => {
    setLastErr(text);
    setMessages((m) => [...m, { role: "error", text }]);
  };

  const runCompact = async (instruction?: string) => {
    const hist = historyRef.current;
    if (hist.length <= 2) { pushSystem("Nothing to compact."); return; }
    const cc = normalizeCompact(cfgRef.current.compact);
    const mc = cfgRef.current.models.find((m) => m.id === modelId);
    if (!mc) { pushError(`Model "${modelId}" not found`); return; }
    pushSystem(`⏳ Compacting (${cc.mode}${instruction ? `, instruction: "${instruction}"` : ""})…`);
    setBusy(true);
    try {
      const res = await compactHistory({
        history: hist,
        mode: cc.mode,
        modelConfig: mc,
        instruction,
        onUsage: (u) => bumpTokens(modelId, u.inputTokens, u.outputTokens),
      });
      historyRef.current = [
        { role: "user" as const, content: `[CONTEXT SUMMARY after compact — ${res.removed} older messages removed. Honor this summary when continuing.]\n${res.summary}` },
        { role: "assistant" as const, content: "Understood. Continuing with the summarized context." },
        ...res.kept,
      ];
      pushSystem(`✓ Compact (${res.mode}): -${res.removed} messages, context ≈${estimateHistoryTokens(historyRef.current)} tok${res.instruction ? ", instruction applied" : ""}`);
    } catch (e: any) {
      pushError(`Compact failed: ${e.message ?? String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const formatModels = (c = cfg) =>
    c.models
      .map((m) => {
        const key = m.apiKeyEnv ? process.env[m.apiKeyEnv] ?? "" : "";
        const hasKey = key ? maskKey(key) : "— no key";
        const active = m.id === modelId ? "●" : "○";
        const def = m.id === c.defaultModel ? " [default]" : "";
        const src = m.source === "local" ? " [local]" : " [global]";
        return `${active} ${m.id.padEnd(16)} ${m.provider.padEnd(10)} ${m.model}  key:${hasKey} ${m.baseURL ?? ""}${src}${def}`;
      })
      .join("\n") + `\n\nGlobal: ${globalConfigPath()}\nLocal: ${localConfigPath() ?? "— none in project"} (local overrides global by model id)`;

  const handleCommand = async (raw: string): Promise<boolean> => {
    if (!raw.startsWith(":")) return false;
    const parts = raw.slice(1).trim().split(/\s+/);
    const c = parts[0]?.toLowerCase() ?? "";
    const args = parts.slice(1);
    if (["exit", "quit", "q", "x", "wq"].includes(c)) { exit(); return true; }
    if (["allow", "permit"].includes(c)) {
      const p = args[0];
      const mode = (["read", "write", "execute"].includes(args[1]) ? args[1] : "write") as any;
      if (!p) { const { listAllowed, getProjectRoot, rulesPath } = await import("../utils/permissions.js"); pushSystem(`Allowed outside: ${(listAllowed().join(", ") || "— none")}\nProject: ${getProjectRoot()}\nRules: ${rulesPath()}\nUsage: :allow <path> [read|write|execute]`); return true; }
      const { allowPath } = await import("../utils/permissions.js"); const abs = allowPath(p, mode); pushSystem(`Allowed (${mode}): ${abs}`); return true;
    }
    if (["deny", "forbid", "revoke"].includes(c)) {
      const p = args.join(" ").trim();
      if (!p) { pushSystem("Usage: :deny <path>"); return true; }
      const { denyPath } = await import("../utils/permissions.js"); const ok = denyPath(p); pushSystem(ok ? `Revoked: ${p}` : `Not in allowlist: ${p}`); return true;
    }
    if (c === "compact-mode" || c === "compactmode") {
      const cur = reloadCfg();
      const cc = normalizeCompact(cur.compact);
      const m = args[0]?.toLowerCase();
      if (!m) {
        pushSystem(`Compact mode: ${cc.mode} | auto: ${cc.autoTrigger ? `${cc.thresholdPercent}%` + (cc.maxTokens > 0 ? `/max ${cc.maxTokens} tok` : "") : "off"}\n  reduce  — hard-trim history, 0 tokens, instant\n  balance — LLM summary + last 4 turns verbatim (default)\n  value   — structured extraction: GOAL/DECISIONS/FACTS/FILES/THREADS/STEPS + 8 turns\nChange: :compact-mode <reduce|balance|value>`);
        return true;
      }
      const mapped = ({ redukcja: "reduce", balans: "balance", wartosc: "value" } as Record<string, string>)[m] ?? m;
      if (!COMPACT_MODES.includes(mapped as CompactMode)) { pushSystem(`Unknown mode "${m}". Available: ${COMPACT_MODES.join(", ")}`); return true; }
      cur.compact = { ...cc, mode: mapped as CompactMode };
      saveConfig(cur); reloadCfg();
      pushSystem(`✓ Compact mode: ${mapped} (saved to ${localConfigPath() ?? globalConfigPath()})`);
      return true;
    }
    if (c === "compact-auto" || c === "compactauto") {
      const cur = reloadCfg();
      const cc = normalizeCompact(cur.compact);
      const a = args[0]?.toLowerCase();
      if (!a) {
        const ctx = active.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
        const { limit, reason } = compactLimit(cc, ctx);
        const parts = [`${cc.thresholdPercent}% of ${ctx} = ${Math.round((ctx * cc.thresholdPercent) / 100)} tok`];
        if (cc.maxTokens > 0) parts.push(`max ${cc.maxTokens.toLocaleString("en-US")} tok (binding: ${reason})`);
        pushSystem(`Auto-compact: ${cc.autoTrigger ? `ON — fires at whichever comes first:\n  ${parts.join("\n  ")}` : "OFF"}\nEffective limit: ${limit.toLocaleString("en-US")} tok\nChange: :compact-auto <on|off|percent 10-100|tokens <n>>`);
        return true;
      }
      if (["on", "tak", "yes"].includes(a)) cur.compact = { ...cc, autoTrigger: true };
      else if (["off", "nie", "no"].includes(a)) cur.compact = { ...cc, autoTrigger: false };
      else if (a === "tokens") {
        const n = parseInt(args[1] ?? "", 10);
        if (!n || n < 1000) { pushSystem("Token limit: >= 1000 (0 disables). Usage: :compact-auto tokens <n>"); return true; }
        cur.compact = { ...cc, autoTrigger: true, maxTokens: n };
      } else if (/^\d+$/.test(a)) {
        const p = parseInt(a, 10);
        if (p < 10 || p > 100) { pushSystem("Percent: 10-100."); return true; }
        cur.compact = { ...cc, autoTrigger: true, thresholdPercent: p };
      } else { pushSystem("Usage: :compact-auto <on|off|percent|tokens <n>>"); return true; }
      saveConfig(cur); reloadCfg();
      const nc = normalizeCompact(reloadCfg().compact);
      const ctx2 = active.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      const lim = compactLimit(nc, ctx2);
      pushSystem(`✓ Auto-compact: ${nc.autoTrigger ? `ON @ ${nc.thresholdPercent}%` + (nc.maxTokens > 0 ? ` / max ${nc.maxTokens.toLocaleString("en-US")} tok` : "") + ` → effective ${lim.limit.toLocaleString("en-US")} tok (${lim.reason})` : "OFF"} (saved to ${localConfigPath() ?? globalConfigPath()})`);
      return true;
    }
    if (["compact", "clear", "compress"].includes(c)) {
      await runCompact(args.join(" ").trim() || undefined);
      return true;
    }
    if (["models", "model", "providers"].includes(c)) {
      const sub = args[0]?.toLowerCase();
      const cur = reloadCfg();
      if (!sub) { pushSystem(`MODELS (${cur.models.length}):\n${formatModels(cur)}\n\n:models <id> — switch\n:models add <id> <provider> <model> [baseURL]\n:models rm <id>\n:models default <id>\n:models key <id> <API_KEY>\n:models test <id>\n:models set <id> <field> <value>\n:models save <global|local> — copy merged config`); return true; }
      if (sub === "test") {
        const id = args[1] ?? modelId;
        const m = cur.models.find((x) => x.id === id);
        if (!m) { pushSystem(`Not found: ${id}`); return true; }
        pushSystem(`Testing ${id} (${m.baseURL ?? m.provider})…`);
        const res = await testConnection(m);
        if (res.ok) pushSystem(`✓ ${id}: ${res.msg}`); else pushError(`✗ ${id}: ${res.msg}`);
        return true;
      }
      if (!["add", "rm", "remove", "del", "default", "key", "set", "test"].includes(sub) && cur.models.find((m) => m.id === sub)) {
        const found = cur.models.find((m) => m.id === sub)!;
        setModelId(found.id); pushSystem(`Switched to ${found.id} (${found.provider}/${found.model})`); return true;
      }
      if (sub === "add") {
        const [id, provider, model, baseURL] = args.slice(1);
        if (!id && !provider) { setWizard({ step: "kind" }); pushSystem("ADD MODEL — wizard. Pick kind:"); return true; }
        if (!id || !provider || !model) { pushSystem("Usage: :models add <id> <provider> <model> [baseURL]  |  :models add — kreator interaktywny"); return true; }
        if (!["anthropic", "openai", "openrouter", "ollama"].includes(provider)) { pushSystem(`Invalid provider "${provider}"`); return true; }
        if (cur.models.find((m) => m.id === id)) { pushSystem(`Model "${id}" already exists`); return true; }
        const apiKeyEnv = provider === "anthropic" ? "ANTHROPIC_API_KEY" : provider === "openai" ? "OPENAI_API_KEY" : provider === "openrouter" ? "OPENROUTER_API_KEY" : undefined;
        cur.models.push({ id, provider: provider as any, model, apiKeyEnv, baseURL });
        const savedTo = saveConfig(cur); reloadCfg(); pushSystem(`Added ${id} (saved to ${savedTo}). Now: :models key ${id} <API_KEY>  and  :models test ${id}`); return true;
      }
      if (["rm", "remove", "del"].includes(sub)) {
        const id = args[1];
        if (!id) { setWizard({ step: "rm", rmId: undefined, models: cur.models.map((m) => m.id) }); pushSystem(`REMOVE MODEL — which id?\n${cur.models.map((m, i) => `${String(i + 1).padStart(2)}. ${m.id} (${m.provider}/${m.model})`).join("\n")}\n\nType a number or id.`); return true; }
        if (!cur.models.find((m) => m.id === id)) { pushSystem(`Not found: ${id}`); return true; }
        setWizard({ step: "rm", rmId: id });
        pushSystem(`Delete model "${id}"? [Y]es / [N]o`); return true;
      }
      if (sub === "default") {
        const id = args[1];
        if (!id || !cur.models.find((m) => m.id === id)) { pushSystem(`Usage: :models default <id> — available: ${cur.models.map((m) => m.id).join(", ")}`); return true; }
        cur.defaultModel = id; saveConfig(cur); reloadCfg(); pushSystem(`Default set to ${id} (saved to ${saveConfig(reloadCfg())})`); return true;
      }
      if (sub === "key") {
        const id = args[1]; const key = args.slice(2).join(" ");
        if (!id || !key) { pushSystem("Usage: :models key <id> <API_KEY>"); return true; }
        const m = cur.models.find((x) => x.id === id);
        if (!m) { pushSystem(`Not found: ${id}`); return true; }
        const envKey = m.apiKeyEnv ?? `${id.toUpperCase().replace(/-/g, "_")}_API_KEY`;
        if (!m.apiKeyEnv) { m.apiKeyEnv = envKey; saveConfig(cur); }
        setEnvKey(envKey, key.trim()); reloadCfg(); pushSystem(`Key saved for ${id} → ${envKey} (${maskKey(key)}) in .env — run :models test ${id}`); return true;
      }
      if (sub === "save") {
        const scope = args[1]?.toLowerCase() === "global" ? "global" : args[1]?.toLowerCase() === "local" ? "local" : undefined;
        if (!scope) { pushSystem("Usage: :models save <global|local> — copies the current merged config"); return true; }
        const savedTo = saveConfig(reloadCfg(), process.cwd(), scope);
        pushSystem(`✓ Config saved (${scope}): ${savedTo}`);
        return true;
      }
      if (sub === "set") {
        const [id, field, ...rest] = args.slice(1);
        const value = rest.join(" ");
        if (!id || !field || !value) { pushSystem("Usage: :models set <id> <provider|model|baseURL|apiKeyEnv|contextWindow> <value>"); return true; }
        const m = cur.models.find((x) => x.id === id);
        if (!m) { pushSystem(`Not found: ${id}`); return true; }
        if (field === "provider" && !["anthropic", "openai", "openrouter", "ollama"].includes(value)) { pushSystem(`Invalid provider`); return true; }
        (m as any)[field] = value; const savedTo = saveConfig(cur); reloadCfg(); pushSystem(`Updated ${id} ${field}=${value} (saved to ${savedTo})`); return true;
      }
      pushSystem(`Unknown subcommand "${sub}". Try :models`); return true;
    }
    if (["key", "apikey"].includes(c)) { setWizard({ step: "key" }); return true; }
    if (["acl", "access"].includes(c)) {
      const { loadRules, listAllowed, rulesPath } = await import("../utils/permissions.js");
      const r = loadRules();
      pushSystem(`ACCESS RULES (outside project) — ${rulesPath()}\nGlobal: read=${r.read ? "YES" : "NO"}, write=${r.write ? "YES" : "NO"}, execute=${r.execute ? "YES" : "NO"}\n\nPer-path rules:\n${listAllowed().join("\n") || "— none —"}\n\nChange: :acl set <read|write|execute> <yes|no>\nAdd: :allow <path> [read|write|execute]  •  Remove: :deny <path>`);
      return true;
    }
    if (c === "aclset") {
      const [field, val] = args;
      if (!field || !val || !["read", "write", "execute"].includes(field) || !["tak", "nie", "yes", "no"].includes(val.toLowerCase())) { pushSystem("Usage: :acl set <read|write|execute> <yes|no>"); return true; }
      const mod = await import("../utils/permissions.js");
      const r = mod.loadRules();
      (r as any)[field] = ["tak", "yes"].includes(val.toLowerCase());
      mod.saveRules();
      pushSystem(`✓ ${field} = ${(r as any)[field] ? "YES" : "NO"} (persisted across sessions)`);
      return true;
    }
    if (["agents", "instructions", "instr"].includes(c)) {
      const mod = await import("../core/instructions.js");
      const { readInstructions, instructionsPath, appendInstruction, removeInstructionLine, initInstructions, INSTRUCTIONS_FILE } = mod;
      const p = instructionsPath();
      const sub = args[0]?.toLowerCase();
      if (sub === "init") {
        const r = initInstructions();
        const tok = estimateTokens(readInstructions() ?? "");
        pushSystem(r.created ? `✓ Created ${r.path} with default content (≈${tok} tok sent with every prompt)` : `${INSTRUCTIONS_FILE} already exists: ${r.path}\nEdit: :agents edit | :agents add <text> | :agents rm <n>`);
        return true;
      }
      if (sub === "add") {
        const text = args.slice(1).join(" ").trim();
        if (!text) { pushSystem("Usage: :agents add <text>"); return true; }
        appendInstruction(text);
        pushSystem(`✓ Appended to ${INSTRUCTIONS_FILE}: "${text}"`);
        return true;
      }
      if (sub === "rm") {
        const n = parseInt(args[1] ?? "", 10);
        if (!n) { pushSystem("Usage: :agents rm <line-number> (numbers shown in :agents)"); return true; }
        const removed = removeInstructionLine(n);
        pushSystem(removed === null ? `No line ${n} in ${INSTRUCTIONS_FILE}` : `✓ Removed line ${n}: ${removed.trim().slice(0, 80) || "(empty)"}`);
        return true;
      }
      if (sub === "edit") {
        if (readInstructions() === null) { pushSystem(`${INSTRUCTIONS_FILE} does not exist. Run :agents init first.`); return true; }
        const editor = process.env.EDITOR ?? "notepad";
        pushSystem(`Opening ${p} in ${editor}… (applies from the next prompt)`);
        try {
          const { spawnSync } = await import("node:child_process");
          const r = spawnSync(editor, [p], { stdio: "inherit", shell: process.platform === "win32" });
          pushSystem(r.status === 0 ? `✓ ${INSTRUCTIONS_FILE} saved — applies from the next prompt` : `${editor} exited with code ${r.status}`);
        } catch (e: any) {
          pushError(`Editor failed: ${e.message}. Set EDITOR env or edit ${p} manually.`);
        }
        return true;
      }
      const content = readInstructions();
      if (content === null) {
        pushSystem(`${INSTRUCTIONS_FILE} not found in project (${p}).\nSent with EVERY prompt — saves output tokens, informs the model about tools.\nCreate: :agents init  •  Edit: :agents edit  •  Append: :agents add <text>  •  Remove: :agents rm <n>`);
        return true;
      }
      const numbered = content.split("\n").map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join("\n");
      pushSystem(`${INSTRUCTIONS_FILE} (${p}) — ≈${estimateTokens(content)} tok sent with every prompt:\n${numbered}\n\nEdit: :agents edit (EDITOR, default notepad)  •  Add: :agents add <text>  •  Remove: :agents rm <n>`);
      return true;
    }
    if (c === "init") {
      const { initInstructions, readInstructions } = await import("../core/instructions.js");
      const r = initInstructions();
      const tok = estimateTokens(readInstructions() ?? "");
      pushSystem(r.created ? `✓ Created ${r.path} with default content (≈${tok} tok sent with every prompt)` : `${r.path} already exists — see :agents`);
      return true;
    }
    if (["help", "h", "?"].includes(c)) { pushSystem(`Commands:\n:exit / :q — exit\n:compact [instruction] — compact history (mode: :compact-mode)\n  examples: :compact keep the implementation plan\n             :compact focus on decisions and file paths\n             :compact keep open threads and next steps\n:compact-mode <reduce|balance|value> — compact strategy\n:compact-auto <on|off|percent|tokens <n>> — auto-trigger: % of context window OR absolute token limit, whichever comes first\n:agents — project instructions file (AGENTS.md), sent with every prompt\n  :agents init | edit | add <text> | rm <line>\n:init — create AGENTS.md with defaults\n:key — set Ollama Cloud API key\n:models — list | :models add/rm — wizards | :models test <id>\n  :models set <id> contextWindow <tok> — window for auto-compact\n:allow <path> / :deny <path> — sandbox\nPgUp/PgDn scroll`); return true; }
    pushSystem(`Unknown command ":${c}". Try :help`); return true;
  };

  const suggestFreeId = (model: string, models: { id: string }[]): string => {
    const base = ollamaIdSuggestion(model);
    if (!models.find((m) => m.id === base)) return base;
    let n = 2;
    while (models.find((m) => m.id === `${base}-${n}`)) n++;
    return `${base}-${n}`;
  };

  const wizardPrompt = (w: NonNullable<typeof wizard>): string => {
    if (w.step === "kind") return "ADD MODEL — 1: local Ollama (localhost:11434), 2: Ollama Cloud (ollama.com)";
    if (w.step === "key") {
      const has = process.env.OLLAMA_API_KEY;
      return `API KEY for Ollama Cloud${has ? ` (have ${maskKey(has)} — type a new one to replace, Enter = keep)` : " (paste key from ollama.com/settings/keys)"}`;
    }
    if (w.step === "model") return `Pick a model — number from the list or type the name (${w.models?.length ?? 0} found, "n" = custom name)`;
    if (w.step === "rm") return w.rmId === undefined ? "Type a number or model id to remove" : `Confirm removal of "${w.rmId}" — y/n`;
    return `ID for ${w.model} (Enter = "${w.suggestedId}")`;
  };

  const handleWizard = async (value: string) => {
    const w = wizard!;
    const v = value.trim();
    if (v === ":q" || v === ":exit") { setWizard(null); pushSystem("Wizard aborted."); return; }
    if (w.step === "kind") {
      if (v !== "1" && v !== "2") { pushSystem("Type 1 (local) or 2 (cloud)."); return; }
      const kind = v === "1" ? "local" as const : "cloud" as const;
      if (kind === "cloud" && !process.env.OLLAMA_API_KEY) { setWizard(null); pushError("Ollama Cloud requires an API key. Run :key first (or :models key <id> <KEY>), then :models add."); return; }
      setWizard({ ...w, step: "model", kind, models: [] });
      try {
        const models = (await listOllamaModels(kind)).map((m) => m.name);
        setWizard({ step: "model", kind, models });
        pushSystem(`Ollama ${kind === "local" ? "local" : "cloud"} — available models:\n${models.map((m, i) => `${String(i + 1).padStart(2)}. ${m}`).join("\n")}\n\nType a number, model name, or "n" (custom).`);
      } catch (e: any) {
        setWizard(null);
        pushError(`Failed to fetch list (${kind === "local" ? "is `ollama serve` running?" : e.message})`);
      }
      return;
    }
    if (w.step === "key") {
      if (!v || v.startsWith(":")) { pushSystem("Provide a key (cancel: :q)."); return; }
      setEnvKey("OLLAMA_API_KEY", v);
      setWizard(null);
      pushSystem(`✓ Key saved to .env → OLLAMA_API_KEY (${maskKey(v)}). Now :models add → 2 (Ollama Cloud).`);
      return;
    }
    if (w.step === "model") {
      let model: string | undefined;
      if (/^\d+$/.test(v)) model = w.models?.[parseInt(v, 10) - 1];
      else if (v.toLowerCase() === "n") { pushSystem('Type the full model name (e.g. "qwen3-coder:480b").'); return; }
      else model = v;
      if (!model) { pushSystem(`No such number (1-${w.models?.length ?? 0}).`); return; }
      setWizard({ ...w, step: "id", model, suggestedId: suggestFreeId(model, cfg.models) });
      return;
    }
    if (w.step === "rm") {
      if (w.rmId === undefined) {
        let id: string | undefined;
        if (/^\d+$/.test(v)) id = w.models?.[parseInt(v, 10) - 1];
        else id = v;
        if (!id || !w.models?.includes(id)) { pushSystem(`No such model (1-${w.models?.length ?? 0} or id name).`); return; }
        setWizard({ ...w, rmId: id });
        pushSystem(`Delete model "${id}"? [Y]es / [N]o`);
        return;
      }
      if (v.toLowerCase() === "t" || v.toLowerCase() === "y") { /* fallthrough do usuwania */ }
      else if (v.toLowerCase() === "n") { setWizard(null); pushSystem("Cancelled."); return; }
      else { pushSystem('Type "y" (delete) or "n" (cancel).'); return; }
      const cur = reloadCfg();
      const idx = cur.models.findIndex((m) => m.id === w.rmId);
      if (idx === -1) { setWizard(null); pushSystem(`Not found: ${w.rmId}`); return; }
      const removed = cur.models.splice(idx, 1)[0];
      if (cur.defaultModel === removed.id) cur.defaultModel = cur.models[0]?.id ?? "";
      const savedTo = saveConfig(cur); reloadCfg();
      if (modelId === removed.id) setModelId(cur.defaultModel);
      setWizard(null);
      pushSystem(`✓ Removed ${removed.id} (${removed.provider}/${removed.model}) (saved to ${savedTo})${cur.defaultModel ? `\nDefault: ${cur.defaultModel}` : "\n⚠ No models left in config!"}`);
      return;
    }
    if (w.step === "id") {
      const id = v || w.suggestedId || ollamaIdSuggestion(w.model ?? "");
      const cur = reloadCfg();
      if (cur.models.find((m) => m.id === id)) { pushSystem(`ID "${id}" already exists — choose another.`); return; }
      const isCloud = w.kind === "cloud";
      cur.models.push({
        id,
        provider: "ollama",
        model: w.model!,
        ...(isCloud ? { apiKeyEnv: "OLLAMA_API_KEY", baseURL: "https://ollama.com/v1" } : {}),
      });
      const savedTo = saveConfig(cur); reloadCfg();
      setWizard(null);
      pushSystem(
        `✓ Added ${id} → ${w.model} (saved to ${savedTo})${isCloud ? " (Ollama Cloud, https://ollama.com/v1)" : " (local)"}\n${isCloud && !process.env.OLLAMA_API_KEY ? `⚠ Set the key: :models key ${id} <OLLAMA_API_KEY> (from ollama.com/settings/keys)\n` : ""}Now: :models test ${id}${isCloud ? "" : "\nIf the model is not pulled yet: ollama pull " + w.model}`
      );
      return;
    }
  };

  useInput(async (char, key) => {
    if (accessRef.current) {
      const c = char?.toLowerCase();
      if (c === "p") { const r = accessRef.current; accessRef.current = null; setPendingAccess(null); r("allow-file"); }
      else if (c === "f") { const r = accessRef.current; accessRef.current = null; setPendingAccess(null); r("allow-dir"); }
      else if (c === "n" || key.escape) { const r = accessRef.current; accessRef.current = null; setPendingAccess(null); r("deny"); }
      return;
    }
    if (approvalRef.current) {
      const c = char?.toLowerCase();
      if (c === "t" || c === "y" || key.return) { const r = approvalRef.current; approvalRef.current = null; setPendingTool(null); r("yes"); }
      else if (c === "n" || key.escape) { const r = approvalRef.current; approvalRef.current = null; setPendingTool(null); r("no"); }
      else if (c === "a") { const r = approvalRef.current; approvalRef.current = null; setPendingTool(null); if (pendingTool) alwaysRef.current.add(pendingTool.name); r("always"); }
      return;
    }
    if (key.pageUp) { setScroll((s) => Math.min(maxScroll, s + 5)); return; }
    if (key.pageDown) { setScroll((s) => Math.max(0, s - 5)); return; }
    if (key.escape) { setWizard(null); setHistIdx(-1); pushSystem("Cancelled (Esc — exit only via :exit)."); return; }
    if (key.ctrl && char === "c") exit();
    if (key.tab) {
      const sug = getSuggestion(input);
      if (input.startsWith(":") && sug) { setInput((s) => s + sug); return; }
      cycleModel(key.shift ? -1 : 1); return;
    }
    if (key.return && wizard && input.trim()) { const v = input; setInput(""); handleWizard(v); return; }
    if (key.return && !busy && input.trim()) {
      let prompt = input; setInput(""); setHistIdx(-1); draftRef.current = "";
      if (prompt.startsWith(":")) {
        const completed = completeInput(prompt);
        if (completed !== prompt) prompt = completed;
      }
      const wasCmd = prompt.startsWith(":");
      if (await handleCommand(prompt)) { setCmdHistory((h) => [...h, prompt].slice(-100)); return; }
      setCmdHistory((h) => [...h, prompt].slice(-100));
      const isChoice = /^\s*[1-9]\s*$/.test(prompt) && historyRef.current.length > 0;
      let effectivePrompt = prompt;
      if (isChoice) {
        const n = prompt.trim();
        const lastAi = [...messages].reverse().find((m) => m.role === "assistant");
        const opt = lastAi?.text.match(new RegExp(`^\\s*${n}[.)\\-]\\s*(.+)$`, "m"));
        effectivePrompt = opt ? `My choice is option ${n}: "${opt[1].trim()}". Continue.` : `My choice is option ${n} from your last list. Continue.`;
        logEntry("USER-CHOICE", modelId, JSON.stringify({ raw: prompt, expanded: effectivePrompt, quotedFrom: opt?.[1]?.trim() ?? null }, null, 2));
      }
      setMessages((m) => [...m, { role: "user", text: prompt }]);
      setBusy(true); setLastErr(null);
      let usageSent = false, usageRecv = false;
      let acc = ""; setMessages((m) => [...m, { role: "assistant", text: "" }]);
      const toolLog: string[] = [];
      const history = [...historyRef.current];
      try {
        for await (const chunk of runAgent(effectivePrompt, { modelId, timeoutMs: 300000, history,
          onToolApproval: async (name, args) => {
            if (alwaysRef.current.has(name)) return "always";
            return await new Promise<ToolDecision>((resolve) => { approvalRef.current = resolve; setPendingTool({ name, args }); });
          },
          onAccessRequest: async (tool, _args, mode, target) => {
            return await new Promise<AccessDecision>((resolve) => { accessRef.current = resolve; setPendingAccess({ tool, mode, target }); });
          },
          onToolCall: (n, a) => { const line = `→ ${n} ${JSON.stringify(a).slice(0, 120)}`; toolLog.push(line); pushSystem(line); }, onToolResult: (n, r) => { pushSystem(`← ${n}: ${r.slice(0, 120)}`); } }, (u) => {
          if (u.inputTokens > 0) { usageSent = true; bumpTokens(modelId, u.inputTokens, 0); }
          if (u.outputTokens > 0) { usageRecv = true; bumpTokens(modelId, 0, u.outputTokens); }
        })) {
          acc += chunk;
          setMessages((m) => {
            const copy = [...m]; copy[copy.length - 1] = { role: "assistant", text: acc || (toolLog.length ? `[working… ${toolLog[toolLog.length - 1]}]` : "…") }; return copy;
          });
        }
        if (!acc.trim()) {
          if (toolLog.length) { acc = `[done — tools: ${toolLog.join(", ")}]`; setMessages((m) => { const c=[...m]; c[c.length-1]={role:"assistant", text:acc}; return c; }); }
          else pushError(`[${modelId}] empty — :models test ${modelId}`);
        }
        if (!usageSent) bumpTokens(modelId, estimateTokens(prompt), 0);
        if (!usageRecv && acc.trim()) bumpTokens(modelId, 0, estimateTokens(acc));
        historyRef.current = [...history, { role: "user" as const, content: effectivePrompt }, { role: "assistant" as const, content: acc }].slice(-20);
        const cc = normalizeCompact(cfgRef.current.compact);
        if (cc.autoTrigger) {
          const ctx = active.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
          const used = estimateHistoryTokens(historyRef.current);
          const { limit, reason } = compactLimit(cc, ctx);
          if (used > limit) {
            const why = reason === "tokens" ? `max ${cc.maxTokens.toLocaleString("en-US")} tok` : `${cc.thresholdPercent}% of ${ctx} = ${Math.round((ctx * cc.thresholdPercent) / 100)} tok`;
            pushSystem(`⚙ Auto-compact: ${used} tok > ${limit} tok (${why})`);
            await runCompact();
          }
        }
      } catch (e: any) {
        pushError(e.message ?? String(e));
        setMessages((m) => {
          const copy = [...m];
          if (copy[copy.length - 1]?.role === "assistant" && !copy[copy.length - 1].text) copy.pop();
          return copy;
        });
      } finally { countLOC().then(setLoc); setBusy(false); setScroll(0); }
    } else if (key.backspace || key.delete) { setInput((s) => s.slice(0, -1)); }
    else if (key.upArrow) {
      if (cmdHistory.length === 0) return;
      if (histIdx === -1) { draftRef.current = input; const idx = cmdHistory.length - 1; setHistIdx(idx); setInput(cmdHistory[idx]); }
      else if (histIdx > 0) { const idx = histIdx - 1; setHistIdx(idx); setInput(cmdHistory[idx]); }
      return;
    } else if (key.downArrow) {
      if (histIdx === -1) return;
      if (histIdx === cmdHistory.length - 1) { setHistIdx(-1); setInput(draftRef.current); }
      else { const idx = histIdx + 1; setHistIdx(idx); setInput(cmdHistory[idx]); }
      return;
    } else if (!key.ctrl && !key.meta && char) { setInput((s) => s + char); }
  });
  const isCmd = input.startsWith(":");
  const suggestion = getSuggestion(input);

  return (
    <Box flexDirection="column" width={cols} height={rows} paddingX={1}>
      <Box flexShrink={0} borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Box flexWrap="wrap" flexDirection="row">
          <Text bold color="cyan">TOKODER</Text>
          <Text> </Text>
          <Text bold color="yellow" wrap="wrap">{process.cwd()}</Text>
        </Box>
        <Box gap={1} flexWrap="wrap">
          {cfg.models.map((m) => {
            const t = tokenStats[m.id] ?? { sent: 0, recv: 0 };
            const fmt = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
            return <Text key={m.id} color={m.id === modelId ? "green" : "gray"} bold={m.id === modelId}>{m.id === modelId ? "●" : "○"} {m.id} ({fmt(t.sent)}↑/{fmt(t.recv)}↓)</Text>;
          })}
        </Box>
      </Box>

      <Box flexShrink={0} borderStyle="round" borderColor={lastErr ? "red" : "yellow"} marginTop={1} paddingX={1} flexDirection="column">
        <Text bold color={lastErr ? "red" : "yellow"}>● STATUS {lastErr ? "— ERROR" : ""}</Text>
        <Box flexWrap="wrap" flexDirection="row" columnGap={2}>
          <Text><Text color="cyan">Model: </Text><Text bold>{active.id}</Text><Text dimColor> ({active.provider}/{active.model})</Text></Text>
          <Text><Text color="green">↑ {curTok.sent.toLocaleString("en-US")}</Text><Text dimColor> sent</Text><Text> </Text><Text color="magenta">↓ {curTok.recv.toLocaleString("en-US")}</Text><Text dimColor> recv</Text></Text>
          {usedModels.length > 1 && <Text dimColor>(∑ {usedModels.length} models: ↑{totTok.sent.toLocaleString("en-US")} ↓{totTok.recv.toLocaleString("en-US")})</Text>}
        </Box>
        <Box flexWrap="wrap" flexDirection="row" columnGap={2}>
          <Text><Text color="cyan">LOC: </Text><Text>{loc === null ? "…" : loc.toLocaleString("en-US")}</Text></Text>
          <Text><Text color="cyan">Time: </Text><Text>{formatDuration(elapsed)}</Text></Text>
          <Text><Text color="cyan">Env: </Text>{envs.map((e, i) => <Text key={e.label} color={e.ok ? "green" : "gray"}>{i ? " " : ""}{e.ok ? "✓" : "✗"}{e.label}</Text>)}</Text>
          <Text><Text color="cyan">Compact: </Text><Text bold>{compactCfg.mode}</Text>{compactCfg.autoTrigger ? <Text dimColor>{compactCfg.maxTokens > 0 ? ` (auto ${compactCfg.thresholdPercent}%/max ${compactCfg.maxTokens >= 1000 ? Math.round(compactCfg.maxTokens / 1000) + "k" : compactCfg.maxTokens})` : ` (auto ${compactCfg.thresholdPercent}%)`}</Text> : <Text dimColor> (auto off)</Text>}</Text>
        </Box>
        {lastErr && <Text color="red" wrap="wrap">✗ {lastErr}</Text>}
      </Box>

      <Box flexGrow={1} flexShrink={1} flexDirection="column" overflow="hidden" borderStyle="round" borderColor="green" marginTop={1} paddingX={1} height={outputH}>
        <Box flexShrink={0}><Text bold color="green">● MODEL RESPONSE {busy ? "(writing…)" : ""}</Text><Text dimColor>{moreAbove ? " ↑more" : ""}{moreBelow ? " ↓end" : ""} {flatLines.length > viewportH ? `[${startIdx + 1}-${startIdx + visibleLines.length}/${flatLines.length} lines]` : ""}</Text></Box>
        <Box flexDirection="row">
          <Box flexDirection="column" width={innerW - 1} flexShrink={0}>
            {visibleLines.length === 0 && messages.length === 0 && !busy && <Text dimColor> No messages — :help</Text>}
            {visibleLines.map((ln, i) => (
              <Text key={i} color={ln.role === "user" ? "blue" : ln.role === "system" ? "yellow" : ln.role === "error" ? "red" : ln.isLabel ? "white" : undefined} bold={ln.isLabel} wrap="truncate">{ln.text}</Text>
            ))}
          </Box>
          {scrollChars.length > 0 && (
            <Box flexDirection="column" width={1} flexShrink={0}>
              {scrollChars.map((c, i) => (
                <Text key={i} color={c.thumb ? "green" : "gray"}>{c.ch}</Text>
              ))}
            </Box>
          )}
        </Box>
      </Box>

      <Box flexShrink={0} borderStyle="round" borderColor={isCmd ? "yellow" : lastErr ? "red" : "magenta"} marginTop={1} paddingX={1} flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" width={innerW}>
          <Text color={wizard ? "cyan" : isCmd ? "yellow" : "magenta"} bold>{wizard ? "⚙" : isCmd ? ":" : "›"} </Text>
          <Text color={wizard ? "cyan" : busy ? "gray" : isCmd ? "yellow" : "yellow"} wrap="wrap">{wizard ? wizardPrompt(wizard) : busy ? (pendingTool ? "" : "(busy…)") : isCmd ? input.slice(1) : input}{suggestion && !busy && !wizard ? <Text dimColor>{suggestion}</Text> : null}</Text>
          {!wizard && <Text backgroundColor={busy ? undefined : isCmd ? "yellow" : "white"} color={isCmd ? "black" : "white"}> </Text>}
        </Box>
        {wizard && <Text dimColor wrap="wrap">→ {input || "(type answer)"} ▌   (:q aborts)</Text>}
        {pendingAccess && (
          <Box flexDirection="column">
            <Text color="red" bold>🔒 ACCESS OUTSIDE PROJECT ({pendingAccess.mode})</Text>
            <Text wrap="truncate">{pendingAccess.target}</Text>
            <Text bold color="yellow">[P]File  [F]Parent folder  [N]o</Text>
          </Box>
        )}
        {pendingTool && !pendingAccess && (
          <Box flexDirection="column">
            <Text color="cyan" bold>⚡ Tool: {pendingTool.name}</Text>
            <Text dimColor wrap="truncate">{JSON.stringify(pendingTool.args).slice(0, innerW - 2)}</Text>
            <Text bold color="yellow">[Y]es  [N]o  [A]lways for {pendingTool.name}</Text>
          </Box>
        )}
        {suggestion && !busy && <Box><Text dimColor>↹Tab → :{input.slice(1) + suggestion}  ↵Enter executes</Text></Box>}
        {input.length > innerW && <Box><Text dimColor>↔ {input.length}/{innerW} chars — wraps</Text></Box>}
      </Box>
      <Box flexShrink={0}><Text dimColor wrap="wrap">↑↓ history {histIdx >= 0 ? `(${histIdx + 1}/${cmdHistory.length})` : ""} (editable) | PgUp/PgDn scroll | :models test {modelId} | {visibleLines.length}/{flatLines.length} lines{suggestion ? ` | :${input.slice(1) + suggestion}` : ""}</Text></Box>
    </Box>
  );
}
