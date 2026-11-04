import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";

import type { lockSync as LockSync } from "proper-lockfile";

import {
  executeWindowsPowerShell,
  processAlive,
  processIdentityChanged,
  processStartIdentity,
  validProcessId,
  windowsPowerShellPath,
} from "./process-identity.js";
import { ProcessTree } from "./process-tree.js";

const privateDirMode = 0o700;
const legacyInitializationGraceMs = 1_000;
const runLockStaleMs = 5_000;
const runLockUpdateMs = 2_500;
const nodeLockStaleMs = 20_000;
const nodeLockUpdateMs = 5_000;
const runLockTimeoutMs = 30_000;
const runLockRetryMs = 10;
const windowsProcessTreeTimeoutMs = 3_000;
const windowsOwnerIdentityTimeoutMs = 10_000;
const windowsRenameAttempts = 40;
const windowsRenameRetryMs = 25;
const windowsRenameRetryCodes = new Set(["EACCES", "EBUSY", "EPERM"]);
const managedSignals: NodeJS.Signals[] = process.platform === "win32"
  ? ["SIGINT", "SIGTERM", "SIGBREAK"]
  : ["SIGHUP", "SIGINT", "SIGTERM", "SIGQUIT"];
const runStoreLockSignalListeners = new Set<NodeJS.SignalsListener>();
let lockSync: typeof LockSync | undefined;

export interface NodeStoreLockOwner {
  processTreeRootPid: number;
}

interface StoredNodeStoreLockOwner extends NodeStoreLockOwner {
  createdAtMs: number;
  processStartIdentity?: string;
}

interface StoredNodeStoreLockOwnerSnapshot {
  owner: StoredNodeStoreLockOwner;
}

export interface RunStateReplacementOptions {
  platform?: NodeJS.Platform;
  rename?: (source: string, destination: string) => void;
  sleep?: (milliseconds: number) => void;
}

export interface WindowsProcessTreeProbeOptions {
  execute?: (command: string, args: string[]) => string;
  systemRoot?: string;
}

export function acquireRunStoreLock(lockPath: string, runId: string): () => void {
  const deadline = Date.now() + runLockTimeoutMs;
  while (true) {
    try {
      return acquireStoreLock(lockPath, runLockStaleMs, runLockUpdateMs);
    } catch (error) {
      if (!isLockContention(error)) throw error;
      if (Date.now() >= deadline) throw new Error(`run is locked: ${runId}`);
      sleepSync(runLockRetryMs);
    }
  }
}

export function acquireNodeStoreLock(lockPath: string, nodeId: string, owner?: NodeStoreLockOwner): () => void {
  try {
    return acquireStoreLock(lockPath, nodeLockStaleMs, nodeLockUpdateMs, owner);
  } catch (error) {
    if (!isLockContention(error)) throw error;
    throw new Error(`node is locked: ${nodeId}`);
  }
}

export function handoffNodeStoreLockOwner(
  lockPath: string,
  expectedProcessTreeRootPid: number,
  owner: NodeStoreLockOwner,
): void {
  if (!lstatSync(lockPath).isDirectory()) throw new Error("node lock lease is missing");
  const storedOwner = readStoredLockOwner(lockPath)?.owner;
  if (storedOwner?.processTreeRootPid !== expectedProcessTreeRootPid) {
    throw new Error("node lock owner changed before handoff");
  }
  writeLockOwner(lockPath, owner);
}

export function waitForNodeStoreLockOwner(
  lockPath: string,
  processTreeRootPid: number,
  timeoutMs = 5_000,
): void {
  const deadline = Date.now() + timeoutMs;
  do {
    if (readStoredLockOwner(lockPath)?.owner.processTreeRootPid === processTreeRootPid) return;
    sleepSync(runLockRetryMs);
  } while (Date.now() < deadline);
  throw new Error("async message lock ownership handoff timed out");
}

export function nodeStoreLockHasLiveSuccessor(lockPath: string, currentProcessTreeRootPid: number): boolean {
  try {
    const snapshot = readStoredLockOwner(lockPath);
    if (!snapshot || snapshot.owner.processTreeRootPid === currentProcessTreeRootPid) return false;
    if (!storedOwnerIsTrusted(snapshot.owner)) return true;
    return processTreeAlive(snapshot.owner);
  } catch {
    return true;
  }
}

export function isRunStoreLockSignalListener(listener: NodeJS.SignalsListener): boolean {
  return runStoreLockSignalListeners.has(listener);
}

export function removeRunStoreLockSignalListeners(): void {
  for (const signal of managedSignals) {
    for (const listener of runStoreLockSignalListeners) process.off(signal, listener);
  }
}

export function replaceRunStateFile(
  source: string,
  destination: string,
  options: RunStateReplacementOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  const rename = options.rename ?? renameSync;
  const sleep = options.sleep ?? sleepSync;
  for (let attempt = 1; attempt <= windowsRenameAttempts; attempt += 1) {
    try {
      rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = platform === "win32" && code !== undefined && windowsRenameRetryCodes.has(code);
      if (!retryable || attempt === windowsRenameAttempts) throw error;
      sleep(windowsRenameRetryMs);
    }
  }
}

function acquireStoreLock(
  lockPath: string,
  stale: number,
  update: number,
  owner?: NodeStoreLockOwner,
): () => void {
  if (leaseOwnerBlocksAcquisition(lockPath)) throw lockContentionError(lockPath);
  if (legacyLockBlocksAcquisition(lockPath)) throw lockContentionError(lockPath);
  const storedOwner = owner ? createStoredLockOwner(owner, windowsOwnerIdentityTimeoutMs) : undefined;

  let compromisedError: Error | undefined;
  const release = loadLockSync()(lockPath, {
    lockfilePath: lockPath,
    onCompromised: (error) => {
      compromisedError = error;
    },
    realpath: false,
    retries: 0,
    stale,
    update,
  });
  let released = false;
  const releaseLease = () => {
    if (released) return;
    released = true;
    release();
  };
  try {
    chmodSync(lockPath, privateDirMode);
    if (ownerSidecarBlocksAcquisition(lockPath)) {
      releaseLease();
      throw lockContentionError(lockPath);
    }
    rmSync(lockOwnerPath(lockPath), { force: true });
    if (storedOwner) writeStoredLockOwner(lockPath, storedOwner);
  } catch (error) {
    releaseLease();
    throw error;
  }

  return () => {
    if (owner) rmSync(lockOwnerPath(lockPath), { force: true });
    if (compromisedError) throw compromisedError;
    releaseLease();
  };
}

function leaseOwnerBlocksAcquisition(lockPath: string): boolean {
  return storedOwnerBlocksAcquisition(lockPath);
}

function ownerSidecarBlocksAcquisition(lockPath: string): boolean {
  return storedOwnerBlocksAcquisition(lockPath);
}

function storedOwnerBlocksAcquisition(lockPath: string): boolean {
  let snapshot: StoredNodeStoreLockOwnerSnapshot | undefined;
  try {
    snapshot = readStoredLockOwner(lockPath);
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    return true;
  }
  if (!snapshot || !storedOwnerIsTrusted(snapshot.owner)) return false;
  return processTreeAlive(snapshot.owner);
}

function readStoredLockOwner(lockPath: string): StoredNodeStoreLockOwnerSnapshot | undefined {
  const ownerPath = lockOwnerPath(lockPath);
  try {
    const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as StoredNodeStoreLockOwner;
    return { owner };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function storedOwnerIsTrusted(owner: StoredNodeStoreLockOwner): boolean {
  return validProcessId(owner.processTreeRootPid) && Number.isFinite(owner.createdAtMs);
}

function writeLockOwner(lockPath: string, owner: NodeStoreLockOwner): void {
  writeStoredLockOwner(lockPath, createStoredLockOwner(owner));
}

function createStoredLockOwner(
  owner: NodeStoreLockOwner,
  windowsIdentityTimeoutMs?: number,
): StoredNodeStoreLockOwner {
  return {
    ...owner,
    createdAtMs: Date.now(),
    processStartIdentity: processStartIdentity(owner.processTreeRootPid, windowsIdentityTimeoutMs),
  };
}

function writeStoredLockOwner(lockPath: string, storedOwner: StoredNodeStoreLockOwner): void {
  const path = lockOwnerPath(lockPath);
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(storedOwner)}\n`);
    fchmodSync(descriptor, 0o600);
    closeSync(descriptor);
    descriptor = undefined;
    replaceRunStateFile(temporaryPath, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
}

function lockOwnerPath(lockPath: string): string {
  return `${lockPath}.owner`;
}

function loadLockSync(): typeof LockSync {
  if (lockSync) return lockSync;

  const listenersBeforeImport = new Map(
    managedSignals.map((signal) => [signal, new Set(process.listeners(signal))] as const),
  );
  lockSync = (createRequire(import.meta.url)("proper-lockfile") as { lockSync: typeof LockSync }).lockSync;
  for (const signal of managedSignals) {
    for (const listener of process.listeners(signal)) {
      if (!listenersBeforeImport.get(signal)?.has(listener)) runStoreLockSignalListeners.add(listener);
    }
  }
  return lockSync;
}

function legacyLockBlocksAcquisition(lockPath: string): boolean {
  let status;
  try {
    status = lstatSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!status.isFile()) return false;

  const pid = readLegacyLockPid(lockPath);
  const malformedAndFresh = pid === undefined && Date.now() - status.mtimeMs < legacyInitializationGraceMs;
  if (malformedAndFresh || (pid !== undefined && processAlive(pid))) return true;

  try {
    rmSync(lockPath, { force: true });
    return false;
  } catch (error) {
    try {
      if (lstatSync(lockPath).isDirectory()) return true;
    } catch (statusError) {
      if ((statusError as NodeJS.ErrnoException).code === "ENOENT") return false;
    }
    throw error;
  }
}

function readLegacyLockPid(lockPath: string): number | undefined {
  let value: string;
  try {
    value = readFileSync(lockPath, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

// Zombie-aware and identity-checked through process-identity: a dead owner
// left as a zombie (non-reaping PID 1) or a reused root PID does not block.
function processTreeAlive(owner: StoredNodeStoreLockOwner): boolean {
  const rootPid = owner.processTreeRootPid;
  const rootAlive = processAlive(rootPid);
  const identityMismatch = rootAlive && processIdentityChanged(rootPid, owner.processStartIdentity);
  return processTreeAliveFromProbes(process.platform, rootAlive, identityMismatch, () => {
    if (process.platform === "win32") return windowsProcessTreeAlive(rootPid);
    return new ProcessTree({ groups: [rootPid] }).alive();
  });
}

export function processTreeAliveFromProbes(
  platform: NodeJS.Platform,
  rootAlive: boolean,
  identityMismatch: boolean,
  descendantsAlive: () => boolean,
): boolean {
  if (rootAlive && !identityMismatch) return true;
  if (rootAlive && platform !== "win32") return false;
  return descendantsAlive();
}

export function windowsProcessTreeAlive(
  rootPid: number,
  options: WindowsProcessTreeProbeOptions = {},
): boolean {
  if (!validProcessId(rootPid)) return true;
  const execute = options.execute
    ?? ((command, args) => executeWindowsPowerShell(command, args, windowsProcessTreeTimeoutMs));
  try {
    const output = execute(windowsPowerShellPath(options.systemRoot), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      windowsDescendantProbe(rootPid),
    ]);
    return output.trim() !== "HEADLESS_PROCESS_TREE_DEAD";
  } catch {
    return true;
  }
}

function windowsDescendantProbe(rootPid: number): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$rootPid = [uint32]${rootPid}`,
    "$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID })",
    "$parents = @($rootPid)",
    "$found = $false",
    "do {",
    "  $children = @($processes | Where-Object { $parents -contains $_.ParentProcessId })",
    "  if ($children.Count -gt 0) { $found = $true }",
    "  $parents = @($children | ForEach-Object { $_.ProcessId })",
    "} while ($parents.Count -gt 0)",
    "if ($found) { 'HEADLESS_PROCESS_TREE_ALIVE' } else { 'HEADLESS_PROCESS_TREE_DEAD' }",
  ].join("; ");
}

function lockContentionError(lockPath: string): Error {
  return Object.assign(new Error(`lock is already held: ${lockPath}`), { code: "ELOCKED" });
}

function isLockContention(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ELOCKED";
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
