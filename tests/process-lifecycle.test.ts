import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runAcpClient } from "../src/acp.ts";
import { runCli } from "../src/cli.ts";
import { cronRoot, parseCronSchedule, readCronJob, recordCronJob, runDueCronJobsOnce } from "../src/cron.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const posixOnly = { skip: process.platform === "win32" };

async function waitFor(assertion: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(assertion(), true);
}

// A killed process whose parent already exited is reparented to PID 1. In
// containers whose PID 1 never reaps (e.g. an agent CLI running as init), it
// then lingers as a zombie that kill(pid, 0) still reports. A zombie has
// terminated, so count it as gone.
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "EPERM";
  }
  if (process.platform !== "linux") return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return true;
  }
}

function readPid(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const pid = Number(readFileSync(path, "utf8"));
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function killQuietly(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/**
 * Writes a fake agent binary that records its PID, spawns a long-sleeping
 * grandchild (stdio detached from headless) and records that PID too. With
 * HEADLESS_TEST_IGNORE_TERM=1 both ignore SIGTERM (=grandchild: only the
 * grandchild, so the agent exits at once and leaves it behind); with HEADLESS_TEST_SETSID=1
 * the grandchild calls setsid (detached spawn) and so leaves the agent's group.
 */
function writeFakeAgent(binDir: string, name: string): void {
  mkdirSync(binDir, { recursive: true });
  const grandchild = [
    "if (process.env.HEADLESS_TEST_IGNORE_TERM === '1' || process.env.HEADLESS_TEST_IGNORE_TERM === 'grandchild') process.on('SIGTERM', () => {});",
    "setTimeout(() => {}, 120_000);",
  ].join("\n");
  const binary = join(binDir, name);
  writeFileSync(
    binary,
    [
      `#!${process.execPath}`,
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "if (process.env.HEADLESS_TEST_IGNORE_TERM === '1') process.on('SIGTERM', () => {});",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore', detached: process.env.HEADLESS_TEST_SETSID === '1' });`,
      "writeFileSync(process.env.HEADLESS_TEST_GRANDCHILD_PID, String(child.pid));",
      "writeFileSync(process.env.HEADLESS_TEST_AGENT_PID, String(process.pid));",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
  chmodSync(binary, 0o755);
}

async function signalOneShotRun(options: { ignoreTerm: boolean; setsid?: boolean }): Promise<{
  exit: { code: number | null; signal: NodeJS.Signals | null };
  elapsedMs: number;
  agentPid: number;
  grandchildPid: number;
}> {
  const dir = mkdtempSync(join(tmpdir(), "headless-lifecycle-test-"));
  const agentPidFile = join(dir, "agent.pid");
  const grandchildPidFile = join(dir, "grandchild.pid");
  const binDir = join(dir, "bin");
  writeFakeAgent(binDir, "claude");
  let headless: ReturnType<typeof spawn> | undefined;
  try {
    // No --timeout: this is the path that used to leave the agent behind.
    headless = spawn(
      process.execPath,
      ["--import", "tsx", join(repoRoot, "src", "cli.ts"), "claude", "--prompt", "hello"],
      {
        env: {
          ...process.env,
          HEADLESS_KILL_GRACE_MS: "500",
          HEADLESS_TEST_AGENT_PID: agentPidFile,
          HEADLESS_TEST_GRANDCHILD_PID: grandchildPidFile,
          HEADLESS_TEST_IGNORE_TERM: options.ignoreTerm ? "1" : "0",
          HEADLESS_TEST_SETSID: options.setsid ? "1" : "0",
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
        stdio: "ignore",
      },
    );
    await waitFor(() => readPid(agentPidFile) !== undefined, 10_000);
    const agentPid = readPid(agentPidFile)!;
    const grandchildPid = readPid(grandchildPidFile)!;
    // Let the grandchild install its SIGTERM handler.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      headless?.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const started = Date.now();
    headless.kill("SIGTERM");
    const exit = await exited;
    const elapsedMs = Date.now() - started;
    // headless must not exit before its whole tree is gone.
    assert.ok(processGone(agentPid), "agent outlived headless");
    assert.ok(processGone(grandchildPid), "grandchild outlived headless");
    return { exit, elapsedMs, agentPid, grandchildPid };
  } finally {
    if (headless && headless.exitCode === null && headless.signalCode === null) headless.kill("SIGKILL");
    killQuietly(readPid(agentPidFile));
    killQuietly(readPid(grandchildPidFile));
    rmSync(dir, { force: true, recursive: true });
  }
}

test("SIGTERM to a one-shot run without a timeout kills the agent and its grandchild", posixOnly, async () => {
  const result = await signalOneShotRun({ ignoreTerm: false });
  assert.deepEqual(result.exit, { code: null, signal: "SIGTERM" });
  assert.ok(processGone(result.agentPid));
  assert.ok(processGone(result.grandchildPid));
});

test("an agent tree that ignores SIGTERM is SIGKILLed after the grace period", posixOnly, async () => {
  const result = await signalOneShotRun({ ignoreTerm: true });
  assert.deepEqual(result.exit, { code: null, signal: "SIGTERM" });
  assert.ok(result.elapsedMs >= 450, `headless exited after ${result.elapsedMs}ms, before the grace period`);
  assert.ok(processGone(result.agentPid));
  assert.ok(processGone(result.grandchildPid));
});

test("a grandchild that escaped the agent's group with setsid is still killed", posixOnly, async () => {
  const result = await signalOneShotRun({ ignoreTerm: true, setsid: true });
  assert.deepEqual(result.exit, { code: null, signal: "SIGTERM" });
  assert.ok(processGone(result.agentPid));
  assert.ok(processGone(result.grandchildPid));
});

test("embedded runCli does not resolve on a host-owned signal until the agent tree is dead", posixOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-lifecycle-embedded-test-"));
  const agentPidFile = join(dir, "agent.pid");
  const grandchildPidFile = join(dir, "grandchild.pid");
  const binDir = join(dir, "bin");
  writeFakeAgent(binDir, "claude");
  // The embedding host owns SIGTERM, so headless must not re-raise it.
  const hostListener = () => {};
  process.on("SIGTERM", hostListener);
  const listenersBefore = process.listeners("SIGINT").length;
  try {
    const run = runCli(["claude", "--prompt", "hello"], {
      env: {
        ...process.env,
        HEADLESS_KILL_GRACE_MS: "300",
        HEADLESS_TEST_AGENT_PID: agentPidFile,
        HEADLESS_TEST_GRANDCHILD_PID: grandchildPidFile,
        // The agent exits on SIGTERM at once; only its grandchild lingers.
        HEADLESS_TEST_IGNORE_TERM: "grandchild",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: () => {},
      stderr: () => {},
    });
    await waitFor(() => readPid(agentPidFile) !== undefined, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    process.emit("SIGTERM");
    await run;
    // An embedder may process.exit() right now: nothing may be left behind.
    assert.ok(processGone(readPid(agentPidFile)!), "agent outlived runCli");
    assert.ok(processGone(readPid(grandchildPidFile)!), "grandchild outlived runCli");
    assert.equal(process.listeners("SIGINT").length, listenersBefore);
  } finally {
    process.off("SIGTERM", hostListener);
    killQuietly(readPid(agentPidFile));
    killQuietly(readPid(grandchildPidFile));
    rmSync(dir, { force: true, recursive: true });
  }
});

interface CronAgentExecution {
  dir: string;
  env: NodeJS.ProcessEnv;
  executionId: string;
  headlessPid: number;
  agentPid: number;
  grandchildPid: number;
  agentPidFile: string;
  grandchildPidFile: string;
}

/** Starts a real cron execution of headless whose fake agent ignores SIGTERM and has a grandchild. */
async function startCronAgentExecution(): Promise<CronAgentExecution> {
  const dir = mkdtempSync(join(tmpdir(), "headless-lifecycle-cron-test-"));
  const agentPidFile = join(dir, "agent.pid");
  const grandchildPidFile = join(dir, "grandchild.pid");
  const binDir = join(dir, "bin");
  writeFakeAgent(binDir, "codex");
  const headlessBin = join(dir, "headless");
  writeFileSync(
    headlessBin,
    ["#!/bin/sh", `exec "${process.execPath}" --import tsx "${join(repoRoot, "src", "cli.ts")}" "$@"`, ""].join("\n"),
  );
  chmodSync(headlessBin, 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(dir, "home"),
    HEADLESS_CRON_DIR: join(dir, "cron"),
    HEADLESS_CLI_BIN: headlessBin,
    HEADLESS_KILL_GRACE_MS: "500",
    HEADLESS_TEST_AGENT_PID: agentPidFile,
    HEADLESS_TEST_GRANDCHILD_PID: grandchildPidFile,
    HEADLESS_TEST_IGNORE_TERM: "1",
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  };
  mkdirSync(env.HOME as string, { recursive: true });
  recordCronJob(env, {
    agent: "codex",
    // repoRoot so the wrapper's `--import tsx` resolves.
    command: { args: ["codex", "--prompt", "tick"], workDir: repoRoot },
    id: "lifecycle",
    schedule: parseCronSchedule({ every: "1h" }),
    now: new Date("2026-05-15T12:00:00.000Z"),
  });
  await runDueCronJobsOnce(env, new Date("2026-05-15T13:00:01.000Z"));
  const executionId = readCronJob(env, "lifecycle")?.activeExecutionId;
  assert.ok(executionId);
  const headlessPid = readExecutionRecord(env, executionId).pid;
  await waitFor(() => readPid(agentPidFile) !== undefined, 10_000);
  // Let the agent and grandchild install their SIGTERM handlers.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return {
    dir, env, executionId, headlessPid, agentPidFile, grandchildPidFile,
    agentPid: readPid(agentPidFile)!,
    grandchildPid: readPid(grandchildPidFile)!,
  };
}

function readExecutionRecord(env: NodeJS.ProcessEnv, executionId: string) {
  return JSON.parse(
    readFileSync(join(cronRoot(env), "jobs", "lifecycle", "executions", executionId, "result.json"), "utf8"),
  ) as { pid: number; agentPgid?: number | null; status: string };
}

function cleanupCronAgentExecution(execution: CronAgentExecution | undefined): void {
  if (!execution) return;
  try {
    process.kill(execution.headlessPid, "SIGCONT");
  } catch {
    // Already gone.
  }
  killQuietly(execution.headlessPid);
  killQuietly(readPid(execution.agentPidFile));
  killQuietly(readPid(execution.grandchildPidFile));
  rmSync(execution.dir, { force: true, recursive: true });
}

test("cron kill terminates the agent's grandchild, not just the headless process", posixOnly, async () => {
  let execution: CronAgentExecution | undefined;
  try {
    execution = await startCronAgentExecution();
    const { env, headlessPid, agentPid, grandchildPid } = execution;
    assert.equal(await runCli(["cron", "kill", "lifecycle"], { env, stdout: () => {} }), 0);
    // cron kill returns only after the whole tree is gone.
    assert.ok(processGone(headlessPid) && processGone(agentPid) && processGone(grandchildPid));
  } finally {
    cleanupCronAgentExecution(execution);
  }
});

test("cron kill reaches the agent's group directly when headless cannot forward", posixOnly, async () => {
  let execution: CronAgentExecution | undefined;
  try {
    execution = await startCronAgentExecution();
    const { env, executionId, headlessPid, agentPid, grandchildPid } = execution;
    // A stopped headless can neither forward signals nor escalate.
    process.kill(headlessPid, "SIGSTOP");
    assert.equal(await runCli(["cron", "kill", "lifecycle"], { env, stdout: () => {} }), 0);
    assert.ok(processGone(agentPid), "agent survived cron kill");
    assert.ok(processGone(grandchildPid), "grandchild survived cron kill");
    assert.equal(readExecutionRecord(env, executionId).status, "killed");
  } finally {
    cleanupCronAgentExecution(execution);
  }
});

test("cron sweeps the agent's group when headless itself is SIGKILLed", posixOnly, async () => {
  let execution: CronAgentExecution | undefined;
  try {
    execution = await startCronAgentExecution();
    const { env, executionId, headlessPid, agentPid, grandchildPid } = execution;
    // An OOM-kill or SIGKILL gives headless no chance to clean up.
    process.kill(headlessPid, "SIGKILL");
    await waitFor(() => readExecutionRecord(env, executionId).status !== "running");
    assert.ok(processGone(agentPid), "agent survived its headless");
    assert.ok(processGone(grandchildPid), "grandchild survived its headless");
    assert.equal(readExecutionRecord(env, executionId).agentPgid, agentPid);
  } finally {
    cleanupCronAgentExecution(execution);
  }
});

/**
 * Minimal ACP server that ignores SIGTERM and stdin EOF and spawns a
 * background child that also ignores SIGTERM. HEADLESS_TEST_CHILD_STDIO picks
 * the child's stdio ("ignore" or "inherit", the latter holding our stdout).
 * With HEADLESS_TEST_DIE_ON_INITIALIZE=1 the server exits on `initialize`
 * without answering, leaving the child behind.
 */
function writeFakeAcpServer(dir: string): string {
  const server = join(dir, "acp-server.js");
  const background = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  writeFileSync(
    server,
    [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(background)}], { stdio: ['ignore', process.env.HEADLESS_TEST_CHILD_STDIO, 'ignore'] });`,
      "writeFileSync(process.env.HEADLESS_TEST_SERVER_PID, `${process.pid} ${child.pid}`);",
      "setInterval(() => {}, 1000);",
      "const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');",
      "let buffer = '';",
      "process.stdin.setEncoding('utf8');",
      // Answer only once the background child has installed its SIGTERM handler.
      "setTimeout(() => process.stdin.on('data', (chunk) => {",
      "  buffer += chunk;",
      "  let newline;",
      "  while ((newline = buffer.indexOf('\\n')) >= 0) {",
      "    const line = buffer.slice(0, newline);",
      "    buffer = buffer.slice(newline + 1);",
      "    if (!line.trim()) continue;",
      "    const request = JSON.parse(line);",
      "    if (request.method === 'initialize') {",
      "      if (process.env.HEADLESS_TEST_DIE_ON_INITIALIZE === '1') process.exit(3);",
      "      send({ id: request.id, result: { protocolVersion: request.params.protocolVersion, agentCapabilities: {} } });",
      "    } else if (request.method === 'session/new') {",
      "      send({ id: request.id, result: { sessionId: 'stubborn' } });",
      "    } else if (request.method === 'session/prompt') {",
      "      send({ method: 'session/update', params: { sessionId: 'stubborn', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } });",
      "      send({ id: request.id, result: { stopReason: 'end_turn' } });",
      "    } else if (request.id !== undefined) {",
      "      send({ id: request.id, error: { code: -32601, message: 'unsupported' } });",
      "    }",
      "  }",
      "}), 300);",
      "",
    ].join("\n"),
  );
  return server;
}

function readPids(path: string): number[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split(" ").map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function runFakeAcp(extraEnv: NodeJS.ProcessEnv): Promise<{
  code: number;
  stdout: string;
  elapsedMs: number;
  serverGone: boolean;
  backgroundGone: boolean;
}> {
  const dir = mkdtempSync(join(tmpdir(), "headless-lifecycle-acp-test-"));
  const pidFile = join(dir, "server.pid");
  const server = writeFakeAcpServer(dir);
  try {
    const stdout: string[] = [];
    const started = Date.now();
    const code = await runAcpClient({
      agentCommand: { command: process.execPath, args: [server] },
      prompt: "hello",
      env: { ...process.env, HEADLESS_KILL_GRACE_MS: "300", HEADLESS_TEST_SERVER_PID: pidFile, ...extraEnv },
      stdout: (text) => stdout.push(text),
      stderr: () => {},
    });
    const elapsedMs = Date.now() - started;
    const [serverPid, backgroundPid] = readPids(pidFile);
    assert.ok(serverPid && backgroundPid);
    // Sample liveness now, before the cleanup below kills any survivors.
    return {
      code,
      stdout: stdout.join(""),
      elapsedMs,
      serverGone: processGone(serverPid),
      backgroundGone: processGone(backgroundPid),
    };
  } finally {
    for (const pid of readPids(pidFile)) killQuietly(pid);
    rmSync(dir, { force: true, recursive: true });
  }
}

test("ACP shutdown is bounded and kills the server's descendants when they ignore SIGTERM", posixOnly, async () => {
  const result = await runFakeAcp({ HEADLESS_TEST_CHILD_STDIO: "ignore" });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /done/);
  assert.ok(result.serverGone, "ACP server survived shutdown");
  assert.ok(result.backgroundGone, "ACP server's background child survived shutdown");
  assert.ok(result.elapsedMs < 3000, `ACP shutdown took ${result.elapsedMs}ms`);
});

test("ACP client fails promptly when the server dies mid-initialize while a child holds its stdout", posixOnly, async () => {
  const result = await runFakeAcp({ HEADLESS_TEST_CHILD_STDIO: "inherit", HEADLESS_TEST_DIE_ON_INITIALIZE: "1" });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /ACP server exited/);
  assert.ok(result.backgroundGone, "ACP server's background child survived");
  assert.ok(result.elapsedMs < 3000, `ACP failure took ${result.elapsedMs}ms`);
});

test("ACP client reports a server that cannot be spawned instead of crashing", async () => {
  const stderr: string[] = [];
  const code = await runAcpClient({
    agentCommand: { command: join(tmpdir(), "headless-missing-acp-server"), args: [] },
    prompt: "hello",
    env: { ...process.env, HEADLESS_KILL_GRACE_MS: "300" },
    stdout: () => {},
    stderr: (text) => stderr.push(text),
  });
  assert.notEqual(code, 0);
  assert.match(stderr.join(""), /ENOENT/);
});
