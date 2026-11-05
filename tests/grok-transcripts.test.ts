import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  deriveNativeTranscriptActivity,
  grokSessionDirName,
  indexNativeAssistantCompletion,
  resolveLatestNativeTranscripts,
  resolveNativeTranscript,
} from "../src/native-transcripts.ts";
import { grokEnvelope, grokSessionId, grokTextChunk, grokTurnCompleted, grokUpdatesJsonl } from "./grok-fixtures.ts";

const ts = 1_767_000_000;

function withWorkspace(run: (paths: { dir: string; home: string; workDir: string; realWorkDir: string }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "headless-grok-transcripts-"));
  try {
    const home = join(dir, "home");
    const workDir = join(dir, "work");
    mkdirSync(workDir, { recursive: true });
    run({ dir, home, workDir, realWorkDir: realpathSync(workDir) });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function writeSession(sessionsRoot: string, cwdDir: string, sessionId: string, contents: string, mtimeSeconds = ts): string {
  const sessionDir = join(sessionsRoot, cwdDir, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, "updates.jsonl");
  writeFileSync(path, contents);
  writeFileSync(join(sessionDir, "chat_history.jsonl"), '{"role":"assistant"}\n');
  writeFileSync(join(sessionDir, "summary.json"), "{}\n");
  utimesSync(path, mtimeSeconds, mtimeSeconds);
  return path;
}

test("grok session dirs use Rust urlencoding::encode of the cwd", () => {
  // urlencoding keeps only A-Za-z0-9 - . _ ~ and percent-encodes UTF-8 bytes in
  // upper-case hex (grok-build xai-grok-config/src/paths.rs encode_cwd_dirname;
  // xai-grok-pager/src/app/subagent_tests.rs builds "/tmp" this way).
  assert.equal(grokSessionDirName("/tmp"), "%2Ftmp");
  assert.equal(grokSessionDirName("/home/u/my project/ü~._-(1)"), "%2Fhome%2Fu%2Fmy%20project%2F%C3%BC~._-%281%29");
});

test("resolves a grok transcript by session id under ~/.grok or GROK_HOME", () => {
  withWorkspace(({ dir, home, workDir, realWorkDir }) => {
    const path = writeSession(join(home, ".grok", "sessions"), grokSessionDirName(realWorkDir), grokSessionId, grokUpdatesJsonl());
    const resolved = resolveNativeTranscript("grok", grokSessionId, workDir, { HOME: home });
    assert.equal(resolved?.path, path);
    assert.equal(resolved?.sessionId, grokSessionId);
    assert.equal(resolved?.kind, "jsonl");

    const grokHome = join(dir, "grok-home");
    const overridden = writeSession(join(grokHome, "sessions"), grokSessionDirName(realWorkDir), grokSessionId, grokUpdatesJsonl());
    assert.equal(resolveNativeTranscript("grok", grokSessionId, workDir, { HOME: home, GROK_HOME: grokHome })?.path, overridden);
    assert.equal(resolveNativeTranscript("grok", "../escape", workDir, { HOME: home }), undefined);
  });
});

test("resolves grok transcripts for long cwds through the .cwd marker", () => {
  withWorkspace(({ home, workDir, realWorkDir }) => {
    // Paths whose encoding exceeds 255 bytes use `<slug>-<blake3 16 hex>` plus a
    // .cwd file holding the original cwd (paths.rs ensure_sessions_cwd_dir_in).
    const sessionsRoot = join(home, ".grok", "sessions");
    const path = writeSession(sessionsRoot, "work-0123456789abcdef", grokSessionId, grokUpdatesJsonl());
    writeFileSync(join(sessionsRoot, "work-0123456789abcdef", ".cwd"), realWorkDir);
    writeSession(sessionsRoot, "other-fedcba9876543210", "22222222-2222-4222-8222-222222222222", grokUpdatesJsonl(), ts + 10);
    writeFileSync(join(sessionsRoot, "other-fedcba9876543210", ".cwd"), "/somewhere/else");

    assert.equal(resolveNativeTranscript("grok", grokSessionId, workDir, { HOME: home })?.path, path);
    const latest = resolveLatestNativeTranscripts("grok", workDir, { HOME: home });
    assert.deepEqual(latest.map((item) => [item.path, item.sessionId]), [[path, grokSessionId]]);
  });
});

test("latest grok transcripts are this workspace's updates.jsonl files, newest first", () => {
  withWorkspace(({ home, workDir, realWorkDir }) => {
    const sessionsRoot = join(home, ".grok", "sessions");
    const older = writeSession(sessionsRoot, grokSessionDirName(realWorkDir), "33333333-3333-4333-8333-333333333333", grokUpdatesJsonl(), ts);
    const newer = writeSession(sessionsRoot, grokSessionDirName(realWorkDir), grokSessionId, grokUpdatesJsonl(), ts + 5);
    writeSession(sessionsRoot, grokSessionDirName("/elsewhere"), "44444444-4444-4444-8444-444444444444", grokUpdatesJsonl(), ts + 9);

    const latest = resolveLatestNativeTranscripts("grok", workDir, { HOME: home });
    assert.deepEqual(latest.map((item) => item.path), [newer, older]);
    assert.equal(latest[0]?.sessionId, grokSessionId);
  });
});

test("grok activity is idle with the turn's final text once turn_completed is written", () => {
  withWorkspace(({ home, workDir, realWorkDir }) => {
    writeSession(join(home, ".grok", "sessions"), grokSessionDirName(realWorkDir), grokSessionId, grokUpdatesJsonl({ completed: true }));
    const transcript = resolveNativeTranscript("grok", grokSessionId, workDir, { HOME: home });
    const activity = deriveNativeTranscriptActivity("grok", transcript, { nowMs: ts * 1000 + 1000, terminalDonePrecedence: true });
    assert.equal(activity?.status, "idle");
    assert.equal(activity?.reason, "terminal_done");
    assert.equal(activity?.message, "Final pinned answer.");
    assert.equal(indexNativeAssistantCompletion("grok", transcript)?.message, "Final pinned answer.");
  });
});

test("grok activity is running while a tool call has no completed update", () => {
  withWorkspace(({ home, workDir, realWorkDir }) => {
    writeSession(join(home, ".grok", "sessions"), grokSessionDirName(realWorkDir), grokSessionId, grokUpdatesJsonl({ pendingTool: true }));
    const transcript = resolveNativeTranscript("grok", grokSessionId, workDir, { HOME: home });
    const activity = deriveNativeTranscriptActivity("grok", transcript, { nowMs: ts * 1000 + 1000 });
    assert.equal(activity?.status, "running");
    assert.equal(activity?.reason, "pending_tool_use_fresh");
  });
});

test("grok activity reads envelope timestamps as unix seconds", () => {
  withWorkspace(({ home, workDir, realWorkDir }) => {
    // The file mtime is older than the last envelope, so only a correct
    // seconds-to-ms conversion makes the run look fresh.
    writeSession(
      join(home, ".grok", "sessions"),
      grokSessionDirName(realWorkDir),
      grokSessionId,
      grokUpdatesJsonl({ timestamp: ts }),
      ts - 600,
    );
    const transcript = resolveNativeTranscript("grok", grokSessionId, workDir, { HOME: home });
    const fresh = deriveNativeTranscriptActivity("grok", transcript, { nowMs: ts * 1000 + 2000 });
    assert.equal(fresh?.updatedAtMs, ts * 1000);
    assert.equal(fresh?.status, "running");
    assert.equal(fresh?.reason, "recent_activity_fresh");
    const stale = deriveNativeTranscriptActivity("grok", transcript, { nowMs: ts * 1000 + 60_000 });
    assert.equal(stale?.status, "idle");
    assert.equal(stale?.message, "Final pinned answer.");
  });
});

test("grok activity for a failed turn reports the error text when no answer was produced", () => {
  withWorkspace(({ home, workDir, realWorkDir }) => {
    const contents = [
      grokEnvelope(grokTextChunk("user_message_chunk", "hi"), ts),
      grokEnvelope(grokTurnCompleted("error", "upstream unavailable"), ts, "_x.ai/session/update"),
      "",
    ].join("\n");
    writeSession(join(home, ".grok", "sessions"), grokSessionDirName(realWorkDir), grokSessionId, contents);
    const transcript = resolveNativeTranscript("grok", grokSessionId, workDir, { HOME: home });
    const activity = deriveNativeTranscriptActivity("grok", transcript, { nowMs: ts * 1000, terminalDonePrecedence: true });
    assert.equal(activity?.reason, "terminal_done");
    assert.equal(activity?.message, "upstream unavailable");
  });
});

test("grok activity names the stop reason of a turn that ended without any text", () => {
  withWorkspace(({ home, workDir, realWorkDir }) => {
    // An earlier turn's answer must not stand in for this turn's empty result.
    const contents = [
      grokEnvelope(grokTextChunk("user_message_chunk", "first"), ts),
      grokEnvelope(grokTextChunk("agent_message_chunk", "old answer"), ts),
      grokEnvelope(grokTurnCompleted(), ts, "_x.ai/session/update"),
      grokEnvelope(grokTextChunk("user_message_chunk", "second"), ts),
      grokEnvelope(grokTurnCompleted("rate_limit"), ts, "_x.ai/session/update"),
      "",
    ].join("\n");
    writeSession(join(home, ".grok", "sessions"), grokSessionDirName(realWorkDir), grokSessionId, contents);
    const transcript = resolveNativeTranscript("grok", grokSessionId, workDir, { HOME: home });
    const activity = deriveNativeTranscriptActivity("grok", transcript, { nowMs: ts * 1000, terminalDonePrecedence: true });
    assert.equal(activity?.reason, "terminal_done");
    assert.equal(activity?.message, "grok turn ended: rate_limit");
  });
});

test("grok activity keeps the answer of a turn that stopped early but produced text", () => {
  withWorkspace(({ home, workDir, realWorkDir }) => {
    const contents = [
      grokEnvelope(grokTextChunk("user_message_chunk", "go"), ts),
      grokEnvelope(grokTextChunk("agent_message_chunk", "partial answer"), ts),
      grokEnvelope(grokTurnCompleted("max_tokens"), ts, "_x.ai/session/update"),
      "",
    ].join("\n");
    writeSession(join(home, ".grok", "sessions"), grokSessionDirName(realWorkDir), grokSessionId, contents);
    const transcript = resolveNativeTranscript("grok", grokSessionId, workDir, { HOME: home });
    const activity = deriveNativeTranscriptActivity("grok", transcript, { nowMs: ts * 1000, terminalDonePrecedence: true });
    assert.equal(activity?.message, "partial answer");
  });
});
