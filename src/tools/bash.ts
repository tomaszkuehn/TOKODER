import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { checkAccess, accessRequest } from "../utils/permissions.js";

const execAsync = promisify(exec);

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

export async function bashTool({ command, workdir, timeout }: z.infer<typeof bashSchema>) {
  const timeoutMs = timeout && timeout > 0 ? timeout * 1000 : 30000;
  const msCap = 600000;
  const eff = Math.min(timeoutMs, msCap);
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
