import { spawn, spawnSync } from "node:child_process";
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

interface ProcessEntry {
  pid: number;
  ppid: number;
  pgid: number;
  /** Terminated but not yet reaped (zombie/dead): no longer counts as alive. */
  exited: boolean;
}

type ProcessTable = Map<number, ProcessEntry>;

/**
 * Snapshot of every visible process. Linux reads /proc; other POSIX systems
 * (macOS) ask `ps`. Undefined on Windows or when neither is available.
 */
function readProcessTable(): ProcessTable | undefined {
  if (process.platform === "win32") return undefined;
  if (process.platform === "linux") {
    let entries: string[];
    try {
      entries = readdirSync("/proc");
    } catch {
      return undefined;
    }
    const table: ProcessTable = new Map();
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const found = linuxProcessEntry(Number(entry));
      if (found) table.set(found.pid, found);
    }
    return table;
  }
  const result = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat="], { encoding: "utf8", timeout: 2000 });
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  const table: ProcessTable = new Map();
  for (const line of result.stdout.split("\n")) {
    const [pid, ppid, pgid, stat] = line.trim().split(/\s+/);
    if (!pid || !ppid || !pgid) continue;
    table.set(Number(pid), {
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      exited: (stat ?? "").startsWith("Z"),
    });
  }
  return table;
}

function linuxProcessEntry(pid: number): ProcessEntry | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const state = fields[0] ?? "";
    return { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), exited: state === "Z" || state === "X" };
  } catch {
    return undefined; // Gone (or exited while we were scanning).
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

function sendSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export interface ProcessTreeOptions {
  /** Process groups whose members belong to the tree. */
  groups?: number[];
  /**
   * PIDs whose descendants (by parent PID) belong to the tree. Descendants
   * are re-snapshotted at every signal and liveness check and remembered, so
   * one that calls setsid()/setpgid() to leave its group is still signalled.
   */
  roots?: number[];
  /**
   * PIDs never signalled or counted, typically the calling process when it
   * shares a group with the tree. A group containing an excluded PID is
   * signalled member by member instead of with kill(-pgid).
   */
  exclude?: number[];
  /** Direct child, signalled when nothing else matched (and on Windows). */
  child?: KillableProcess;
  /** Test seams for the Windows path (taskkill-based). */
  platform?: NodeJS.Platform;
  taskkill?: TaskkillLauncher;
  systemRoot?: string;
}

/**
 * A process tree to terminate: whole process groups plus every tracked
 * descendant of the roots.
 *
 * Limits: a descendant that double-forks and is reparented away (to init or a
 * subreaper) *before* any snapshot saw it, and that also left the group, is
 * invisible and can escape. Agents run in tmux mode are owned by the tmux
 * server by design and are not part of any headless process tree.
 */
export class ProcessTree {
  private readonly groups: Set<number>;
  private readonly roots: Set<number>;
  private readonly exclude: Set<number>;
  private readonly tracked = new Set<number>();

  constructor(private readonly options: ProcessTreeOptions) {
    this.groups = new Set((options.groups ?? []).filter((pid) => pid > 0));
    this.roots = new Set((options.roots ?? []).filter((pid) => pid > 0));
    this.exclude = new Set(options.exclude ?? []);
  }

  /** Windows has no process groups: trees are rooted PIDs killed with taskkill /T. */
  get windows(): boolean {
    return (this.options.platform ?? process.platform) === "win32";
  }

  private windowsTargets(): number[] {
    const pids = new Set([...this.roots].filter((pid) => !this.exclude.has(pid)));
    const childPid = this.options.child?.pid;
    if (childPid && !this.exclude.has(childPid)) pids.add(childPid);
    return [...pids];
  }

  /** Windows: `taskkill /PID <pid> /T /F` every root, awaiting each (bounded). */
  async taskkillAll(timeoutMs: number): Promise<void> {
    await Promise.all(this.windowsTargets().filter(probe).map((pid) =>
      runTaskkill(pid, timeoutMs, this.options.taskkill, this.options.systemRoot)));
  }

  addGroup(pgid: number): void {
    if (pgid > 0) this.groups.add(pgid);
  }

  addRoot(pid: number): void {
    if (pid > 0) this.roots.add(pid);
  }

  private refresh(table: ProcessTable): void {
    // Forget tracked PIDs that are gone so a recycled PID is not adopted.
    for (const pid of this.tracked) {
      const entry = table.get(pid);
      if (!entry || entry.exited) this.tracked.delete(pid);
    }
    const children = new Map<number, number[]>();
    for (const entry of table.values()) {
      if (entry.exited) continue;
      const siblings = children.get(entry.ppid);
      if (siblings) siblings.push(entry.pid);
      else children.set(entry.ppid, [entry.pid]);
      if (this.groups.has(entry.pgid) && !this.exclude.has(entry.pid)) this.tracked.add(entry.pid);
    }
    const pending = [...this.roots, ...this.tracked];
    while (pending.length) {
      const pid = pending.pop()!;
      const entry = table.get(pid);
      if (entry && !entry.exited && !this.exclude.has(pid)) this.tracked.add(pid);
      for (const child of children.get(pid) ?? []) {
        if (!this.tracked.has(child) && !this.exclude.has(child)) {
          this.tracked.add(child);
          pending.push(child);
        }
      }
    }
  }

  signal(signal: NodeJS.Signals): void {
    if (this.windows) {
      if (this.options.child) {
        this.signalChild(signal);
      } else if (signal === "SIGTERM" || signal === "SIGKILL") {
        // PID-only tree (e.g. cron's stored PIDs): no handle to signal.
        void this.taskkillAll(5000);
      }
      return;
    }
    const table = readProcessTable();
    if (table) this.refresh(table);
    let delivered = false;
    const signalledGroups = new Set<number>();
    for (const pgid of this.groups) {
      const sharesGroupWithExcluded = [...this.exclude].some((pid) => {
        const entry = table?.get(pid);
        return entry ? entry.pgid === pgid : pid === pgid;
      });
      if (!sharesGroupWithExcluded && sendSignal(-pgid, signal)) {
        delivered = true;
        signalledGroups.add(pgid);
      }
    }
    // Individually: setsid escapees, and members of groups we cannot signal
    // whole. Skip members the group signal already reached, so a process
    // with a handler does not see the same signal twice.
    // SIGKILL goes to every tracked PID regardless: a process that changed
    // group between the snapshot and the group kill must not be missed.
    for (const pid of this.tracked) {
      const pgid = table?.get(pid)?.pgid;
      if (signal !== "SIGKILL" && pgid !== undefined && signalledGroups.has(pgid)) continue;
      if (sendSignal(pid, signal)) delivered = true;
    }
    if (!delivered) this.signalChild(signal);
  }

  alive(): boolean {
    if (this.windows) return this.windowsTargets().some(probe);
    const table = readProcessTable();
    if (!table) {
      if ([...this.groups].some((pgid) => probe(-pgid))) return true;
      if ([...this.roots].some((pid) => !this.exclude.has(pid) && probe(pid))) return true;
      return this.childAlive() ?? false;
    }
    this.refresh(table);
    if (this.tracked.size > 0) return true;
    // Group members hidden from the table (e.g. /proc hidepid) still count.
    for (const pgid of this.groups) {
      if (probe(-pgid) && ![...table.values()].some((entry) => entry.pgid === pgid)) return true;
    }
    return false;
  }

  private signalChild(signal: NodeJS.Signals): void {
    try {
      this.options.child?.kill(signal);
    } catch {
      // Already exited.
    }
  }

  private childAlive(): boolean | undefined {
    const pid = this.options.child?.pid;
    return pid === undefined ? undefined : probe(pid);
  }
}

/**
 * True while `pid` exists and has not terminated. Unlike kill(pid, 0) this
 * treats a zombie as dead (Linux), which matters where PID 1 never reaps.
 */
export function processRunning(pid: number): boolean {
  if (!probe(pid)) return false;
  if (process.platform !== "linux") return true;
  return linuxProcessEntry(pid)?.exited !== true;
}

/** Tree for a child spawned detached (leader of its own process group). */
export function childProcessTree(child: KillableProcess, exclude: number[] = [process.pid]): ProcessTree {
  const pid = child.pid;
  return new ProcessTree({ groups: pid ? [pid] : [], roots: pid ? [pid] : [], exclude, child });
}

/** True while the group led by `pid`, or `pid`'s descendants, have a live process. */
export function processGroupAlive(pid: number): boolean {
  return new ProcessTree({ groups: [pid], roots: [pid], exclude: [process.pid] }).alive();
}

export interface TerminateProcessTreeOptions {
  signal?: NodeJS.Signals;
  graceMs: number;
  pollMs?: number;
}

export interface TerminateProcessTreeResult {
  /** Last signal sent. */
  signal: NodeJS.Signals;
  /** True when something was still alive after SIGKILL and the final wait. */
  survived: boolean;
}

/**
 * POSIX: sends `signal` (default SIGTERM) to the tree, waits up to `graceMs`
 * for it to exit, then SIGKILLs it and waits up to `graceMs` again. Never
 * rejects.
 */
export async function terminateProcessTree(
  tree: ProcessTree,
  options: TerminateProcessTreeOptions,
): Promise<TerminateProcessTreeResult> {
  const signal = options.signal ?? "SIGTERM";
  const pollMs = options.pollMs ?? 25;
  if (!tree.alive()) return { signal, survived: false };
  if (tree.windows) {
    // No catchable termination on Windows: force-kill each root's tree.
    await tree.taskkillAll(options.graceMs);
    const dead = await waitUntilDead(tree, options.graceMs, pollMs);
    return { signal: "SIGKILL", survived: !dead };
  }
  tree.signal(signal);
  if (await waitUntilDead(tree, options.graceMs, pollMs)) return { signal, survived: false };
  tree.signal("SIGKILL");
  // Re-send SIGKILL on every poll: it also catches descendants forked or
  // regrouped after the previous snapshot.
  const dead = await waitUntilDead(tree, options.graceMs, pollMs, () => tree.signal("SIGKILL"));
  return { signal: "SIGKILL", survived: !dead };
}

async function waitUntilDead(
  tree: ProcessTree,
  timeoutMs: number,
  pollMs: number,
  onPoll?: () => void,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!tree.alive()) return true;
    onPoll?.();
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return !tree.alive();
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

/**
 * Runs `taskkill /PID <pid> /T /F` and resolves once it exits (true on
 * success) or after `timeoutMs` (false; the hung taskkill is killed).
 */
export function runTaskkill(
  pid: number,
  timeoutMs: number,
  launch: TaskkillLauncher = launchTaskkill,
  systemRoot = process.env.SystemRoot,
): Promise<boolean> {
  return new Promise((resolve) => {
    let taskkill: TaskkillProcess;
    try {
      taskkill = launch(windowsTaskkillPath(systemRoot), ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      taskkill.kill("SIGKILL");
      done(false);
    }, timeoutMs);
    taskkill.once("error", () => done(false));
    taskkill.once("close", (code) => done(code === 0));
  });
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
