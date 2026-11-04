import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

import type { CoordinationMode, Role, RunStatus } from "./roles.js";
import {
  acquireNodeStoreLock,
  acquireRunStoreLock,
  replaceRunStateFile,
  type NodeStoreLockOwner,
} from "./run-storage.js";
import type { AgentName, AllowMode, Env, ReasoningEffort } from "./types.js";

const privateDirMode = 0o700;
const privateFileMode = 0o600;

export interface RunNode {
  runId: string;
  nodeId: string;
  role: Role;
  agent: AgentName;
  coordination: CoordinationMode;
  status: RunStatus;
  lastMessage?: string;
  dependsOn: string[];
  planned: boolean;
  unplanned: boolean;
  allow?: AllowMode;
  model?: string;
  profile?: string;
  fast?: boolean;
  /** --keep-background: leave the agent's background processes running. */
  keepBackground?: boolean;
  reasoningEffort?: ReasoningEffort;
  workDir?: string;
  sessionAlias?: string;
  tmuxSessionName?: string;
  /**
   * Where the host launched this node: recorded at registration from the
   * host's own invocation. A sandboxed node is never relaunched on the host.
   */
  sandbox: SandboxKind;
  metrics?: RunNodeMetrics;
  createdAt: string;
  updatedAt: string;
}

export type SandboxKind = "none" | "docker" | "modal";

const sandboxKinds: readonly SandboxKind[] = ["none", "docker", "modal"];

export function isSandboxKind(value: unknown): value is SandboxKind {
  return typeof value === "string" && (sandboxKinds as readonly string[]).includes(value);
}

export interface RunNodeMetrics {
  turns?: number;
  durationMs?: number;
  apiDurationMs?: number;
  totalCostUsd?: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

export interface NativeTranscript {
  kind: "jsonl" | "sqlite";
  path: string;
  sessionId?: string;
  startedAt?: string;
  completedAt?: string;
  startOffset?: number;
  endOffset?: number;
}

export interface RunEvent {
  type:
    | "run_started"
    | "node_registered"
    | "node_started"
    | "message_sent"
    | "status_changed"
    | "node_output"
    | "node_failed"
    | "node_completed";
  runId: string;
  nodeId?: string;
  parentNodeId?: string;
  targetNodeId?: string;
  role?: Role;
  agent?: AgentName;
  coordination?: CoordinationMode;
  status?: RunStatus;
  message?: string;
  dependsOn?: string[];
  createdAt: string;
}

export interface RunRecord {
  version: 2;
  runId: string;
  createdAt: string;
  updatedAt: string;
  nodes: Record<string, RunNode>;
  events: RunEvent[];
}

export interface RegisterNodeInput {
  runId: string;
  nodeId: string;
  role: Role;
  agent: AgentName;
  coordination: CoordinationMode;
  status?: RunStatus;
  dependsOn?: string[];
  planned?: boolean;
  allow?: AllowMode;
  model?: string;
  profile?: string;
  fast?: boolean;
  /** --keep-background: leave the agent's background processes running. */
  keepBackground?: boolean;
  reasoningEffort?: ReasoningEffort;
  workDir?: string;
  sessionAlias?: string;
  tmuxSessionName?: string;
  sandbox: SandboxKind;
}

export function validateRunId(value: string | undefined, label: string): string {
  if (!value || value === "." || value === ".." || !/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`invalid ${label}; use letters, numbers, dots, dashes, or underscores`);
  }
  return value;
}

export function isValidRunId(value: unknown): value is string {
  return typeof value === "string" && value !== "." && value !== ".." && /^[A-Za-z0-9_.-]+$/.test(value);
}

export function validateNodeId(value: string | undefined): string {
  return validateRunId(value, "node");
}

export function runDirectory(env: Env, runId: string): string {
  validateRunId(runId, "run");
  const override = env.HEADLESS_RUN_DIR;
  if (override) {
    if (basename(override) !== runId) {
      throw new Error(`HEADLESS_RUN_DIR is for run ${basename(override)}, not ${runId}`);
    }
    return override;
  }
  if (!env.HOME) {
    throw new Error("HOME is required for --run");
  }
  return join(env.HOME, ".headless", "runs", runId);
}

export function runStoreRoot(env: Env): string {
  if (env.HEADLESS_RUN_DIR) {
    return dirname(env.HEADLESS_RUN_DIR);
  }
  if (!env.HOME) {
    throw new Error("HOME is required for headless run");
  }
  return join(env.HOME, ".headless", "runs");
}

export function nodeDirectory(env: Env, runId: string, nodeId: string): string {
  return join(runDirectory(env, runId), "nodes", validateNodeId(nodeId));
}

export function nodeLockPath(env: Env, runId: string, nodeId: string): string {
  return join(nodeDirectory(env, runId, nodeId), "session.lock");
}

/** Derived from the ids alone; never read from run state. */
export function nodeLogPath(env: Env, runId: string, nodeId: string, stream: "stdout" | "stderr"): string {
  return join(nodeDirectory(env, runId, nodeId), `latest.${stream}.log`);
}

export function appendNodeLog(
  env: Env,
  runId: string,
  nodeId: string,
  stream: "stdout" | "stderr",
  text: string,
): void {
  if (!text) {
    return;
  }
  const path = nodeLogPath(env, runId, nodeId, stream);
  ensureNodeDir(env, runId, nodeId);
  appendPrivateFile(path, text);
}

/** Opens the node's log for appending (no symlink following); caller closes it. */
export function openNodeLog(env: Env, runId: string, nodeId: string, stream: "stdout" | "stderr"): number {
  ensureNodeDir(env, runId, nodeId);
  return openPrivateAppend(nodeLogPath(env, runId, nodeId, stream));
}

export function readRun(env: Env, runId: string): RunRecord | undefined {
  const state = readRunState(env, runId);
  return state.kind === "ok" ? state.run : undefined;
}

type RunState = { kind: "missing" } | { kind: "invalid" } | { kind: "ok"; run: RunRecord };

function readRunState(env: Env, runId: string): RunState {
  const path = join(runDirectory(env, runId), "run.json");
  if (!existsSync(path)) {
    return { kind: "missing" };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Omit<RunRecord, "version">> & { version?: number };
    if (
      parsed.version !== 2 || parsed.runId !== runId
      || !isPlainObject(parsed.nodes) || !Array.isArray(parsed.events)
    ) {
      return { kind: "invalid" };
    }
    // Node ids name directories under the run dir: drop any entry whose key
    // is not a valid id or does not match the node it holds.
    const nodes: Record<string, RunNode> = {};
    for (const [nodeId, node] of Object.entries(parsed.nodes as Record<string, unknown>)) {
      if (!isValidRunId(nodeId) || !isPlainObject(node)) continue;
      const candidate = node as unknown as RunNode;
      if (candidate.nodeId !== nodeId || candidate.runId !== runId || !isSandboxKind(candidate.sandbox)) continue;
      nodes[nodeId] = candidate;
    }
    return {
      kind: "ok",
      run: {
        version: 2,
        runId,
        createdAt: parsed.createdAt ?? new Date().toISOString(),
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
        nodes,
        events: parsed.events,
      },
    };
  } catch {
    return { kind: "invalid" };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function listRuns(env: Env): RunRecord[] {
  const root = runStoreRoot(env);
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root)
    .filter(isValidRunId)
    .map((entry) => readRun({ ...env, HEADLESS_RUN_DIR: join(root, entry) }, entry))
    .filter((run): run is RunRecord => Boolean(run))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function registerNode(env: Env, input: RegisterNodeInput): RunNode {
  validateRunId(input.runId, "run");
  validateRunId(input.nodeId, "node");
  if (!isSandboxKind(input.sandbox)) {
    throw new Error(`invalid sandbox kind for node ${input.nodeId}`);
  }
  return withRunLock(env, input.runId, () => {
    const state = readRunState(env, input.runId);
    if (state.kind === "invalid") {
      // Never replace state we could not read: that would silently discard
      // the run's roster and history.
      throw new Error(`run state is unreadable: ${input.runId}`);
    }
    const run = state.kind === "ok" ? state.run : emptyRun(input.runId);
    const now = new Date().toISOString();
    const existing = run.nodes[input.nodeId];
    if (existing && existing.sandbox !== input.sandbox) {
      throw new Error(
        `node ${input.nodeId} in run ${input.runId} was launched with sandbox ${existing.sandbox}; `
        + `relaunch it with the same sandbox (${sandboxFlag(existing.sandbox)}), not ${sandboxFlag(input.sandbox)}`,
      );
    }
    const status =
      existing?.status === "busy" && input.status === "starting"
        ? "busy"
        : (input.status ?? existing?.status ?? "planned");
    const node: RunNode = {
      runId: input.runId,
      nodeId: input.nodeId,
      role: input.role,
      agent: input.agent,
      coordination: input.coordination,
      status,
      lastMessage: existing?.lastMessage,
      dependsOn: unique(input.dependsOn ?? existing?.dependsOn ?? []),
      planned: input.planned ?? existing?.planned ?? false,
      unplanned: !(input.planned ?? existing?.planned ?? false),
      allow: input.allow ?? existing?.allow,
      model: input.model ?? existing?.model,
      profile: input.agent === existing?.agent ? (input.profile ?? existing.profile) : input.profile,
      fast: input.agent === existing?.agent ? (input.fast ?? existing.fast) : input.fast,
      ...((input.keepBackground ?? existing?.keepBackground) ? { keepBackground: true } : {}),
      reasoningEffort: input.reasoningEffort ?? existing?.reasoningEffort,
      workDir: input.workDir ?? existing?.workDir,
      sessionAlias: input.sessionAlias ?? existing?.sessionAlias,
      tmuxSessionName: input.tmuxSessionName ?? existing?.tmuxSessionName,
      sandbox: input.sandbox,
      metrics: existing?.metrics,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    run.nodes[input.nodeId] = node;
    addEvent(run, {
      type: existing ? "node_started" : "node_registered",
      runId: input.runId,
      nodeId: input.nodeId,
      role: input.role,
      agent: input.agent,
      coordination: input.coordination,
      status: node.status,
      dependsOn: node.dependsOn,
      createdAt: now,
    });
    writeRun(env, run);
    return node;
  });
}

export function updateNodeStatus(
  env: Env,
  runId: string,
  nodeId: string,
  status: RunStatus,
  message?: string,
  metrics?: RunNodeMetrics,
): RunNode {
  validateRunId(runId, "run");
  validateNodeId(nodeId);
  return withRunLock(env, runId, () => {
    const run = requireRun(env, runId);
    const node = requireNode(run, nodeId);
    const now = new Date().toISOString();
    node.status = status;
    node.updatedAt = now;
    if (message !== undefined) {
      node.lastMessage = message;
    }
    if (metrics && Object.keys(metrics).length > 0) {
      node.metrics = { ...node.metrics, ...metrics };
    }
    addEvent(run, {
      type: status === "failed" ? "node_failed" : status === "done" || status === "idle" ? "node_completed" : "status_changed",
      runId,
      nodeId,
      status,
      message,
      createdAt: now,
    });
    writeRun(env, run);
    return node;
  });
}

export function completeIdleRunNodes(env: Env, runId: string, orchestratorNodeId: string, orchestratorMessage?: string): void {
  validateRunId(runId, "run");
  withRunLock(env, runId, () => {
    const run = requireRun(env, runId);
    const now = new Date().toISOString();
    for (const node of Object.values(run.nodes)) {
      const shouldComplete = node.nodeId === orchestratorNodeId || node.status === "idle";
      if (!shouldComplete) {
        continue;
      }
      node.status = "done";
      node.updatedAt = now;
      if (node.nodeId === orchestratorNodeId && orchestratorMessage !== undefined) {
        node.lastMessage = orchestratorMessage;
      }
      addEvent(run, {
        type: "node_completed",
        runId,
        nodeId: node.nodeId,
        status: "done",
        message: node.nodeId === orchestratorNodeId ? orchestratorMessage : undefined,
        createdAt: now,
      });
    }
    writeRun(env, run);
  });
}

export function recordMessage(
  env: Env,
  runId: string,
  fromNodeId: string,
  targetNodeId: string,
  message: string,
): void {
  validateRunId(runId, "run");
  validateNodeId(targetNodeId);
  withRunLock(env, runId, () => {
    const run = requireRun(env, runId);
    const now = new Date().toISOString();
    if (!run.nodes[targetNodeId]) {
      throw new Error(`unknown node in run ${runId}: ${targetNodeId}`);
    }
    const sourceNode = run.nodes[fromNodeId];
    const messageOwner = sourceNode ?? run.nodes[targetNodeId];
    messageOwner.lastMessage = message;
    messageOwner.updatedAt = now;
    addEvent(run, {
      type: "message_sent",
      runId,
      nodeId: fromNodeId,
      targetNodeId,
      message,
      createdAt: now,
    });
    writeRun(env, run);
  });
}

export function acquireNodeLock(env: Env, runId: string, nodeId: string, owner?: NodeStoreLockOwner): () => void {
  const lockPath = nodeLockPath(env, runId, nodeId);
  ensureNodeDir(env, runId, nodeId);
  return acquireNodeStoreLock(lockPath, nodeId, owner);
}

export function writeRun(env: Env, run: RunRecord): void {
  const dir = runDirectory(env, run.runId);
  ensurePrivateDir(dir);
  for (const nodeId of Object.keys(run.nodes)) {
    ensureNodeDir(env, run.runId, nodeId);
  }
  run.updatedAt = new Date().toISOString();
  const path = join(dir, "run.json");
  const tmpPath = `${path}.tmp-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(tmpPath, "wx", privateFileMode);
    writeFileSync(descriptor, `${JSON.stringify(run, null, 2)}\n`);
    fchmodSync(descriptor, privateFileMode);
    closeSync(descriptor);
    descriptor = undefined;
    replaceRunStateFile(tmpPath, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(tmpPath, { force: true });
  }
  chmodSync(path, privateFileMode);
  // Every event the transaction added, not just the last one.
  const events = pendingEvents.get(run) ?? [];
  pendingEvents.delete(run);
  if (events.length > 0) {
    appendPrivateFile(join(dir, "events.jsonl"), events.map((event) => `${JSON.stringify(event)}\n`).join(""));
  }
}

function withRunLock<T>(env: Env, runId: string, callback: () => T): T {
  const release = acquireRunLock(env, runId);
  try {
    return callback();
  } finally {
    release();
  }
}

function acquireRunLock(env: Env, runId: string): () => void {
  const dir = runDirectory(env, runId);
  ensurePrivateDir(dir);
  const lockPath = join(dir, "run.lock");
  return acquireRunStoreLock(lockPath, runId);
}

function requireRun(env: Env, runId: string): RunRecord {
  const run = readRun(env, runId);
  if (!run) {
    throw new Error(`unknown run: ${runId}`);
  }
  return run;
}

function requireNode(run: RunRecord, nodeId: string): RunNode {
  const node = run.nodes[nodeId];
  if (!node) {
    throw new Error(`unknown node in run ${run.runId}: ${nodeId}`);
  }
  return node;
}

function emptyRun(runId: string): RunRecord {
  const now = new Date().toISOString();
  const run: RunRecord = { version: 2, runId, createdAt: now, updatedAt: now, nodes: {}, events: [] };
  addEvent(run, { type: "run_started", runId, createdAt: now });
  return run;
}

const pendingEvents = new WeakMap<RunRecord, RunEvent[]>();

function addEvent(run: RunRecord, event: RunEvent): void {
  const pending = pendingEvents.get(run) ?? [];
  pending.push(event);
  pendingEvents.set(run, pending);
  run.events.push(event);
  if (run.events.length > 200) {
    run.events = run.events.slice(-200);
  }
}

function sandboxFlag(sandbox: SandboxKind): string {
  return sandbox === "none" ? "no sandbox" : `--${sandbox}`;
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: privateDirMode });
  chmodSync(path, privateDirMode);
}

/**
 * Creates <runDir>/nodes/<nodeId> without following a symbolic link at
 * either level, so a planted link cannot redirect the chmod or later writes.
 */
function ensureNodeDir(env: Env, runId: string, nodeId: string): void {
  const runDir = runDirectory(env, runId);
  ensurePrivateDir(runDir);
  ensureRealPrivateDir(join(runDir, "nodes"));
  ensureRealPrivateDir(nodeDirectory(env, runId, nodeId));
}

function ensureRealPrivateDir(path: string): void {
  try {
    mkdirSync(path, { mode: privateDirMode });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stats = lstatSync(path);
  if (!stats.isDirectory()) {
    throw new Error(`run store path is not a directory: ${path}`);
  }
  chmodSync(path, privateDirMode);
}

function openPrivateAppend(path: string): number {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    privateFileMode,
  );
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`run store path is not a regular file: ${path}`);
    }
    fchmodSync(descriptor, privateFileMode);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function appendPrivateFile(path: string, text: string): void {
  const descriptor = openPrivateAppend(path);
  try {
    writeFileSync(descriptor, text);
  } finally {
    closeSync(descriptor);
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
