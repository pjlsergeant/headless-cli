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
 * HEADLESS_TEST_IGNORE_TERM=1 both ignore SIGTERM.
 */
function writeFakeAgent(binDir: string, name: string): void {
  mkdirSync(binDir, { recursive: true });
  const grandchild = [
    "if (process.env.HEADLESS_TEST_IGNORE_TERM === '1') process.on('SIGTERM', () => {});",
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
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });`,
      "writeFileSync(process.env.HEADLESS_TEST_GRANDCHILD_PID, String(child.pid));",
      "writeFileSync(process.env.HEADLESS_TEST_AGENT_PID, String(process.pid));",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
  chmodSync(binary, 0o755);
}

async function signalOneShotRun(options: { ignoreTerm: boolean }): Promise<{
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
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
        stdio: "ignore",
      },
    );
    await waitFor(() => readPid(agentPidFile) !== undefined, 10_000);
    const agentPid = readPid(agentPidFile)!;
    const grandchildPid = readPid(grandchildPidFile)!;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      headless?.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const started = Date.now();
    headless.kill("SIGTERM");
    const exit = await exited;
    const elapsedMs = Date.now() - started;
    await waitFor(() => processGone(agentPid) && processGone(grandchildPid));
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

test("cron kill terminates the agent's grandchild, not just the headless process", posixOnly, async () => {
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
  let headlessPid: number | undefined;
  try {
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
    const result = JSON.parse(
      readFileSync(join(cronRoot(env), "jobs", "lifecycle", "executions", executionId, "result.json"), "utf8"),
    );
    headlessPid = result.pid;
    await waitFor(() => readPid(agentPidFile) !== undefined, 10_000);
    const agentPid = readPid(agentPidFile)!;
    const grandchildPid = readPid(grandchildPidFile)!;

    assert.equal(await runCli(["cron", "kill", "lifecycle"], { env, stdout: () => {} }), 0);

    await waitFor(() => processGone(headlessPid!) && processGone(agentPid) && processGone(grandchildPid));
  } finally {
    killQuietly(headlessPid);
    killQuietly(readPid(agentPidFile));
    killQuietly(readPid(grandchildPidFile));
    rmSync(dir, { force: true, recursive: true });
  }
});

test("ACP shutdown is bounded when the server ignores SIGTERM", posixOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-lifecycle-acp-test-"));
  const serverPidFile = join(dir, "server.pid");
  const server = join(dir, "acp-server.js");
  // Minimal ACP server that ignores SIGTERM and stdin EOF, so only SIGKILL
  // can end it once the prompt is answered.
  writeFileSync(
    server,
    [
      "const { writeFileSync } = require('node:fs');",
      "writeFileSync(process.env.HEADLESS_TEST_SERVER_PID, String(process.pid));",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
      "const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');",
      "let buffer = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += chunk;",
      "  let newline;",
      "  while ((newline = buffer.indexOf('\\n')) >= 0) {",
      "    const line = buffer.slice(0, newline);",
      "    buffer = buffer.slice(newline + 1);",
      "    if (!line.trim()) continue;",
      "    const request = JSON.parse(line);",
      "    if (request.method === 'initialize') {",
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
      "});",
      "",
    ].join("\n"),
  );
  let serverPid: number | undefined;
  try {
    const stdout: string[] = [];
    const started = Date.now();
    const code = await runAcpClient({
      agentCommand: { command: process.execPath, args: [server] },
      prompt: "hello",
      env: { ...process.env, HEADLESS_KILL_GRACE_MS: "300", HEADLESS_TEST_SERVER_PID: serverPidFile },
      stdout: (text) => stdout.push(text),
      stderr: () => {},
    });
    const elapsedMs = Date.now() - started;
    serverPid = readPid(serverPidFile);
    assert.equal(code, 0);
    assert.match(stdout.join(""), /done/);
    assert.ok(serverPid);
    assert.ok(processGone(serverPid), "ACP server survived shutdown");
    assert.ok(elapsedMs < 3000, `ACP shutdown took ${elapsedMs}ms`);
  } finally {
    killQuietly(serverPid);
    rmSync(dir, { force: true, recursive: true });
  }
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
