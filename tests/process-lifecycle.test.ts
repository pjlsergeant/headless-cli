import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
