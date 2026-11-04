import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { spawn } from "node:child_process";
import { once } from "node:events";

import {
  DEFAULT_KILL_GRACE_MS,
  forceKillWindowsProcessTree,
  killGraceMs,
  childProcessTree,
  processGroupAlive,
  ProcessTree,
  terminateProcessTree,
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
    assert.deepEqual(await terminateProcessTree(childProcessTree(child), { graceMs: 200 }), { signal: "SIGKILL", survived: false });
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
  assert.deepEqual(await terminateProcessTree(childProcessTree(child), { graceMs: 2000 }), { signal: "SIGTERM", survived: false });
});

test("process tree tracks a descendant that left the group with setsid", { skip: process.platform === "win32" }, async () => {
  // The leader spawns a detached (setsid) grandchild that ignores SIGTERM.
  const grandchild = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  const child = spawn(process.execPath, ["-e", `
    const { spawn } = require('node:child_process');
    const g = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { detached: true, stdio: 'ignore' });
    console.log(g.pid);
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let grandchildPid: number | undefined;
  try {
    grandchildPid = Number(String(await once(child.stdout, "data")));
    assert.ok(grandchildPid > 0);
    // Let the grandchild install its SIGTERM handler.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const tree = childProcessTree(child);
    assert.equal(tree.alive(), true);
    assert.deepEqual(await terminateProcessTree(tree, { graceMs: 300 }), { signal: "SIGKILL", survived: false });
    assert.equal(new ProcessTree({ roots: [grandchildPid] }).alive(), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (grandchildPid) {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});

test("Windows PID-rooted trees are terminated with an awaited taskkill /T /F", async () => {
  // A real process stands in for the Windows one; the fake taskkill kills it.
  const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const invocations: Array<{ command: string; args: string[] }> = [];
  const launch: TaskkillLauncher = (command, args) => {
    invocations.push({ command, args });
    const taskkill = new FakeTaskkill();
    setTimeout(() => {
      victim.kill("SIGKILL");
      taskkill.emit("close", 0);
    }, 20);
    return taskkill;
  };
  try {
    await once(victim, "spawn");
    const tree = new ProcessTree({ roots: [victim.pid!], platform: "win32", taskkill: launch, systemRoot: "C:\\Windows" });
    assert.equal(tree.alive(), true);
    const exited = once(victim, "exit");
    assert.deepEqual(await terminateProcessTree(tree, { graceMs: 1000 }), { signal: "SIGKILL", survived: false });
    await exited;
    assert.deepEqual(invocations, [{
      command: "C:\\Windows\\System32\\taskkill.exe",
      args: ["/pid", String(victim.pid), "/T", "/F"],
    }]);
  } finally {
    if (victim.exitCode === null && victim.signalCode === null) victim.kill("SIGKILL");
  }
});

test("Windows tree termination reports survivors when taskkill fails", async () => {
  const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const launch: TaskkillLauncher = () => {
    const taskkill = new FakeTaskkill();
    setTimeout(() => taskkill.emit("close", 128), 10);
    return taskkill;
  };
  try {
    await once(victim, "spawn");
    const tree = new ProcessTree({ roots: [victim.pid!], platform: "win32", taskkill: launch });
    assert.deepEqual(await terminateProcessTree(tree, { graceMs: 100 }), { signal: "SIGKILL", survived: true });
  } finally {
    victim.kill("SIGKILL");
  }
});
