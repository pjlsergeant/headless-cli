import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { isSameProcess, ownProcessStartIdentity, validProcessId } from "./process-identity.js";

/**
 * One owner-aware, crash-safe lock used by every headless lock.
 *
 * A lock is a directory of immutable, numbered generation files. Each file is
 * created atomically with its full content (hard link from a private temp file,
 * which fails if the name exists), and names either a holder
 * {hostname, pid, startIdentity, token} or a release. The highest generation
 * is the lock's state:
 *
 * - acquire: if the top is a held record whose owner is still the same process
 *   (or lives on another host), wait. Otherwise create top+1, then re-list: if
 *   a higher generation exists the attempt lost (its file is removed), else
 *   the caller holds the lock and removes lower generations.
 * - release: create top+1 as a release record, but only from the holder's own
 *   generation; if that name is taken the lock moved on and release is a no-op.
 *
 * Nothing ever deletes the top generation or the directory, so the highest
 * number only grows. A waiter acting on a stale view can only create a number
 * that is already below the top, which its re-list detects. That makes stale
 * reclamation atomic without a compare-and-delete: two waiters can never both
 * hold, and a slow or dead former holder can never remove a newer holder.
 *
 * Staleness never depends on timers or mtimes: a holder is stale exactly when
 * it is on this host and is no longer the same process (dead, zombie, or its
 * PID reused). Owners on other hosts (shared filesystems) are treated as alive.
 */

export interface OwnerLockRecord {
  hostname: string;
  pid: number;
  startIdentity?: string;
  token: string;
  acquiredAt: string;
}

export interface OwnerLock {
  readonly path: string;
  readonly owner: OwnerLockRecord;
  /** True while this handle's generation is still the lock's top holder. */
  held(): boolean;
  /** Releases if still held by this handle; otherwise a no-op. Idempotent. */
  release(): void;
}

export interface OwnerLockOptions {
  /** Total wait for a held lock. 0 tries once; Infinity waits while the holder lives. */
  timeoutMs?: number;
  /** Poll interval while waiting. */
  retryMs?: number;
  /** Names the lock in timeout errors. */
  label?: string;
}

export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const defaultRetryMs = 25;
const maximumRecordBytes = 4096;
const privateDirMode = 0o700;
const privateFileMode = 0o600;
const generationPattern = /^\d{1,15}$/;
// An unparseable top record is only possible through the non-link fallback
// (written in place) or outside interference; give a writer this long.
const unreadableGraceMs = 5_000;
// Re-verify a holder's start identity (a `ps`/PowerShell spawn off Linux) at
// most this often; liveness itself is re-probed on every attempt.
const identityRecheckMs = 1_000;

type TopRecord =
  | { kind: "none" }
  | { kind: "held"; generation: number; owner: OwnerLockRecord }
  | { kind: "released"; generation: number }
  | { kind: "unreadable"; generation: number; fresh: boolean }
  | { kind: "vanished" };

export class OwnerLockTimeoutError extends Error {
  readonly code = "ELOCKED";
  constructor(message: string, readonly holder: OwnerLockRecord | undefined) {
    super(message);
  }
}

/** One attempt; undefined when another live owner holds the lock. */
export function tryAcquireOwnerLock(path: string): OwnerLock | undefined {
  return attempt(path, new Map());
}

export function acquireOwnerLockSync(path: string, options: OwnerLockOptions = {}): OwnerLock {
  const deadline = deadlineFor(options);
  const verified = new Map<string, number>();
  while (true) {
    const lock = attempt(path, verified);
    if (lock) return lock;
    if (Date.now() >= deadline) throw timeoutError(path, options);
    sleepSync(Math.min(options.retryMs ?? defaultRetryMs, Math.max(1, deadline - Date.now())));
  }
}

/** Waits without blocking the event loop. */
export async function acquireOwnerLock(path: string, options: OwnerLockOptions = {}): Promise<OwnerLock> {
  const deadline = deadlineFor(options);
  const verified = new Map<string, number>();
  while (true) {
    const lock = attempt(path, verified);
    if (lock) return lock;
    if (Date.now() >= deadline) throw timeoutError(path, options);
    const delay = Math.min(options.retryMs ?? defaultRetryMs, Math.max(1, deadline - Date.now()));
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}

/** Runs `callback` while holding the lock (sync wait; keep `callback` short). */
export function withOwnerLockSync<T>(path: string, callback: () => T, options: OwnerLockOptions = {}): T {
  const lock = acquireOwnerLockSync(path, options);
  try {
    return callback();
  } finally {
    lock.release();
  }
}

/** The current holder if one is alive (or on another host); otherwise undefined. */
export function readOwnerLockHolder(path: string): OwnerLockRecord | undefined {
  for (let tries = 0; tries < 10; tries += 1) {
    let top: TopRecord;
    try {
      top = readTop(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (top.kind === "vanished") continue;
    return top.kind === "held" && holderAlive(top.owner, new Map()) ? top.owner : undefined;
  }
  return undefined;
}

/**
 * The recorded state, without judging liveness: "held" names the last
 * acquirer even if it has since died (use readOwnerLockHolder for a live one).
 */
export function inspectOwnerLock(path: string): { state: "free" | "held" | "released"; owner?: OwnerLockRecord } {
  for (let tries = 0; tries < 10; tries += 1) {
    let top: TopRecord;
    try {
      top = readTop(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "free" };
      throw error;
    }
    if (top.kind === "vanished") continue;
    if (top.kind === "held") return { state: "held", owner: top.owner };
    return { state: top.kind === "released" ? "released" : "free" };
  }
  return { state: "held" };
}

function attempt(path: string, verified: Map<string, number>): OwnerLock | undefined {
  ensureLockDirectory(path);
  for (let tries = 0; tries < 10; tries += 1) {
    const top = readTop(path);
    if (top.kind === "vanished") continue;
    if (top.kind === "held" && holderAlive(top.owner, verified)) return undefined;
    if (top.kind === "unreadable" && top.fresh) return undefined;
    const generation = top.kind === "none" ? 1 : top.generation + 1;
    const owner: OwnerLockRecord = {
      hostname: hostname(),
      pid: process.pid,
      ...(ownProcessStartIdentity() === undefined ? {} : { startIdentity: ownProcessStartIdentity() }),
      token: randomUUID(),
      acquiredAt: new Date().toISOString(),
    };
    if (!createGeneration(path, generation, owner)) continue;
    const highest = highestGeneration(path);
    if (highest !== generation) {
      removeGeneration(path, generation);
      continue;
    }
    for (const lower of listGenerations(path)) {
      if (lower < generation) removeGeneration(path, lower);
    }
    return lockHandle(path, generation, owner);
  }
  return undefined;
}

function lockHandle(path: string, generation: number, owner: OwnerLockRecord): OwnerLock {
  let released = false;
  const held = () => {
    if (released) return false;
    const top = readTop(path);
    return top.kind === "held" && top.generation === generation && top.owner.token === owner.token;
  };
  return {
    path,
    owner,
    held,
    release: () => {
      if (released) return;
      released = true;
      try {
        if (!createGeneration(path, generation + 1, { released: true, token: owner.token })) return;
      } catch (error) {
        // The lock directory was removed from under us: nothing left to release.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        released = false;
        throw error;
      }
      removeGeneration(path, generation);
    },
  };
}

function holderAlive(owner: OwnerLockRecord, verified: Map<string, number>): boolean {
  if (owner.hostname !== hostname()) return true;
  const checkedAt = verified.get(owner.token);
  if (checkedAt !== undefined && Date.now() - checkedAt < identityRecheckMs) {
    // Identity recently matched; only re-probe that the PID still lives.
    if (isSameProcess(owner.pid, undefined)) return true;
  }
  if (!isSameProcess(owner.pid, owner.startIdentity)) return false;
  verified.set(owner.token, Date.now());
  return true;
}

function readTop(path: string): TopRecord {
  const generation = highestGeneration(path);
  if (generation === undefined) return { kind: "none" };
  const file = generationPath(path, generation);
  let text: string;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
    text = readBounded(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "vanished" };
    throw error;
  }
  const record = parseRecord(text);
  if (record === "released") return { kind: "released", generation };
  if (record) return { kind: "held", generation, owner: record };
  return { kind: "unreadable", generation, fresh: Date.now() - mtimeMs < unreadableGraceMs };
}

function parseRecord(text: string): OwnerLockRecord | "released" | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.released === true) return "released";
  if (typeof record.hostname !== "string" || !record.hostname) return undefined;
  if (!validProcessId(record.pid)) return undefined;
  if (record.startIdentity !== undefined && typeof record.startIdentity !== "string") return undefined;
  if (typeof record.token !== "string" || !record.token) return undefined;
  return {
    hostname: record.hostname,
    pid: record.pid,
    ...(record.startIdentity === undefined ? {} : { startIdentity: record.startIdentity as string }),
    token: record.token,
    acquiredAt: typeof record.acquiredAt === "string" ? record.acquiredAt : "",
  };
}

function listGenerations(path: string): number[] {
  return readdirSync(path)
    .filter((entry) => generationPattern.test(entry))
    .map(Number)
    .sort((left, right) => left - right);
}

function highestGeneration(path: string): number | undefined {
  return listGenerations(path).at(-1);
}

function generationPath(path: string, generation: number): string {
  return join(path, String(generation).padStart(12, "0"));
}

/** Atomically creates a generation file with its full content; false if it exists. */
function createGeneration(path: string, generation: number, content: object): boolean {
  const target = generationPath(path, generation);
  const temporary = join(path, `.tmp-${randomUUID()}`);
  writeFileSync(temporary, `${JSON.stringify(content)}\n`, { flag: "wx", mode: privateFileMode });
  try {
    linkSync(temporary, target);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS" && code !== "EOPNOTSUPP") throw error;
    // No hard links on this filesystem: exclusive create, written in place.
    // Readers give a not-yet-parseable file unreadableGraceMs to fill in.
    try {
      writeFileSync(target, `${JSON.stringify(content)}\n`, { flag: "wx", mode: privateFileMode });
      return true;
    } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw fallbackError;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

function removeGeneration(path: string, generation: number): void {
  try {
    unlinkSync(generationPath(path, generation));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function ensureLockDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: privateDirMode });
  // Refuse a symlink (or anything else) planted where the directory belongs.
  if (!lstatSync(path).isDirectory()) {
    throw Object.assign(new Error(`lock path is not a directory: ${path}`), { code: "ENOTDIR" });
  }
  chmodSync(path, privateDirMode);
}

function readBounded(file: string): string {
  const descriptor = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(maximumRecordBytes);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function deadlineFor(options: OwnerLockOptions): number {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  return timeoutMs === Infinity ? Infinity : Date.now() + Math.max(0, timeoutMs);
}

function timeoutError(path: string, options: OwnerLockOptions): OwnerLockTimeoutError {
  const holder = readOwnerLockHolder(path);
  const label = options.label ?? "lock";
  const by = holder ? ` (held by pid ${holder.pid} on ${holder.hostname})` : "";
  return new OwnerLockTimeoutError(`timed out acquiring ${label}: ${path}${by}`, holder);
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
