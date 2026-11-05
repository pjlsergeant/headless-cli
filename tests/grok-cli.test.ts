import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import { grokNotSignedInLine, grokSessionId, grokStreamingJsonLines, grokUpdatesJsonl } from "./grok-fixtures.ts";
import { grokSessionDirName } from "../src/native-transcripts.ts";

// Every spawn here runs against a temp HOME with all grok/xAI auth stripped so
// a real `grok` on PATH or a developer's credentials can never be picked up.
function isolatedEnv(dir: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    ...process.env,
    HOME: join(dir, "home"),
    PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
    XAI_API_KEY: undefined,
    GROK_CODE_XAI_API_KEY: undefined,
    GROK_HOME: undefined,
    GROK_AUTH_PATH: undefined,
    GROK_AUTH_PROVIDER_COMMAND: undefined,
    HEADLESS_MODELS_DEV_CACHE: "",
    ...extra,
  };
}

// A stand-in grok: records its argv, then replays a fixture trace with the
// session id it was given (--session-id / --resume), like the real CLI does.
function writeFakeGrok(dir: string, trace: string, exitCode = 0): string {
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(dir, "home"), { recursive: true });
  const tracePath = join(dir, "trace.jsonl");
  const capturePath = join(dir, "grok-args.jsonl");
  writeFileSync(tracePath, trace);
  const script = join(binDir, "grok");
  writeFileSync(
    script,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      `fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify(args) + '\\n');`,
      "const pick = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };",
      "const id = pick('--session-id') || pick('--resume') || 'fresh-session';",
      `const trace = fs.readFileSync(${JSON.stringify(tracePath)}, 'utf8').split(${JSON.stringify(grokSessionId)}).join(id);`,
      "process.stdout.write(trace);",
      `process.exit(${exitCode});`,
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return capturePath;
}

function capturedCalls(path: string): string[][] {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
}

test("CLI grok one-shot prints the final message and native usage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-grok-"));
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({}));
    const capture = writeFakeGrok(dir, grokStreamingJsonLines());
    const stdout: string[] = [];
    const code = await runCli(["grok", "--prompt", "- what is the answer?", "--usage"], {
      env: isolatedEnv(dir),
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    const lines = stdout.join("").trim().split("\n");
    assert.equal(lines[0], "The answer is 42.");
    const { billing: _billing, ...usage } = JSON.parse(lines[1]).usage;
    assert.equal(usage.agent, "grok");
    assert.equal(usage.provider, "xai");
    assert.equal(usage.model, "grok-4.6");
    assert.equal(usage.totalTokens, 2300);
    assert.equal(usage.cost.total, 0.0123);
    assert.equal(usage.costBasis, "native-reported");
    assert.equal(capturedCalls(capture)[0]?.at(-1), "--single=- what is the answer?");
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI grok surfaces the not-signed-in error and its exit code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-grok-"));
  try {
    writeFakeGrok(dir, `${grokNotSignedInLine}\n`, 1);
    const stderr: string[] = [];
    const code = await runCli(["grok", "--prompt", "hello"], {
      env: isolatedEnv(dir),
      stdout: () => undefined,
      stderr: (text) => stderr.push(text),
    });

    assert.equal(code, 1);
    assert.match(stderr.join(""), /^headless: grok error: Not signed in\. To authenticate without a browser/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI grok --session pins a new session id, stores it and resumes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-grok-"));
  try {
    const capture = writeFakeGrok(dir, grokStreamingJsonLines());
    const env = isolatedEnv(dir);
    assert.equal(await runCli(["grok", "--session", "work", "--prompt", "hello"], { env, stdout: () => undefined }), 0);
    const store = JSON.parse(readFileSync(join(dir, "home", ".headless", "sessions.json"), "utf8"));
    const nativeId = store.agents.grok.work.nativeId as string;
    assert.match(nativeId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    assert.equal(await runCli(["grok", "--session", "work", "--prompt", "again"], { env, stdout: () => undefined }), 0);
    const calls = capturedCalls(capture);
    assert.deepEqual(calls[0]?.slice(-3), ["--session-id", nativeId, "--single=hello"]);
    assert.deepEqual(calls[1]?.slice(-3), ["--resume", nativeId, "--single=again"]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI grok --tmux --wait pins the session id and reads the final message from updates.jsonl", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-grok-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const workDir = join(dir, "work");
    const captureFile = join(dir, "tmux.jsonl");
    const transcript = join(dir, "updates.jsonl");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(transcript, grokUpdatesJsonl({ completed: true }));
    // On new-session the fake tmux mirrors grok: it reads the caller-assigned
    // --session-id from the launched command and writes updates.jsonl where grok
    // would, $HOME/.grok/sessions/<url-encoded cwd>/<id>/updates.jsonl.
    const sessionsRoot = join(home, ".grok", "sessions", grokSessionDirName(realpathSync(workDir)));
    writeFileSync(
      join(binDir, "tmux"),
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const args = process.argv.slice(2);",
        "fs.appendFileSync(process.env.HEADLESS_TMUX_CAPTURE, JSON.stringify(args) + '\\n');",
        "if (args[0] === 'new-session') {",
        "  const launch = args.find((arg) => /--session-id\\s/.test(arg));",
        "  const sessionId = /--session-id\\s+(\\S+)/.exec(launch)[1];",
        `  const sessionDir = path.join(${JSON.stringify(sessionsRoot)}, sessionId);`,
        "  fs.mkdirSync(sessionDir, { recursive: true });",
        `  fs.copyFileSync(${JSON.stringify(transcript)}, path.join(sessionDir, 'updates.jsonl'));`,
        "}",
        "if (args[0] === 'has-session') process.exit(0);",
        "",
      ].join("\n"),
    );
    chmodSync(join(binDir, "tmux"), 0o755);

    const stdout: string[] = [];
    const code = await runCli(["grok", "--prompt", "hello", "--work-dir", workDir, "--tmux", "--wait", "--timeout", "2"], {
      env: isolatedEnv(dir, { HEADLESS_TMUX_CAPTURE: captureFile, HEADLESS_TMUX_WAIT_INTERVAL_MS: "10" }),
      stdout: (text) => stdout.push(text),
    });

    const newSession = readFileSync(captureFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
      .find((args) => args[0] === "new-session");
    const launchCommand = newSession?.find((arg) => /--session-id\s/.test(arg)) ?? "";
    assert.equal(code, 0);
    assert.equal(stdout.join(""), "Final pinned answer.\n");
    assert.match(launchCommand, /--session-id /);
    assert.doesNotMatch(launchCommand, /headless-tmux-wait/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI grok --docker/--modal refuses to start without an xAI API key, even with a host OAuth login", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-grok-"));
  try {
    writeFakeGrok(dir, grokStreamingJsonLines());
    const workDir = join(dir, "work");
    mkdirSync(join(dir, "home", ".grok"), { recursive: true });
    mkdirSync(workDir, { recursive: true });
    // A host OAuth login exists, but it must never be copied into a container.
    writeFileSync(join(dir, "home", ".grok", "auth.json"), "{}\n");
    for (const sandbox of [["--docker"], ["--docker", "--session", "work"], ["--modal"]]) {
      const stderr: string[] = [];
      const stdout: string[] = [];
      const code = await runCli(["grok", "--prompt", "hi", "--work-dir", workDir, ...sandbox, "--print-command"], {
        env: isolatedEnv(dir),
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      });
      assert.notEqual(code, 0, sandbox.join(" "));
      assert.equal(stdout.join(""), "", sandbox.join(" "));
      assert.match(
        stderr.join(""),
        /grok in Docker or Modal needs XAI_API_KEY or GROK_CODE_XAI_API_KEY; the host grok login cannot be used in containers/,
        sandbox.join(" "),
      );
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI grok --docker/--modal accepts an xAI key from the environment or an explicit forward", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-grok-"));
  try {
    writeFakeGrok(dir, grokStreamingJsonLines());
    const workDir = join(dir, "work");
    mkdirSync(workDir, { recursive: true });
    const cases: Array<{ args: string[]; env: Record<string, string> }> = [
      { args: ["--docker"], env: { XAI_API_KEY: "xai-test" } },
      { args: ["--docker"], env: { GROK_CODE_XAI_API_KEY: "xai-test" } },
      { args: ["--docker", "--docker-env", "XAI_API_KEY=xai-inline"], env: {} },
      { args: ["--modal"], env: { XAI_API_KEY: "xai-test" } },
      { args: ["--modal", "--modal-env", "GROK_CODE_XAI_API_KEY=xai-inline"], env: {} },
    ];
    for (const testCase of cases) {
      const stdout: string[] = [];
      const code = await runCli(["grok", "--prompt", "hi", "--work-dir", workDir, ...testCase.args, "--print-command"], {
        env: isolatedEnv(dir, testCase.env),
        stdout: (text) => stdout.push(text),
        stderr: () => undefined,
      });
      assert.equal(code, 0, testCase.args.join(" "));
      assert.match(stdout.join(""), /grok/, testCase.args.join(" "));
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
