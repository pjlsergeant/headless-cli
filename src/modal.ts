import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

import { getAgentConfig } from "./agents.js";
import { codexProfileSeedFiles, readCodexBaseFiles } from "./codex-profile.js";
import { seedAwsProfileFiles } from "./aws-profile.js";
import { collectForwardedEnvEntries } from "./env.js";
import { quoteArg } from "./shell.js";
import type { AgentName, BuiltCommand, Env } from "./types.js";

export const DEFAULT_MODAL_IMAGE =
  "ghcr.io/roberttlange/headless@sha256:d482f2b604f4025a8c2f2ad102bd7b3c65c1f2f84e6348cc1af91c9bf9022965";
export const DEFAULT_MODAL_APP = "headless-cli";
export const DEFAULT_MODAL_CPU = 2;
export const DEFAULT_MODAL_MEMORY_MIB = 4096;
export const DEFAULT_MODAL_TIMEOUT_SECONDS = 3600;
// Result download gets its own window after the agent deadline.
export const MODAL_RECOVERY_TIMEOUT_SECONDS = 120;
// Lifetime of a sandbox created with --modal-keep-sandbox, so it outlives a
// failed recovery long enough to be inspected (Modal's sandbox maximum).
export const MODAL_KEPT_SANDBOX_LIFETIME_SECONDS = 24 * 60 * 60;

const remoteWorkDir = "/workspace";
const remoteHome = "/home/node";
const remoteHostHome = "/tmp/headless-host-home";
const remoteGoogleCredentialsRelPath = ".config/headless/google-application-credentials.json";
const remoteGoogleCredentialsPath = `${remoteHome}/${remoteGoogleCredentialsRelPath}`;
const localTarCommand = process.platform === "win32" ? "tar" : "/usr/bin/tar";
const remoteTarCommand = "/usr/bin/tar";
const sandboxUser = "node";
const bootstrapScript = [
  "set -eu",
  `mkdir -p "${remoteHome}"`,
  `if [ -d "${remoteHostHome}" ]; then cp -R "${remoteHostHome}/." "$HOME"/; fi`,
  `chown -R ${sandboxUser}:${sandboxUser} "${remoteHome}" "${remoteWorkDir}"`,
  `exec runuser -u ${sandboxUser} -- "$@"`,
].join("; ");

export type StdoutHandling = "capture" | "stream" | "capture-and-stream";

export interface ModalAttemptResult {
  code: number;
  stdout: string;
}

export type ModalAttemptExecutor = (
  command: BuiltCommand,
  attemptEnv: Env,
  timeoutSeconds: number,
  observe: (chunk: string) => void,
) => Promise<ModalAttemptResult>;

export interface ExecuteModalOptions {
  agent: AgentName;
  appName: string;
  command: BuiltCommand;
  cpu: number;
  env: Env;
  image: string;
  imageSecret?: string;
  includeGit: boolean;
  memoryMiB: number;
  modalEnv: string[];
  modalSecrets: string[];
  profile?: string;
  maxCapturedStdoutBytes?: number;
  stdout: (text: string) => unknown;
  stdoutHandling: StdoutHandling;
  stderr: (text: string) => void;
  timeoutSeconds: number;
  waitForStdoutDrain?: (signal: AbortSignal) => Promise<void>;
  workDir: string;
  clientFactory?: () => Promise<ModalClientLike>;
  invoke?: (execute: ModalAttemptExecutor) => Promise<ModalAttemptResult>;
  /** Leave the sandbox running when the result cannot be recovered. */
  keepSandboxOnFailure?: boolean;
  recoveryTimeoutSeconds?: number;
}

export interface ExecuteModalResult {
  code: number;
  stdout: string;
  conflicts: string[];
}

export interface ModalClientLike {
  apps: {
    fromName(name: string, params?: { createIfMissing?: boolean }): Promise<unknown>;
  };
  images: {
    fromRegistry(image: string, secret?: unknown): unknown;
  };
  secrets: {
    fromName(name: string): Promise<unknown>;
  };
  sandboxes: {
    create(app: unknown, image: unknown, params?: ModalSandboxCreateParams): Promise<ModalSandboxLike>;
  };
  close?: () => void;
}

export interface ModalSandboxCreateParams {
  command?: string[];
  cpu?: number;
  env?: Record<string, string>;
  idleTimeoutMs?: number;
  memoryMiB?: number;
  secrets?: unknown[];
  timeoutMs?: number;
  workdir?: string;
}

export interface ModalExecParams {
  env?: Record<string, string>;
  mode?: "text" | "binary";
  secrets?: unknown[];
  stderr?: "pipe" | "ignore";
  stdout?: "pipe" | "ignore";
  timeoutMs?: number;
  workdir?: string;
}

export interface ModalSandboxLike {
  sandboxId?: string;
  exec(command: string[], params?: ModalExecParams): Promise<ModalProcessLike<string | Uint8Array>>;
  terminate(): Promise<void>;
}

export interface ModalProcessLike<R extends string | Uint8Array> {
  stdin: ModalWriteStreamLike<R>;
  stdout: ModalReadStreamLike<R>;
  stderr: ModalReadStreamLike<R>;
  wait(): Promise<number>;
}

export interface ModalReadStreamLike<R extends string | Uint8Array> {
  getReader?: () => ReadableStreamDefaultReader<R>;
  readText?: () => Promise<string>;
  readBytes?: () => Promise<Uint8Array>;
}

export interface ModalWriteStreamLike<R extends string | Uint8Array> {
  close?: () => Promise<void>;
  writeBytes?: (bytes: Uint8Array) => Promise<void>;
  writeText?: (text: string) => Promise<void>;
}

interface FileState {
  hash?: string;
  mode: number;
  target?: string;
  type: "directory" | "file" | "symlink";
}

interface GeneratedSeedFile {
  content: string;
  mode: number;
  relPath: string;
}

export interface WorkspaceSyncResult {
  changed: string[];
  conflicts: string[];
}

export function buildModalRunSummary(options: {
  appName: string;
  command: BuiltCommand;
  cpu: number;
  image: string;
  imageSecret?: string;
  memoryMiB: number;
  modalSecrets: string[];
  timeoutSeconds: number;
  workDir: string;
}): BuiltCommand {
  const args = [
    "run",
    "--app",
    options.appName,
    "--image",
    options.image,
    "--cpu",
    String(options.cpu),
    "--memory",
    String(options.memoryMiB),
    "--timeout",
    String(options.timeoutSeconds),
    "--work-dir",
    options.workDir,
  ];
  if (options.imageSecret) {
    args.push("--image-secret", options.imageSecret);
  }
  for (const secret of options.modalSecrets) {
    args.push("--secret", secret);
  }
  args.push("--", options.command.command, ...options.command.args);
  return {
    command: "modal-sandbox",
    args,
    env: options.command.env,
    stdinFile: options.command.stdinFile,
    stdinText: options.command.stdinText,
  };
}

export function collectModalEnv(
  env: Env,
  commandEnv: Env | undefined,
  explicitModalEnv: string[],
  options: { workDir?: string } = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of collectForwardedEnvEntries(env, commandEnv, explicitModalEnv)) {
    if (entry.actualValue !== undefined) {
      result[entry.name] = entry.actualValue;
    }
  }
  if (options.workDir && result.GOOGLE_APPLICATION_CREDENTIALS) {
    const localPath = resolve(options.workDir, result.GOOGLE_APPLICATION_CREDENTIALS);
    if (existsSync(localPath) && lstatSync(localPath).isFile()) {
      result.GOOGLE_APPLICATION_CREDENTIALS = isWithin(options.workDir, localPath)
        ? `${remoteWorkDir}/${normalizeRelative(options.workDir, localPath)}`
        : remoteGoogleCredentialsPath;
    }
  }
  result.HOME = remoteHome;
  return result;
}

export async function executeModalAgent(options: ExecuteModalOptions): Promise<ExecuteModalResult> {
  const workDir = realpathSync(options.workDir);
  const timeoutMs = options.timeoutSeconds * 1000;
  const recoveryTimeoutMs = (options.recoveryTimeoutSeconds ?? MODAL_RECOVERY_TIMEOUT_SECONDS) * 1000;
  const sandboxLifetimeMs = Math.max(
    timeoutMs + recoveryTimeoutMs,
    options.keepSandboxOnFailure ? MODAL_KEPT_SANDBOX_LIFETIME_SECONDS * 1000 : 0,
  );
  const env = collectModalEnv(options.env, options.command.env, options.modalEnv, { workDir });
  let client: ModalClientLike | undefined;
  let sandbox: ModalSandboxLike | undefined;
  const stdoutDrainController = new AbortController();
  const baselineDir = mkdtempSync(join(tmpdir(), "headless-modal-baseline-"));
  const resultDir = mkdtempSync(join(tmpdir(), "headless-modal-result-"));
  let keepSandbox = false;

  try {
    const seedArchive = await createAgentSeedArchive(options.agent, options.env, options.profile);
    const credentialArchive = await createCredentialSeedArchive(
      options.env,
      options.command.env,
      options.modalEnv,
      workDir,
    );
    const workspaceArchive = await createWorkspaceArchive(workDir, options.includeGit);
    extractArchiveLocally(workspaceArchive, baselineDir);

    client = await (options.clientFactory ?? createModalClient)();
    const app = await client.apps.fromName(options.appName, { createIfMissing: true });
    const imageSecret = options.imageSecret ? await client.secrets.fromName(options.imageSecret) : undefined;
    const image = client.images.fromRegistry(options.image, imageSecret);
    const secrets = await Promise.all(options.modalSecrets.map((name) => client?.secrets.fromName(name)));
    sandbox = await client.sandboxes.create(app, image, {
      command: ["sleep", "infinity"],
      cpu: options.cpu,
      env,
      idleTimeoutMs: sandboxLifetimeMs,
      memoryMiB: options.memoryMiB,
      secrets,
      timeoutMs: sandboxLifetimeMs,
      workdir: "/",
    });

    await runRemoteTar(sandbox, ["mkdir", "-p", remoteWorkDir], timeoutMs);
    await runRemoteTar(sandbox, [remoteTarCommand, "-xzf", "-", "-C", remoteWorkDir], timeoutMs, workspaceArchive);

    if (seedArchive.length > 0) {
      await runRemoteTar(sandbox, ["mkdir", "-p", remoteHostHome], timeoutMs);
      await runRemoteTar(sandbox, [remoteTarCommand, "-xzf", "-", "-C", remoteHostHome], timeoutMs, seedArchive);
    }
    if (credentialArchive.length > 0) {
      await runRemoteTar(sandbox, ["mkdir", "-p", remoteHostHome], timeoutMs);
      await runRemoteTar(sandbox, [remoteTarCommand, "-xzf", "-", "-C", remoteHostHome], timeoutMs, credentialArchive);
    }

    let initialized = false;
    const execute: ModalAttemptExecutor = async (command, attemptEnv, remainingSeconds, observe) => {
      const overrides = { ...command.env };
      for (const [name, value] of Object.entries(attemptEnv)) {
        if (value === undefined) overrides[name] = undefined;
      }
      const attemptEnvironment = collectModalEnv(attemptEnv, overrides, options.modalEnv, { workDir });
      if (options.invoke) {
        Object.assign(attemptEnvironment, collectModalEnv(attemptEnv, overrides, [], { workDir }));
      }
      // An invocation's route overrides also outrank explicit transport environment.
      for (const [name, value] of Object.entries(command.env ?? {})) {
        if (value !== undefined) attemptEnvironment[name] = value;
      }
      const masked = Object.entries(overrides).filter(([, value]) => value === undefined).map(([name]) => name);
      for (const name of masked) delete attemptEnvironment[name];
      const native = masked.length
        ? ["env", ...masked.flatMap((name) => ["-u", name]), "--", command.command, ...command.args]
        : [command.command, ...command.args];
      const setup = initialized ? 'exec runuser -u node -- "$@"' : bootstrapScript;
      initialized = true;
      const runProcess = await sandbox!.exec(
        ["sh", "-lc", setup, "headless-agent", ...native],
        {
          env: attemptEnvironment,
          mode: "text",
          secrets,
          stderr: "pipe",
          stdout: "pipe",
          timeoutMs: remainingSeconds * 1000,
          workdir: remoteWorkDir,
        },
      );
      const stdoutPromise = readTextStream(
        runProcess.stdout,
        async (text) => {
          observe(text);
          if (options.stdoutHandling !== "capture") {
            const writable = options.stdout(text);
            if (writable === false) {
              await options.waitForStdoutDrain?.(stdoutDrainController.signal);
            }
          }
        },
        options.maxCapturedStdoutBytes,
      );
      const stderrPromise = readTextStream(runProcess.stderr, options.stderr);
      await writeModalStdin(runProcess.stdin, command);
      const [stdout, , code] = await Promise.all([stdoutPromise, stderrPromise, runProcess.wait()]);
      return { stdout, code };
    };
    const { stdout, code } = options.invoke
      ? await options.invoke(execute)
      : await execute(options.command, options.env, options.timeoutSeconds, () => {});

    const activeSandbox = sandbox;
    const recoveryFailed = (error: unknown, archive?: Uint8Array): Error => {
      const reason = error instanceof Error ? error.message.trim() : String(error);
      options.stderr(`headless: modal result recovery failed: ${reason}\n`);
      if (archive) {
        reportSavedRecoveryArchive(options, activeSandbox, archive, workDir);
      }
      if (options.keepSandboxOnFailure) {
        keepSandbox = true;
        reportKeptSandbox(options, activeSandbox, sandboxLifetimeMs);
      }
      return new Error(`modal result recovery failed: ${reason}`);
    };
    let resultArchive: Uint8Array;
    try {
      resultArchive = await captureRemoteArchive(sandbox, recoveryTimeoutMs);
    } catch (error) {
      throw recoveryFailed(error);
    }
    let sync: WorkspaceSyncResult;
    try {
      extractArchiveLocally(resultArchive, resultDir);
      sync = syncWorkspace({ baselineDir, resultDir, workDir });
    } catch (error) {
      throw recoveryFailed(error, resultArchive);
    }
    for (const conflict of sync.conflicts) {
      options.stderr(`headless: modal sync skipped local conflict: ${conflict}\n`);
    }

    return { code, stdout, conflicts: sync.conflicts };
  } finally {
    stdoutDrainController.abort();
    if (sandbox && !keepSandbox) {
      await sandbox.terminate();
    }
    client?.close?.();
    rmSync(baselineDir, { force: true, recursive: true });
    rmSync(resultDir, { force: true, recursive: true });
  }
}

function reportSavedRecoveryArchive(
  options: ExecuteModalOptions,
  sandbox: ModalSandboxLike,
  archive: Uint8Array,
  workDir: string,
): void {
  let path: string;
  try {
    path = saveRecoveryArchive(options.env, sandbox.sandboxId, archive);
  } catch (error) {
    options.stderr(
      `headless: could not save the Modal workspace archive: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return;
  }
  const extractDir = path.replace(/\.tar\.gz$/, "");
  options.stderr(
    [
      `headless: saved the remote Modal workspace (not applied to your work dir) to ${path}`,
      "headless: extract it into a new directory, compare, and copy back what you need:",
      `headless:   mkdir ${quoteArg(extractDir)} && tar -xzf ${quoteArg(path)} -C ${quoteArg(extractDir)}`,
      `headless:   diff -r ${quoteArg(workDir)} ${quoteArg(extractDir)}`,
      "",
    ].join("\n"),
  );
}

function reportKeptSandbox(options: ExecuteModalOptions, sandbox: ModalSandboxLike, lifetimeMs: number): void {
  const id = sandbox.sandboxId ?? "(unknown id)";
  const hours = Math.round(lifetimeMs / 3_600_000);
  options.stderr(
    [
      `headless: WARNING: Modal sandbox ${id} was left running (--modal-keep-sandbox).`,
      `headless: it keeps billing until you terminate it, or until its ${hours}h lifetime from creation ends.`,
      `headless: terminate it from the Modal dashboard, or with the Modal JS SDK:`,
      `headless:   await (await new ModalClient().sandboxes.fromId(${JSON.stringify(id)})).terminate()`,
      "",
    ].join("\n"),
  );
}

function saveRecoveryArchive(env: Env, sandboxId: string | undefined, archive: Uint8Array): string {
  const dir = join(env.HOME || homedir(), ".headless", "modal-recovery");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`not a directory: ${dir}`);
  }
  chmodSync(dir, 0o700);
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const shortId = (sandboxId?.replace(/[^A-Za-z0-9]/g, "").slice(-8)) || randomBytes(4).toString("hex");
  const path = join(dir, `${timestamp}-${shortId}.tar.gz`);
  writeFileSync(path, archive, { flag: "wx", mode: 0o600 });
  return path;
}

async function createModalClient(): Promise<ModalClientLike> {
  const { ModalClient } = await import("modal");
  return new ModalClient() as ModalClientLike;
}

async function createWorkspaceArchive(workDir: string, includeGit: boolean): Promise<Uint8Array> {
  const files = await listGitFiles(workDir);
  if (!files) {
    throw new Error("Modal workspace upload requires a git workdir");
  }
  const selected = includeGit ? [...files, ...listGitMetadataFiles(workDir)] : files;
  return await runLocalTar(workDir, selected);
}

async function createAgentSeedArchive(agent: AgentName, env: Env, profile?: string): Promise<Uint8Array> {
  const home = env.HOME;
  if (!home && !(agent === "codex" && env.CODEX_HOME)) {
    return new Uint8Array();
  }
  const paths: string[] = [];
  const seedPaths = home && !(agent === "codex" && env.CODEX_HOME) ? getAgentConfig(agent).seedPaths : [];
  for (const relPath of seedPaths) {
    const path = join(home as string, relPath);
    if (!existsSync(path)) {
      continue;
    }
    paths.push(relPath);
    if (lstatSync(path).isDirectory()) {
      break;
    }
  }
  const generatedFiles = collectGeneratedSeedFiles(agent, env, paths, profile);
  if (generatedFiles.length === 0) {
    return paths.length > 0 ? await runLocalTar(home as string, paths) : new Uint8Array();
  }

  const seedDir = mkdtempSync(join(tmpdir(), "headless-modal-seed-"));
  try {
    for (const relPath of paths) {
      const source = join(home as string, relPath);
      const target = join(seedDir, relPath);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true, verbatimSymlinks: true });
    }
    for (const file of generatedFiles) {
      const target = join(seedDir, file.relPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, { mode: file.mode });
      if (!paths.includes(file.relPath)) {
        paths.push(file.relPath);
      }
    }
    return paths.length > 0 ? await runLocalTar(seedDir, paths) : new Uint8Array();
  } finally {
    rmSync(seedDir, { force: true, recursive: true });
  }
}

async function createCredentialSeedArchive(
  env: Env,
  commandEnv: Env | undefined,
  explicitModalEnv: string[],
  workDir: string,
): Promise<Uint8Array> {
  const seedDir = mkdtempSync(join(tmpdir(), "headless-modal-credentials-"));
  const paths: string[] = [];
  try {
    const awsProfile = forwardedEnvValue(env, commandEnv, explicitModalEnv, "AWS_PROFILE");
    const awsDir = env.HOME ? join(env.HOME, ".aws") : undefined;
    if (awsProfile && awsDir && existsSync(awsDir) && lstatSync(awsDir).isDirectory()) {
      paths.push(...seedAwsProfileFiles(awsDir, seedDir, awsProfile));
    }

    const googleCredentials = forwardedEnvValue(env, commandEnv, explicitModalEnv, "GOOGLE_APPLICATION_CREDENTIALS");
    if (googleCredentials) {
      const googlePath = resolve(workDir, googleCredentials);
      if (existsSync(googlePath) && lstatSync(googlePath).isFile() && !isWithin(workDir, googlePath)) {
        const target = join(seedDir, remoteGoogleCredentialsRelPath);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(googlePath, target);
        chmodSync(target, lstatSync(googlePath).mode & 0o777);
        paths.push(remoteGoogleCredentialsRelPath);
      }
    }

    return paths.length > 0 ? await runLocalTar(seedDir, paths) : new Uint8Array();
  } finally {
    rmSync(seedDir, { force: true, recursive: true });
  }
}

function forwardedEnvValue(env: Env, commandEnv: Env | undefined, explicitEnv: string[], name: string): string | undefined {
  return collectForwardedEnvEntries(env, commandEnv, explicitEnv).find((entry) => entry.name === name)?.actualValue;
}

function collectGeneratedSeedFiles(
  agent: AgentName,
  env: Env,
  selectedPaths: string[],
  profile?: string,
): GeneratedSeedFile[] {
  if (agent === "codex") {
    const baseFiles = env.CODEX_HOME ? readCodexBaseFiles(env) : [];
    const profileFiles = profile
      ? codexProfileSeedFiles(env, profile, join(remoteHome, ".codex"))
      : [];
    return [...baseFiles, ...profileFiles].map((file) => ({
      content: file.content,
      mode: 0o600,
      relPath: file.relPath,
    }));
  }
  if (agent !== "claude" || !env.HOME || selectedPaths.includes(".claude/.credentials.json")) return [];
  const content = readClaudeKeychainCredentials(env);
  return content ? [{ content, mode: 0o600, relPath: ".claude/.credentials.json" }] : [];
}

function readClaudeKeychainCredentials(env: Env): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }
  const user = process.env.USER;
  if (!user) {
    return undefined;
  }
  const configDir = env.CLAUDE_CONFIG_DIR || join(env.HOME ?? "", ".claude");
  const configSuffix = env.CLAUDE_CONFIG_DIR ? `-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}` : "";
  const service = `Claude Code-credentials${configSuffix}`;
  const result = spawnSync("security", ["find-generic-password", "-a", user, "-w", "-s", service], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    return undefined;
  }
  return result.stdout;
}

async function listGitFiles(workDir: string): Promise<string[] | undefined> {
  const result = await captureLocalCommand("git", ["-C", workDir, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."]);
  if (result.code !== 0) {
    return undefined;
  }
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((path) => path !== ".")
    // --cached still lists tracked files deleted from the worktree but not
    // staged; tar would fail on them. Existing symlinks are kept (lstat).
    .filter((path) => pathExists(join(workDir, path)))
    .sort();
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function listFilesRecursive(root: string, options: { ignoredDirs?: Set<string> } = {}): string[] {
  const result: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && options.ignoredDirs?.has(entry.name)) {
        continue;
      }
      const path = join(dir, entry.name);
      const relPath = normalizeRelative(root, path);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        result.push(relPath);
      }
    }
  };
  walk(root);
  return result.sort();
}

function listGitMetadataFiles(workDir: string): string[] {
  const gitPath = join(workDir, ".git");
  if (!existsSync(gitPath)) {
    return [];
  }
  const stat = lstatSync(gitPath);
  if (stat.isFile() || stat.isSymbolicLink()) {
    return [".git"];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  return listFilesRecursive(gitPath).map((path) => `.git/${path}`);
}

async function runLocalTar(cwd: string, paths: string[]): Promise<Uint8Array> {
  const result = await captureLocalCommand(localTarCommand, ["-czf", "-", "--null", "-T", "-"], {
    cwd,
    stdin: paths.length > 0 ? `${paths.join("\0")}\0` : "",
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || "could not create Modal workspace archive");
  }
  return result.stdout;
}

function extractArchiveLocally(archive: Uint8Array, dir: string): void {
  validateArchiveEntries(archive);
  const result = spawnSync(localTarCommand, ["-xzf", "-", "-C", dir], { input: archive, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.error?.message || "could not extract Modal workspace archive");
  }
}

async function runRemoteTar(
  sandbox: ModalSandboxLike,
  command: string[],
  timeoutMs: number,
  stdin?: Uint8Array,
): Promise<string> {
  const process = await sandbox.exec(command, {
    mode: stdin ? "binary" : "text",
    stderr: "pipe",
    stdout: "pipe",
    timeoutMs,
    workdir: "/",
  });
  const stdoutPromise = stdin ? readBytes(process.stdout as ModalReadStreamLike<Uint8Array>) : readTextStream(process.stdout);
  const stderrPromise = readTextStream(process.stderr);
  if (stdin) {
    await process.stdin.writeBytes?.(stdin);
  }
  await process.stdin.close?.();
  const [stdout, stderr, code] = await Promise.all([stdoutPromise, stderrPromise, process.wait()]);
  if (code !== 0) {
    throw new Error(stderr || `${command[0]} failed in Modal sandbox`);
  }
  return typeof stdout === "string" ? stdout : "";
}

async function captureRemoteArchive(sandbox: ModalSandboxLike, timeoutMs: number): Promise<Uint8Array> {
  const process = await sandbox.exec([remoteTarCommand, "-czf", "-", "-C", remoteWorkDir, "."], {
    mode: "binary",
    stderr: "pipe",
    stdout: "pipe",
    timeoutMs,
    workdir: remoteWorkDir,
  });
  const [stdout, stderr, code] = await Promise.all([
    readBytes(process.stdout as ModalReadStreamLike<Uint8Array>),
    readTextStream(process.stderr),
    process.wait(),
  ]);
  if (code !== 0) {
    throw new Error(stderr || "could not download Modal workspace archive");
  }
  return stdout;
}

function validateArchiveEntries(archive: Uint8Array): void {
  let data: Buffer;
  try {
    data = gunzipSync(archive);
  } catch {
    throw new Error("could not inspect Modal workspace archive");
  }

  let offset = 0;
  let nextLongName: string | undefined;
  let nextPaxPath: string | undefined;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      return;
    }

    const type = readTarString(header, 156, 1) || "0";
    const size = readTarSize(header);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > data.length) {
      throw new Error("unsafe Modal workspace archive entry: truncated archive");
    }

    if (type === "L") {
      nextLongName = readNullTerminated(data.subarray(contentStart, contentEnd));
      offset = nextTarOffset(contentEnd);
      continue;
    }
    if (type === "x") {
      nextPaxPath = parsePaxRecords(data.subarray(contentStart, contentEnd)).path;
      offset = nextTarOffset(contentEnd);
      continue;
    }
    if (type === "g") {
      const records = parsePaxRecords(data.subarray(contentStart, contentEnd));
      if (records.path !== undefined) {
        throw new Error("unsafe Modal workspace archive entry: global pax path is not supported");
      }
      offset = nextTarOffset(contentEnd);
      continue;
    }

    const prefix = readTarString(header, 345, 155);
    const name = nextPaxPath ?? nextLongName ?? [prefix, readTarString(header, 0, 100)].filter(Boolean).join("/");
    nextLongName = undefined;
    nextPaxPath = undefined;
    if (!isSafeArchivePath(name)) {
      throw new Error(`unsafe Modal workspace archive entry: ${name}`);
    }
    if (!["0", "\0", "2", "5"].includes(type)) {
      throw new Error(`unsafe Modal workspace archive entry: unsupported type ${type || "unknown"} for ${name}`);
    }

    offset = nextTarOffset(contentEnd);
  }

  throw new Error("unsafe Modal workspace archive entry: missing end marker");
}

function readTarString(header: Buffer, start: number, length: number): string {
  const end = header.indexOf(0, start);
  return header.subarray(start, end === -1 || end > start + length ? start + length : end).toString("utf8");
}

function readTarSize(header: Buffer): number {
  const value = readTarString(header, 124, 12).trim();
  const parsed = Number.parseInt(value || "0", 8);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("unsafe Modal workspace archive entry: invalid size");
  }
  return parsed;
}

function readNullTerminated(data: Buffer): string {
  const end = data.indexOf(0);
  return data.subarray(0, end === -1 ? data.length : end).toString("utf8");
}

function parsePaxRecords(data: Buffer): Record<string, string> {
  const text = data.toString("utf8");
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space === -1) {
      break;
    }
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0 || offset + length > text.length) {
      throw new Error("unsafe Modal workspace archive entry: invalid pax header");
    }
    const record = text.slice(space + 1, offset + length - 1);
    const equals = record.indexOf("=");
    if (equals !== -1) {
      records[record.slice(0, equals)] = record.slice(equals + 1);
    }
    offset += length;
  }
  return records;
}

function nextTarOffset(contentEnd: number): number {
  return Math.ceil(contentEnd / 512) * 512;
}

function isSafeArchivePath(path: string): boolean {
  if (!path || path === ".") {
    return true;
  }
  const normalized = path.split("\\").join("/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    return false;
  }
  return !normalized.split("/").some((segment) => segment === "..");
}

async function writeModalStdin(stdin: ModalWriteStreamLike<string | Uint8Array>, command: BuiltCommand): Promise<void> {
  if (command.stdinText !== undefined) {
    await stdin.writeText?.(command.stdinText);
  } else if (command.stdinFile) {
    await stdin.writeBytes?.(readFileSync(command.stdinFile));
  }
  await stdin.close?.();
}

async function readTextStream<R extends string | Uint8Array>(
  stream: ModalReadStreamLike<R>,
  onChunk?: (text: string) => unknown,
  maxBytes?: number,
): Promise<string> {
  const emitChunks = async (text: string) => {
    const maxChunkChars = 64 * 1024;
    for (let offset = 0; offset < text.length; offset += maxChunkChars) {
      await onChunk?.(text.slice(offset, offset + maxChunkChars));
    }
  };
  if (!stream.getReader) {
    const text = (await stream.readText?.()) ?? "";
    if (text) {
      await emitChunks(text);
    }
    return maxBytes === undefined ? text : boundedTextTail(text, maxBytes);
  }
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const output = new BoundedTextCapture(maxBytes);
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const text = typeof value === "string" ? value : decoder.decode(value, { stream: true });
    output.append(text);
    await emitChunks(text);
  }
  const tail = decoder.decode();
  if (tail) {
    output.append(tail);
    await emitChunks(tail);
  }
  return output.text();
}

export class BoundedTextCapture {
  private byteLength = 0;
  private readonly chunks: Array<Buffer | undefined> = [];
  private head = 0;

  constructor(private readonly maxBytes?: number) {}

  append(text: string): void {
    if (!text) {
      return;
    }
    const chunk = Buffer.from(text, "utf8");
    this.chunks.push(chunk);
    this.byteLength += chunk.byteLength;
    if (this.maxBytes === undefined) {
      return;
    }
    while (this.byteLength > this.maxBytes && this.head < this.chunks.length) {
      const overflow = this.byteLength - this.maxBytes;
      const first = this.chunks[this.head];
      if (!first) {
        this.head += 1;
        continue;
      }
      if (first.byteLength <= overflow) {
        this.chunks[this.head] = undefined;
        this.head += 1;
        this.byteLength -= first.byteLength;
        continue;
      }
      let start = overflow;
      while (start < first.byteLength && (first[start] & 0xc0) === 0x80) {
        start += 1;
      }
      this.chunks[this.head] = Buffer.from(first.subarray(start));
      this.byteLength -= start;
    }
    if (this.head > 1024 && this.head * 2 > this.chunks.length) {
      this.chunks.splice(0, this.head);
      this.head = 0;
    }
  }

  text(): string {
    const retained = this.chunks
      .slice(this.head)
      .filter((chunk): chunk is Buffer => chunk !== undefined);
    return Buffer.concat(retained, this.byteLength).toString("utf8");
  }
}

function boundedTextTail(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maxBytes) {
    return text;
  }
  let start = encoded.byteLength - maxBytes;
  while (start < encoded.byteLength && (encoded[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return encoded.subarray(start).toString("utf8");
}

async function readBytes(stream: ModalReadStreamLike<Uint8Array>): Promise<Uint8Array> {
  if (!stream.getReader) {
    return (await stream.readBytes?.()) ?? new Uint8Array();
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    length += value.byteLength;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

interface SyncOp {
  relPath: string;
  before?: FileState;
  after?: FileState;
  local?: FileState;
}

export function syncWorkspace(options: {
  baselineDir: string;
  resultDir: string;
  workDir: string;
  /** Test seam; detected from the work dir's filesystem when omitted. */
  caseInsensitive?: boolean;
}): WorkspaceSyncResult {
  const baseline = snapshotTree(options.baselineDir);
  const result = snapshotTree(options.resultDir);
  const localTree = snapshotTree(options.workDir);
  const fold = pathFolder(options.workDir, options.caseInsensitive);
  const collides = collisionChecker(fold, [baseline.keys(), result.keys(), localTree.keys()]);
  const allPaths = new Set([...baseline.keys(), ...result.keys()]);
  const changed: string[] = [];
  const conflicts: string[] = [];
  const replacedAncestors = new Set<string>();
  const ops: SyncOp[] = [];

  // Plan every change before touching the work dir.
  for (const relPath of [...allPaths].sort()) {
    if (hasReplacedAncestor(relPath, replacedAncestors)) {
      continue;
    }
    const before = baseline.get(relPath);
    const after = result.get(relPath);
    if (sameState(before, after)) {
      continue;
    }
    const localPath = resolve(options.workDir, relPath);
    if (!isWithin(options.workDir, localPath)) {
      conflicts.push(relPath);
      continue;
    }
    if (!parentRealPathIsWithin(options.workDir, localPath)) {
      conflicts.push(relPath);
      continue;
    }
    // On a case- or normalisation-insensitive filesystem a differently
    // spelled path is the same file: never touch it.
    if (collides(relPath)) {
      conflicts.push(relPath);
      replacedAncestors.add(relPath);
      continue;
    }
    const local = localTree.get(relPath);
    if (!before && local) {
      conflicts.push(relPath);
      continue;
    }
    if (before && !sameState(before, local)) {
      conflicts.push(relPath);
      continue;
    }
    if (before?.type === "directory" && after?.type !== "directory" && treeHasLocalChanges(relPath, baseline, localTree)) {
      conflicts.push(relPath);
      replacedAncestors.add(relPath);
      continue;
    }
    if (after?.type === "symlink" && !isSafeLinkText(after.target ?? "")) {
      conflicts.push(relPath);
      continue;
    }
    ops.push({ relPath, before, after, local });
    if (before?.type === "directory" && after?.type !== "directory") {
      replacedAncestors.add(relPath);
    }
  }

  // Judge every sandbox symlink against the tree as it would be once all
  // planned changes are applied. Dropping a rejected link changes that tree,
  // so repeat until nothing more is rejected. Nothing is mutated before this.
  const rejected = new Set<string>();
  if (ops.some((op) => op.after?.type === "symlink")) {
    for (;;) {
      const tree = virtualTree(localTree, ops.filter((op) => !rejected.has(op.relPath)), fold);
      let rejectedMore = false;
      for (const op of ops) {
        if (op.after?.type !== "symlink" || rejected.has(op.relPath)) continue;
        if (!virtualLinkStaysInside(tree, op.relPath, op.after.target ?? "", fold)) {
          rejected.add(op.relPath);
          rejectedMore = true;
        }
      }
      if (!rejectedMore) break;
    }
  }

  const createdLinks: SyncOp[] = [];
  for (const op of ops) {
    const { relPath, after, local } = op;
    if (rejected.has(relPath)) {
      conflicts.push(relPath);
      continue;
    }
    const localPath = resolve(options.workDir, relPath);
    if (!parentRealPathIsWithin(options.workDir, localPath)) {
      conflicts.push(relPath);
      continue;
    }
    if (!after) {
      removePathIfPresent(localPath);
      changed.push(relPath);
      continue;
    }
    mkdirSync(dirname(localPath), { recursive: true });
    if (after.type === "directory") {
      if (local?.type !== "directory") {
        removePathIfPresent(localPath);
      }
      mkdirSync(localPath, { recursive: true, mode: after.mode });
      chmodSync(localPath, after.mode);
    } else if (after.type === "symlink") {
      removePathIfPresent(localPath);
      symlinkSync(after.target ?? "", localPath);
      createdLinks.push(op);
    } else {
      removePathIfPresent(localPath);
      copyFileSync(join(options.resultDir, relPath), localPath);
      chmodSync(localPath, after.mode);
    }
    changed.push(relPath);
  }

  // Check the created links again on the real filesystem. One that escapes
  // after all is removed and its path restored from the baseline.
  for (const op of createdLinks) {
    const localPath = resolve(options.workDir, op.relPath);
    if (!symlinkTargetIsWithin(options.workDir, localPath, readlinkText(localPath))) {
      removePathIfPresent(localPath);
      restoreBaselinePath(options.baselineDir, op.relPath, op.before, localPath);
      changed.splice(changed.indexOf(op.relPath), 1);
      conflicts.push(op.relPath);
    }
  }

  return { changed, conflicts };
}

function restoreBaselinePath(baselineDir: string, relPath: string, before: FileState | undefined, localPath: string): void {
  if (!before) return;
  const source = join(baselineDir, relPath);
  if (before.type === "directory") {
    cpSync(source, localPath, { recursive: true, verbatimSymlinks: true });
  } else if (before.type === "symlink") {
    symlinkSync(before.target ?? "", localPath);
  } else {
    copyFileSync(source, localPath);
    chmodSync(localPath, before.mode);
  }
}

// Sandbox link text is accepted only as a plain relative POSIX path: no
// absolute paths, drive letters, backslashes (a name character on POSIX but
// a separator on Windows, so checks and the created link could disagree) or NUL.
function isSafeLinkText(target: string): boolean {
  return Boolean(target) && !target.includes("\\") && !target.includes("\0") && !target.startsWith("/") &&
    !isAbsolute(target) && !/^[A-Za-z]:/.test(target);
}

/**
 * Folds paths the way the work dir's filesystem compares them: always NFC
 * (macOS is normalisation-insensitive), and lower-cased unless the
 * filesystem is known to be case-sensitive.
 */
function pathFolder(workDir: string, caseInsensitive?: boolean): (path: string) => string {
  const insensitive = caseInsensitive ?? probeCaseInsensitive(workDir);
  return (path) => {
    const normalized = path.normalize("NFC");
    return insensitive ? normalized.toLowerCase() : normalized;
  };
}

function probeCaseInsensitive(workDir: string): boolean {
  const name = basename(workDir);
  const swapped = [...name].map((char) => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase())).join("");
  if (swapped === name) {
    return true; // Cannot tell from this name; assume the cautious answer.
  }
  try {
    const original = statSync(workDir);
    const other = statSync(join(dirname(workDir), swapped));
    return original.ino === other.ino && original.dev === other.dev;
  } catch {
    return false;
  }
}

/** True when a path or one of its ancestors also exists under another spelling that folds to the same name. */
function collisionChecker(fold: (path: string) => string, sources: Iterable<string>[]): (relPath: string) => boolean {
  const spellings = new Map<string, Set<string>>();
  const add = (path: string) => {
    const key = fold(path);
    const set = spellings.get(key) ?? new Set<string>();
    set.add(path);
    spellings.set(key, set);
  };
  for (const source of sources) {
    for (const path of source) add(path);
  }
  return (relPath) => {
    const segments = relPath.split("/");
    for (let index = 1; index <= segments.length; index += 1) {
      if ((spellings.get(fold(segments.slice(0, index).join("/")))?.size ?? 0) > 1) return true;
    }
    return false;
  };
}

type VirtualEntry = Pick<FileState, "type" | "target">;

function virtualTree(localTree: Map<string, FileState>, ops: SyncOp[], fold: (path: string) => string): Map<string, VirtualEntry> {
  const tree = new Map<string, VirtualEntry>();
  for (const [path, state] of localTree) tree.set(fold(path), state);
  const removeSubtree = (key: string) => {
    tree.delete(key);
    for (const other of [...tree.keys()]) {
      if (other.startsWith(`${key}/`)) tree.delete(other);
    }
  };
  for (const op of ops) {
    const key = fold(op.relPath);
    if (!op.after || op.after.type !== "directory") removeSubtree(key);
    if (op.after) tree.set(key, op.after);
  }
  return tree;
}

/** Resolves a link through the simulated final tree; false when it leaves the work dir. */
function virtualLinkStaysInside(
  tree: Map<string, VirtualEntry>,
  relPath: string,
  target: string,
  fold: (path: string) => string,
): boolean {
  return resolveVirtual(tree, relPath.split("/").slice(0, -1), target, fold, 0) !== undefined;
}

function resolveVirtual(
  tree: Map<string, VirtualEntry>,
  start: string[],
  target: string,
  fold: (path: string) => string,
  depth: number,
): string[] | undefined {
  // Absolute targets (including local links the user made) count as leaving.
  if (depth > 40 || !target || target.startsWith("/") || isAbsolute(target) || target.includes("\0")) {
    return undefined;
  }
  let segments = [...start];
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(part);
    const entry = tree.get(fold(segments.join("/")));
    if (entry?.type === "symlink") {
      segments.pop();
      const resolved = resolveVirtual(tree, segments, entry.target ?? "", fold, depth + 1);
      if (!resolved) return undefined;
      segments = resolved;
    }
  }
  return segments;
}

// A symlink from the sandbox is applied only when its target stays inside the
// work dir: never absolute, inside lexically, and inside once the existing
// part of the path is resolved through the local filesystem.
function symlinkTargetIsWithin(workDir: string, linkPath: string, target: string): boolean {
  if (!isSafeLinkText(target)) {
    return false;
  }
  const normalized = target;
  const parent = dirname(linkPath);
  if (!isWithin(workDir, resolve(parent, normalized))) {
    return false;
  }
  let rootReal: string;
  try {
    rootReal = realpathSync(workDir);
  } catch {
    return false;
  }
  let current: string;
  try {
    current = realpathSync(parent);
  } catch {
    // The parent does not exist yet; its existing ancestors were checked.
    return true;
  }
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      current = dirname(current);
      continue;
    }
    current = join(current, segment);
    try {
      current = realpathSync(current);
    } catch {
      // A dangling link may point anywhere; a missing path resolves lexically.
      try {
        if (lstatSync(current).isSymbolicLink()) return false;
      } catch {
        // Missing component.
      }
    }
  }
  return isWithin(rootReal, current);
}

function snapshotTree(root: string): Map<string, FileState> {
  const result = new Map<string, FileState>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const relPath = normalizeRelative(root, path);
      const state = snapshotPath(root, relPath);
      if (state) {
        result.set(relPath, state);
      }
      if (entry.isDirectory()) {
        walk(path);
      }
    }
  };
  walk(root);
  return result;
}

function snapshotPath(root: string, relPath: string): FileState | undefined {
  const path = resolve(root, relPath);
  if (!isWithin(root, path)) {
    return undefined;
  }
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return undefined;
  }
  const mode = stat.mode & 0o777;
  if (stat.isSymbolicLink()) {
    return { mode, target: readlinkText(path), type: "symlink" };
  }
  if (stat.isDirectory()) {
    return { mode, type: "directory" };
  }
  if (!stat.isFile()) {
    return undefined;
  }
  return { hash: createHash("sha256").update(readFileSync(path)).digest("hex"), mode, type: "file" };
}

function sameState(left: FileState | undefined, right: FileState | undefined): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.type === right.type && left.hash === right.hash && left.mode === right.mode && left.target === right.target;
}

function treeHasLocalChanges(
  relPath: string,
  baseline: Map<string, FileState>,
  localTree: Map<string, FileState>,
): boolean {
  const descendants = new Set<string>();
  for (const path of baseline.keys()) {
    if (isDescendantPath(path, relPath)) {
      descendants.add(path);
    }
  }
  for (const path of localTree.keys()) {
    if (isDescendantPath(path, relPath)) {
      descendants.add(path);
    }
  }
  for (const path of descendants) {
    if (!sameState(baseline.get(path), localTree.get(path))) {
      return true;
    }
  }
  return false;
}

function isDescendantPath(path: string, ancestor: string): boolean {
  return path.startsWith(`${ancestor}/`);
}

function readlinkText(path: string): string {
  return readlinkSync(path);
}

function removePathIfPresent(path: string): void {
  try {
    lstatSync(path);
  } catch {
    return;
  }
  rmSync(path, { force: true, recursive: true });
}

function hasReplacedAncestor(relPath: string, ancestors: Set<string>): boolean {
  let parent = dirname(relPath).split("\\").join("/");
  while (parent && parent !== ".") {
    if (ancestors.has(parent)) {
      return true;
    }
    parent = dirname(parent).split("\\").join("/");
  }
  return false;
}

function normalizeRelative(root: string, path: string): string {
  return relative(root, path).split("\\").join("/");
}

function isWithin(root: string, path: string): boolean {
  const relPath = relative(resolve(root), resolve(path));
  return relPath === "" || (!relPath.startsWith("..") && !relPath.startsWith("/"));
}

function parentRealPathIsWithin(root: string, path: string): boolean {
  let parent = dirname(path);
  try {
    while (!existsSync(parent)) {
      const next = dirname(parent);
      if (next === parent) {
        return false;
      }
      parent = next;
    }
    const rootReal = realpathSync(root);
    const parentReal = realpathSync(parent);
    const relPath = relative(rootReal, parentReal);
    return relPath === "" || (!relPath.startsWith("..") && !relPath.startsWith("/"));
  } catch {
    return false;
  }
}

async function captureLocalCommand(
  command: string,
  args: string[],
  options: { cwd?: string; stdin?: string | Uint8Array } = {},
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return await new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolvePromise({ code: 127, stdout: Buffer.concat(stdout), stderr: `${error.message}\n` });
    });
    child.on("close", (code, signal) => {
      resolvePromise({ code: signal ? 1 : (code ?? 1), stdout: Buffer.concat(stdout), stderr });
    });
    child.stdin.end(options.stdin);
  });
}
