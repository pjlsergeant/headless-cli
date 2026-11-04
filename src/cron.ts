import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import { hostOnlyError, runningInHeadlessContainer } from "./container.js";
import { extractFinalMessage } from "./output.js";
import {
  readOwnerLockHolder,
  tryAcquireOwnerLock,
  withOwnerLockSync,
  type OwnerLock,
  type OwnerLockRecord,
} from "./owner-lock.js";
import {
  isSameProcess,
  processAlive,
  processStartIdentity,
  signallableIds,
  type ProcessIdentity,
} from "./process-identity.js";
import { killGraceMs, ProcessTree, terminateProcessTree } from "./process-tree.js";
import { nextCronRun, parseCronSchedule, type CronSchedule } from "./cron-schedule.js";
import type { AgentName, Env } from "./types.js";

export { nextCronRun, parseCronSchedule, type CronSchedule } from "./cron-schedule.js";

const privateDirMode = 0o700;
const privateFileMode = 0o600;
const daemonPollMs = 1000;

export type CronJobStatus = "active" | "paused" | "disabled";
export type CronExecutionStatus = "running" | "succeeded" | "failed" | "killed";

export interface CronCommandRecord {
  args: string[];
  workDir: string;
}

export interface CronJobRecord {
  version: 1;
  id: string;
  agent: AgentName;
  schedule: CronSchedule;
  status: CronJobStatus;
  timezone: string;
  command: CronCommandRecord;
  nextRunAt: string;
  lastRunAt?: string;
  lastExitCode?: number | null;
  lastExecutionId?: string;
  activeExecutionId: string | null;
  pending: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CronExecutionRecord {
  version: 1;
  jobId: string;
  executionId: string;
  status: CronExecutionStatus;
  pid: number | null;
  /** Start identity of `pid`; signals are refused once the PID is reused. */
  pidIdentity?: string;
  /**
   * Process group of the agent headless spawned, reported by headless via
   * HEADLESS_AGENT_PGID_FILE. Lets cron kill/reconcile reach the agent even
   * when headless itself died (SIGKILL, OOM) without forwarding anything.
   */
  agentPgid?: number | null;
  /** Start identity of the agent group's leader, reported with agent.pgid. */
  agentPgidIdentity?: string;
  startedAt: string;
  completedAt?: string;
  exitCode: number | null;
  signal: string | null;
  finalMessage?: string;
  stdoutLog: string;
  stderrLog: string;
}

export interface NewCronJobInput {
  id?: string;
  agent: AgentName;
  schedule: CronSchedule;
  command: CronCommandRecord;
  now?: Date;
}

export function cronRoot(env: Env): string {
  if (env.HEADLESS_CRON_DIR) {
    return env.HEADLESS_CRON_DIR;
  }
  if (!env.HOME) {
    throw new Error("HOME is required for headless cron");
  }
  return join(env.HOME, ".headless", "cron");
}

/** Held by the running daemon for its whole life; the holder names its PID. */
export function cronDaemonLockPath(env: Env): string {
  return join(cronRoot(env), "locks", "daemon");
}

function cronJobLockPath(env: Env, id: string): string {
  return join(cronRoot(env), "locks", "jobs", id);
}

/**
 * Every job state transition (daemon and CLI alike) runs under the job's lock
 * and re-reads the record inside it, so no writer persists a stale snapshot.
 * Sections are short and synchronous; never await while holding one.
 */
function withCronJobLock<T>(env: Env, id: string, callback: () => T): T {
  validateCronJobId(id);
  ensurePrivateDir(dirname(cronJobLockPath(env, id)));
  return withOwnerLockSync(cronJobLockPath(env, id), (lock) => {
    const outer = heldJobLock;
    heldJobLock = lock;
    try {
      return callback();
    } finally {
      heldJobLock = outer;
    }
  }, {
    label: `cron job lock for ${id}`,
    // Sections are short; one still held after this died, possibly on a host
    // (or container) that cannot be probed.
    maxHoldMs: cronJobLockMaxHoldMs,
    timeoutMs: cronJobLockMaxHoldMs + 30_000,
  });
}

const cronJobLockMaxHoldMs = 60_000;
let heldJobLock: OwnerLock | undefined;

/**
 * Called before every job-state write: a section that outlived maxHoldMs has
 * lost its lock and must not overwrite a newer holder's state. (Residual:
 * losing it between this check and the rename.)
 */
function assertJobLockHeld(): void {
  if (heldJobLock && !heldJobLock.held()) {
    throw new Error(`cron job lock was lost before writing: ${heldJobLock.path}`);
  }
}

export function cronLogPath(env: Env): string {
  return join(cronRoot(env), "daemon.log");
}

export function recordCronJob(env: Env, input: NewCronJobInput | CronJobRecord): CronJobRecord {
  const job = "version" in input ? normalizeJob(input) : createJob(input);
  return withCronJobLock(env, job.id, () => writeJob(env, job));
}

/**
 * Re-reads job `id` under its lock and persists what `mutate` returns
 * (undefined leaves it unchanged). Returns undefined if the job is gone.
 */
export function updateCronJob(
  env: Env,
  id: string,
  mutate: (job: CronJobRecord) => CronJobRecord | undefined,
): CronJobRecord | undefined {
  return withCronJobLock(env, id, () => {
    const job = readCronJob(env, id);
    if (!job) return undefined;
    const updated = mutate(job);
    return updated ? writeJob(env, normalizeJob(updated)) : job;
  });
}

function writeJob(env: Env, job: CronJobRecord): CronJobRecord {
  validateCronJobId(job.id);
  assertJobLockHeld();
  ensurePrivateDir(jobsRoot(env));
  ensurePrivateDir(jobHistoryRoot(env, job.id));
  writeJsonPrivate(jobFilePath(env, job.id), job);
  return job;
}

export function readCronJob(env: Env, id: string): CronJobRecord | undefined {
  validateCronJobId(id);
  const path = jobFilePath(env, id);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CronJobRecord>;
    if (parsed.version !== 1 || parsed.id !== id || !parsed.schedule || !parsed.command) {
      return undefined;
    }
    return normalizeJob(parsed as CronJobRecord);
  } catch {
    return undefined;
  }
}

export function listCronJobs(env: Env): CronJobRecord[] {
  const root = jobsRoot(env);
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => readCronJob(env, entry.slice(0, -5)))
    .filter((job): job is CronJobRecord => Boolean(job))
    .sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt) || left.id.localeCompare(right.id));
}

export function deleteCronJob(env: Env, id: string): void {
  withCronJobLock(env, id, () => removeJobFiles(env, id));
}

function removeJobFiles(env: Env, id: string): void {
  assertJobLockHeld();
  rmSync(jobFilePath(env, id), { force: true });
  rmSync(jobHistoryRoot(env, id), { force: true, recursive: true });
}

/**
 * Removes job `id`. Without `force` an active execution refuses; with it the
 * job is first disabled (so nothing respawns it) and its execution killed.
 */
export async function removeCronJob(env: Env, id: string, force: boolean): Promise<boolean> {
  const active = withCronJobLock(env, id, () => {
    const job = readCronJob(env, id);
    if (!job) return undefined;
    if (!job.activeExecutionId) {
      removeJobFiles(env, id);
      return false;
    }
    if (!force) throw new Error(`job has an active execution; use --force to remove: ${id}`);
    return true;
  });
  if (active === undefined) return false;
  if (active) {
    await killCronExecution(env, id, "disabled");
    deleteCronJob(env, id);
  }
  return true;
}

/** The live daemon's lock record, if a daemon is running. */
export function cronDaemonHolder(env: Env): OwnerLockRecord | undefined {
  return readOwnerLockHolder(cronDaemonLockPath(env));
}

export function daemonRunning(env: Env): boolean {
  return cronDaemonHolder(env) !== undefined;
}

export function resolveHeadlessCronBinary(env: Env): string {
  return env.HEADLESS_CLI_BIN || env.HEADLESS_BIN || process.argv[1] || "headless";
}

export async function runDueCronJobsOnce(env: Env, now = new Date()): Promise<void> {
  reconcileCronJobs(env);
  const due = (job: CronJobRecord | undefined): job is CronJobRecord =>
    job?.status === "active" && job.nextRunAt <= now.toISOString();
  for (const listed of listCronJobs(env)) {
    if (!due(listed)) continue;
    withCronJobLock(env, listed.id, () => {
      const job = readCronJob(env, listed.id);
      if (!due(job)) return;
      if (job.activeExecutionId) {
        writeJob(env, {
          ...job,
          pending: true,
          nextRunAt: nextCronRun(job.schedule, now).toISOString(),
          updatedAt: now.toISOString(),
        });
        return;
      }
      startCronExecution(env, job, now);
    });
  }
}

export async function runCronDaemon(env: Env): Promise<void> {
  if (runningInHeadlessContainer(env)) throw hostOnlyError("the cron daemon");
  ensurePrivateDir(dirname(cronDaemonLockPath(env)));
  // No maxHoldMs: the daemon holds this for its whole life, and only host
  // processes run it, so a dead holder is always detectable.
  const lock = tryAcquireOwnerLock(cronDaemonLockPath(env));
  if (!lock) throw new Error("cron daemon already running");
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  const stop = () => {
    stopped = true;
    stopPromise ??= killAllActiveExecutions(env);
  };
  // Stay installed until shutdown finishes: a second SIGTERM/SIGINT must not
  // kill the daemon while it is still escalating on active executions.
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  appendDaemonLog(env, `started ${process.pid}\n`);
  try {
    while (!stopped) {
      try {
        await runDueCronJobsOnce(env);
      } catch (error) {
        appendDaemonLog(env, `tick failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      await new Promise((resolve) => setTimeout(resolve, daemonPollMs));
    }
  } finally {
    await stopPromise;
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    appendDaemonLog(env, `stopped ${process.pid}\n`);
    lock.release();
  }
}

/**
 * Kills job `jobId`'s active execution and sets its status (`status`
 * undefined keeps the current one). The status is persisted *before* any
 * signal so the daemon, seeing the execution exit, cannot respawn a pending
 * run; the final record is re-read afterwards so concurrent changes (pause,
 * delete) made during termination survive. Undefined if the job is gone.
 */
export async function killCronExecution(
  env: Env,
  jobId: string,
  status?: CronJobStatus,
): Promise<CronJobRecord | undefined> {
  const started = withCronJobLock(env, jobId, () => {
    const job = readCronJob(env, jobId);
    if (!job) return undefined;
    const stored = job.activeExecutionId ? readExecution(env, jobId, job.activeExecutionId) : undefined;
    const execution = stored?.status === "running" ? refreshAgentPgid(env, jobId, stored) : undefined;
    const updated = writeJob(env, {
      ...job,
      status: status ?? job.status,
      pending: false,
      activeExecutionId: execution ? job.activeExecutionId : null,
      updatedAt: new Date().toISOString(),
    });
    return { job: updated, execution };
  });
  if (!started?.execution) return started?.job;
  const execution = started.execution;
  const signal = await terminateExecution(env, jobId, execution);
  return withCronJobLock(env, jobId, () => {
    const job = readCronJob(env, jobId);
    if (!job) return undefined;
    const current = readExecution(env, jobId, execution.executionId);
    if (current?.status === "running") {
      writeExecution(env, jobId, {
        ...withLatestAgentPgid(env, jobId, current),
        status: "killed",
        completedAt: new Date().toISOString(),
        exitCode: null,
        signal,
      });
    }
    if (job.activeExecutionId !== execution.executionId) return job;
    return writeJob(env, { ...job, activeExecutionId: null, pending: false, updatedAt: new Date().toISOString() });
  });
}

export function recentCronExecutions(env: Env, jobId: string, limit = 10): CronExecutionRecord[] {
  validateCronJobId(jobId);
  const root = executionsRoot(env, jobId);
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root)
    .map((entry) => readExecution(env, jobId, entry))
    .filter((execution): execution is CronExecutionRecord => Boolean(execution))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, limit);
}

/** Spawns job `job`'s next execution. Caller holds the job's lock. */
function startCronExecution(env: Env, job: CronJobRecord, now: Date): ChildProcess {
  assertJobLockHeld();
  const executionId = generatedExecutionId(now);
  const executionDir = executionRoot(env, job.id, executionId);
  ensurePrivateDir(executionDir);
  const stdoutLog = join(executionDir, "stdout.log");
  const stderrLog = join(executionDir, "stderr.log");
  const stdoutFd = openSync(stdoutLog, "a", privateFileMode);
  const stderrFd = openSync(stderrLog, "a", privateFileMode);
  chmodSync(stdoutLog, privateFileMode);
  chmodSync(stderrLog, privateFileMode);
  let logsClosed = false;
  const closeLogs = () => {
    if (logsClosed) return;
    logsClosed = true;
    closeSync(stdoutFd);
    closeSync(stderrFd);
  };

  // Own process group (POSIX) so `cron kill`/`stop`/`rm --force`, which only
  // know the recorded PID, can signal everything this execution started.
  const child = spawn(resolveHeadlessCronBinary(env), job.command.args, {
    cwd: job.command.workDir,
    detached: true,
    env: { ...env, HEADLESS_AGENT_PGID_FILE: agentPgidPath(executionDir) } as NodeJS.ProcessEnv,
    stdio: ["ignore", stdoutFd, stderrFd],
  });
  const running: CronExecutionRecord = {
    version: 1,
    jobId: job.id,
    executionId,
    status: "running",
    pid: child.pid ?? null,
    ...(child.pid ? identityField("pidIdentity", processStartIdentity(child.pid)) : {}),
    startedAt: now.toISOString(),
    exitCode: null,
    signal: null,
    stdoutLog,
    stderrLog,
  };
  writeExecution(env, job.id, running);
  writeJob(env, {
    ...job,
    activeExecutionId: executionId,
    pending: false,
    lastRunAt: now.toISOString(),
    lastExecutionId: executionId,
    nextRunAt: nextCronRun(job.schedule, now).toISOString(),
    updatedAt: now.toISOString(),
  });

  const headless: ProcessIdentity | undefined = child.pid
    ? { pid: child.pid, startIdentity: running.pidIdentity }
    : undefined;
  const finish = (code: number | null, signal: string | null) => {
    try {
      finishCronExecution(env, job.id, executionId, code, signal);
    } catch (error) {
      appendDaemonLog(env, `finishing ${job.id}/${executionId} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };
  child.on("close", (code, signal) => {
    closeLogs();
    // headless killed by a signal (SIGKILL, OOM) could not clean up: sweep
    // its own group and its agent's group. After an ordinary exit headless
    // already cleaned up, so only sweep its agent group as a safety net, and
    // not at all when the job asked to keep background processes.
    const abnormal = signal !== null;
    if (!abnormal && cronArgsKeepBackground(job.command.args)) {
      finish(code ?? null, null);
      return;
    }
    void sweepOrphanedAgent(env, job.id, executionId, abnormal ? headless : undefined).finally(() => {
      finish(code ?? null, signal ?? null);
    });
  });
  child.on("error", () => {
    closeLogs();
    finish(127, null);
  });
  return child;
}

function finishCronExecution(env: Env, jobId: string, executionId: string, code: number | null, signal: string | null): void {
  withCronJobLock(env, jobId, () => {
    const execution = readExecution(env, jobId, executionId);
    // Already finalized (killed or reconciled), or the job was removed.
    if (!execution || execution.status !== "running") return;
    const job = readCronJob(env, jobId);
    if (!job) return;
    const stdout = existsSync(execution.stdoutLog) ? readFileSync(execution.stdoutLog, "utf8") : "";
    const status = signal ? "killed" : code === 0 ? "succeeded" : "failed";
    writeExecution(env, jobId, {
      ...withLatestAgentPgid(env, jobId, execution),
      status,
      completedAt: new Date().toISOString(),
      exitCode: code,
      signal,
      finalMessage: extractFinalMessage(job.agent, stdout) || undefined,
    });
    if (job.activeExecutionId !== executionId) return;
    const updated = writeJob(env, {
      ...job,
      activeExecutionId: null,
      lastExitCode: code,
      updatedAt: new Date().toISOString(),
    });
    if (updated.pending && updated.status === "active") {
      startCronExecution(env, { ...updated, activeExecutionId: null, pending: false }, new Date());
    }
  });
}

function reconcileCronJobs(env: Env): void {
  for (const listed of listCronJobs(env)) {
    if (!listed.activeExecutionId) continue;
    withCronJobLock(env, listed.id, () => {
      const job = readCronJob(env, listed.id);
      if (!job?.activeExecutionId) return;
      const stored = readExecution(env, job.id, job.activeExecutionId);
      const execution = stored ? refreshAgentPgid(env, job.id, stored) : undefined;
      // Zombie-aware and identity-checked: a dead headless that a non-reaping
      // PID 1 never reaps, or whose PID was reused, is not "still running".
      if (execution?.status === "running" && execution.pid && isSameProcess(execution.pid, execution.pidIdentity)) {
        return;
      }
      // headless is gone; kill whatever is left of its agent tree.
      if (execution) void terminateProcessTree(executionTree(execution), { graceMs: killGraceMs(env) });
      if (!execution || execution.status === "running") {
        writeExecution(env, job.id, {
          ...(execution ?? missingExecution(env, job)),
          status: "killed",
          completedAt: new Date().toISOString(),
          exitCode: null,
          signal: "stale",
        });
      }
      writeJob(env, { ...job, activeExecutionId: null, pending: false, updatedAt: new Date().toISOString() });
    });
  }
}

async function killAllActiveExecutions(env: Env): Promise<void> {
  for (const job of listCronJobs(env)) {
    if (job.activeExecutionId) {
      // Keep whatever status the job has when the kill lands (a concurrent
      // `cron pause` must survive daemon shutdown).
      await killCronExecution(env, job.id);
    }
  }
}

function createJob(input: NewCronJobInput): CronJobRecord {
  const now = input.now ?? new Date();
  const id = input.id ?? generatedJobId(now);
  return {
    version: 1,
    id,
    agent: input.agent,
    schedule: input.schedule,
    status: "active",
    timezone: resolvedTimezone(),
    command: input.command,
    nextRunAt: nextCronRun(input.schedule, now).toISOString(),
    activeExecutionId: null,
    pending: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function normalizeJob(job: CronJobRecord): CronJobRecord {
  return {
    ...job,
    version: 1,
    status: job.status ?? "active",
    activeExecutionId: job.activeExecutionId ?? null,
    pending: Boolean(job.pending),
  };
}

function validateCronJobId(value: string): string {
  if (!value || value === "." || value === ".." || !/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("invalid cron job id; use letters, numbers, dots, dashes, or underscores");
  }
  return value;
}

function jobsRoot(env: Env): string {
  return join(cronRoot(env), "jobs");
}

function jobFilePath(env: Env, id: string): string {
  return join(jobsRoot(env), `${id}.json`);
}

function jobHistoryRoot(env: Env, id: string): string {
  return join(jobsRoot(env), id);
}

function executionsRoot(env: Env, jobId: string): string {
  return join(jobHistoryRoot(env, jobId), "executions");
}

function executionRoot(env: Env, jobId: string, executionId: string): string {
  return join(executionsRoot(env, jobId), executionId);
}

function executionPath(env: Env, jobId: string, executionId: string): string {
  return join(executionRoot(env, jobId, executionId), "result.json");
}

function readExecution(env: Env, jobId: string, executionId: string): CronExecutionRecord | undefined {
  const path = executionPath(env, jobId, executionId);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CronExecutionRecord;
    return parsed.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeExecution(env: Env, jobId: string, execution: CronExecutionRecord): void {
  assertJobLockHeld();
  ensurePrivateDir(executionRoot(env, jobId, execution.executionId));
  writeJsonPrivate(executionPath(env, jobId, execution.executionId), execution);
}

function missingExecution(env: Env, job: CronJobRecord): CronExecutionRecord {
  const executionId = job.activeExecutionId ?? generatedExecutionId(new Date());
  const root = executionRoot(env, job.id, executionId);
  return {
    version: 1,
    jobId: job.id,
    executionId,
    status: "killed",
    pid: null,
    startedAt: job.lastRunAt ?? new Date().toISOString(),
    exitCode: null,
    signal: "stale",
    stdoutLog: join(root, "stdout.log"),
    stderrLog: join(root, "stderr.log"),
  };
}

function generatedJobId(now: Date): string {
  return `cron-${timestampId(now)}-${randomBytes(2).toString("hex")}`;
}

function generatedExecutionId(now: Date): string {
  return `exec-${timestampId(now)}-${randomBytes(2).toString("hex")}`;
}

function timestampId(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-");
}

function resolvedTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || timezoneOffset();
}

function timezoneOffset(): string {
  const offset = -new Date().getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: privateDirMode });
  chmodSync(path, privateDirMode);
}

function writeJsonPrivate(path: string, value: unknown): void {
  ensurePrivateDir(dirname(path));
  const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  const tmpPath = `${path}.tmp-${process.pid}-${randomBytes(2).toString("hex")}`;
  writeFileSync(tmpPath, text, { mode: privateFileMode });
  chmodSync(tmpPath, privateFileMode);
  renameSync(tmpPath, path);
  chmodSync(path, privateFileMode);
}

function appendDaemonLog(env: Env, text: string): void {
  const path = cronLogPath(env);
  ensurePrivateDir(dirname(path));
  writeFileSync(path, `${new Date().toISOString()} ${text}`, { flag: "a", mode: privateFileMode });
  chmodSync(path, privateFileMode);
}

function identityField<K extends string>(key: K, identity: string | undefined): Partial<Record<K, string>> {
  return identity === undefined ? {} : ({ [key]: identity } as Record<K, string>);
}

function agentPgidPath(executionDir: string): string {
  return join(executionDir, "agent.pgid");
}

/** agent.pgid: the group id on line 1, the leader's start identity (optional) on line 2. */
function readAgentPgid(env: Env, jobId: string, executionId: string): ProcessIdentity | undefined {
  const path = agentPgidPath(executionRoot(env, jobId, executionId));
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n").map((line) => line.trim());
  } catch {
    return undefined;
  }
  const pid = Number.parseInt(lines[0] ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return { pid, ...identityField("startIdentity", lines[1] || undefined) };
}

/** headless's own group plus the agent's group, with descendants of both. */
function executionTree(execution: CronExecutionRecord): ProcessTree {
  // A stored PID/PGID whose number now belongs to another process is dropped.
  const ids = signallableIds([
    execution.pid ? { pid: execution.pid, startIdentity: execution.pidIdentity } : undefined,
    execution.agentPgid ? { pid: execution.agentPgid, startIdentity: execution.agentPgidIdentity } : undefined,
  ]);
  return new ProcessTree({ groups: ids, roots: ids, exclude: [process.pid] });
}

async function terminateExecution(
  env: Env,
  jobId: string,
  execution: CronExecutionRecord,
): Promise<NodeJS.Signals | null> {
  // Signal BOTH groups directly rather than trusting headless to forward:
  // headless may be wedged or killed before it reaches its agent's group.
  const tree = executionTree(withLatestAgentPgid(env, jobId, execution));
  const { signal } = await terminateProcessTree(tree, { graceMs: killGraceMs(env) });
  return signal;
}

/**
 * headless rewrites agent.pgid for every attempt (billing/capacity retries),
 * so the file, not the first value persisted, names the live agent group.
 */
function withLatestAgentPgid(env: Env, jobId: string, execution: CronExecutionRecord): CronExecutionRecord {
  const current = readAgentPgid(env, jobId, execution.executionId);
  if (current === undefined) return execution;
  if (current.pid === execution.agentPgid && (current.startIdentity ?? execution.agentPgidIdentity) === execution.agentPgidIdentity) {
    return execution;
  }
  // headless reports the leader's identity; if it did not, capture it now
  // while the group is fresh.
  const startIdentity = current.startIdentity
    ?? (processAlive(current.pid) ? processStartIdentity(current.pid) : undefined);
  const { agentPgidIdentity: _previous, ...rest } = execution;
  return { ...rest, agentPgid: current.pid, ...identityField("agentPgidIdentity", startIdentity) };
}

/** withLatestAgentPgid, persisted. Caller holds the job's lock. */
function refreshAgentPgid(env: Env, jobId: string, execution: CronExecutionRecord): CronExecutionRecord {
  const refreshed = withLatestAgentPgid(env, jobId, execution);
  if (refreshed !== execution) writeExecution(env, jobId, refreshed);
  return refreshed;
}

async function sweepOrphanedAgent(
  env: Env,
  jobId: string,
  executionId: string,
  headless?: ProcessIdentity,
): Promise<void> {
  // headless's own detached group catches anything it started besides the
  // agent; the agent's separate group is reachable only through agent.pgid.
  const ids = signallableIds([readAgentPgid(env, jobId, executionId), headless]);
  if (ids.length === 0) return;
  const tree = new ProcessTree({ groups: ids, roots: ids, exclude: [process.pid] });
  if (tree.alive()) await terminateProcessTree(tree, { graceMs: killGraceMs(env) });
}

const cronValueOptions = new Set([
  "--prompt", "--prompt-file", "--model", "--profile", "--reasoning-effort", "--allow", "--work-dir",
  "--docker-image", "--docker-arg", "--docker-env", "--modal-app", "--modal-cpu", "--modal-env",
  "--modal-image", "--modal-image-secret", "--modal-memory", "--modal-secret", "--modal-timeout", "--timeout",
]);

/** True when a scheduled invocation carries --keep-background as a flag (not as an option value). */
function cronArgsKeepBackground(args: readonly string[]): boolean {
  return args.some((arg, index) => arg === "--keep-background" && !cronValueOptions.has(args[index - 1] ?? ""));
}
