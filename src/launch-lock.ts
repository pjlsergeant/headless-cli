import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { acquireOwnerLock } from "./owner-lock.js";
import type { AgentName, Env } from "./types.js";

const privateDirMode = 0o700;
// The holder keeps the lock until its brand-new transcript appears or its
// tmux session ends; with --timeout that claim wait is bounded by it. The
// holder may be a nested headless in a Docker container whose host cannot be
// probed, so a holder older than this is stale on any host.
const minimumLaunchLockHoldMs = 10 * 60_000;
const launchLockHoldMarginMs = 60_000;

export interface LaunchLock {
  release: () => void;
}

export interface DockerSessionLock {
  release: () => Promise<Error | undefined>;
}

interface LaunchLockOptions {
  /** Wait for a held lock; defaults to just over the maximum hold. */
  timeoutMs?: number;
  /** The run's --timeout, which bounds how long its transcript claim may hold the lock. */
  claimTimeoutSeconds?: number;
}

/** How long a launch-lock holder may hold before any waiter treats it as stale. */
export function launchLockMaxHoldMs(claimTimeoutSeconds?: number): number {
  const claimMs = claimTimeoutSeconds === undefined ? 0 : claimTimeoutSeconds * 1000 + launchLockHoldMarginMs;
  return Math.max(minimumLaunchLockHoldMs, claimMs);
}

// Serializes only the brief launch window of concurrent same-(agent, workspace)
// runs so the `claim` wait tier can attribute a brand-new transcript to this run.
// Different agents and different workspaces never contend (distinct lock files),
// and the lock is released before the agent's actual work is awaited.
export async function acquireLaunchLock(
  env: Env,
  agent: AgentName,
  workspace: string,
  options: LaunchLockOptions = {},
): Promise<LaunchLock> {
  const lockPath = launchLockPath(env, agent, workspace);
  if (!lockPath) return { release: () => {} };

  ensurePrivateDir(dirname(lockPath));
  const maxHoldMs = launchLockMaxHoldMs(options.claimTimeoutSeconds);
  const lock = await acquireOwnerLock(lockPath, {
    label: "launch lock",
    maxHoldMs,
    timeoutMs: options.timeoutMs ?? maxHoldMs + launchLockHoldMarginMs,
  });
  return {
    release: () => {
      try {
        lock.release();
      } catch {
        // Unreleasable (e.g. permissions): it becomes reclaimable once this process exits.
      }
    },
  };
}

export function launchLockPath(env: Env, agent: AgentName, workspace: string): string | undefined {
  if (!env.HOME) return undefined;
  const key = `${agent}-${workspace.replace(/\//g, "-")}`.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(env.HOME, ".headless", "launch-locks", key);
}

// Serializes every run of one durable Docker session home. A second run waits
// for as long as the first one lives (runs can take hours); a holder that died
// is reclaimed at once. No maxHoldMs: only host-side headless takes this lock
// (its directory is outside the container-visible home), so the holder can
// always be probed, and a hold time limit would cut off long legitimate runs.
export async function acquireDockerSessionLock(persistentHome: string): Promise<DockerSessionLock> {
  const lockPath = dockerSessionLockPath(persistentHome);
  ensurePrivateDir(dirname(lockPath));
  const lock = await acquireOwnerLock(lockPath, { label: "Docker session lock", retryMs: 250, timeoutMs: Infinity });
  let released = false;
  return {
    release: async () => {
      if (released) return undefined;
      released = true;
      try {
        lock.release();
        return undefined;
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    },
  };
}

export function dockerSessionLockPath(persistentHome: string): string {
  const canonicalHome = realpathSync(persistentHome);
  const sessionRoot = dirname(dirname(canonicalHome));
  const key = createHash("sha256").update(canonicalHome).digest("hex");
  return join(sessionRoot, ".headless-session-locks", `${key}.lock`);
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: privateDirMode });
  chmodSync(path, privateDirMode);
}
