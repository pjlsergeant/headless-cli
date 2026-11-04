import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { spawn } from "node:child_process";
import { once } from "node:events";

import {
  DEFAULT_KILL_GRACE_MS,
  forceKillWindowsProcessTree,
  killGraceMs,
  processGroupAlive,
  terminateProcessGroup,
  windowsTaskkillPath,
  type TaskkillLauncher,
} from "../src/process-tree.ts";

class FakeTaskkill extends EventEmitter {
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];
  unrefCalled = false;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    return true;
  }

  unref(): void {
    this.unrefCalled = true;
  }
}

test("Windows tree cleanup launches trusted taskkill with numeric arguments", () => {
  const taskkill = new FakeTaskkill();
  let invocation: { command: string; args: string[] } | undefined;
  const launch: TaskkillLauncher = (command, args) => {
    invocation = { command, args };
    return taskkill;
  };
  const childSignals: Array<NodeJS.Signals | number | undefined> = [];

  forceKillWindowsProcessTree(
    {
      pid: 1234,
      kill: (signal) => {
        childSignals.push(signal);
        return true;
      },
    },
    100,
    launch,
  );
  taskkill.emit("close", 0);

  assert.deepEqual(invocation, {
    command: "C:\\Windows\\System32\\taskkill.exe",
    args: ["/pid", "1234", "/T", "/F"],
  });
  assert.equal(taskkill.unrefCalled, true);
  assert.deepEqual(childSignals, []);
});

test("Windows tree cleanup resolves taskkill from a non-default system root", () => {
  assert.equal(windowsTaskkillPath("D:\\WinNT"), "D:\\WinNT\\System32\\taskkill.exe");
});

test("Windows tree cleanup bounds a hung taskkill and falls back to the direct child", async () => {
  const taskkill = new FakeTaskkill();
  const childSignals: Array<NodeJS.Signals | number | undefined> = [];

  forceKillWindowsProcessTree(
    {
      pid: 1234,
      kill: (signal) => {
        childSignals.push(signal);
        return true;
      },
    },
    1,
    () => taskkill,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(taskkill.signals, ["SIGKILL"]);
  assert.deepEqual(childSignals, ["SIGKILL"]);
});

test("kill grace defaults to one shared value and honours HEADLESS_KILL_GRACE_MS", () => {
  assert.equal(DEFAULT_KILL_GRACE_MS, 5000);
  assert.equal(killGraceMs({}), 5000);
  assert.equal(killGraceMs({ HEADLESS_KILL_GRACE_MS: "250" }), 250);
  assert.equal(killGraceMs({ HEADLESS_KILL_GRACE_MS: "soon" }), 5000);
  assert.equal(killGraceMs({ HEADLESS_KILL_GRACE_MS: "-1" }), 5000);
});

test("process group termination escalates to SIGKILL for a group that ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    await once(child.stdout, "data");
    assert.equal(processGroupAlive(child.pid!), true);
    const started = Date.now();
    assert.equal(await terminateProcessGroup(child, { graceMs: 200 }), "SIGKILL");
    assert.ok(Date.now() - started >= 180);
    assert.equal(processGroupAlive(child.pid!), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("process group termination stops at SIGTERM when the group exits", { skip: process.platform === "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000);"], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  await once(child.stdout, "data");
  assert.equal(await terminateProcessGroup(child, { graceMs: 2000 }), "SIGTERM");
});
