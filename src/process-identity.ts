import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { win32 } from "node:path";

/**
 * The one place that answers "is this PID alive?" and "is this still the same
 * process?". Every stored PID/PGID (locks, cron executions, run nodes) is
 * paired with a start identity captured here, and checked here before it is
 * trusted or signalled.
 *
 * - exists: kill(pid, 0) succeeds or fails with EPERM (someone else's process).
 * - alive: exists and, on Linux, is not a zombie (state Z/X). A non-reaping
 *   PID 1 leaves dead processes as zombies that kill(pid, 0) still finds.
 * - start identity: an opaque string that changes when the PID is reused:
 *   `linux:<boot id>:<start ticks>`, `darwin:<lstart>`, `win32:<creation ticks>`.
 * - same process: alive and, when both identities are known, equal.
 */

const windowsProcessIdentityTimeoutMs = 5_000;
const maximumProcessId = 0xffff_ffff;

export interface ProcessIdentity {
  pid: number;
  startIdentity?: string;
}

export interface LinuxProcStat {
  state: string;
  ppid: number;
  pgid: number;
  startTicks: string;
}

export interface WindowsProcessProbeOptions {
  execute?: (command: string, args: string[]) => string;
  systemRoot?: string;
}

export interface MacosProcessStartIdentityOptions {
  env?: NodeJS.ProcessEnv;
  execute?: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv },
  ) => string;
}

export function validProcessId(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && pid <= maximumProcessId;
}

/** kill(pid, 0); a negative pid probes a process group. EPERM counts as existing. */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Parsed /proc/<pid>/stat, or undefined when unavailable (gone, not Linux). */
export function readLinuxProcStat(pid: number): LinuxProcStat | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return {
      state: fields[0] ?? "",
      ppid: Number(fields[1]),
      pgid: Number(fields[2]),
      startTicks: fields[19] ?? "",
    };
  } catch {
    return undefined;
  }
}

export function linuxStateExited(state: string): boolean {
  return state === "Z" || state === "X";
}

/** True while `pid` exists and has not terminated (a zombie is dead on Linux). */
export function processAlive(pid: number): boolean {
  if (!validProcessId(pid) || !processExists(pid)) return false;
  if (process.platform !== "linux") return true;
  const stat = readLinuxProcStat(pid);
  return stat === undefined || !linuxStateExited(stat.state);
}

let linuxBootId: string | undefined;

export function processStartIdentity(
  pid: number,
  windowsTimeoutMs = windowsProcessIdentityTimeoutMs,
): string | undefined {
  if (!validProcessId(pid)) return undefined;
  if (process.platform === "linux") {
    const stat = readLinuxProcStat(pid);
    if (!stat?.startTicks) return undefined;
    try {
      linuxBootId ??= readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
      return undefined;
    }
    return linuxBootId ? `linux:${linuxBootId}:${stat.startTicks}` : undefined;
  }
  if (process.platform === "darwin") return macosProcessStartIdentity(pid);
  if (process.platform === "win32") return probeWindowsProcessStartIdentity(pid, {}, windowsTimeoutMs);
  return undefined;
}

export function captureProcessIdentity(pid: number): ProcessIdentity {
  const startIdentity = processStartIdentity(pid);
  return startIdentity === undefined ? { pid } : { pid, startIdentity };
}

let ownIdentity: string | undefined | null = null;

/** This process's start identity (cached: it never changes). */
export function ownProcessStartIdentity(): string | undefined {
  if (ownIdentity === null) ownIdentity = processStartIdentity(process.pid);
  return ownIdentity;
}

/**
 * True when `pid` is alive and still the process `startIdentity` was captured
 * from. Unknown identities (not recorded, or unreadable now) fall back to
 * plain liveness.
 */
export function isSameProcess(pid: number, startIdentity: string | undefined): boolean {
  if (!processAlive(pid)) return false;
  if (startIdentity === undefined) return true;
  const current = pid === process.pid ? ownProcessStartIdentity() : processStartIdentity(pid);
  return current === undefined || current === startIdentity;
}

/**
 * True when a live process now holds `pid` but it is provably not the one
 * `startIdentity` was captured from (the PID was reused).
 */
export function processIdentityChanged(pid: number, startIdentity: string | undefined): boolean {
  if (startIdentity === undefined || !processAlive(pid)) return false;
  const current = processStartIdentity(pid);
  return current !== undefined && current !== startIdentity;
}

/**
 * Stored PIDs/PGIDs that are still safe to signal. A PID whose number now
 * belongs to a different live process is dropped. A dead PID is kept: as a
 * process group id it cannot be reused while any member of the old group is
 * alive (POSIX), so signalling the group still reaches only the old members.
 */
export function signallableIds(ids: ReadonlyArray<ProcessIdentity | undefined>): number[] {
  return ids
    .filter((id): id is ProcessIdentity => id !== undefined && validProcessId(id.pid))
    .filter((id) => !processIdentityChanged(id.pid, id.startIdentity))
    .map((id) => id.pid);
}

export function windowsProcessStartIdentity(
  pid: number,
  options: WindowsProcessProbeOptions = {},
): string | undefined {
  return probeWindowsProcessStartIdentity(pid, options, windowsProcessIdentityTimeoutMs);
}

function probeWindowsProcessStartIdentity(
  pid: number,
  options: WindowsProcessProbeOptions,
  timeoutMs: number,
): string | undefined {
  if (!validProcessId(pid)) return undefined;
  const execute = options.execute
    ?? ((command, args) => executeWindowsPowerShell(command, args, timeoutMs));
  try {
    const output = execute(windowsPowerShellPath(options.systemRoot), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      windowsProcessStartIdentityProbe(pid),
    ]).trim();
    const match = /^HEADLESS_PROCESS_START:(\d+)$/.exec(output);
    return match ? `win32:${match[1]}` : undefined;
  } catch {
    return undefined;
  }
}

export function executeWindowsPowerShell(command: string, args: string[], timeout: number): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
}

export function windowsPowerShellPath(systemRoot = process.env.SystemRoot): string {
  const root = systemRoot && win32.isAbsolute(systemRoot) ? systemRoot : "C:\\Windows";
  return win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function windowsProcessStartIdentityProbe(pid: number): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$rootPid = [uint32]${pid}`,
    "$process = Get-CimInstance Win32_Process -Filter \"ProcessId = $rootPid\"",
    "if ($null -ne $process) { 'HEADLESS_PROCESS_START:' + $process.CreationDate.ToUniversalTime().Ticks }",
  ].join("; ");
}

export function macosProcessStartIdentity(
  pid: number,
  options: MacosProcessStartIdentityOptions = {},
): string | undefined {
  const execute = options.execute ?? executeMacosProcessStartIdentityProbe;
  const env = { ...(options.env ?? process.env), LC_ALL: "C", TZ: "UTC" };
  try {
    const startedAt = execute(
      "/bin/ps",
      ["-o", "lstart=", "-p", String(pid)],
      { env },
    ).trim();
    return startedAt ? `darwin:${startedAt}` : undefined;
  } catch {
    return undefined;
  }
}

function executeMacosProcessStartIdentityProbe(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
): string {
  return execFileSync(command, args, {
    ...options,
    encoding: "utf8",
    timeout: 3_000,
  });
}
