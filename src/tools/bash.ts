import { exec } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { accessRequest, checkAccess, getProjectRoot } from "../utils/permissions.js";
import type { ToolCtx } from "./index.js";

const execAsync = promisify(exec);

const T = "[^\\s\"'\\x60;|&<>),]*";

function normalizeTarget(raw: string): string {
  const mnt = raw.match(/^\/mnt\/([A-Za-z])(?:\/(.*))?$/i);
  if (mnt) return resolve(`${mnt[1].toUpperCase()}:\\${mnt[2] ?? ""}`);
  if (raw.startsWith("~")) return resolve(homedir(), raw.slice(1));
  return resolve(raw);
}

/** read-only commands (no side effects) — access-checked with "read" mode instead of "write" */
const BASH_READ_ONLY = new RegExp(
  String.raw`^(type|cat|Get-Content|gc|dir|ls|Get-ChildItem|gci|Select-String|sls|findstr|grep|head|tail|wc|git\s+(log|diff|status|show|branch|blame)|node\s+(--version|-v)|npm\s+(run|test|ls|outdated|view)|echo(?!.*>)|pwd|whoami|hostname|where|which|Get-Date|Get-Location|Test-Path|wsl\s+(-l|--version)|ollama\s+list)\b`,
  "i",
);

/** commands with side effects (mutating / network / process control) — always require write access for referenced targets */
const BASH_MUTATING = new RegExp(
  String.raw`(>|Out-File|Set-Content|Add-Content|Tee-Object|Remove-Item|\brm\b|\bdel\b|rmdir|\bmv\b|Move-Item|Copy-Item|New-Item|\btouch\b|git\s+(add|commit|push|reset|checkout|restore|clean|merge|rebase)|npm\s+(install|\bi\b|\badd\b|remove|uninstall|update|upgrade|publish|link)|pip\b|cargo\b|dotnet\b|apt\b|choco\b|winget\b|scoop\b|Invoke-WebRequest|\bcurl\b|\bwget\b|Start-Process|Stop-Process|taskkill|\breg\b|regedit|format|diskpart|icacls|attrib)`,
  "i",
);

/** screens a raw bash command for out-of-project targets before execution (sandbox layer) */
export function screenCommand(command: string): string | null {
  if (/(^|[\s"'`\x60;|&\\/])\.\.([\s"'`\x60;=|&\\/]|$)/.test(command)) {
    return `Error: command contains ".." path traversal — sandbox forbids leaving the project directory. Use paths inside ${getProjectRoot()} instead.`;
  }
  if (/(^|[\s"'`\x60;|&])\/(\s|$)/.test(command)) {
    return `Error: command references filesystem root "/" — sandbox forbids touching it.`;
  }
  const mutating = BASH_MUTATING.test(command);
  const readOnly = !mutating && BASH_READ_ONLY.test(command);
  const targets: string[] = [];
  for (const m of command.matchAll(new RegExp(`(?<![\\w])[A-Za-z]:[\\\\/]${T}`, "g"))) targets.push(m[0]);
  for (const m of command.matchAll(new RegExp(`\\\\\\\\${T}`, "g"))) targets.push(m[0]);
  if (/\$HOME\b|%USERPROFILE%|\$env\.?(?:USERPROFILE|HOME)/i.test(command)) targets.push(homedir());
  for (const m of command.matchAll(new RegExp(`(?<![\\w~])~[\\\\/]${T}`, "g"))) targets.push(m[0]);
  for (const m of command.matchAll(/(?<![\w~:/])\/(?:mnt\/[A-Za-z](?:\/[^\s"'`;|&<>),]*)?|[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[^\s"'`;|&<>),]*)?)/g)) targets.push(m[0]);
  for (const raw of targets) {
    const p = normalizeTarget(raw);
    // read-only commands may access paths the rules allow for READ (read=true by default); mutating ones need write
    const chk = checkAccess(p, mutating ? "write" : readOnly ? "read" : "write");
    if (chk.ok) continue;
    if (chk.reason === "system") return `Error: DENIED — command touches a Windows system folder ("${raw}"). Never accessible.`;
    return accessRequest(chk.needs, p, `PENDING-APPROVAL: bash command references "${raw}" (→ ${p}) outside the project (${chk.needs}=NO by default). User decision required.`);
  }
  return null;
}

export const bashSchema = z.object({
  command: z.string(),
  workdir: z.string().optional(),
  /** seconds (converted to ms internally); null/undefined = 30000ms default */
  timeout: z.number().optional().nullable(),
});

let wslCache: boolean | null = null;
async function hasWsl(): Promise<boolean> {
  if (wslCache !== null) return wslCache;
  if (process.platform !== "win32") { wslCache = false; return false; }
  try {
    const { execSync } = await import("node:child_process");
    execSync("wsl --version", { stdio: "ignore", timeout: 2000 });
    wslCache = true;
  } catch { wslCache = !!process.env.WSL_DISTRO_NAME; }
  return wslCache!;
}

function isLinuxish(cmd: string): boolean {
  return /(^|\s)(mkdir -p|ls -la|chmod|chown|touch\s+\/|cat\s+\/|echo.*>\s*\/|~\/|\/tmp\/|\/home\/|\/opt\/)/.test(cmd) || /^\s*\//.test(cmd.trim());
}

export async function bashTool({ command, workdir, timeout }: z.infer<typeof bashSchema>, ctx?: ToolCtx) {
  const timeoutMs = timeout && timeout > 0 ? timeout * 1000 : 30000;
  const msCap = 600000;
  const eff = Math.min(timeoutMs, msCap);
  const blocked = screenCommand(command);
  if (blocked) return blocked;
  if (workdir) {
    const chk = checkAccess(workdir, "execute");
    if (!chk.ok) return chk.reason === "system"
      ? `Error: DENIED — workdir "${workdir}" is inside Windows system folder.`
      : accessRequest("execute", workdir, `execute workdir outside project denied by rules: ${workdir}`);
  }
  let cmd = command;
  let cwd = workdir ?? process.cwd();
  const onWin = process.platform === "win32";
  const linuxish = isLinuxish(cmd);
  if (onWin && linuxish && (await hasWsl())) {
    const wslCwd = cwd.replace(/^([A-Z]):\\/i, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, "/");
    cmd = `wsl bash -c ${JSON.stringify(`cd ${JSON.stringify(wslCwd)}; ${command}`)}`;
    cwd = undefined as any;
  }
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd,
      timeout: eff,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      shell: onWin && !linuxish ? "powershell.exe" : undefined,
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
    });
    const out = [stdout, stderr].filter(Boolean).join("\n").slice(0, 30000);
    return out || "(no output)";
  } catch (e: any) {
    if (e.killed && (e.signal ?? "").startsWith("SIG")) return `Error: command killed after ${eff / 1000}s timeout. If you passed timeout in ms by mistake, note the bash tool timeout is in SECONDS (default 30s). Retry with timeout: ${Math.min(Math.ceil((e.message.match(/(\d+)\s*ms/)?.[1] ? eff / 1000 : 60)), 600)}+ or omit it.`;
    const base = `Error (exit ${e.code ?? "?"}): ${(e.stdout ?? "") + (e.stderr ?? e.message)}`.slice(0, 28000);
    const hint = onWin && linuxish
      ? `\nHint: You are on Windows (${process.platform}) but sent Linux command. WSL ${await hasWsl() ? "is available — rerun via wsl bash" : "not found — use Windows paths or install WSL"}.`
      : onWin
      ? `\nHint: You are on Windows. Use PowerShell syntax or WSL bash.`
      : "";
    return (base + hint).slice(0, 30000);
  }
}