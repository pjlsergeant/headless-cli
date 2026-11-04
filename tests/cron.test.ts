import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import {
  cronDaemonLockPath,
  cronRoot,
  daemonRunning,
  listCronJobs,
  nextCronRun,
  parseCronSchedule,
  readCronJob,
  recordCronJob,
  runCronDaemon,
  runDueCronJobsOnce,
} from "../src/cron.ts";
import { readOwnerLockHolder, tryAcquireOwnerLock } from "../src/owner-lock.ts";
import { processStartIdentity } from "../src/process-identity.ts";

function testEnv(dir: string): NodeJS.ProcessEnv {
  return {
    HOME: join(dir, "home"),
    HEADLESS_CRON_DIR: join(dir, "cron"),
    HEADLESS_CLI_BIN: join(dir, "fake-headless.js"),
    HEADLESS_KILL_GRACE_MS: "500",
    PATH: process.env.PATH,
  };
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(assertion(), true);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Takes the daemon lock in this process, so a daemon looks alive. */
function markDaemonRunning(env: NodeJS.ProcessEnv): void {
  mkdirSync(join(env.HEADLESS_CRON_DIR as string, "locks"), { recursive: true });
  assert.ok(tryAcquireOwnerLock(cronDaemonLockPath(env)));
}

/** Writes a daemon lock record by hand, naming `pid` with `startIdentity`. */
function forgeDaemonHolder(env: NodeJS.ProcessEnv, pid: number, startIdentity: string | undefined): void {
  const lockPath = cronDaemonLockPath(env);
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(join(lockPath, "000000000001"), JSON.stringify({
    hostname: hostname(), pid, startIdentity, token: "forged", acquiredAt: new Date().toISOString(),
  }));
}

const repoRoot = process.cwd();
const cronModuleUrl = pathToFileURL(join(repoRoot, "src", "cron.ts")).href;
const cliModuleUrl = pathToFileURL(join(repoRoot, "src", "cli.ts")).href;

test("cron schedule parser accepts every durations and five-field cron expressions", () => {
  assert.deepEqual(parseCronSchedule({ every: "30m" }), {
    kind: "every",
    value: "30m",
    intervalMs: 1_800_000,
  });
  assert.deepEqual(parseCronSchedule({ every: "1d" }), {
    kind: "every",
    value: "1d",
    intervalMs: 86_400_000,
  });
  assert.equal(parseCronSchedule({ schedule: "0 */6 * * *" }).kind, "cron");
  assert.equal(
    nextCronRun(parseCronSchedule({ schedule: "0 0 15 * 1" }), new Date(2026, 4, 14, 23, 59)).getTime(),
    new Date(2026, 4, 15, 0, 0).getTime(),
  );
  assert.throws(() => parseCronSchedule({ every: "0m" }), /positive duration/);
  assert.throws(() => parseCronSchedule({ every: "30m", schedule: "* * * * *" }), /use either --every or --schedule/);
  assert.throws(() => parseCronSchedule({ schedule: "* * *" }), /five-field/);
});

test("cron store writes private job files and lists jobs by next run", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  const previousUmask = process.umask(0);
  try {
    const env = testEnv(dir);
    const job = recordCronJob(env, {
      agent: "codex",
      command: { args: ["codex", "--prompt", "triage"], workDir: dir },
      id: "inbox-triage",
      schedule: parseCronSchedule({ every: "1h" }),
      now: new Date("2026-05-15T12:00:00.000Z"),
    });

    const root = cronRoot(env);
    assert.equal(modeOf(root), 0o700);
    assert.equal(modeOf(join(root, "jobs")), 0o700);
    assert.equal(modeOf(join(root, "jobs", "inbox-triage.json")), 0o600);
    assert.equal(readCronJob(env, "inbox-triage")?.nextRunAt, "2026-05-15T13:00:00.000Z");
    assert.equal(listCronJobs(env)[0]?.id, job.id);
  } finally {
    process.umask(previousUmask);
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cron add persists safe detached command options and rejects unsafe tmux/session flags", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  try {
    const env = testEnv(dir);
    markDaemonRunning(env);
    let stdout = "";
    let stderr = "";
    const code = await runCli(
      [
        "cron",
        "add",
        "codex",
        "--name",
        "repo-summary",
        "--every",
        "30m",
        "--prompt",
        "Summarize repository changes",
        "--model",
        "gpt-5.5",
        "--profile",
        "research",
        "--fast",
        "--reasoning-effort",
        "high",
        "--allow",
        "read-only",
        "--work-dir",
        dir,
        "--keep-background",
        "--json",
        "--usage",
      ],
      {
        env,
        stdinIsTTY: true,
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );
    assert.equal(code, 0, stderr);
    assert.match(stdout, /added: repo-summary/);
    assert.deepEqual(readCronJob(env, "repo-summary")?.command.args, [
      "codex",
      "--prompt",
      "Summarize repository changes",
      "--model",
      "gpt-5.5",
      "--profile",
      "research",
      "--fast",
      "--reasoning-effort",
      "high",
      "--allow",
      "read-only",
      "--work-dir",
      dir,
      "--keep-background",
      "--json",
      "--usage",
    ]);

    assert.equal(
      await runCli(
        [
          "cron", "add", "codex", "--name", "standard", "--every", "30m",
          "--prompt", "x", "--no-fast",
        ],
        { env, stdout: () => undefined, stderr: (text) => { stderr += text; } },
      ),
      0,
    );
    assert.deepEqual(readCronJob(env, "standard")?.command.args, [
      "codex",
      "--prompt",
      "x",
      "--no-fast",
    ]);

    stderr = "";
    const badCode = await runCli(
      ["cron", "add", "codex", "--every", "1h", "--prompt", "x", "--tmux"],
      { env, stdinIsTTY: true, stderr: (text) => { stderr += text; } },
    );
    assert.equal(badCode, 2);
    assert.match(stderr, /--tmux cannot be scheduled/);

    stderr = "";
    assert.equal(
      await runCli(
        ["cron", "add", "codex", "--every", "1h", "--prompt", "x", "--docker-image", "headless-local:dev"],
        { env, stderr: (text) => { stderr += text; } },
      ),
      2,
    );
    assert.match(stderr, /require --docker/);

    stderr = "";
    assert.equal(
      await runCli(
        ["cron", "add", "gemini", "--every", "1h", "--prompt", "x", "--fast"],
        { env, stderr: (text) => { stderr += text; } },
      ),
      2,
    );
    assert.match(stderr, /--fast is supported only by claude and codex/);

    stderr = "";
    assert.equal(
      await runCli(
        ["cron", "add", "claude", "--every", "1h", "--prompt", "x", "--profile", "research"],
        { env, stderr: (text) => { stderr += text; } },
      ),
      2,
    );
    assert.match(stderr, /--profile is supported only by codex/);

  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cron lifecycle commands list, view, pause, resume, and refuse active rm without force", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  try {
    const env = testEnv(dir);
    markDaemonRunning(env);
    await runCli(["cron", "add", "codex", "--name", "docs", "--every", "1h", "--prompt-file", "prompt.md"], {
      env,
      stdinIsTTY: true,
      stdout: () => {},
    });

    let stdout = "";
    assert.equal(await runCli(["cron", "list"], { env, stdout: (text) => { stdout += text; } }), 0);
    assert.match(stdout, /docs\s+codex\s+every 1h\s+active/);

    stdout = "";
    assert.equal(await runCli(["cron", "view", "docs"], { env, stdout: (text) => { stdout += text; } }), 0);
    assert.match(stdout, /prompt file: prompt.md/);
    assert.match(stdout, /warning: prompt file not found/);

    assert.equal(await runCli(["cron", "pause", "docs"], { env, stdout: () => {} }), 0);
    assert.equal(readCronJob(env, "docs")?.status, "paused");
    assert.equal(await runCli(["cron", "resume", "docs"], { env, stdout: () => {} }), 0);
    assert.equal(readCronJob(env, "docs")?.status, "active");
    assert.equal(await runCli(["cron", "kill", "docs"], { env, stdout: () => {} }), 0);
    assert.equal(readCronJob(env, "docs")?.status, "disabled");
    assert.equal(await runCli(["cron", "resume", "docs"], { env, stdout: () => {} }), 0);

    const job = readCronJob(env, "docs");
    assert.ok(job);
    recordCronJob(env, { ...job, activeExecutionId: "exec-active" });

    let stderr = "";
    assert.equal(await runCli(["cron", "rm", "docs"], { env, stderr: (text) => { stderr += text; } }), 2);
    assert.match(stderr, /active execution/);
    assert.equal(await runCli(["cron", "rm", "docs", "--force"], { env, stdout: () => {} }), 0);
    assert.equal(readCronJob(env, "docs"), undefined);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cron kill escalates stubborn active executions before returning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const childClosed = new Promise((resolve) => child.once("close", resolve));
  try {
    assert.ok(child.pid);
    await new Promise((resolve) => child.stdout.once("data", resolve));
    const env = testEnv(dir);
    const now = new Date("2026-05-15T12:00:00.000Z");
    recordCronJob(env, {
      agent: "codex",
      command: { args: ["codex", "--prompt", "tick"], workDir: dir },
      id: "stubborn",
      schedule: parseCronSchedule({ every: "1h" }),
      now,
    });
    const job = readCronJob(env, "stubborn");
    assert.ok(job);
    recordCronJob(env, { ...job, activeExecutionId: "exec-stubborn" });

    const executionRoot = join(cronRoot(env), "jobs", "stubborn", "executions", "exec-stubborn");
    mkdirSync(executionRoot, { recursive: true });
    writeFileSync(
      join(executionRoot, "result.json"),
      JSON.stringify({
        version: 1,
        jobId: "stubborn",
        executionId: "exec-stubborn",
        status: "running",
        pid: child.pid,
        startedAt: now.toISOString(),
        exitCode: null,
        signal: null,
        stdoutLog: join(executionRoot, "stdout.log"),
        stderrLog: join(executionRoot, "stderr.log"),
      }),
    );

    let stdout = "";
    assert.equal(await runCli(["cron", "kill", "stubborn"], { env, stdout: (text) => { stdout += text; } }), 0);
    assert.match(stdout, /killed: stubborn/);
    await childClosed;
    assert.equal(processAlive(child.pid), false);

    const execution = readFileSync(join(executionRoot, "result.json"), "utf8");
    assert.match(execution, /"status": "killed"/);
    assert.match(execution, /"signal": "SIGKILL"/);
  } finally {
    if (child.pid && processAlive(child.pid)) {
      process.kill(child.pid, "SIGKILL");
    }
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cron start is idempotent when the daemon pid is alive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  try {
    const env = testEnv(dir);
    markDaemonRunning(env);

    let stdout = "";
    const code = await runCli(["cron", "start"], {
      env,
      stdout: (text) => {
        stdout += text;
      },
    });
    assert.equal(code, 0);
    assert.match(stdout, /daemon already running/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cron start fails when the daemon process cannot be spawned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  try {
    const env = testEnv(dir);
    let stdout = "";
    let stderr = "";
    const code = await runCli(["cron", "start"], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.match(stderr, /cron daemon failed to start/);
    assert.equal(daemonRunning(env), false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cron add passes --modal-keep-sandbox through to the scheduled invocation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-modal-keep-"));
  try {
    const env = testEnv(dir);
    markDaemonRunning(env);
    let stderr = "";
    const code = await runCli(
      ["cron", "add", "codex", "--name", "modal-keep", "--every", "1h", "--prompt", "x", "--modal", "--modal-keep-sandbox"],
      { env, stdinIsTTY: true, stdout: () => undefined, stderr: (text) => { stderr += text; } },
    );
    assert.equal(code, 0, stderr);
    assert.deepEqual(readCronJob(env, "modal-keep")?.command.args, [
      "codex", "--prompt", "x", "--modal", "--modal-keep-sandbox",
    ]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cron add rolls back new jobs when the daemon cannot start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  try {
    const env = testEnv(dir);
    let stderr = "";
    const code = await runCli(
      ["cron", "add", "codex", "--name", "missing-daemon", "--every", "1h", "--prompt", "x"],
      {
        env,
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    assert.equal(code, 2);
    assert.match(stderr, /cron daemon failed to start/);
    assert.equal(readCronJob(env, "missing-daemon"), undefined);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cron daemon tick starts due jobs and collapses overlapping ticks to one pending run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  try {
    const env = testEnv(dir);
    writeFileSync(
      env.HEADLESS_CLI_BIN as string,
      [
        "#!/usr/bin/env node",
        "setTimeout(() => {",
        "  console.log(JSON.stringify({type:'agent_message', text:'finished'}));",
        "}, 100);",
      ].join("\n"),
      { mode: 0o755 },
    );
    recordCronJob(env, {
      agent: "codex",
      command: { args: ["codex", "--prompt", "tick"], workDir: dir },
      id: "tick",
      schedule: parseCronSchedule({ every: "1s" }),
      now: new Date("2026-05-15T12:00:00.000Z"),
    });

    await runDueCronJobsOnce(env, new Date("2026-05-15T12:00:02.000Z"));
    const running = readCronJob(env, "tick");
    assert.ok(running?.activeExecutionId);
    await runDueCronJobsOnce(env, new Date("2026-05-15T12:00:03.000Z"));
    await runDueCronJobsOnce(env, new Date("2026-05-15T12:00:04.000Z"));
    assert.equal(readCronJob(env, "tick")?.pending, true);

    await waitFor(() => {
      const job = readCronJob(env, "tick");
      return Boolean(job?.activeExecutionId && job.activeExecutionId !== running.activeExecutionId);
    });
    await waitFor(() => readCronJob(env, "tick")?.activeExecutionId === null);

    const jobRoot = join(cronRoot(env), "jobs", "tick", "executions");
    const executions = existsSync(jobRoot) ? readFileSync(join(jobRoot, readCronJob(env, "tick")?.lastExecutionId ?? "", "result.json"), "utf8") : "";
    assert.match(executions, /"status": "succeeded"/);
    assert.equal(readCronJob(env, "tick")?.pending, false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cron daemon keeps its signal handlers until active executions are killed", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const sigtermListeners = process.listenerCount("SIGTERM");
  try {
    assert.ok(child.pid);
    await new Promise((resolve) => child.stdout.once("data", resolve));
    const env = testEnv(dir);
    const now = new Date();
    recordCronJob(env, {
      agent: "codex",
      command: { args: ["codex", "--prompt", "tick"], workDir: dir },
      id: "stubborn",
      schedule: parseCronSchedule({ every: "1h" }),
      now,
    });
    const job = readCronJob(env, "stubborn");
    assert.ok(job);
    recordCronJob(env, { ...job, activeExecutionId: "exec-stubborn" });
    const executionRoot = join(cronRoot(env), "jobs", "stubborn", "executions", "exec-stubborn");
    mkdirSync(executionRoot, { recursive: true });
    writeFileSync(join(executionRoot, "result.json"), JSON.stringify({
      version: 1, jobId: "stubborn", executionId: "exec-stubborn", status: "running", pid: child.pid,
      startedAt: now.toISOString(), exitCode: null, signal: null,
      stdoutLog: join(executionRoot, "stdout.log"), stderrLog: join(executionRoot, "stderr.log"),
    }));

    const daemon = runCronDaemon(env);
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.emit("SIGTERM");
    // While it escalates on the stubborn execution, a second SIGTERM must
    // still hit the daemon's handler instead of the default (fatal) action.
    assert.ok(process.listenerCount("SIGTERM") > sigtermListeners, "daemon dropped its SIGTERM handler mid-shutdown");
    process.emit("SIGTERM");
    await daemon;
    assert.equal(child.exitCode !== null || child.signalCode !== null || !processAlive(child.pid), true);
    assert.equal(process.listenerCount("SIGTERM"), sigtermListeners);
  } finally {
    if (child.pid && processAlive(child.pid)) process.kill(child.pid, "SIGKILL");
    rmSync(dir, { force: true, recursive: true });
  }
});

function stubbornGroupLeader(): ReturnType<typeof spawn> {
  return spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
}

function writeRunningExecution(
  env: NodeJS.ProcessEnv,
  record: { pid: number; agentPgid?: number; pidIdentity?: string },
  agentPgidFile?: number,
): string {
  const now = new Date();
  recordCronJob(env, {
    agent: "codex",
    command: { args: ["codex", "--prompt", "tick"], workDir: env.HOME as string },
    id: "retry",
    schedule: parseCronSchedule({ every: "1h" }),
    now,
  });
  const job = readCronJob(env, "retry");
  assert.ok(job);
  recordCronJob(env, { ...job, activeExecutionId: "exec-retry" });
  const executionRoot = join(cronRoot(env), "jobs", "retry", "executions", "exec-retry");
  mkdirSync(executionRoot, { recursive: true });
  writeFileSync(join(executionRoot, "result.json"), JSON.stringify({
    version: 1, jobId: "retry", executionId: "exec-retry", status: "running", startedAt: now.toISOString(),
    exitCode: null, signal: null, stdoutLog: join(executionRoot, "stdout.log"), stderrLog: join(executionRoot, "stderr.log"),
    ...record,
  }));
  if (agentPgidFile !== undefined) writeFileSync(join(executionRoot, "agent.pgid"), `${agentPgidFile}\n`);
  return executionRoot;
}

test("cron kill targets the agent group headless reported last, not a stale persisted one", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  const headless = stubbornGroupLeader();
  const currentAgent = stubbornGroupLeader();
  try {
    await Promise.all([once(headless.stdout, "data"), once(currentAgent.stdout, "data")]);
    const env = testEnv(dir);
    mkdirSync(env.HOME as string, { recursive: true });
    // agentPgid persisted from an earlier (retried) attempt; agent.pgid names the current one.
    const executionRoot = writeRunningExecution(env, { pid: headless.pid!, agentPgid: 2 ** 22 + 7 }, currentAgent.pid!);
    assert.equal(await runCli(["cron", "kill", "retry"], { env, stdout: () => {} }), 0);
    await Promise.all([
      headless.exitCode !== null || headless.signalCode !== null ? undefined : once(headless, "exit"),
      currentAgent.exitCode !== null || currentAgent.signalCode !== null ? undefined : once(currentAgent, "exit"),
    ]);
    assert.equal(currentAgent.signalCode, "SIGKILL");
    const record = JSON.parse(readFileSync(join(executionRoot, "result.json"), "utf8"));
    assert.equal(record.agentPgid, currentAgent.pid);
    assert.equal(record.status, "killed");
  } finally {
    for (const child of [headless, currentAgent]) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cron reconcile treats a zombie headless as dead and sweeps its agent group", { skip: process.platform !== "linux" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  // `sleep 30` (exec'd over sh) never reaps its background child, which
  // therefore stays a zombie: a dead headless that kill(pid, 0) still finds.
  const zombieParent = spawn("sh", ["-c", "sleep 0.05 & echo $!; exec sleep 30"], { stdio: ["ignore", "pipe", "ignore"] });
  const agent = stubbornGroupLeader();
  try {
    const zombiePid = Number(String(await once(zombieParent.stdout, "data")).trim());
    await once(agent.stdout, "data");
    await waitFor(() => readFileSync(`/proc/${zombiePid}/stat`, "utf8").split(") ")[1]?.startsWith("Z") ?? false);
    const env = { ...testEnv(dir), HEADLESS_KILL_GRACE_MS: "200" };
    mkdirSync(env.HOME as string, { recursive: true });
    const executionRoot = writeRunningExecution(env, { pid: zombiePid }, agent.pid!);
    await runDueCronJobsOnce(env, new Date(Date.now() - 60_000));
    if (agent.exitCode === null && agent.signalCode === null) await once(agent, "exit");
    assert.equal(agent.signalCode, "SIGKILL");
    const record = JSON.parse(readFileSync(join(executionRoot, "result.json"), "utf8"));
    assert.equal(record.status, "killed");
    assert.equal(record.signal, "stale");
  } finally {
    for (const child of [zombieParent, agent]) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(dir, { force: true, recursive: true });
  }
});

/**
 * Stand-in for headless under the cron daemon: starts an "agent" in its own
 * group (reported via HEADLESS_AGENT_PGID_FILE unless FAKE_NO_PGID=1) and a
 * helper in headless's own group, records both PIDs, then exits 0 or, with
 * FAKE_SELF_KILL=1, SIGKILLs itself like an OOM kill.
 */
function writeFakeCronHeadless(env: NodeJS.ProcessEnv, pidsFile: string): void {
  const keepAlive = "setInterval(() => {}, 1000)";
  writeFileSync(env.HEADLESS_CLI_BIN as string, [
    "#!/usr/bin/env node",
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const agent = spawn(process.execPath, ['-e', ${JSON.stringify(keepAlive)}], { detached: true, stdio: 'ignore' });`,
    `const helper = spawn(process.execPath, ['-e', ${JSON.stringify(keepAlive)}], { stdio: 'ignore' });`,
    "if (process.env.FAKE_NO_PGID !== '1') writeFileSync(process.env.HEADLESS_AGENT_PGID_FILE, agent.pid + '\\n');",
    `writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ agent: agent.pid, helper: helper.pid }));`,
    "agent.unref(); helper.unref();",
    "setTimeout(() => process.env.FAKE_SELF_KILL === '1' ? process.kill(process.pid, 'SIGKILL') : process.exit(0), 300);",
    "",
  ].join("\n"), { mode: 0o755 });
}

function cronProcessGone(pid: number): boolean {
  if (!processAlive(pid)) return true;
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z") ?? false;
  } catch {
    return true;
  }
}

async function runFakeCronExecution(
  extraArgs: string[],
  fakeEnv: NodeJS.ProcessEnv,
): Promise<{ agentGone: boolean; helperGone: boolean; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  const pidsFile = join(dir, "pids.json");
  const env = { ...testEnv(dir), HEADLESS_KILL_GRACE_MS: "300", ...fakeEnv };
  writeFakeCronHeadless(env, pidsFile);
  recordCronJob(env, {
    agent: "codex",
    command: { args: ["codex", "--prompt", "tick", ...extraArgs], workDir: dir },
    id: "sweep",
    schedule: parseCronSchedule({ every: "1h" }),
    now: new Date("2026-05-15T12:00:00.000Z"),
  });
  await runDueCronJobsOnce(env, new Date("2026-05-15T13:00:01.000Z"));
  await waitFor(() => readCronJob(env, "sweep")?.activeExecutionId === null);
  const pids = JSON.parse(readFileSync(pidsFile, "utf8")) as { agent: number; helper: number };
  const result = { agentGone: cronProcessGone(pids.agent), helperGone: cronProcessGone(pids.helper) };
  return {
    ...result,
    cleanup: () => {
      for (const pid of [pids.agent, pids.helper]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      rmSync(dir, { force: true, recursive: true });
    },
  };
}

test("cron leaves a --keep-background job's processes running after an ordinary exit", { skip: process.platform === "win32" }, async () => {
  const run = await runFakeCronExecution(["--keep-background"], {});
  try {
    assert.equal(run.agentGone, false, "cron swept the agent group despite --keep-background");
  } finally {
    run.cleanup();
  }
});

test("cron sweeps the agent group after an ordinary exit without --keep-background", { skip: process.platform === "win32" }, async () => {
  const run = await runFakeCronExecution([], {});
  try {
    assert.equal(run.agentGone, true);
  } finally {
    run.cleanup();
  }
});

test("cron sweeps headless's own group and the agent group when headless is SIGKILLed, even with --keep-background", { skip: process.platform === "win32" }, async () => {
  const run = await runFakeCronExecution(["--keep-background"], { FAKE_SELF_KILL: "1" });
  try {
    assert.equal(run.agentGone, true, "agent group survived its SIGKILLed headless");
    assert.equal(run.helperGone, true, "headless's own group survived");
  } finally {
    run.cleanup();
  }
});

test("cron sweeps headless's own group when headless dies before reporting agent.pgid", { skip: process.platform === "win32" }, async () => {
  const run = await runFakeCronExecution([], { FAKE_SELF_KILL: "1", FAKE_NO_PGID: "1" });
  try {
    assert.equal(run.helperGone, true, "headless's own group survived");
    // The unreported agent group is the documented residual window.
    assert.equal(run.agentGone, false);
  } finally {
    run.cleanup();
  }
});

function sleeper(): ReturnType<typeof spawn> {
  return spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000);"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
}

test("cron daemon lock is reclaimed after its holder is SIGKILLed", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  const env = testEnv(dir);
  const startDaemon = () => spawn(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval",
    `const { runCronDaemon } = await import(${JSON.stringify(cronModuleUrl)}); await runCronDaemon(process.env);`,
  ], { cwd: repoRoot, env, stdio: ["ignore", "ignore", "pipe"] });
  const daemons: ReturnType<typeof spawn>[] = [];
  try {
    const first = startDaemon();
    daemons.push(first);
    await waitFor(() => readOwnerLockHolder(cronDaemonLockPath(env))?.pid === first.pid);
    first.kill("SIGKILL");
    await once(first, "exit");
    assert.equal(daemonRunning(env), false);

    const second = startDaemon();
    daemons.push(second);
    let stderr = "";
    second.stderr!.on("data", (chunk) => { stderr += String(chunk); });
    await waitFor(() => readOwnerLockHolder(cronDaemonLockPath(env))?.pid === second.pid);
    assert.doesNotMatch(stderr, /already running/);

    let stdout = "";
    assert.equal(await runCli(["cron", "stop"], { env, stdout: (text) => { stdout += text; } }), 0);
    assert.match(stdout, /daemon stopped/);
    const [code] = await once(second, "exit");
    assert.equal(code, 0);
  } finally {
    for (const daemon of daemons) if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cron stop refuses to signal a daemon PID whose start identity changed", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  const unrelated = sleeper();
  try {
    await once(unrelated.stdout!, "data");
    const env = testEnv(dir);
    // The daemon lock names a PID that now belongs to another process.
    forgeDaemonHolder(env, unrelated.pid!, "linux:another-boot:1");
    let stdout = "";
    assert.equal(await runCli(["cron", "stop"], { env, stdout: (text) => { stdout += text; } }), 0);
    assert.match(stdout, /daemon already stopped/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(unrelated.exitCode, null);
    assert.equal(unrelated.signalCode, null);

    // The same PID with its real identity is the daemon: stop signals it.
    forgeDaemonHolder(env, unrelated.pid!, processStartIdentity(unrelated.pid!));
    stdout = "";
    assert.equal(await runCli(["cron", "stop"], { env, stdout: (text) => { stdout += text; } }), 0);
    assert.match(stdout, /daemon stopped/);
    const [, signal] = await once(unrelated, "exit");
    assert.equal(signal, "SIGTERM");
  } finally {
    if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill("SIGKILL");
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cron reconcile and kill refuse to signal an execution PID whose identity changed", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  const unrelated = sleeper();
  try {
    await once(unrelated.stdout!, "data");
    const env = { ...testEnv(dir), HEADLESS_KILL_GRACE_MS: "200" };
    mkdirSync(env.HOME as string, { recursive: true });
    // The stored headless PID (and agent group) now name an unrelated process.
    const executionRoot = writeRunningExecution(env, { pid: unrelated.pid!, pidIdentity: "linux:another-boot:1" });
    writeFileSync(join(executionRoot, "agent.pgid"), `${unrelated.pid}\nlinux:another-boot:2\n`);
    assert.equal(await runCli(["cron", "kill", "retry"], { env, stdout: () => {} }), 0);
    await runDueCronJobsOnce(env, new Date(Date.now() - 60_000));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(unrelated.exitCode, null);
    assert.equal(unrelated.signalCode, null);
    assert.equal(readCronJob(env, "retry")?.activeExecutionId, null);
  } finally {
    if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill("SIGKILL");
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cron pause during daemon shutdown survives the shutdown kill", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  const child = stubbornGroupLeader();
  try {
    await once(child.stdout!, "data");
    const env = testEnv(dir);
    mkdirSync(env.HOME as string, { recursive: true });
    writeRunningExecution(env, { pid: child.pid! });
    const daemon = runCronDaemon(env);
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.emit("SIGTERM");
    // The daemon is now escalating on the stubborn execution (500ms grace).
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await runCli(["cron", "pause", "retry"], { env, stdout: () => {} }), 0);
    await daemon;
    const job = readCronJob(env, "retry");
    assert.equal(job?.status, "paused");
    assert.equal(job?.activeExecutionId, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(dir, { force: true, recursive: true });
  }
});

/**
 * A pending job whose headless exits promptly on SIGTERM while its agent group
 * ignores it: the daemon sees the execution finish while `cron kill`/`rm` is
 * still escalating on the agent.
 */
async function startPendingKillableJob(dir: string, id: string): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => void }> {
  const env = testEnv(dir);
  const pidsFile = join(dir, "pids");
  writeFileSync(env.HEADLESS_CLI_BIN as string, [
    "#!/usr/bin/env node",
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    `const agent = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: 'ignore' });`,
    "fs.writeFileSync(process.env.HEADLESS_AGENT_PGID_FILE, agent.pid + '\\n');",
    `fs.appendFileSync(${JSON.stringify(pidsFile)}, process.pid + ' ' + agent.pid + '\\n');`,
    "agent.unref();",
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"), { mode: 0o755 });
  recordCronJob(env, {
    agent: "codex",
    // --keep-background: an ordinary headless exit finishes the execution at once.
    command: { args: ["codex", "--prompt", "tick", "--keep-background"], workDir: dir },
    id,
    schedule: parseCronSchedule({ every: "1s" }),
    now: new Date("2026-05-15T12:00:00.000Z"),
  });
  await runDueCronJobsOnce(env, new Date("2026-05-15T12:00:02.000Z"));
  await runDueCronJobsOnce(env, new Date("2026-05-15T12:00:04.000Z"));
  assert.equal(readCronJob(env, id)?.pending, true);
  await waitFor(() => existsSync(pidsFile));
  await new Promise((resolve) => setTimeout(resolve, 300)); // agent installs its SIGTERM handler
  const pids = () => readFileSync(pidsFile, "utf8").trim().split(/\s+/).map(Number);
  return {
    env,
    cleanup: () => {
      for (const pid of existsSync(pidsFile) ? pids() : []) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    },
  };
}

function executionCount(env: NodeJS.ProcessEnv, id: string): number {
  const root = join(cronRoot(env), "jobs", id, "executions");
  return existsSync(root) ? readdirSync(root).length : 0;
}

test("cron kill of a pending job does not leave a respawned execution running untracked", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  let cleanup = () => {};
  try {
    const started = await startPendingKillableJob(dir, "pending");
    cleanup = started.cleanup;
    const { env } = started;
    assert.equal(await runCli(["cron", "kill", "pending"], { env, stdout: () => {} }), 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const job = readCronJob(env, "pending");
    assert.equal(job?.status, "disabled");
    assert.equal(job?.activeExecutionId, null);
    assert.equal(executionCount(env, "pending"), 1, "the kill respawned a pending execution");
  } finally {
    cleanup();
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cron rm --force leaves nothing behind that resurrects the job", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  let cleanup = () => {};
  try {
    const started = await startPendingKillableJob(dir, "doomed");
    cleanup = started.cleanup;
    const { env } = started;
    assert.equal(await runCli(["cron", "rm", "doomed", "--force"], { env, stdout: () => {} }), 0);
    // Anything still running for the job now exits and reports back.
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await runDueCronJobsOnce(env, new Date("2026-05-15T12:00:09.000Z"));
    assert.equal(readCronJob(env, "doomed"), undefined);
    assert.equal(existsSync(join(cronRoot(env), "jobs", "doomed")), false);
  } finally {
    cleanup();
    rmSync(dir, { force: true, recursive: true });
  }
});

test("concurrent cron pause from another process vs daemon completion keeps every pause", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  try {
    const env = testEnv(dir);
    const goPath = join(dir, "go");
    // Executions finish the moment the go file appears, racing the pauses.
    writeFileSync(env.HEADLESS_CLI_BIN as string, [
      "#!/usr/bin/env node",
      "const { existsSync } = require('node:fs');",
      `const poll = setInterval(() => { if (existsSync(${JSON.stringify(goPath)})) { clearInterval(poll); console.log('done'); } }, 1);`,
      "",
    ].join("\n"), { mode: 0o755 });
    const ids = Array.from({ length: 6 }, (_, index) => `race-${index}`);
    for (const id of ids) {
      recordCronJob(env, {
        agent: "codex",
        command: { args: ["codex", "--prompt", "tick"], workDir: dir },
        id,
        schedule: parseCronSchedule({ every: "1s" }),
        now: new Date("2026-05-15T12:00:00.000Z"),
      });
    }
    await runDueCronJobsOnce(env, new Date("2026-05-15T12:00:02.000Z"));
    // A second due tick marks each running job pending: completion respawns.
    await runDueCronJobsOnce(env, new Date("2026-05-15T12:00:04.000Z"));
    assert.ok(ids.every((id) => readCronJob(env, id)?.pending));

    const pauser = spawn(process.execPath, [
      "--import", "tsx", "--input-type=module", "--eval",
      [
        `import { existsSync } from "node:fs";`,
        `const { runCli } = await import(${JSON.stringify(cliModuleUrl)});`,
        `process.stdout.write("ready\\n");`,
        `while (!existsSync(${JSON.stringify(goPath)})) await new Promise((resolve) => setTimeout(resolve, 1));`,
        `for (const id of ${JSON.stringify(ids)}) if (await runCli(["cron", "pause", id], { stdout: () => {} }) !== 0) process.exit(1);`,
      ].join("\n"),
    ], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "inherit"] });
    await once(pauser.stdout!, "data");
    writeFileSync(goPath, "");
    const [code] = await once(pauser, "exit");
    assert.equal(code, 0);
    await waitFor(() => ids.every((id) => readCronJob(env, id)?.activeExecutionId === null));
    for (const id of ids) assert.equal(readCronJob(env, id)?.status, "paused", id);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("inside a headless Docker container, cron add/start, the daemon and --docker are refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  try {
    const env = { ...testEnv(dir), HEADLESS_IN_CONTAINER: "1" };
    mkdirSync(env.HOME as string, { recursive: true });
    const run = async (argv: string[]) => {
      let stderr = "";
      const code = await runCli(argv, { env, stdout: () => {}, stderr: (text) => { stderr += text; } });
      return { code, stderr };
    };
    for (const argv of [
      ["cron", "start"],
      ["cron", "add", "codex", "--name", "inside", "--every", "1h", "--prompt", "x"],
      ["cron-daemon"],
      ["codex", "--docker", "--prompt", "x"],
      ["codex", "--docker", "--session", "work", "--prompt", "x"],
    ]) {
      const { code, stderr } = await run(argv);
      assert.equal(code, 2, argv.join(" "));
      assert.match(stderr, /must run on the host, not inside a headless Docker container/, argv.join(" "));
    }
    await assert.rejects(runCronDaemon(env), /must run on the host/);
    assert.equal(daemonRunning(env), false);
    assert.equal(readCronJob(env, "inside"), undefined);
    // Everything else still works inside the container.
    assert.equal((await run(["cron", "list"])).code, 0);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
