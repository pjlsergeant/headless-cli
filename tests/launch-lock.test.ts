import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  acquireDockerSessionLock,
  acquireLaunchLock,
  dockerSessionLockPath,
  launchLockPath,
} from "../src/launch-lock.ts";
import { acquireOwnerLockSync, inspectOwnerLock, readOwnerLockHolder, tryAcquireOwnerLock } from "../src/owner-lock.ts";

const repoRoot = process.cwd();
const ownerLockUrl = pathToFileURL(join(repoRoot, "src", "owner-lock.ts")).href;
const launchLockUrl = pathToFileURL(join(repoRoot, "src", "launch-lock.ts")).href;

async function withHome<T>(callback: (home: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "headless-lock-"));
  try {
    return await callback(home);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
}

/** Writes a lock generation by hand, as a crashed or foreign holder would leave it. */
function forgeHolder(lockPath: string, owner: Record<string, unknown>, generation = 1): void {
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(join(lockPath, String(generation).padStart(12, "0")), `${JSON.stringify({
    hostname: hostname(),
    token: `forged-${generation}`,
    acquiredAt: new Date().toISOString(),
    ...owner,
  })}\n`);
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
}

test("launch lock holds a per-(agent, workspace) lock and releases it", async () => {
  await withHome(async (home) => {
    const env = { HOME: home };
    const path = launchLockPath(env, "codex", "/repo/a");
    assert.ok(path);
    const lock = await acquireLaunchLock(env, "codex", "/repo/a");
    assert.equal(readOwnerLockHolder(path!)?.pid, process.pid);
    lock.release();
    assert.equal(readOwnerLockHolder(path!), undefined);
    assert.equal(inspectOwnerLock(path!).state, "released");
  });
});

test("launch lock keys are distinct per agent and per workspace", async () => {
  await withHome(async (home) => {
    const env = { HOME: home };
    const a = await acquireLaunchLock(env, "codex", "/repo/a");
    const b = await acquireLaunchLock(env, "codex", "/repo/b");
    const c = await acquireLaunchLock(env, "gemini", "/repo/a");
    // Different workspace and different agent never contend, so all three hold.
    for (const [agent, workspace] of [["codex", "/repo/a"], ["codex", "/repo/b"], ["gemini", "/repo/a"]] as const) {
      assert.equal(readOwnerLockHolder(launchLockPath(env, agent, workspace)!)?.pid, process.pid);
    }
    a.release();
    b.release();
    c.release();
  });
});

test("launch lock reclaims a lock held by a dead process", async () => {
  await withHome(async (home) => {
    const env = { HOME: home };
    const path = launchLockPath(env, "codex", "/repo/a")!;
    forgeHolder(path, { pid: deadPid() });
    const lock = await acquireLaunchLock(env, "codex", "/repo/a", { timeoutMs: 1_000 });
    assert.equal(readOwnerLockHolder(path)?.pid, process.pid);
    lock.release();
  });
});

test("launch lock reclaims a lock whose holder PID was reused (e.g. after a reboot)", async () => {
  await withHome(async (home) => {
    const env = { HOME: home };
    const path = launchLockPath(env, "codex", "/repo/a")!;
    // A live PID (ours), but not the process that took the lock.
    forgeHolder(path, { pid: process.pid, startIdentity: "linux:another-boot:1" });
    const lock = await acquireLaunchLock(env, "codex", "/repo/a", { timeoutMs: 1_000 });
    lock.release();
  });
});

test("launch lock blocks against a live holder without blocking the event loop", async () => {
  await withHome(async (home) => {
    const env = { HOME: home };
    const path = launchLockPath(env, "codex", "/repo/a")!;
    const first = await acquireLaunchLock(env, "codex", "/repo/a");

    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 10);
    try {
      await assert.rejects(
        acquireLaunchLock(env, "codex", "/repo/a", { timeoutMs: 150 }),
        /timed out acquiring launch lock/,
      );
    } finally {
      clearInterval(timer);
    }
    assert.ok(ticks >= 3, `event loop was blocked while waiting (ticks=${ticks})`);
    assert.equal(readOwnerLockHolder(path)?.pid, process.pid);

    first.release();
    const acquiredAfterRelease = await acquireLaunchLock(env, "codex", "/repo/a", { timeoutMs: 1_000 });
    acquiredAfterRelease.release();
  });
});

test("launch lock is a no-op without HOME", async () => {
  const lock = await acquireLaunchLock({}, "codex", "/repo/a");
  lock.release(); // must not throw
});

test("a stale handle's release never removes the lock's new holder", async () => {
  await withHome((home) => {
    const lockPath = join(home, "lock");
    const stale = acquireOwnerLockSync(lockPath, { timeoutMs: 0 });
    // Make the first holder look dead (as if it crashed), so it is reclaimed.
    const [generation] = generations(lockPath);
    writeFileSync(join(lockPath, generation!), `${JSON.stringify({
      hostname: hostname(), pid: deadPid(), token: stale.owner.token, acquiredAt: "",
    })}\n`);
    const current = acquireOwnerLockSync(lockPath, { timeoutMs: 1_000 });

    stale.release();
    assert.equal(current.held(), true);
    assert.equal(readOwnerLockHolder(lockPath)?.token, current.owner.token);
    assert.equal(tryAcquireOwnerLock(lockPath), undefined);
    current.release();
    assert.equal(current.held(), false);
    tryAcquireOwnerLock(lockPath)?.release();
  });
});

function generations(path: string): string[] {
  return readdirSync(path).filter((entry) => /^\d+$/.test(entry)).sort();
}

test("concurrent acquirers racing to reclaim a dead holder's lock produce exactly one holder", { skip: process.platform === "win32" }, async () => {
  await withHome(async (home) => {
    const lockPath = join(home, "lock");
    const goPath = join(home, "go");
    forgeHolder(lockPath, { pid: deadPid() });
    const script = [
      `import { existsSync } from "node:fs";`,
      `import { tryAcquireOwnerLock } from ${JSON.stringify(ownerLockUrl)};`,
      `while (!existsSync(${JSON.stringify(goPath)})) await new Promise((resolve) => setTimeout(resolve, 2));`,
      `const lock = tryAcquireOwnerLock(${JSON.stringify(lockPath)});`,
      `process.stdout.write(lock ? "won\\n" : "lost\\n");`,
      // Hold (if won) until the parent has counted, so losers cannot re-acquire.
      `await new Promise((resolve) => setTimeout(resolve, 1500));`,
    ].join("\n");
    const children = Array.from({ length: 8 }, () =>
      spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "inherit"],
      }));
    const outputs = children.map((child) => {
      let text = "";
      child.stdout.on("data", (chunk) => { text += String(chunk); });
      return { child, text: () => text };
    });
    // Let every child load and start polling before releasing them together.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    writeFileSync(goPath, "");
    await Promise.all(children.map((child) => once(child, "exit")));
    const results = outputs.map(({ text }) => text().trim());
    assert.equal(results.filter((result) => result === "won").length, 1, results.join(","));
    assert.equal(results.filter((result) => result === "lost").length, 7, results.join(","));
  });
});

test("concurrent launch-lock acquirers after a dead holder never overlap", { skip: process.platform === "win32" }, async () => {
  await withHome(async (home) => {
    const env = { HOME: home };
    forgeHolder(launchLockPath(env, "codex", "/repo/a")!, { pid: deadPid() });
    const goPath = join(home, "go");
    const markerPath = join(home, "inside");
    const logPath = join(home, "log");
    const script = [
      `import { appendFileSync, closeSync, existsSync, openSync, rmSync } from "node:fs";`,
      `import { acquireLaunchLock } from ${JSON.stringify(launchLockUrl)};`,
      `while (!existsSync(${JSON.stringify(goPath)})) await new Promise((resolve) => setTimeout(resolve, 2));`,
      `for (let index = 0; index < 8; index += 1) {`,
      `  const lock = await acquireLaunchLock({ HOME: ${JSON.stringify(home)} }, "codex", "/repo/a", { timeoutMs: 30000 });`,
      `  try { closeSync(openSync(${JSON.stringify(markerPath)}, "wx")); } catch { appendFileSync(${JSON.stringify(logPath)}, "overlap\\n"); }`,
      `  await new Promise((resolve) => setTimeout(resolve, 3));`,
      `  rmSync(${JSON.stringify(markerPath)}, { force: true });`,
      `  appendFileSync(${JSON.stringify(logPath)}, "held\\n");`,
      `  lock.release();`,
      `}`,
    ].join("\n");
    const children = Array.from({ length: 6 }, () =>
      spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "inherit"],
      }));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    writeFileSync(goPath, "");
    const exits = await Promise.all(children.map((child) => once(child, "exit")));
    assert.deepEqual(exits.map(([code]) => code), children.map(() => 0));
    const log = readFileSync(logPath, "utf8").trim().split("\n");
    assert.equal(log.filter((line) => line === "overlap").length, 0);
    assert.equal(log.filter((line) => line === "held").length, 48);
  });
});

test("Docker session lock paths derive from the canonical durable home", async () => {
  await withHome((home) => {
    const persistentHome = join(home, "sessions", "codex", "work");
    const dottedAliasHome = join(home, "sessions", "codex", "work.lock");
    mkdirSync(persistentHome, { recursive: true });
    mkdirSync(dottedAliasHome);
    const path = dockerSessionLockPath(persistentHome);

    assert.ok(path.startsWith(join(realpathSync(join(home, "sessions")), ".headless-session-locks")));
    assert.ok(path.endsWith(".lock"));
    assert.notEqual(path, realpathSync(dottedAliasHome));
  });
});

test("Docker session locks recover crash remnants", async () => {
  await withHome(async (home) => {
    const persistentHome = join(home, "sessions", "codex", "work");
    mkdirSync(persistentHome, { recursive: true });
    const lockPath = dockerSessionLockPath(persistentHome);
    // An empty directory (as an older lock left it) and a dead holder.
    mkdirSync(lockPath, { recursive: true });
    let lock = await acquireDockerSessionLock(persistentHome);
    assert.equal(await lock.release(), undefined);
    forgeHolder(lockPath, { pid: deadPid() }, 100);
    lock = await acquireDockerSessionLock(persistentHome);
    assert.equal(readOwnerLockHolder(lockPath)?.pid, process.pid);
    assert.equal(await lock.release(), undefined);
    assert.equal(inspectOwnerLock(lockPath).state, "released");
  });
});

test("Docker session locks wait for a live local owner", async () => {
  await withHome(async (home) => {
    const persistentHome = join(home, "sessions", "codex", "work");
    mkdirSync(persistentHome, { recursive: true });
    const first = await acquireDockerSessionLock(persistentHome);
    if (process.platform === "linux") {
      const owner = readOwnerLockHolder(dockerSessionLockPath(persistentHome));
      assert.match(owner?.startIdentity ?? "", /^linux:[0-9a-f-]{36}:\d+$/);
    }
    let secondAcquired = false;
    const secondPromise = acquireDockerSessionLock(persistentHome).then((lock) => {
      secondAcquired = true;
      return lock;
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(secondAcquired, false);
    assert.equal(await first.release(), undefined);
    const second = await secondPromise;
    assert.equal(secondAcquired, true);
    assert.equal(await second.release(), undefined);
  });
});

test("Docker session locks recover when a stale owner PID has been reused", async () => {
  await withHome(async (home) => {
    const persistentHome = join(home, "sessions", "codex", "work");
    mkdirSync(persistentHome, { recursive: true });
    forgeHolder(dockerSessionLockPath(persistentHome), { pid: process.pid, startIdentity: "different process birth" });

    const lock = await acquireDockerSessionLock(persistentHome);
    assert.equal(await lock.release(), undefined);
  });
});

test("Docker session lock release remains non-throwing after external removal", async () => {
  await withHome(async (home) => {
    const persistentHome = join(home, "sessions", "codex", "work");
    mkdirSync(persistentHome, { recursive: true });
    const lock = await acquireDockerSessionLock(persistentHome);
    rmSync(dockerSessionLockPath(persistentHome), { force: true, recursive: true });

    await assert.doesNotReject(lock.release());
  });
});

test("Docker session lock release reports permission failures without rejecting", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "headless-lock-"));
  const persistentHome = join(home, "sessions", "codex", "work");
  let lockPath = "";
  try {
    mkdirSync(persistentHome, { recursive: true });
    const lock = await acquireDockerSessionLock(persistentHome);
    lockPath = dockerSessionLockPath(persistentHome);
    chmodSync(lockPath, 0o500);

    assert.match((await lock.release())?.message ?? "", /permission|EACCES/i);
  } finally {
    if (lockPath) chmodSync(lockPath, 0o700);
    rmSync(home, { force: true, recursive: true });
  }
});

test("Docker session locks do not retry permanent namespace errors", async () => {
  await withHome(async (home) => {
    const persistentHome = join(home, "sessions", "codex", "work");
    mkdirSync(persistentHome, { recursive: true });
    writeFileSync(join(home, "sessions", ".headless-session-locks"), "not a directory");

    await assert.rejects(acquireDockerSessionLock(persistentHome), /EEXIST|not a directory|ENOTDIR/);
  });
});

test("owner locks refuse a symlink planted in place of the lock directory", { skip: process.platform === "win32" }, async () => {
  await withHome((home) => {
    const target = join(home, "elsewhere");
    mkdirSync(target);
    symlinkSync(target, join(home, "lock"));
    assert.throws(() => tryAcquireOwnerLock(join(home, "lock")), /not a directory/);
    assert.deepEqual(readdirSync(target), []);
  });
});

test("a foreign-host holder older than maxHoldMs is stale; a fresh one is not", async () => {
  await withHome((home) => {
    const lockPath = join(home, "lock");
    // E.g. a nested headless in a Docker container that died holding the lock.
    forgeHolder(lockPath, { hostname: "container-1", pid: process.pid, acquiredAt: new Date(Date.now() - 120_000).toISOString() });
    const reclaimed = acquireOwnerLockSync(lockPath, { maxHoldMs: 60_000, timeoutMs: 0 });
    assert.equal(readOwnerLockHolder(lockPath)?.token, reclaimed.owner.token);
    reclaimed.release();

    const fresh = join(home, "fresh");
    forgeHolder(fresh, { hostname: "container-2", pid: process.pid, acquiredAt: new Date().toISOString() });
    assert.throws(() => acquireOwnerLockSync(fresh, { maxHoldMs: 60_000, timeoutMs: 50 }), /timed out acquiring lock/);
    // Without maxHoldMs a foreign holder is never judged stale.
    forgeHolder(join(home, "old"), { hostname: "container-3", pid: process.pid, acquiredAt: new Date(0).toISOString() });
    assert.equal(tryAcquireOwnerLock(join(home, "old")), undefined);
  });
});

test("a holder that outlived maxHoldMs sees it no longer holds the lock", async () => {
  await withHome((home) => {
    const lockPath = join(home, "lock");
    const slow = acquireOwnerLockSync(lockPath, { timeoutMs: 0 });
    // Age the record as if the section had run for two minutes.
    const [generation] = generations(lockPath);
    writeFileSync(join(lockPath, generation!), `${JSON.stringify({
      ...slow.owner, acquiredAt: new Date(Date.now() - 120_000).toISOString(),
    })}\n`);
    const next = acquireOwnerLockSync(lockPath, { maxHoldMs: 60_000, timeoutMs: 0 });
    assert.equal(slow.held(), false);
    slow.release();
    assert.equal(next.held(), true);
    next.release();
  });
});

test("owner locks refuse filesystems without hard links instead of publishing in place", async () => {
  await withHome((home) => {
    const lockPath = join(home, "lock");
    const link = () => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    };
    assert.throws(() => tryAcquireOwnerLock(lockPath, { link }), (error: Error) =>
      error.message.includes(lockPath) && /does not support hard links \(EPERM\)/.test(error.message));
    // Nothing was published, and the private temp record was removed.
    assert.deepEqual(readdirSync(lockPath), []);
  });
});

test("a FIFO planted as a lock record neither hangs nor holds the lock", { skip: process.platform === "win32" }, async () => {
  await withHome((home) => {
    const lockPath = join(home, "lock");
    mkdirSync(lockPath);
    const fifo = spawnSync("mkfifo", [join(lockPath, "000000000001")], { encoding: "utf8" });
    assert.equal(fifo.status, 0, fifo.stderr);
    // In a child with a deadline: a blocking open would hang it, signals included.
    const child = spawnSync(process.execPath, [
      "--import", "tsx", "--input-type=module", "--eval",
      [
        `const { readOwnerLockHolder, tryAcquireOwnerLock } = await import(${JSON.stringify(ownerLockUrl)});`,
        `if (readOwnerLockHolder(${JSON.stringify(lockPath)}) !== undefined) process.exit(3);`,
        `const lock = tryAcquireOwnerLock(${JSON.stringify(lockPath)});`,
        `if (!lock) process.exit(4);`,
        `lock.release();`,
      ].join("\n"),
    ], { cwd: repoRoot, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" });
    assert.equal(child.signal, null, "lock code hung on a FIFO");
    assert.equal(child.status, 0, child.stderr);
  });
});

test("a garbage lock record does not hold the lock", async () => {
  await withHome((home) => {
    const lockPath = join(home, "lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "000000000001"), "{\"hostname\":");
    const lock = tryAcquireOwnerLock(lockPath);
    assert.ok(lock);
    lock.release();
  });
});
