import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { isRunStatus, type RunStatus } from "./roles.js";
import {
  appendNodeLog,
  ensureRunSubdirectory,
  isValidRunId,
  parseRunRecord,
  readRun,
  recordMessage,
  runDirectory,
  updateNodeStatus,
  type RunNode,
  type RunRecord,
} from "./runs.js";
import type { Env } from "./types.js";

/**
 * A Docker run node never sees the run directory. It gets one mailbox:
 *
 *   <runDir>/mailboxes/<nodeId>/requests -> /headless-mailbox/requests (rw)
 *   <runDir>/mailboxes/<nodeId>/replies  -> /headless-mailbox/replies  (ro)
 *
 * The container drops request files into requests/; the host process that
 * launched the container validates each one and applies it to run state
 * under the run lock. The host writes replies/<id>.json and a run state
 * snapshot replies/run.json, which the container can read but not change.
 * Nothing a container writes is used as a path, command, work dir,
 * permission mode, or environment on the host.
 */
export const RUN_MAILBOX_ENV = "HEADLESS_RUN_MAILBOX";
export const CONTAINER_MAILBOX_ROOT = "/headless-mailbox";
export const MAILBOX_SNAPSHOT_NAME = "run.json";

export const mailboxLimits = {
  /** Largest request file the host reads. */
  requestBytes: 256 * 1024,
  /** Longest prompt a request may carry. */
  promptChars: 100_000,
  /** Requests applied per poll; the rest wait for the next poll. */
  requestsPerPoll: 16,
  /** Requests one container may submit over its lifetime. */
  requestsPerMailbox: 500,
  /** Reply files kept before the oldest are removed. */
  replies: 64,
};

const requestFilePattern = /^([A-Za-z0-9-]{1,64})\.json$/;
const requestIdPattern = /^[A-Za-z0-9-]{1,64}$/;
const privateFileMode = 0o600;

export interface MailboxPaths {
  requests: string;
  replies: string;
}

export type MailboxRequest =
  | { version: 1; id: string; op: "message"; target: string; prompt: string; async: boolean }
  | { version: 1; id: string; op: "mark"; status: RunStatus };

export interface MailboxReply {
  version: 1;
  id: string;
  ok: boolean;
  /** For message: whether the target was started, not only recorded. */
  delivered?: boolean;
  error?: string;
}

export function mailboxPaths(env: Env, runId: string, nodeId: string): MailboxPaths {
  const root = join(runDirectory(env, runId), "mailboxes", nodeId);
  return { requests: join(root, "requests"), replies: join(root, "replies") };
}

/** Creates the node's mailbox and discards anything a previous container left in it. */
export function prepareMailbox(env: Env, runId: string, nodeId: string): MailboxPaths {
  const requests = ensureRunSubdirectory(env, runId, "mailboxes", nodeId, "requests");
  const replies = ensureRunSubdirectory(env, runId, "mailboxes", nodeId, "replies");
  for (const dir of [requests, replies]) {
    for (const entry of readdirSync(dir)) removeEntry(join(dir, entry));
  }
  return { requests, replies };
}

export function dockerMailboxArgs(paths: MailboxPaths): string[] {
  return [
    "--volume", `${paths.requests}:${CONTAINER_MAILBOX_ROOT}/requests`,
    "--volume", `${paths.replies}:${CONTAINER_MAILBOX_ROOT}/replies:ro`,
    "--env", `${RUN_MAILBOX_ENV}=${CONTAINER_MAILBOX_ROOT}`,
  ];
}

/** Starts the target node in the same sandbox as the requesting node. */
export type MailboxDeliver = (target: RunNode, prompt: string, fromNodeId: string) => Promise<void>;

export interface RunMailboxServiceOptions {
  env: Env;
  runId: string;
  nodeId: string;
  paths: MailboxPaths;
  deliver?: MailboxDeliver;
  log?: (text: string) => void;
  intervalMs?: number;
}

export class RunMailboxService {
  private readonly options: RunMailboxServiceOptions;
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;
  private processed = 0;
  private lastSnapshot = "";
  private readonly replyNames: string[] = [];

  constructor(options: RunMailboxServiceOptions) {
    this.options = options;
  }

  start(): void {
    this.writeSnapshot();
    const intervalMs = this.options.intervalMs ?? parseInterval(this.options.env.HEADLESS_RUN_MAILBOX_INTERVAL_MS, 200);
    this.timer = setInterval(() => void this.poll(), intervalMs);
    this.timer.unref();
  }

  /** Stops polling after one last pass, so requests sent just before exit apply. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.poll();
  }

  poll(): Promise<void> {
    this.polling ??= this.pollOnce().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    try {
      let names: string[];
      try {
        names = readdirSync(this.options.paths.requests);
      } catch {
        return;
      }
      const requests: string[] = [];
      for (const name of names) {
        if (requestFilePattern.test(name)) {
          requests.push(name);
        } else if (!name.startsWith(".")) {
          // Not a request; dot files are a client's in-progress writes.
          removeEntry(join(this.options.paths.requests, name));
          this.reject(name, undefined, "not a request file name");
        }
      }
      requests.sort();
      for (const name of requests.slice(0, mailboxLimits.requestsPerPoll)) {
        await this.processRequest(name);
      }
    } catch (error) {
      this.logLine(`run mailbox error: ${errorMessage(error)}`);
    } finally {
      try {
        this.writeSnapshot();
      } catch (error) {
        this.logLine(`run mailbox snapshot error: ${errorMessage(error)}`);
      }
    }
  }

  private async processRequest(name: string): Promise<void> {
    const path = join(this.options.paths.requests, name);
    const id = requestFilePattern.exec(name)?.[1] as string;
    let text: string;
    try {
      text = readRequestFile(path);
    } catch (error) {
      this.reject(name, id, errorMessage(error));
      return;
    } finally {
      removeEntry(path);
    }
    this.processed += 1;
    if (this.processed > mailboxLimits.requestsPerMailbox) {
      this.reject(name, id, `request limit reached (${mailboxLimits.requestsPerMailbox} per container)`);
      return;
    }
    const request = parseMailboxRequest(text, id);
    if (typeof request === "string") {
      this.reject(name, id, request);
      return;
    }
    try {
      const reply = await this.apply(request);
      this.writeSnapshot();
      this.writeReply(reply);
    } catch (error) {
      this.reject(name, id, errorMessage(error));
    }
  }

  private async apply(request: MailboxRequest): Promise<MailboxReply> {
    const { env, runId, nodeId } = this.options;
    if (request.op === "mark") {
      updateNodeStatus(env, runId, nodeId, request.status);
      return { version: 1, id: request.id, ok: true };
    }
    const run = readRun(env, runId);
    const target = run?.nodes[request.target];
    if (!target) {
      throw new Error(`unknown node in run ${runId}: ${request.target}`);
    }
    if (target.nodeId === nodeId) {
      throw new Error("a node cannot message itself");
    }
    const refusal = deliveryRefusal(target, Boolean(this.options.deliver));
    if (refusal) {
      recordMessage(env, runId, nodeId, target.nodeId, request.prompt);
      return { version: 1, id: request.id, ok: true, delivered: false, error: refusal };
    }
    await this.options.deliver!(target, request.prompt, nodeId);
    return { version: 1, id: request.id, ok: true, delivered: true };
  }

  private reject(name: string, id: string | undefined, reason: string): void {
    this.logLine(`run mailbox rejected request ${JSON.stringify(name.slice(0, 80))} from ${this.options.nodeId}: ${reason}`);
    if (id) {
      try {
        this.writeReply({ version: 1, id, ok: false, error: reason });
      } catch {
        // The rejection is already logged.
      }
    }
  }

  private logLine(text: string): void {
    const line = `headless: ${text}\n`;
    try {
      appendNodeLog(this.options.env, this.options.runId, this.options.nodeId, "stderr", line);
    } catch {
      // Logging must not stop the mailbox.
    }
    this.options.log?.(line);
  }

  private writeSnapshot(): void {
    const run = readRun(this.options.env, this.options.runId);
    if (!run) return;
    const text = `${JSON.stringify(run)}\n`;
    if (text === this.lastSnapshot) return;
    writeFileAtomic(join(this.options.paths.replies, MAILBOX_SNAPSHOT_NAME), text);
    this.lastSnapshot = text;
  }

  private writeReply(reply: MailboxReply): void {
    const name = `${reply.id}.json`;
    writeFileAtomic(join(this.options.paths.replies, name), `${JSON.stringify(reply)}\n`);
    this.replyNames.push(name);
    while (this.replyNames.length > mailboxLimits.replies) {
      rmSync(join(this.options.paths.replies, this.replyNames.shift() as string), { force: true });
    }
  }
}

/** Why a container's message to target is recorded but not started, if it is not started. */
function deliveryRefusal(target: RunNode, canDeliver: boolean): string | undefined {
  if (target.sandbox === "none") {
    return `node ${target.nodeId} runs on the host; a container cannot start it`;
  }
  if (target.sandbox !== "docker") {
    return `node ${target.nodeId} runs in ${target.sandbox}; a container cannot start it`;
  }
  if (target.coordination !== "oneshot") {
    return `node ${target.nodeId} uses ${target.coordination} coordination; only oneshot Docker nodes can be started from a container`;
  }
  if (target.status === "busy" || target.status === "starting") {
    return `node ${target.nodeId} is ${target.status}`;
  }
  if (!canDeliver) {
    return "this node cannot start other nodes";
  }
  return undefined;
}

/** Strict schema check; returns the request or the reason it was rejected. */
export function parseMailboxRequest(text: string, id: string): MailboxRequest | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "request is not JSON";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "request is not an object";
  }
  const request = value as Record<string, unknown>;
  if (request.version !== 1) return "unsupported request version";
  if (request.id !== id) return "request id does not match its file name";
  const allowedKeys: Record<string, string[]> = {
    message: ["version", "id", "op", "target", "prompt", "async"],
    mark: ["version", "id", "op", "status"],
  };
  const op = request.op;
  if (typeof op !== "string" || !Object.hasOwn(allowedKeys, op)) return "unsupported operation";
  const extra = Object.keys(request).filter((key) => !allowedKeys[op].includes(key));
  if (extra.length > 0) return `unexpected field: ${extra[0].slice(0, 40)}`;
  if (op === "mark") {
    if (typeof request.status !== "string" || !isRunStatus(request.status)) return "invalid status";
    return { version: 1, id, op: "mark", status: request.status };
  }
  if (!isValidRunId(request.target)) return "invalid target node id";
  if (typeof request.prompt !== "string" || request.prompt.trim() === "") return "prompt must be a non-empty string";
  if (request.prompt.length > mailboxLimits.promptChars) return `prompt exceeds ${mailboxLimits.promptChars} characters`;
  if (typeof request.async !== "boolean") return "async must be a boolean";
  return { version: 1, id, op: "message", target: request.target, prompt: request.prompt, async: request.async };
}

function readRequestFile(path: string): string {
  // O_NOFOLLOW and O_NONBLOCK: a planted symlink or FIFO is refused, not followed or waited on.
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    // Do not echo host paths back into the container.
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(code === "ELOOP" ? "request is a symbolic link" : `request could not be opened (${code ?? "error"})`);
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error("request is not a regular file");
    if (stats.size > mailboxLimits.requestBytes) throw new Error(`request exceeds ${mailboxLimits.requestBytes} bytes`);
    const text = readFileSync(descriptor, "utf8");
    if (Buffer.byteLength(text) > mailboxLimits.requestBytes) throw new Error(`request exceeds ${mailboxLimits.requestBytes} bytes`);
    return text;
  } finally {
    closeSync(descriptor);
  }
}

function removeEntry(path: string): void {
  try {
    const stats = lstatSync(path);
    // rmSync never follows symlinks, so a planted link is removed, not its target.
    rmSync(path, { force: true, recursive: stats.isDirectory() });
  } catch {
    // Already gone.
  }
}

function writeFileAtomic(path: string, text: string): void {
  const tmpPath = `${path}.tmp-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(tmpPath, "wx", privateFileMode);
    writeFileSync(descriptor, text);
    fchmodSync(descriptor, privateFileMode);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tmpPath, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(tmpPath, { force: true });
  }
}

// ---- Container side -------------------------------------------------------

export function containerMailboxRoot(env: Env): string | undefined {
  return env[RUN_MAILBOX_ENV] || undefined;
}

/** Reads the host's run state snapshot from the read-only replies mount. */
export function readMailboxSnapshot(root: string, runId: string): RunRecord | undefined {
  try {
    return parseRunRecord(readFileSync(join(root, "replies", MAILBOX_SNAPSHOT_NAME), "utf8"), runId);
  } catch {
    return undefined;
  }
}

export function newRequestId(): string {
  return randomUUID();
}

export function submitMailboxRequest(root: string, request: MailboxRequest): void {
  if (!requestIdPattern.test(request.id)) throw new Error("invalid request id");
  const requests = join(root, "requests");
  const tmpPath = join(requests, `.${request.id}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify(request)}\n`, { flag: "wx", mode: privateFileMode });
  renameSync(tmpPath, join(requests, `${request.id}.json`));
}

export async function waitForMailboxReply(root: string, id: string, timeoutMs: number): Promise<MailboxReply> {
  const path = join(root, "replies", `${id}.json`);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const reply = JSON.parse(readFileSync(path, "utf8")) as MailboxReply;
      if (reply.id === id) return reply;
    } catch {
      // Not written yet.
    }
    if (Date.now() >= deadline) {
      throw new Error("no reply from the host run mailbox; is the host headless process still running?");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function parseInterval(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
