import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  readStoredSession,
  writeStoredSession,
  writeStoredTmuxSession,
} from "../src/sessions.ts";

test("secure session stores reject symlinks and oversized files", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sessions-test-"));
  try {
    const storeDir = join(dir, ".headless");
    const storePath = join(storeDir, "sessions.json");
    const external = join(dir, "external.json");
    const env = { HOME: dir };
    mkdirSync(storeDir);
    writeFileSync(external, "{}\n");
    symlinkSync(external, storePath);

    assert.throws(() => readStoredSession(env, "codex", "work"), /ELOOP/);
    assert.equal(readFileSync(external, "utf8"), "{}\n");

    rmSync(storePath);
    const fifo = spawnSync("mkfifo", [storePath], { encoding: "utf8" });
    assert.equal(fifo.status, 0, fifo.stderr);
    assert.throws(() => readStoredSession(env, "codex", "work"), /bounded regular file/);
    rmSync(storePath);
    writeFileSync(storePath, "");
    truncateSync(storePath, 1024 * 1024 + 1);
    assert.throws(() => readStoredSession(env, "codex", "work"), /bounded regular file/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("secure session stores validate records and write private files atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sessions-test-"));
  try {
    const storeDir = join(dir, ".headless");
    const storePath = join(storeDir, "sessions.json");
    const env = { HOME: dir };
    mkdirSync(storeDir);
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        agents: {
          codex: {
            work: {
              agent: "codex",
              alias: "different",
              nativeId: "untrusted",
              createdAt: "now",
              updatedAt: "now",
            },
          },
        },
      }),
    );
    assert.equal(readStoredSession(env, "codex", "work"), undefined);

    writeStoredSession(env, {
      agent: "codex",
      alias: "work",
      nativeId: "trusted",
      profile: "research",
      workDir: dir,
    });
    assert.equal(readStoredSession(env, "codex", "work")?.nativeId, "trusted");
    assert.equal(readStoredSession(env, "codex", "work")?.profile, "research");
    assert.equal(statSync(storePath).mode & 0o777, 0o600);

    const longAlias = "a".repeat(300);
    writeStoredSession(env, {
      agent: "codex",
      alias: longAlias,
      nativeId: "long-session",
      workDir: dir,
    });
    assert.equal(readStoredSession(env, "codex", longAlias)?.nativeId, "long-session");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("secure session stores preserve reserved aliases as own properties", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sessions-test-"));
  try {
    const storeDir = join(dir, ".headless");
    const storePath = join(storeDir, "sessions.json");
    const env = { HOME: dir };
    const aliases = ["__proto__", "constructor", "prototype"];
    const sessions = Object.fromEntries(
      aliases.map((alias) => [
        alias,
        {
          agent: "codex",
          alias,
          nativeId: `${alias}-session`,
          createdAt: "now",
          updatedAt: "now",
        },
      ]),
    );
    mkdirSync(storeDir);
    writeFileSync(storePath, JSON.stringify({ version: 1, agents: { codex: sessions } }));

    writeStoredSession(env, {
      agent: "codex",
      alias: "work",
      nativeId: "work-session",
      workDir: dir,
    });

    const stored = JSON.parse(readFileSync(storePath, "utf8")) as {
      agents: { codex: Record<string, unknown> };
    };
    for (const alias of aliases) {
      assert.equal(Object.hasOwn(stored.agents.codex, alias), true);
      assert.equal(readStoredSession(env, "codex", alias)?.nativeId, `${alias}-session`);
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("concurrent session writes from many processes keep every alias", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sessions-test-"));
  try {
    const moduleUrl = pathToFileURL(join(process.cwd(), "src", "sessions.ts")).href;
    const goPath = join(dir, "go");
    const writer = (index: number) => spawn(process.execPath, [
      "--import", "tsx", "--input-type=module", "--eval",
      [
        `import { existsSync } from "node:fs";`,
        `const { writeStoredSession } = await import(${JSON.stringify(moduleUrl)});`,
        `while (!existsSync(${JSON.stringify(goPath)})) await new Promise((resolve) => setTimeout(resolve, 1));`,
        `for (let round = 0; round < 10; round += 1) {`,
        `  writeStoredSession({ HOME: ${JSON.stringify(dir)} }, { agent: "codex", alias: "w${index}-" + round, nativeId: "n${index}-" + round, workDir: "/w" });`,
        `}`,
      ].join("\n"),
    ], { cwd: process.cwd(), stdio: ["ignore", "ignore", "inherit"] });
    const writers = Array.from({ length: 5 }, (_, index) => writer(index));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    writeFileSync(goPath, "");
    const exits = await Promise.all(writers.map((child) => once(child, "exit")));
    assert.deepEqual(exits.map(([code]) => code), writers.map(() => 0));
    for (let index = 0; index < 5; index += 1) {
      for (let round = 0; round < 10; round += 1) {
        assert.equal(readStoredSession({ HOME: dir }, "codex", `w${index}-${round}`)?.nativeId, `n${index}-${round}`);
      }
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a corrupt session store fails the write and is left untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sessions-test-"));
  try {
    const storePath = join(dir, ".headless", "sessions.json");
    mkdirSync(dirname(storePath), { recursive: true });
    for (const corrupt of ['{"version": 1, "agents": {"codex": {"work": ', '{"version": 2, "agents": {}}\n', "[]\n"]) {
      writeFileSync(storePath, corrupt);
      assert.throws(
        () => writeStoredSession({ HOME: dir }, { agent: "codex", alias: "new", nativeId: "n", workDir: dir }),
        /session store is unreadable/,
      );
      assert.throws(() => readStoredSession({ HOME: dir }, "codex", "work"), /session store is unreadable/);
      assert.equal(readFileSync(storePath, "utf8"), corrupt);
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("session store keeps tmux wait strategies across unrelated writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sessions-test-"));
  try {
    const env = { HOME: dir };
    writeStoredTmuxSession(env, {
      agent: "codex",
      alias: "tmux",
      tmuxWaitStrategy: { kind: "claim", claimed: "/transcripts/a.jsonl" },
      workDir: dir,
    });
    writeStoredSession(env, { agent: "codex", alias: "other", nativeId: "n", workDir: dir });
    assert.deepEqual(readStoredSession(env, "codex", "tmux")?.tmuxWaitStrategy, {
      kind: "claim",
      claimed: "/transcripts/a.jsonl",
    });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
