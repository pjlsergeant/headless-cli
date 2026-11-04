import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import {
  mailboxLimits,
  prepareMailbox,
  RunMailboxService,
  type MailboxPaths,
} from "../src/run-mailbox.ts";
import { nodeLogPath, readRun, registerNode, runDirectory, type RegisterNodeInput, type RunNode } from "../src/runs.ts";

const repoRoot = process.cwd();
const tsxLoader = join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs");
const posixOnly = { skip: process.platform === "win32" };

function node(nodeId: string, sandbox: RegisterNodeInput["sandbox"], extra: Partial<RegisterNodeInput> = {}): RegisterNodeInput {
  return {
    runId: "auth", nodeId, role: "worker", agent: "codex", coordination: "oneshot", status: "idle", sandbox, ...extra,
  };
}

function submit(paths: MailboxPaths, name: string, body: unknown): void {
  writeFileSync(join(paths.requests, name), typeof body === "string" ? body : JSON.stringify(body));
}

function reply(paths: MailboxPaths, id: string): Record<string, unknown> | undefined {
  const path = join(paths.replies, `${id}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "headless-mailbox-test-"));
  const env = { HOME: join(dir, "home") };
  registerNode(env, node("orchestrator", "docker", { role: "orchestrator", status: "busy" }));
  registerNode(env, node("worker-1", "docker", { workDir: dir, allow: "read-only" }));
  registerNode(env, node("host-node", "none", { workDir: dir }));
  const paths = prepareMailbox(env, "auth", "orchestrator");
  const delivered: Array<{ target: RunNode; prompt: string; from: string }> = [];
  const logs: string[] = [];
  const service = new RunMailboxService({
    env, runId: "auth", nodeId: "orchestrator", paths,
    log: (text) => logs.push(text),
    deliver: async (target, prompt, from) => {
      delivered.push({ target, prompt, from });
    },
  });
  return { dir, env, paths, service, delivered, logs };
}

test("hostile mailbox requests are rejected, logged, and never applied", posixOnly, async () => {
  const { dir, env, paths, service, delivered, logs } = fixture();
  try {
    const canary = join(dir, "canary");
    writeFileSync(canary, "original\n");
    const base = { version: 1, op: "message", target: "worker-1", prompt: "hi", async: true };
    submit(paths, "a1.json", { ...base, id: "a1", workDir: "/", allow: "yolo" });
    submit(paths, "a2.json", { ...base, id: "a2", target: "../../../../tmp/x" });
    submit(paths, "a3.json", { ...base, id: "a3", op: "register" });
    submit(paths, "a4.json", { ...base, id: "a4", logs: { stdout: canary } });
    submit(paths, "a5.json", { ...base, id: "other" });
    submit(paths, "a6.json", "{ not json");
    submit(paths, "a7.json", { ...base, id: "a7", prompt: "x".repeat(mailboxLimits.promptChars + 1) });
    submit(paths, "a8.json", "x".repeat(mailboxLimits.requestBytes + 1));
    submit(paths, "a9.json", { ...base, id: "a9", target: "unknown-node" });
    submit(paths, "b1.json", { ...base, id: "b1", target: "orchestrator" });
    submit(paths, "b2.json", { version: 1, id: "b2", op: "mark", status: "pwned" });
    symlinkSync(canary, join(paths.requests, "b3.json"));
    execFileSync("mkfifo", [join(paths.requests, "b4.json")]);
    mkdirSync(join(paths.requests, "b5.json"));
    submit(paths, "x%2f..%2fescape", "x");

    await service.poll();

    for (const id of ["a1", "a2", "a3", "a4", "a6", "a7", "a8", "a9", "b1", "b2", "b3", "b4", "b5"]) {
      assert.equal(reply(paths, id)?.ok, false, `${id} should be rejected`);
    }
    assert.equal(reply(paths, "other"), undefined);
    assert.match(String(reply(paths, "a1")?.error), /unexpected field: workDir/);
    assert.equal(reply(paths, "b3")?.error, "request is a symbolic link");
    assert.deepEqual(delivered, []);
    assert.deepEqual(readdirSync(paths.requests), []);
    assert.equal(readFileSync(canary, "utf8"), "original\n");
    const run = readRun(env, "auth");
    assert.equal(run?.nodes["worker-1"].status, "idle");
    assert.equal(run?.nodes["worker-1"].allow, "read-only");
    assert.equal(run?.nodes["worker-1"].workDir, dir);
    assert.equal(run?.events.some((event) => event.type === "message_sent"), false);
    const stderrLog = readFileSync(nodeLogPath(env, "auth", "orchestrator", "stderr"), "utf8");
    assert.match(stderrLog, /run mailbox rejected request "a1.json" from orchestrator/);
    assert.match(stderrLog, /not a request file name/);
    assert.equal(logs.length >= 14, true);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("mailbox messages start Docker nodes from host state and only record the rest", posixOnly, async () => {
  const { dir, env, paths, service, delivered } = fixture();
  try {
    submit(paths, "m1.json", { version: 1, id: "m1", op: "message", target: "worker-1", prompt: "build it", async: false });
    submit(paths, "m2.json", { version: 1, id: "m2", op: "message", target: "host-node", prompt: "status", async: true });
    submit(paths, "m3.json", { version: 1, id: "m3", op: "mark", status: "waiting" });
    await service.poll();

    assert.deepEqual(reply(paths, "m1"), { version: 1, id: "m1", ok: true, delivered: true });
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].target.nodeId, "worker-1");
    assert.equal(delivered[0].target.workDir, dir);
    assert.equal(delivered[0].from, "orchestrator");
    assert.equal(reply(paths, "m2")?.delivered, false);
    assert.match(String(reply(paths, "m2")?.error), /runs on the host; a container cannot start it/);
    const run = readRun(env, "auth");
    assert.equal(run?.nodes.orchestrator.status, "waiting");
    assert.equal(run?.nodes["host-node"].status, "idle");
    assert.equal(run?.events.some((event) => event.type === "message_sent" && event.targetNodeId === "host-node"), true);
    const snapshot = JSON.parse(readFileSync(join(paths.replies, "run.json"), "utf8"));
    assert.equal(snapshot.nodes.orchestrator.status, "waiting");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a mailbox stops accepting requests past its lifetime cap", posixOnly, async () => {
  const { dir, paths, service } = fixture();
  try {
    for (let index = 0; index <= mailboxLimits.requestsPerMailbox; index += 1) {
      submit(paths, `r${String(index).padStart(4, "0")}.json`, { version: 1, id: `r${String(index).padStart(4, "0")}`, op: "mark", status: "busy" });
      if (index % mailboxLimits.requestsPerPoll === 0) await service.poll();
    }
    while (readdirSync(paths.requests).length > 0) await service.poll();
    const last = `r${String(mailboxLimits.requestsPerMailbox).padStart(4, "0")}`;
    assert.match(String(reply(paths, last)?.error), /request limit reached/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

// End to end through the real CLI: a fake `docker` runs the "container"
// agent with the mailbox mounts it was given (emulating the bind mounts by
// pointing HEADLESS_RUN_MAILBOX at the host mailbox) and a private HOME.
test("a Docker orchestrator messages a Docker worker through its mailbox, and cannot touch run state", posixOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-mailbox-e2e-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const project = join(dir, "project");
    const canary = join(dir, "canary");
    for (const path of [home, binDir, project]) mkdirSync(path);
    writeFileSync(canary, "original\n");
    const headless = join(binDir, "headless");
    writeFileSync(headless, `#!/bin/sh\nexec "${process.execPath}" --import "${tsxLoader}" "${join(repoRoot, "src", "cli.ts")}" "$@"\n`);
    writeFileSync(join(binDir, "docker"), [
      `#!${process.execPath}`,
      "const { spawnSync } = require('node:child_process');",
      "const { mkdtempSync } = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "const env = { PATH: process.env.PATH, FAKE_AGENT_CANARY: process.env.FAKE_AGENT_CANARY, FAKE_HEADLESS: process.env.FAKE_HEADLESS };",
      "let mounts = [];",
      "for (let i = 1; i < args.length; i += 1) {",
      "  if (args[i] === '--volume') mounts.push(args[++i]);",
      "  else if (args[i] === '--env') { const v = args[++i]; const eq = v.indexOf('='); if (eq > 0) env[v.slice(0, eq)] = v.slice(eq + 1); }",
      "}",
      "const requests = mounts.map((m) => m.split(':')).find((m) => m[1] === '/headless-mailbox/requests');",
      "if (mounts.some((m) => m.includes('/.headless/runs/') && !m.includes('/mailboxes/'))) { console.error('run dir mounted'); process.exit(97); }",
      "if (requests) env.HEADLESS_RUN_MAILBOX = path.dirname(requests[0]);",
      "env.HOME = mkdtempSync(process.env.FAKE_CONTAINER_HOME_PREFIX);",
      "const result = spawnSync(process.execPath, [process.env.FAKE_AGENT], { env, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });",
      "process.stdout.write(result.stdout);",
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"));
    const agent = join(dir, "agent.cjs");
    writeFileSync(agent, [
      "const { spawnSync } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const say = (text) => { console.log(JSON.stringify({ type: 'thread.started', thread_id: '019ad9b8-0000-7000-8000-000000000001' })); console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })); };",
      "const headless = (...args) => spawnSync(process.env.FAKE_HEADLESS, args, { env: process.env, encoding: 'utf8' });",
      "if (process.env.HEADLESS_RUN_NODE === 'worker-1') { say('worker finished'); process.exit(0); }",
      "// Hostile: plant a request that tries to redirect logs and widen permissions.",
      "const requests = path.join(process.env.HEADLESS_RUN_MAILBOX, 'requests');",
      "fs.writeFileSync(path.join(requests, 'evil.json'), JSON.stringify({ version: 1, id: 'evil', op: 'message', target: 'worker-1', prompt: 'x', async: true, logs: { stdout: process.env.FAKE_AGENT_CANARY }, allow: 'yolo' }));",
      "fs.symlinkSync(process.env.FAKE_AGENT_CANARY, path.join(requests, 'link.json'));",
      "const direct = headless('codex', '--role', 'worker', '--run', 'auth', '--node', 'sneaky', '--prompt', 'x');",
      "const sent = headless('run', 'message', 'auth', 'worker-1', '--prompt', 'do the work');",
      "const view = headless('run', 'view', 'auth');",
      "say(['direct=' + direct.status, 'sent=' + sent.status, 'err=' + JSON.stringify(sent.stderr + view.stderr), 'reply=' + sent.stdout.trim(), 'view=' + /worker-1/.test(view.stdout)].join(' '));",
      "",
    ].join("\n"));
    chmodSync(headless, 0o755);
    chmodSync(join(binDir, "docker"), 0o755);
    const env = {
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HEADLESS_CLI_BIN: headless,
      FAKE_HEADLESS: headless,
      FAKE_AGENT: agent,
      FAKE_AGENT_CANARY: canary,
      FAKE_CONTAINER_HOME_PREFIX: join(dir, "container-home-"),
      HEADLESS_RUN_MAILBOX_INTERVAL_MS: "50",
      HEADLESS_RUN_WAIT_INTERVAL_MS: "50",
      HEADLESS_RUN_STATUS_INTERVAL_MS: "50",
      OPENAI_API_KEY: "test-key",
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(
      ["codex", "--role", "orchestrator", "--run", "auth", "--node", "orchestrator", "--team", "worker=2",
        "--docker", "--docker-image", "fake:image", "--work-dir", project, "--prompt", "coordinate"],
      { env, stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    );
    assert.equal(code, 0, stderr.join(""));
    // The team child of a Docker orchestrator is named after its role.
    const output = stdout.join("");
    assert.match(output, /direct=2/);
    assert.match(output, /sent=0 err="" reply=worker finished/);
    assert.match(output, /view=true/);
    const run = readRun(env, "auth");
    assert.equal(run?.nodes["worker-1"]?.sandbox, "docker");
    assert.equal(run?.nodes["worker-1"]?.lastMessage, "worker finished");
    assert.equal(run?.nodes.sneaky, undefined);
    assert.equal(readFileSync(canary, "utf8"), "original\n");
    const orchestratorErr = readFileSync(nodeLogPath(env, "auth", "orchestrator", "stderr"), "utf8");
    assert.match(orchestratorErr, /rejected request "evil.json".*unexpected field/);
    assert.match(orchestratorErr, /rejected request "link.json"/);
    assert.equal(existsSync(join(runDirectory(env, "auth"), "mailboxes", "worker-1", "requests")), true);
    // Let the detached worker that ran worker-1 release its node lock.
    const lock = join(runDirectory(env, "auth"), "nodes", "worker-1", "session.lock");
    const deadline = Date.now() + 10_000;
    while (existsSync(lock) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
