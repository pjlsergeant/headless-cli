import { closeSync } from "node:fs";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { extractFinalMessage } from "./output.js";
import { deriveNativeTranscriptActivity, nativeTranscriptKey, resolveLatestNativeTranscripts } from "./native-transcripts.js";
import { extractRunNodeMetrics } from "./run-metrics.js";
import { renderRunList, renderRunView } from "./run-view.js";
import {
  acquireNodeLock,
  appendNodeLog,
  listRuns,
  nodeLogPath,
  openNodeLog,
  readRun,
  recordMessage,
  updateNodeStatus,
  type RunNode,
  type RunRecord,
} from "./runs.js";
import {
  containerMailboxRoot,
  newRequestId,
  readMailboxSnapshot,
  submitMailboxRequest,
  waitForMailboxReply,
  type MailboxReply,
  type MailboxRequest,
} from "./run-mailbox.js";
import { quoteCommand } from "./shell.js";
import { renderSdkResult, type SdkFormat } from "./sdk.js";
import type { AgentName, Env } from "./types.js";
import type { RunStatus } from "./roles.js";
import type { AsyncRunMessageRequest, AsyncRunMessageResponse, AsyncRunMessageTask } from "./async-run-message.js";

export interface RunCommandInput {
  command: "list" | "view" | "mark" | "message" | "wait";
  runId?: string;
  nodeId?: string;
  status?: RunStatus;
  async: boolean;
  printCommand: boolean;
  sdkFormat?: SdkFormat;
}

export interface ResolvedPrompt {
  prompt: string;
  promptFile?: string;
}

export interface RunCommandHandlers {
  env: Env;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  resolvePrompt: () => Promise<ResolvedPrompt>;
  executeNode: (node: RunNode, prompt: string) => Promise<{ code: number; stdout: string }>;
  sendTmux: (sessionName: string, prompt: string, printCommand: boolean) => Promise<number>;
}

export async function handleRunCommand(input: RunCommandInput, handlers: RunCommandHandlers): Promise<number> {
  const mailboxRoot = containerMailboxRoot(handlers.env);
  if (mailboxRoot) {
    return await handleMailboxRunCommand(input, handlers, mailboxRoot);
  }
  if (input.command === "list") {
    const runs = listRuns(handlers.env);
    handlers.stdout(
      input.sdkFormat
        ? renderSdkResult("runs.list", { runs: runs.map(sdkRunSummary) })
        : renderRunList(runs),
    );
    return 0;
  }
  const runId = requireValue(input.runId, "run");
  if (input.command === "view") {
    reconcileTmuxRunNodes(handlers.env, runId);
    const run = readRun(handlers.env, runId);
    if (!run) {
      throw new Error(`unknown run: ${runId}`);
    }
    handlers.stdout(
      input.sdkFormat
        ? renderSdkResult("runs.view", { run: sdkRunView(run) })
        : renderRunView(run, (nodeId) => nodeLogPath(handlers.env, runId, nodeId, "stdout")),
    );
    return 0;
  }
  if (input.command === "mark") {
    const nodeId = requireValue(input.nodeId, "node");
    if (!input.status) {
      throw new Error("run mark requires --status");
    }
    updateNodeStatus(handlers.env, runId, nodeId, input.status);
    handlers.stdout(`marked: ${runId}/${nodeId} ${input.status}\n`);
    return 0;
  }
  if (input.command === "wait") {
    await waitForRunIdle(handlers.env, runId);
    handlers.stdout(`run idle: ${runId}\n`);
    return 0;
  }
  if (input.command === "message") {
    return await handleRunMessage(input, handlers, runId);
  }
  throw new Error("unsupported run command");
}

/**
 * Inside a Docker run node: there is no run directory, only the node's
 * mailbox. Reads come from the host's read-only snapshot; changes are
 * requests the host validates and applies.
 */
async function handleMailboxRunCommand(
  input: RunCommandInput,
  handlers: RunCommandHandlers,
  root: string,
): Promise<number> {
  const ownRunId = handlers.env.HEADLESS_RUN_ID;
  const ownNodeId = handlers.env.HEADLESS_RUN_NODE;
  if (!ownRunId || !ownNodeId) {
    throw new Error("run mailbox requires HEADLESS_RUN_ID and HEADLESS_RUN_NODE");
  }
  const snapshot = (): RunRecord => {
    const run = readMailboxSnapshot(root, ownRunId);
    if (!run) throw new Error(`run state for ${ownRunId} is not available in this container yet`);
    return run;
  };
  if (input.command === "list") {
    const runs = [snapshot()];
    handlers.stdout(input.sdkFormat ? renderSdkResult("runs.list", { runs: runs.map(sdkRunSummary) }) : renderRunList(runs));
    return 0;
  }
  const runId = requireValue(input.runId, "run");
  if (runId !== ownRunId) {
    throw new Error(`this container can only reach its own run (${ownRunId}), not ${runId}`);
  }
  if (input.command === "view") {
    const run = snapshot();
    handlers.stdout(input.sdkFormat ? renderSdkResult("runs.view", { run: sdkRunView(run) }) : renderRunView(run));
    return 0;
  }
  if (input.command === "wait") {
    const intervalMs = parseDelayMs(handlers.env.HEADLESS_RUN_WAIT_INTERVAL_MS, 1000);
    while (Object.values(snapshot().nodes).some((node) => node.nodeId !== ownNodeId && isActive(node.status))) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    handlers.stdout(`run idle: ${runId}\n`);
    return 0;
  }
  const nodeId = requireValue(input.nodeId, "node");
  if (input.command === "mark") {
    if (!input.status) throw new Error("run mark requires --status");
    if (nodeId !== ownNodeId) {
      throw new Error(`a container can only mark its own node (${ownNodeId})`);
    }
    const reply = await sendMailboxRequest(handlers.env, root, { version: 1, id: newRequestId(), op: "mark", status: input.status });
    if (!reply.ok) throw new Error(reply.error ?? "run mailbox rejected the request");
    handlers.stdout(`marked: ${runId}/${nodeId} ${input.status}\n`);
    return 0;
  }
  if (input.command !== "message") throw new Error("unsupported run command");
  const prompt = await handlers.resolvePrompt();
  const request = {
    version: 1 as const, id: newRequestId(), op: "message" as const, target: nodeId, prompt: prompt.prompt, async: input.async,
  };
  if (input.printCommand) {
    handlers.stdout(`${JSON.stringify(request)}\n`);
    return 0;
  }
  const reply = await sendMailboxRequest(handlers.env, root, request);
  if (!reply.ok) throw new Error(reply.error ?? "run mailbox rejected the request");
  if (!reply.delivered) {
    handlers.stderr(`headless: message recorded in run ${runId} but not delivered: ${reply.error ?? "unknown reason"}\n`);
    return 1;
  }
  if (input.async) {
    handlers.stdout(`started: ${runId}/${nodeId}\n`);
    return 0;
  }
  const intervalMs = parseDelayMs(handlers.env.HEADLESS_RUN_WAIT_INTERVAL_MS, 1000);
  while (true) {
    const target = snapshot().nodes[nodeId];
    if (!target || !isActive(target.status)) {
      if (target?.lastMessage) handlers.stdout(`${target.lastMessage}\n`);
      return target?.status === "idle" || target?.status === "done" ? 0 : 1;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function sendMailboxRequest(env: Env, root: string, request: MailboxRequest): Promise<MailboxReply> {
  submitMailboxRequest(root, request);
  return await waitForMailboxReply(root, request.id, parseDelayMs(env.HEADLESS_RUN_MAILBOX_TIMEOUT_MS, 60_000));
}

function isActive(status: RunStatus): boolean {
  return status === "busy" || status === "starting";
}

function sdkRunSummary(run: RunRecord): Record<string, unknown> {
  const nodes = Object.values(run.nodes);
  const statusCounts = Object.fromEntries(
    [...new Set(nodes.map((node) => node.status))]
      .sort()
      .map((status) => [status, nodes.filter((node) => node.status === status).length]),
  );
  return {
    runId: run.runId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    coordination: nodes[0]?.coordination ?? null,
    nodeCount: nodes.length,
    activeCount: nodes.filter((node) => node.status === "busy" || node.status === "starting").length,
    statusCounts,
  };
}

function sdkRunView(run: RunRecord): Record<string, unknown> {
  const nodes = Object.fromEntries(
    Object.entries(run.nodes).map(([nodeId, node]) => [
      nodeId,
      {
        nodeId: node.nodeId,
        role: node.role,
        agent: node.agent,
        coordination: node.coordination,
        status: node.status,
        lastMessage: boundedSdkText(node.lastMessage),
        dependsOn: node.dependsOn,
        planned: node.planned,
        unplanned: node.unplanned,
        allow: node.allow,
        model: node.model,
        profile: node.profile,
        reasoningEffort: node.reasoningEffort,
        sessionAlias: node.sessionAlias,
        tmuxSessionName: node.tmuxSessionName,
        metrics: node.metrics,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
      },
    ]),
  );
  const events = run.events.slice(-8).map((event) => ({
    type: event.type,
    nodeId: event.nodeId,
    parentNodeId: event.parentNodeId,
    targetNodeId: event.targetNodeId,
    role: event.role,
    agent: event.agent,
    coordination: event.coordination,
    status: event.status,
    message: boundedSdkText(event.message),
    dependsOn: event.dependsOn,
    createdAt: event.createdAt,
  }));
  return {
    version: run.version,
    runId: run.runId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    nodes,
    events,
  };
}

function boundedSdkText(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 200 ? normalized : `${normalized.slice(0, 197)}...`;
}

async function handleRunMessage(
  input: RunCommandInput,
  handlers: RunCommandHandlers,
  runId: string,
): Promise<number> {
  const nodeId = requireValue(input.nodeId, "node");
  const run = readRun(handlers.env, runId);
  if (!run) {
    throw new Error(`unknown run: ${runId}`);
  }
  const node = run.nodes[nodeId];
  if (!node) {
    throw new Error(`unknown node in run ${runId}: ${nodeId}`);
  }
  if (node.sandbox !== "none") {
    // The host never runs a sandboxed node outside its sandbox: its stored
    // settings (work dir, permissions) were chosen for that sandbox.
    throw new Error(
      `node ${nodeId} in run ${runId} runs in ${node.sandbox}; headless cannot relaunch it on the host. `
      + `Run it again with headless ${node.agent} --role ${node.role} --run ${runId} --node ${nodeId} --${node.sandbox} --prompt "..."`,
    );
  }
  const prompt = await handlers.resolvePrompt();

  if (node.coordination === "tmux") {
    const sessionName = node.tmuxSessionName ?? `headless-${node.agent}-${node.sessionAlias ?? node.nodeId}`;
    const code = await handlers.sendTmux(sessionName, prompt.prompt, input.printCommand);
    if (code === 0 && !input.printCommand) {
      recordMessage(handlers.env, runId, handlers.env.HEADLESS_RUN_NODE || "cli", nodeId, prompt.prompt);
      updateNodeStatus(handlers.env, runId, nodeId, "busy");
      handlers.stdout(`sent: ${runId}/${nodeId}\n`);
    }
    return code;
  }

  if (input.printCommand) {
    const command = input.async
      ? buildAsyncMessageCliCommand(handlers.env, runId, nodeId, prompt.prompt)
      : buildNodeInvocationCommand(handlers.env, runId, nodeId, node, prompt.prompt);
    handlers.stdout(`${quoteCommand(command)}\n`);
    return 0;
  }

  if (input.async) {
    return await startAsyncRunMessage(handlers, runId, nodeId, node, prompt.prompt);
  }

  const releaseLock = acquireNodeLock(handlers.env, runId, nodeId);
  try {
    recordMessage(handlers.env, runId, handlers.env.HEADLESS_RUN_NODE || "cli", nodeId, prompt.prompt);
    updateNodeStatus(handlers.env, runId, nodeId, "busy");
    const result = await handlers.executeNode(node, prompt.prompt);
    const finalMessage = extractFinalMessage(node.agent, result.stdout);
    updateNodeStatus(
      handlers.env,
      runId,
      nodeId,
      result.code === 0 ? "idle" : "failed",
      finalMessage || undefined,
      extractRunNodeMetrics(node.agent, result.stdout, { model: node.model }),
    );
    if (finalMessage) {
      handlers.stdout(`${finalMessage}\n`);
    }
    return result.code;
  } finally {
    releaseLock();
  }
}

async function waitForRunIdle(env: Env, runId: string): Promise<void> {
  const intervalMs = parseDelayMs(env.HEADLESS_RUN_WAIT_INTERVAL_MS, 1000);
  const currentNode = env.HEADLESS_RUN_NODE;
  while (true) {
    reconcileTmuxRunNodes(env, runId);
    const run = readRun(env, runId);
    if (!run) {
      throw new Error(`unknown run: ${runId}`);
    }
    const busy = Object.values(run.nodes).some(
      (node) => node.nodeId !== currentNode && (node.status === "busy" || node.status === "starting"),
    );
    if (!busy) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function reconcileTmuxRunNodes(env: Env, runId: string): void {
  const run = readRun(env, runId);
  if (!run) return;
  const claimedTranscripts = new Set<string>();
  const nodes = Object.values(run.nodes)
    .filter(shouldReconcileTmuxNode)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.updatedAt.localeCompare(left.updatedAt) || right.nodeId.localeCompare(left.nodeId));
  const candidatesByScope = tmuxTranscriptCandidatesByScope(nodes, env);

  for (const node of nodes) {
    const transcript = (candidatesByScope.get(tmuxTranscriptScope(node.agent, node.workDir)) ?? []).find(
      (candidate) => !claimedTranscripts.has(nativeTranscriptKey(candidate)),
    );
    if (!transcript) continue;
    claimedTranscripts.add(nativeTranscriptKey(transcript));
    const activity = deriveNativeTranscriptActivity(node.agent, transcript);
    if (!activity) continue;
    const status = activity.status === "running" ? "busy" : activity.status === "waiting_input" ? "waiting" : "idle";
    if (status === node.status && (!activity.message || activity.message === node.lastMessage)) continue;
    updateNodeStatus(env, runId, node.nodeId, status, activity.message);
  }
}

function shouldReconcileTmuxNode(node: RunNode): boolean {
  if (node.coordination !== "tmux") return false;
  return node.status === "busy" || node.status === "starting" || node.status === "waiting";
}

function tmuxTranscriptCandidatesByScope(nodes: RunNode[], env: Env): Map<string, ReturnType<typeof resolveLatestNativeTranscripts>> {
  const nodesByScope = new Map<string, RunNode[]>();
  for (const node of nodes) {
    const scope = tmuxTranscriptScope(node.agent, node.workDir);
    const scopedNodes = nodesByScope.get(scope) ?? [];
    scopedNodes.push(node);
    nodesByScope.set(scope, scopedNodes);
  }

  const candidatesByScope = new Map<string, ReturnType<typeof resolveLatestNativeTranscripts>>();
  for (const [scope, scopedNodes] of nodesByScope) {
    const firstNode = scopedNodes[0];
    if (!firstNode) continue;
    const earliestCreatedAt = scopedNodes.reduce((earliest, node) => (node.createdAt < earliest ? node.createdAt : earliest), scopedNodes[0]?.createdAt ?? "");
    candidatesByScope.set(
      scope,
      resolveLatestNativeTranscripts(firstNode.agent, firstNode.workDir, env, { startedAt: earliestCreatedAt }, scopedNodes.length),
    );
  }
  return candidatesByScope;
}

function tmuxTranscriptScope(agent: AgentName, workDir: string | undefined): string {
  return `${agent}\t${workDir ?? ""}`;
}

async function startAsyncRunMessage(
  handlers: RunCommandHandlers,
  runId: string,
  nodeId: string,
  node: RunNode,
  prompt: string,
): Promise<number> {
  await startDetachedNodeMessage(handlers.env, runId, nodeId, node, prompt, handlers.env.HEADLESS_RUN_NODE || "cli", []);
  handlers.stdout(`started: ${runId}/${nodeId}\n`);
  return 0;
}

/**
 * Starts a node from a container's mailbox request, in the same sandbox as
 * the requesting node: sandboxArgs are the host's own launch flags for it.
 * Everything else comes from the host's run state.
 */
export async function startSandboxedNodeMessage(
  env: Env,
  runId: string,
  node: RunNode,
  prompt: string,
  fromNodeId: string,
  sandboxArgs: string[],
): Promise<void> {
  if (node.sandbox !== "docker" || !sandboxArgs.includes("--docker")) {
    throw new Error(`node ${node.nodeId} cannot be started in this sandbox`);
  }
  await startDetachedNodeMessage(env, runId, node.nodeId, node, prompt, fromNodeId, sandboxArgs);
}

async function startDetachedNodeMessage(
  env: Env,
  runId: string,
  nodeId: string,
  node: RunNode,
  prompt: string,
  fromNodeId: string,
  sandboxArgs: string[],
): Promise<void> {
  const errFd = openNodeLog(env, runId, nodeId, "stderr");
  let worker: ChildProcess;
  try {
    worker = fork(asyncRunMessageWorkerPath(), [], {
      env: env as NodeJS.ProcessEnv,
      detached: true,
      stdio: ["ignore", "ignore", errFd, "ipc"],
    });
  } finally {
    closeSync(errFd);
  }

  const task: AsyncRunMessageTask = {
    command: withExtraArgs(buildNodeInvocationCommand(env, runId, nodeId, node, prompt), sandboxArgs),
    cwd: node.workDir,
    runId,
    nodeId,
  };
  await prepareAsyncWorker(worker, task);
  try {
    recordMessage(env, runId, fromNodeId, nodeId, prompt);
    updateNodeStatus(env, runId, nodeId, "busy");
    const timestamp = new Date().toISOString();
    appendNodeLog(env, runId, nodeId, "stdout", `\n===== async message ${timestamp} =====\n`);
    appendNodeLog(env, runId, nodeId, "stderr", `\n===== async message ${timestamp} =====\n`);
    await startPreparedAsyncWorker(worker);
  } catch (error) {
    try {
      updateNodeStatus(
        env,
        runId,
        nodeId,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
    } catch {
      // Preserve the startup error when rollback storage also fails.
    }
    cancelAsyncWorker(worker);
    throw error;
  }
  if (worker.connected) worker.disconnect();
  worker.unref();
}

function withExtraArgs(command: { command: string; args: string[] }, extra: string[]): { command: string; args: string[] } {
  return { command: command.command, args: [...command.args, ...extra] };
}

function prepareAsyncWorker(worker: ChildProcess, task: AsyncRunMessageTask): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => fail(new Error("async message worker did not become ready")), 5_000);
    timeout.unref();
    const cleanup = () => {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("error", fail);
      worker.off("exit", onExit);
    };
    const fail = (error: Error) => {
      cleanup();
      cancelAsyncWorker(worker);
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(new Error(`async message worker exited before startup (${signal ?? code ?? "unknown"})`));
    };
    const onMessage = (message: AsyncRunMessageResponse) => {
      if (message.type === "error") {
        fail(new Error(message.message));
        return;
      }
      cleanup();
      resolve();
    };
    worker.once("error", fail);
    worker.once("exit", onExit);
    worker.on("message", onMessage);
    void sendWorkerRequest(worker, { type: "task", task }).catch(fail);
  });
}

function sendWorkerRequest(worker: ChildProcess, request: AsyncRunMessageRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.send(request, (error) => error ? reject(error) : resolve());
  });
}

function startPreparedAsyncWorker(worker: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => fail(new Error("async message worker did not start its agent")), 5_000);
    timeout.unref();
    const cleanup = () => {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("error", fail);
      worker.off("exit", onExit);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(new Error(`async message worker exited before agent startup (${signal ?? code ?? "unknown"})`));
    };
    const onMessage = (message: AsyncRunMessageResponse) => {
      if (message.type === "error") {
        fail(new Error(message.message));
      } else if (message.type === "started") {
        cleanup();
        resolve();
      }
    };
    worker.once("error", fail);
    worker.once("exit", onExit);
    worker.on("message", onMessage);
    void sendWorkerRequest(worker, { type: "start" }).catch(fail);
  });
}

function cancelAsyncWorker(worker: ChildProcess): void {
  worker.once("error", () => undefined);
  if (worker.connected) {
    worker.send({ type: "cancel" } satisfies AsyncRunMessageRequest, () => {
      if (worker.connected) worker.disconnect();
    });
  }
  worker.unref();
}

function asyncRunMessageWorkerPath(): string {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return fileURLToPath(new URL(`./async-run-message.${extension}`, import.meta.url));
}

function buildNodeInvocationCommand(env: Env, runId: string, nodeId: string, node: RunNode, prompt: string): {
  command: string;
  args: string[];
} {
  const cli = headlessCli(env);
  return {
    command: cli,
    args: [
      node.agent,
      "--role",
      node.role,
      "--coordination",
      node.coordination,
      "--run",
      runId,
      "--node",
      nodeId,
      "--prompt",
      prompt,
      ...(node.allow ? ["--allow", node.allow] : []),
      ...(node.model ? ["--model", node.model] : []),
      ...(node.profile ? ["--profile", node.profile] : []),
      ...(node.fast === undefined ? [] : [node.fast ? "--fast" : "--no-fast"]),
      ...(node.keepBackground ? ["--keep-background"] : []),
      ...(node.reasoningEffort ? ["--reasoning-effort", node.reasoningEffort] : []),
      ...(node.workDir ? ["--work-dir", node.workDir] : []),
      ...(node.coordination === "session" ? ["--session", node.sessionAlias ?? nodeId] : []),
    ],
  };
}

function buildAsyncMessageCliCommand(env: Env, runId: string, nodeId: string, prompt: string): {
  command: string;
  args: string[];
} {
  return {
    command: headlessCli(env),
    args: ["run", "message", runId, nodeId, "--prompt", prompt, "--async"],
  };
}

function headlessCli(env: Env): string {
  return env.HEADLESS_CLI_BIN ?? env.HEADLESS_BIN ?? "headless";
}

function parseDelayMs(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function requireValue(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`invalid ${label}; use letters, numbers, dots, dashes, or underscores`);
  }
  return value;
}
