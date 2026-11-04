import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import {
  appendNodeLog,
  completeIdleRunNodes,
  nodeLogPath,
  readRun,
  registerNode,
  runDirectory,
  updateNodeStatus,
  type RegisterNodeInput,
} from "../src/runs.ts";

async function writeExecutable(path: string, source: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, source);
  await chmod(path, 0o755);
}

function worker(nodeId: string, sandbox: RegisterNodeInput["sandbox"] = "none"): RegisterNodeInput {
  return { runId: "auth", nodeId, role: "worker", agent: "codex", coordination: "oneshot", status: "idle", sandbox };
}

function tamper(env: { HOME: string }, mutate: (run: Record<string, any>) => void): void {
  const path = join(runDirectory(env, "auth"), "run.json");
  const run = JSON.parse(readFileSync(path, "utf8"));
  mutate(run);
  writeFileSync(path, JSON.stringify(run));
}

test("hostile log paths in run state never redirect host log writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-trust-"));
  try {
    const env = { HOME: join(dir, "home") };
    const canary = join(dir, "canary");
    writeFileSync(canary, "original\n");
    registerNode(env, worker("worker-1"));
    tamper(env, (run) => {
      run.nodes["worker-1"].logs = { stdout: canary, stderr: canary };
    });

    appendNodeLog(env, "auth", "worker-1", "stdout", "agent output\n");
    appendNodeLog(env, "auth", "worker-1", "stderr", "agent error\n");
    updateNodeStatus(env, "auth", "worker-1", "busy");

    assert.equal(readFileSync(canary, "utf8"), "original\n");
    assert.equal(readFileSync(nodeLogPath(env, "auth", "worker-1", "stdout"), "utf8"), "agent output\n");
    assert.equal(nodeLogPath(env, "auth", "worker-1", "stdout"), join(runDirectory(env, "auth"), "nodes", "worker-1", "latest.stdout.log"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("traversal node keys in run state are dropped and never chmodded", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-trust-"));
  try {
    const env = { HOME: join(dir, "home") };
    const outside = join(dir, "project");
    mkdirSync(outside);
    chmodSync(outside, 0o755);
    registerNode(env, worker("worker-1"));
    const traversal = "../../../../project";
    tamper(env, (run) => {
      run.nodes[traversal] = { ...run.nodes["worker-1"], nodeId: traversal };
      run.nodes["mismatch"] = { ...run.nodes["worker-1"] };
    });

    const run = readRun(env, "auth");
    assert.deepEqual(Object.keys(run?.nodes ?? {}), ["worker-1"]);
    updateNodeStatus(env, "auth", "worker-1", "busy");
    registerNode(env, worker("worker-2"));
    completeIdleRunNodes(env, "auth", "worker-1");

    assert.equal(statSync(outside).mode & 0o777, 0o755);
    assert.throws(() => updateNodeStatus(env, "auth", traversal, "busy"), /invalid node/);
    assert.throws(() => appendNodeLog(env, "auth", traversal, "stdout", "x"), /invalid node/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("symlinks planted in the run store are not followed", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-trust-"));
  try {
    const env = { HOME: join(dir, "home") };
    const canary = join(dir, "canary");
    const outside = join(dir, "outside");
    writeFileSync(canary, "original\n");
    mkdirSync(outside);
    chmodSync(outside, 0o755);
    registerNode(env, worker("worker-1"));
    registerNode(env, worker("worker-2"));
    const nodes = join(runDirectory(env, "auth"), "nodes");
    symlinkSync(canary, join(nodes, "worker-1", "latest.stdout.log"));
    rmSync(join(nodes, "worker-2"), { recursive: true });
    symlinkSync(outside, join(nodes, "worker-2"));

    assert.throws(() => appendNodeLog(env, "auth", "worker-1", "stdout", "pwned\n"));
    assert.throws(() => appendNodeLog(env, "auth", "worker-2", "stdout", "pwned\n"), /not a directory/);
    assert.equal(readFileSync(canary, "utf8"), "original\n");
    assert.equal(statSync(outside).mode & 0o777, 0o755);
    assert.equal(existsSync(join(outside, "latest.stdout.log")), false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("HEADLESS_RUN_DIR resolves only its own run", () => {
  const env = { HOME: "/home/u", HEADLESS_RUN_DIR: "/headless-runs/auth" };
  assert.equal(runDirectory(env, "auth"), "/headless-runs/auth");
  assert.throws(() => runDirectory(env, "other"), /HEADLESS_RUN_DIR is for run auth/);
  assert.throws(() => runDirectory({ HOME: "/home/u" }, "../x"), /invalid run/);
});

test("registerNode never replaces run state it cannot parse", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-trust-"));
  try {
    const env = { HOME: join(dir, "home") };
    registerNode(env, worker("worker-1"));
    const path = join(runDirectory(env, "auth"), "run.json");
    writeFileSync(path, "{ not json");
    assert.throws(() => registerNode(env, worker("worker-2")), /unreadable/);
    assert.equal(readFileSync(path, "utf8"), "{ not json");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("writeRun appends every event a transaction adds", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-trust-"));
  try {
    const env = { HOME: join(dir, "home") };
    registerNode(env, { ...worker("orchestrator"), role: "orchestrator" });
    registerNode(env, worker("worker-1"));
    registerNode(env, worker("worker-2"));
    completeIdleRunNodes(env, "auth", "orchestrator");
    const events = readFileSync(join(runDirectory(env, "auth"), "events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const completed = events.filter((event) => event.type === "node_completed").map((event) => event.nodeId).sort();
    assert.deepEqual(completed, ["orchestrator", "worker-1", "worker-2"]);
    assert.equal(events[0].type, "run_started");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a sandboxed node is never relaunched on the host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-trust-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const marker = join(dir, "ran-on-host");
    mkdirSync(home);
    await writeExecutable(join(binDir, "codex"), [
      "#!/usr/bin/env node",
      "require('node:fs').writeFileSync(process.env.HEADLESS_MARKER, process.cwd());",
      "console.log(JSON.stringify({ type: 'agent_message', text: 'ran' }));",
      "",
    ].join("\n"));
    const env = { ...process.env, HOME: home, HEADLESS_MARKER: marker, PATH: `${binDir}:${process.env.PATH ?? ""}` };
    registerNode(env, { ...worker("worker-1", "docker"), workDir: dir, allow: "read-only" });
    tamper({ HOME: home }, (run) => {
      run.nodes["worker-1"].workDir = home;
      run.nodes["worker-1"].allow = "yolo";
    });

    for (const extra of [[], ["--async"]]) {
      const stderr: string[] = [];
      const code = await runCli(["run", "message", "auth", "worker-1", "--prompt", "hi", ...extra], {
        env, stdout: () => undefined, stderr: (text) => stderr.push(text),
      });
      assert.notEqual(code, 0);
      assert.match(stderr.join(""), /runs in docker; headless cannot relaunch it on the host/);
    }
    // A direct relaunch must use the node's sandbox too.
    const stderr: string[] = [];
    const code = await runCli(["codex", "--role", "worker", "--run", "auth", "--node", "worker-1", "--prompt", "hi"], {
      env, stdout: () => undefined, stderr: (text) => stderr.push(text),
    });
    assert.notEqual(code, 0);
    assert.match(stderr.join(""), /launched with sandbox docker/);
    assert.equal(existsSync(marker), false);
    assert.equal(readRun(env, "auth")?.nodes["worker-1"].status, "idle");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
