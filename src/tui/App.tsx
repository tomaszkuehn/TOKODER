import React, { useEffect, useState, useRef, useMemo } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { runAgent, testConnection, type ToolDecision, type AccessDecision } from "../core/agent.js";
import { loadConfig, saveConfig } from "../core/config.js";
import { countLOC, detectEnvs, formatDuration, estimateTokens } from "../utils/stats.js";
import { setEnvKey, maskKey } from "../utils/env.js";
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

  const roleLabel = (r: string) => (r === "user" ? "› TY:" : r === "system" ? "◆ SYS:" : r === "error" ? "✗ ERR:" : "● AI:");

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

  const COMMANDS = ["exit", "quit", "q", "compact", "clear", "models", "key", "help", "allow", "deny"] as const;
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
    if (["compact", "clear", "compress"].includes(c)) {
      if (messages.length <= 2) pushSystem("Nothing to compact.");
      else {
        const keep = 2;
        const removed = messages.length - keep;
        setMessages((m) => [{ role: "system", text: `[COMPACT] Removed ${removed} messages.` }, ...m.slice(-keep)]);
      }
      return true;
    }
    if (["models", "model", "providers"].includes(c)) {
      const sub = args[0]?.toLowerCase();
      const cur = reloadCfg();
      if (!sub) { pushSystem(`MODELS (${cur.models.length}):\n${formatModels(cur)}\n\n:models <id> — switch\n:models add <id> <provider> <model> [baseURL]\n:models rm <id>\n:models default <id>\n:models key <id> <API_KEY>\n:models test <id>\n:models set <id> <field> <value>`); return true; }
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
        if (!id && !provider) { setWizard({ step: "kind" }); pushSystem("DODAWANIE MODELU — kreator. Wybierz rodzaj:"); return true; }
        if (!id || !provider || !model) { pushSystem("Usage: :models add <id> <provider> <model> [baseURL]  |  :models add — kreator interaktywny"); return true; }
        if (!["anthropic", "openai", "openrouter", "ollama"].includes(provider)) { pushSystem(`Invalid provider "${provider}"`); return true; }
        if (cur.models.find((m) => m.id === id)) { pushSystem(`Model "${id}" already exists`); return true; }
        const apiKeyEnv = provider === "anthropic" ? "ANTHROPIC_API_KEY" : provider === "openai" ? "OPENAI_API_KEY" : provider === "openrouter" ? "OPENROUTER_API_KEY" : undefined;
        cur.models.push({ id, provider: provider as any, model, apiKeyEnv, baseURL });
        saveConfig(cur); reloadCfg(); pushSystem(`Added ${id}. Now: :models key ${id} <API_KEY>  and  :models test ${id}`); return true;
      }
      if (["rm", "remove", "del"].includes(sub)) {
        const id = args[1];
        if (!id) { setWizard({ step: "rm", rmId: undefined, models: cur.models.map((m) => m.id) }); pushSystem(`USUWANIE MODELU — które ID?\n${cur.models.map((m, i) => `${String(i + 1).padStart(2)}. ${m.id} (${m.provider}/${m.model})`).join("\n")}\n\nWpisz numer lub nazwę ID.`); return true; }
        if (!cur.models.find((m) => m.id === id)) { pushSystem(`Not found: ${id}`); return true; }
        setWizard({ step: "rm", rmId: id });
        pushSystem(`Usunąć model "${id}"? [T]ak / [N]ie`); return true;
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
        setEnvKey(envKey, key.trim()); reloadCfg(); pushSystem(`Key saved for ${id} → ${envKey} (${maskKey(key)}) in .env — run :models test ${id}`); return true;
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
      pushSystem(`Unknown subcommand "${sub}". Try :models`); return true;
    }
    if (["key", "apikey"].includes(c)) { setWizard({ step: "key" }); return true; }
    if (["acl", "access"].includes(c)) {
      const { loadRules, listAllowed, rulesPath } = await import("../utils/permissions.js");
      const r = loadRules();
      pushSystem(`ZASADY DOSTĘPU (poza projektem) — ${rulesPath()}\nGlobalnie: read=${r.read ? "TAK" : "NIE"}, write=${r.write ? "TAK" : "NIE"}, execute=${r.execute ? "TAK" : "NIE"}\n\nReguły per-ścieżka:\n${listAllowed().join("\n") || "— brak —"}\n\nZmiana: :acl set <read|write|execute> <tak|nie>\nDodaj: :allow <path> [read|write|execute]  •  Usuń: :deny <path>`);
      return true;
    }
    if (c === "aclset") {
      const [field, val] = args;
      if (!field || !val || !["read", "write", "execute"].includes(field) || !["tak", "nie", "yes", "no"].includes(val.toLowerCase())) { pushSystem("Usage: :acl set <read|write|execute> <tak|nie>"); return true; }
      const mod = await import("../utils/permissions.js");
      const r = mod.loadRules();
      (r as any)[field] = ["tak", "yes"].includes(val.toLowerCase());
      mod.saveRules();
      pushSystem(`✓ ${field} = ${(r as any)[field] ? "TAK" : "NIE"} (zapisane między sesjami)`);
      return true;
    }
    if (["help", "h", "?"].includes(c)) { pushSystem(`Commands:\n:exit / :q — exit\n:compact — compact\n:key — set Ollama Cloud API key\n:models — list\n:models add — interactive wizard\n:models rm — interactive remove\n:models test <id>\n:allow <path> / :deny <path> — sandbox\nPgUp/PgDn scroll`); return true; }
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
    if (w.step === "kind") return "DODAWANIE MODELU — 1: Ollama lokalny (localhost:11434), 2: Ollama Cloud (ollama.com)";
    if (w.step === "key") {
      const has = process.env.OLLAMA_API_KEY;
      return `KLUCZ API dla Ollama Cloud${has ? ` (jest ${maskKey(has)} — wpisz nowy aby nadpisać, Enter = zostaw)` : " (wklej klucz z ollama.com/settings/keys)"}`;
    }
    if (w.step === "model") return `Wybierz model — numer z listy lub wpisz nazwę ręcznie (${w.models?.length ?? 0} znalezionych, "n" = własna nazwa)`;
    if (w.step === "rm") return w.rmId === undefined ? "Wpisz numer lub ID modelu do usunięcia" : `Potwierdź usunięcie "${w.rmId}" — t/n`;
    return `ID dla ${w.model} (Enter = "${w.suggestedId}")`;
  };

  const handleWizard = async (value: string) => {
    const w = wizard!;
    const v = value.trim();
    if (v === ":q" || v === ":exit") { setWizard(null); pushSystem("Wizard przerwany."); return; }
    if (w.step === "kind") {
      if (v !== "1" && v !== "2") { pushSystem("Wpisz 1 (lokalny) lub 2 (cloud)."); return; }
      const kind = v === "1" ? "local" as const : "cloud" as const;
      if (kind === "cloud" && !process.env.OLLAMA_API_KEY) { setWizard(null); pushError("Ollama Cloud wymaga klucza API. Najpierw uruchom :key (lub :models key <id> <KEY>), potem :models add."); return; }
      setWizard({ ...w, step: "model", kind, models: [] });
      try {
        const models = (await listOllamaModels(kind)).map((m) => m.name);
        setWizard({ step: "model", kind, models });
        pushSystem(`Ollama ${kind === "local" ? "lokalny" : "cloud"} — dostępne modele:\n${models.map((m, i) => `${String(i + 1).padStart(2)}. ${m}`).join("\n")}\n\nWpisz numer, nazwę modelu lub "n" (własna).`);
      } catch (e: any) {
        setWizard(null);
        pushError(`Nie udało się pobrać listy (${kind === "local" ? "czy `ollama serve` działa?" : e.message})`);
      }
      return;
    }
    if (w.step === "key") {
      if (!v || v.startsWith(":")) { pushSystem("Podaj klucz (anuluj: :q)."); return; }
      setEnvKey("OLLAMA_API_KEY", v);
      setWizard(null);
      pushSystem(`✓ Klucz zapisany do .env → OLLAMA_API_KEY (${maskKey(v)}). Teraz :models add → 2 (Ollama Cloud).`);
      return;
    }
    if (w.step === "model") {
      let model: string | undefined;
      if (/^\d+$/.test(v)) model = w.models?.[parseInt(v, 10) - 1];
      else if (v.toLowerCase() === "n") { pushSystem('Wpisz pełną nazwę modelu (np. "qwen3-coder:480b").'); return; }
      else model = v;
      if (!model) { pushSystem(`Nie ma takiego numeru (1-${w.models?.length ?? 0}).`); return; }
      setWizard({ ...w, step: "id", model, suggestedId: suggestFreeId(model, cfg.models) });
      return;
    }
    if (w.step === "rm") {
      if (w.rmId === undefined) {
        let id: string | undefined;
        if (/^\d+$/.test(v)) id = w.models?.[parseInt(v, 10) - 1];
        else id = v;
        if (!id || !w.models?.includes(id)) { pushSystem(`Nie ma takiego modelu (1-${w.models?.length ?? 0} lub nazwa ID).`); return; }
        setWizard({ ...w, rmId: id });
        pushSystem(`Usunąć model "${id}"? [T]ak / [N]ie`);
        return;
      }
      if (v.toLowerCase() === "t") { /* fallthrough do usuwania */ }
      else if (v.toLowerCase() === "n") { setWizard(null); pushSystem("Anulowano."); return; }
      else { pushSystem('Wpisz "t" (usuń) lub "n" (anuluj).'); return; }
      const cur = reloadCfg();
      const idx = cur.models.findIndex((m) => m.id === w.rmId);
      if (idx === -1) { setWizard(null); pushSystem(`Nie znaleziono: ${w.rmId}`); return; }
      const removed = cur.models.splice(idx, 1)[0];
      if (cur.defaultModel === removed.id) cur.defaultModel = cur.models[0]?.id ?? "";
      saveConfig(cur); reloadCfg();
      if (modelId === removed.id) setModelId(cur.defaultModel);
      setWizard(null);
      pushSystem(`✓ Usunięto ${removed.id} (${removed.provider}/${removed.model})${cur.defaultModel ? `\nDefault: ${cur.defaultModel}` : "\n⚠ Brak modeli w konfiguracji!"}`);
      return;
    }
    if (w.step === "id") {
      const id = v || w.suggestedId || ollamaIdSuggestion(w.model ?? "");
      const cur = reloadCfg();
      if (cur.models.find((m) => m.id === id)) { pushSystem(`ID "${id}" już istnieje — podaj inne.`); return; }
      const isCloud = w.kind === "cloud";
      cur.models.push({
        id,
        provider: "ollama",
        model: w.model!,
        ...(isCloud ? { apiKeyEnv: "OLLAMA_API_KEY", baseURL: "https://ollama.com/v1" } : {}),
      });
      saveConfig(cur); reloadCfg();
      setWizard(null);
      pushSystem(
        `✓ Dodano ${id} → ${w.model}${isCloud ? " (Ollama Cloud, https://ollama.com/v1)" : " (lokalny)"}\n${isCloud && !process.env.OLLAMA_API_KEY ? `⚠ Ustaw klucz: :models key ${id} <OLLAMA_API_KEY> (z ollama.com/settings/keys)\n` : ""}Teraz: :models test ${id}${isCloud ? "" : "\nJeśli model nie jest pobrany: ollama pull " + w.model}`
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
    if (key.escape) { setWizard(null); setHistIdx(-1); pushSystem("Anulowano (Esc — wyjście tylko przez :exit)."); return; }
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
          <Text><Text color="green">↑ {curTok.sent.toLocaleString("pl-PL")}</Text><Text dimColor> sent</Text><Text> </Text><Text color="magenta">↓ {curTok.recv.toLocaleString("pl-PL")}</Text><Text dimColor> recv</Text></Text>
          {usedModels.length > 1 && <Text dimColor>(∑ {usedModels.length} models: ↑{totTok.sent.toLocaleString("pl-PL")} ↓{totTok.recv.toLocaleString("pl-PL")})</Text>}
        </Box>
        <Box flexWrap="wrap" flexDirection="row" columnGap={2}>
          <Text><Text color="cyan">LOC: </Text><Text>{loc === null ? "…" : loc.toLocaleString("pl-PL")}</Text></Text>
          <Text><Text color="cyan">Czas: </Text><Text>{formatDuration(elapsed)}</Text></Text>
          <Text><Text color="cyan">Env: </Text>{envs.map((e, i) => <Text key={e.label} color={e.ok ? "green" : "gray"}>{i ? " " : ""}{e.ok ? "✓" : "✗"}{e.label}</Text>)}</Text>
        </Box>
        {lastErr && <Text color="red" wrap="wrap">✗ {lastErr}</Text>}
      </Box>

      <Box flexGrow={1} flexShrink={1} flexDirection="column" overflow="hidden" borderStyle="round" borderColor="green" marginTop={1} paddingX={1} height={outputH}>
        <Box flexShrink={0}><Text bold color="green">● ODPOWIEDŹ MODELU {busy ? "(pisze…)" : ""}</Text><Text dimColor>{moreAbove ? " ↑more" : ""}{moreBelow ? " ↓end" : ""} {flatLines.length > viewportH ? `[${startIdx + 1}-${startIdx + visibleLines.length}/${flatLines.length} linii]` : ""}</Text></Box>
        <Box flexDirection="row">
          <Box flexDirection="column" width={innerW - 1} flexShrink={0}>
            {visibleLines.length === 0 && messages.length === 0 && !busy && <Text dimColor> Brak wiadomości — :help</Text>}
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
          <Text color={wizard ? "cyan" : busy ? "gray" : isCmd ? "yellow" : "yellow"} wrap="wrap">{wizard ? wizardPrompt(wizard) : busy ? (pendingTool ? "" : "(zajęty…)") : isCmd ? input.slice(1) : input}{suggestion && !busy && !wizard ? <Text dimColor>{suggestion}</Text> : null}</Text>
          {!wizard && <Text backgroundColor={busy ? undefined : isCmd ? "yellow" : "white"} color={isCmd ? "black" : "white"}> </Text>}
        </Box>
        {wizard && <Text dimColor wrap="wrap">→ {input || "(wpisz odpowiedź)"} ▌   (:q przerywa)</Text>}
        {pendingAccess && (
          <Box flexDirection="column">
            <Text color="red" bold>🔒 DOSTĘP POZA PROJEKT ({pendingAccess.mode})</Text>
            <Text wrap="truncate">{pendingAccess.target}</Text>
            <Text bold color="yellow">[P]lik  [F]folder nadrzędny  [N]ie</Text>
          </Box>
        )}
        {pendingTool && !pendingAccess && (
          <Box flexDirection="column">
            <Text color="cyan" bold>⚡ Tool: {pendingTool.name}</Text>
            <Text dimColor wrap="truncate">{JSON.stringify(pendingTool.args).slice(0, innerW - 2)}</Text>
            <Text bold color="yellow">[T]ak  [N]ie  [A]zawsze dla {pendingTool.name}</Text>
          </Box>
        )}
        {suggestion && !busy && <Box><Text dimColor>↹Tab → :{input.slice(1) + suggestion}  ↵Enter executes</Text></Box>}
        {input.length > innerW && <Box><Text dimColor>↔ {input.length}/{innerW} chars — wraps</Text></Box>}
      </Box>
      <Box flexShrink={0}><Text dimColor wrap="wrap">↑↓ history {histIdx >= 0 ? `(${histIdx + 1}/${cmdHistory.length})` : ""} (edytowalna) | PgUp/PgDn scroll | :models test {modelId} | {visibleLines.length}/{flatLines.length} linii{suggestion ? ` | :${input.slice(1) + suggestion}` : ""}</Text></Box>
    </Box>
  );
}
