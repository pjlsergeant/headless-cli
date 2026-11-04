import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { win32 } from "node:path";

export interface KillableProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/**
 * How long a signalled process tree gets to exit before it is SIGKILLed.
 * Every termination path (parent signals, timeouts, cron kill, ACP shutdown,
 * async workers) shares this one value; HEADLESS_KILL_GRACE_MS overrides it.
 */
export const DEFAULT_KILL_GRACE_MS = 5000;

export function killGraceMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.HEADLESS_KILL_GRACE_MS;
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return DEFAULT_KILL_GRACE_MS;
  return Number(raw.trim());
}

/**
 * Grace a supervisor (cron) gives a headless process it SIGTERMed before
 * SIGKILLing headless's group: headless itself needs one grace period to
 * escalate on its agent's separate process group, so the supervisor waits
 * twice as long to avoid killing headless mid-escalation and orphaning that
 * agent group.
 */
export function supervisorKillGraceMs(env: Record<string, string | undefined> = process.env): number {
  return 2 * killGraceMs(env);
}

/**
 * Signals the process group led by `child` (POSIX, child spawned detached),
 * falling back to the direct child when no such group exists (child not a
 * group leader, or the group already exited). Windows has no process groups;
 * the direct child is signalled.
 */
export function signalProcessGroup(child: KillableProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Not a group leader, or the group is gone: fall back to the direct child.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}

function probe(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * True while the process group led by `pid` (or, failing that, `pid` itself)
 * has a member that has not terminated.
 *
 * On Linux, zombies are ignored: a killed descendant that was orphaned is
 * reparented to PID 1 and, when PID 1 never reaps (containers without an init,
 * e.g. Node as PID 1), lingers as a zombie that kill(-pgid, 0) still reports,
 * which would otherwise turn every shutdown into a full grace-period wait.
 */
export function processGroupAlive(pid: number): boolean {
  if (process.platform !== "win32" && probe(-pid)) {
    return process.platform !== "linux" || linuxGroupHasLiveMember(pid);
  }
  return probe(pid) && (process.platform !== "linux" || !linuxProcessIsZombie(pid));
}

function linuxStat(pid: string | number): { state: string; pgrp: number } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0] ?? "", pgrp: Number(fields[2]) };
  } catch {
    return undefined;
  }
}

function linuxProcessIsZombie(pid: number): boolean {
  return linuxStat(pid)?.state === "Z";
}

function linuxGroupHasLiveMember(pgid: number): boolean {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return true; // Cannot tell: the kill(-pgid, 0) probe said alive.
  }
  let sawMember = false;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = linuxStat(entry);
    if (!stat || stat.pgrp !== pgid) continue;
    sawMember = true;
    if (stat.state !== "Z" && stat.state !== "X") return true;
  }
  // Members hidden from us (e.g. hidepid) still count as alive.
  return !sawMember;
}

export interface TerminateProcessGroupOptions {
  signal?: NodeJS.Signals;
  graceMs: number;
  pollMs?: number;
  /** Overrides the liveness probe (defaults to processGroupAlive(child.pid)). */
  isAlive?: () => boolean;
}

/**
 * POSIX: sends `signal` (default SIGTERM) to the group, waits up to `graceMs`
 * for every member to exit, then SIGKILLs the group and waits up to `graceMs`
 * again. Resolves with the last signal that was sent. Never rejects.
 */
export async function terminateProcessGroup(
  child: KillableProcess,
  options: TerminateProcessGroupOptions,
): Promise<NodeJS.Signals> {
  const signal = options.signal ?? "SIGTERM";
  const pollMs = options.pollMs ?? 25;
  const pid = child.pid;
  const alive = options.isAlive ?? (() => pid !== undefined && processGroupAlive(pid));
  if (!alive()) return signal;
  signalProcessGroup(child, signal);
  if (await waitUntilDead(alive, options.graceMs, pollMs)) return signal;
  signalProcessGroup(child, "SIGKILL");
  await waitUntilDead(alive, options.graceMs, pollMs);
  return "SIGKILL";
}

async function waitUntilDead(alive: () => boolean, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive()) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return !alive();
}

interface TaskkillProcess extends KillableProcess {
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null) => void): this;
  unref(): void;
}

export type TaskkillLauncher = (
  command: string,
  args: string[],
  options: { stdio: "ignore"; windowsHide: true },
) => TaskkillProcess;

const launchTaskkill: TaskkillLauncher = (command, args, options) => spawn(command, args, options);

export function windowsTaskkillPath(systemRoot = process.env.SystemRoot): string {
  const root = systemRoot && win32.isAbsolute(systemRoot) ? systemRoot : "C:\\Windows";
  return win32.join(root, "System32", "taskkill.exe");
}

export function forceKillWindowsProcessTree(
  child: KillableProcess,
  timeoutMs: number,
  launch: TaskkillLauncher = launchTaskkill,
  systemRoot = process.env.SystemRoot,
): void {
  if (!child.pid) {
    child.kill("SIGKILL");
    return;
  }

  const taskkill = launch(windowsTaskkillPath(systemRoot), ["/pid", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  let finished = false;
  const finish = (fallback: boolean) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    if (fallback) child.kill("SIGKILL");
  };
  const timeout = setTimeout(() => {
    taskkill.kill("SIGKILL");
    finish(true);
  }, timeoutMs);
  timeout.unref();
  taskkill.once("error", () => finish(true));
  taskkill.once("close", (code) => finish(code !== 0));
  taskkill.unref();
}
