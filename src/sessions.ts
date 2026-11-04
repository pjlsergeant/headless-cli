import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import type { AgentName, Env } from "./types.js";
import { validateCodexProfileName } from "./codex-profile.js";
import { withOwnerLockSync } from "./owner-lock.js";

export type StoredTmuxWaitStrategy =
  | { kind: "pin"; sessionId: string }
  | { kind: "title"; title: string }
  | { kind: "dir"; sessionDir: string }
  | { kind: "claim"; claimed: string };

export interface StoredSession {
  agent: AgentName;
  alias: string;
  nativeId?: string;
  profile?: string;
  tmuxWaitStrategy?: StoredTmuxWaitStrategy;
  workDir?: string;
  createdAt: string;
  updatedAt: string;
}

interface SessionStoreFile {
  version: 1;
  agents: Partial<Record<AgentName, Record<string, StoredSession>>>;
}

const maxSessionStoreBytes = 1024 * 1024;
const sessionStoreLockMaxHoldMs = 60_000;

export function sessionStorePath(env: Env): string | undefined {
  return env.HOME ? join(env.HOME, ".headless", "sessions.json") : undefined;
}

export function readStoredSession(env: Env, agent: AgentName, alias: string): StoredSession | undefined {
  const path = sessionStorePath(env);
  return path ? readSessionStore(path).agents[agent]?.[alias] : undefined;
}

/**
 * Every write is a read-modify-write of the whole store under its lock, so
 * concurrent runs never drop each other's aliases. An unreadable store throws
 * instead of being replaced by an empty one.
 */
function updateSessionStore(path: string, update: (store: SessionStoreFile) => StoredSession): StoredSession {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withOwnerLockSync(`${path}.lock`, (lock) => {
    const store = readSessionStore(path);
    const stored = update(store);
    // A holder past maxHoldMs loses the lock; never publish over a newer
    // writer. (Residual: losing it between this check and the rename.)
    if (!lock.held()) throw new Error(`session store lock was lost before writing: ${path}`);
    writeSessionStore(path, store);
    return stored;
  }, {
    label: "session store lock",
    // The holder may be a nested headless in a Docker container sharing this
    // home, whose liveness the host cannot probe: a section this short that
    // is still held after a minute has died.
    maxHoldMs: sessionStoreLockMaxHoldMs,
    timeoutMs: sessionStoreLockMaxHoldMs + 30_000,
  });
}

export function writeStoredSession(
  env: Env,
  session: Pick<StoredSession, "agent" | "alias" | "nativeId" | "profile" | "workDir">,
): StoredSession {
  const path = sessionStorePath(env);
  if (!path) {
    throw new Error("HOME is required for --session");
  }

  return updateSessionStore(path, (store) => {
    const existing = store.agents[session.agent]?.[session.alias];
    const now = new Date().toISOString();
    const stored: StoredSession = {
      agent: session.agent,
      alias: session.alias,
      nativeId: session.nativeId,
      profile: session.profile ?? existing?.profile,
      tmuxWaitStrategy: existing?.tmuxWaitStrategy,
      workDir: session.workDir,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    setStoredSession(store, stored);
    return stored;
  });
}

export function writeStoredTmuxSession(
  env: Env,
  session: Pick<StoredSession, "agent" | "alias" | "profile" | "tmuxWaitStrategy" | "workDir">,
): StoredSession {
  const path = sessionStorePath(env);
  if (!path) {
    throw new Error("HOME is required for --session");
  }

  return updateSessionStore(path, (store) => {
    const existing = store.agents[session.agent]?.[session.alias];
    const now = new Date().toISOString();
    const stored: StoredSession = {
      agent: session.agent,
      alias: session.alias,
      nativeId: existing?.nativeId,
      profile: session.profile ?? existing?.profile,
      tmuxWaitStrategy: session.tmuxWaitStrategy,
      workDir: session.workDir,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    setStoredSession(store, stored);
    return stored;
  });
}

function setStoredSession(store: SessionStoreFile, stored: StoredSession): void {
  const sessions = store.agents[stored.agent] ?? (Object.create(null) as Record<string, StoredSession>);
  sessions[stored.alias] = stored;
  store.agents[stored.agent] = sessions;
}

// The store may live in a Docker session home the container can write, so it
// is read without following symlinks, bounded, and validated record by record.
function readSessionStore(path: string): SessionStoreFile {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size > maxSessionStoreBytes) {
      throw new Error("session store must be a bounded regular file");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(descriptor, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) throw corruptStoreError(path);
      throw error;
    }
    return normalizeSessionStore(parsed, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function corruptStoreError(path: string): Error {
  return new Error(`session store is unreadable; fix or remove it: ${path}`);
}

function normalizeSessionStore(value: unknown, path: string): SessionStoreFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.agents)) throw corruptStoreError(path);
  const store = emptyStore();
  for (const agent of ["acp", "antigravity", "claude", "codex", "cursor", "gemini", "opencode", "pi"] as const) {
    const sessions = value.agents[agent];
    if (!isRecord(sessions)) continue;
    const normalizedSessions = Object.create(null) as Record<string, StoredSession>;
    for (const [alias, candidate] of Object.entries(sessions)) {
      const session = normalizeStoredSession(candidate, agent, alias);
      if (session) {
        normalizedSessions[alias] = session;
      }
    }
    if (Object.keys(normalizedSessions).length > 0) {
      store.agents[agent] = normalizedSessions;
    }
  }
  return store;
}

function normalizeStoredSession(value: unknown, agent: AgentName, alias: string): StoredSession | undefined {
  if (
    !isRecord(value) ||
    value.agent !== agent ||
    value.alias !== alias ||
    alias === "." ||
    alias === ".." ||
    !/^[A-Za-z0-9_.-]+$/.test(alias) ||
    typeof value.createdAt !== "string" ||
    value.createdAt.length > 64 ||
    typeof value.updatedAt !== "string" ||
    value.updatedAt.length > 64
  ) {
    return undefined;
  }
  const nativeId = boundedOptionalString(value.nativeId, 4096);
  const profile = boundedOptionalProfile(value.profile);
  const workDir = boundedOptionalString(value.workDir, 4096);
  const tmuxWaitStrategy = optionalTmuxWaitStrategy(value.tmuxWaitStrategy);
  if (nativeId === null || profile === null || workDir === null || tmuxWaitStrategy === null) return undefined;
  return {
    agent,
    alias,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(nativeId === undefined ? {} : { nativeId }),
    ...(profile === undefined ? {} : { profile }),
    ...(tmuxWaitStrategy === undefined ? {} : { tmuxWaitStrategy }),
    ...(workDir === undefined ? {} : { workDir }),
  };
}

function optionalTmuxWaitStrategy(value: unknown): StoredTmuxWaitStrategy | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const field = { pin: "sessionId", title: "title", dir: "sessionDir", claim: "claimed" }[String(value.kind)];
  if (!field) return null;
  const text = value[field];
  if (typeof text !== "string" || text.length > 4096) return null;
  return { kind: value.kind, [field]: text } as StoredTmuxWaitStrategy;
}

function boundedOptionalString(value: unknown, maxLength: number): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

function boundedOptionalProfile(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  try {
    return validateCodexProfileName(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyStore(): SessionStoreFile {
  return { version: 1, agents: {} };
}

function writeSessionStore(path: string, store: SessionStoreFile): void {
  const contents = `${JSON.stringify(store, null, 2)}\n`;
  if (Buffer.byteLength(contents) > maxSessionStoreBytes) {
    throw new Error("session store exceeds its size limit");
  }
  const tmpPath = join(dirname(path), `.sessions.json.tmp-${process.pid}-${randomUUID()}`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      tmpPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, contents);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tmpPath, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(tmpPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}
