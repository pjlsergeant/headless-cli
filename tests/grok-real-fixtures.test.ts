import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  deriveNativeTranscriptActivity,
  grokSessionDirName,
  indexNativeAssistantCompletion,
  resolveNativeTranscript,
} from "../src/native-transcripts.ts";
import {
  extractAgentError,
  extractFinalMessage,
  extractNativeSessionId,
  extractUsageSummary,
  priceUsageSummary,
} from "../src/output.ts";

// Recorded from grok 1.0.70 (model grok-4.6-build) on 2026-11-05 in a scratch
// git repo holding a.txt and b.txt, prompt "List the files in the current
// directory using a tool, then reply with just their names separated by
// commas." Scrubbed: the repo path is /work/repo, ids are fixed placeholders,
// encrypted reasoning signatures are "<signature>", and the account's
// tool and slash-command/skill catalogs are replaced with synthetic lists.
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "grok");
const readFixture = (name: string) => readFileSync(join(fixtureDir, name), "utf8");
const streaming = readFixture("streaming-json-tool-call.jsonl");
const updates = readFixture("updates-tool-call.jsonl");
const badModel = readFixture("streaming-json-bad-model.jsonl");
const sessionId = "01a1ab5e-0000-7000-8000-000000000001";

test("real grok streaming-json: final message, session id and native usage", () => {
  assert.equal(extractFinalMessage("grok", streaming), "a.txt, b.txt");
  assert.equal(extractNativeSessionId("grok", streaming), sessionId);
  const summary = priceUsageSummary(extractUsageSummary("grok", streaming, { provider: "xai", model: "grok-4.6" }), {});
  assert.deepEqual(summary, {
    agent: "grok",
    provider: "xai",
    model: "grok-4.6-build",
    inputTokens: 19557,
    cacheReadTokens: 9216,
    cacheWriteTokens: 0,
    outputTokens: 91,
    reasoningOutputTokens: 60,
    totalTokens: 28864,
    usageStatus: "reported",
    cost: { input: null, cacheRead: null, cacheWrite: null, output: null, total: 0.01505112 },
    costBasis: "native-reported",
    pricingSource: "native",
    pricingStatus: "native",
  });
});

test("real grok usage without a trusted native cost is not list-priced under a guessed model", () => {
  // models.dev (2026-11-05) lists xai grok-4.6 and grok-build-0.1 but no
  // grok-4.6-build. Neither list price reproduces grok's own $0.01505 for this
  // run, so the fallback stays unpriced rather than aliasing the id.
  const partial = streaming
    .split("\n")
    .map((line) => {
      if (!line.includes('"type":"end"')) return line;
      const { total_cost_usd: _total, total_cost_usd_ticks: _ticks, ...rest } = JSON.parse(line) as Record<string, unknown>;
      return JSON.stringify({ ...rest, cost_is_partial: true });
    })
    .join("\n");
  const pricing = {
    xai: {
      models: {
        "grok-4.6": { cost: { input: 2, output: 6, cache_read: 0.5 } },
        "grok-build-0.1": { cost: { input: 1, output: 2, cache_read: 0.2 } },
      },
    },
  };
  const summary = priceUsageSummary(extractUsageSummary("grok", partial, { provider: "xai", model: "grok-4.6" }), pricing);
  assert.equal(summary.model, "grok-4.6-build");
  assert.equal(summary.usageStatus, "reported");
  assert.equal(summary.pricingStatus, "missing");
  assert.equal(summary.cost, null);
});

test("real grok bad-model error is reported and has no final message", () => {
  assert.equal(extractFinalMessage("grok", badModel), "");
  assert.equal(
    extractAgentError("grok", badModel),
    "grok error: Couldn't set model 'no-such-model-xyz': Invalid params: \"unknown model id\". Run 'grok models' to see available models.",
  );
});

test("real grok updates.jsonl resolves to terminal_done with the final answer", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-grok-real-"));
  try {
    const home = join(dir, "home");
    const workDir = join(dir, "work");
    mkdirSync(workDir, { recursive: true });
    const sessionDir = join(home, ".grok", "sessions", grokSessionDirName(realpathSync(workDir)), sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "updates.jsonl"), updates);

    const transcript = resolveNativeTranscript("grok", sessionId, workDir, { HOME: home });
    const activity = deriveNativeTranscriptActivity("grok", transcript, { nowMs: 1793876437455 + 1000, terminalDonePrecedence: true });
    assert.equal(activity?.status, "idle");
    assert.equal(activity?.reason, "terminal_done");
    assert.equal(activity?.message, "a.txt, b.txt");
    assert.equal(indexNativeAssistantCompletion("grok", transcript)?.message, "a.txt, b.txt");
    assert.equal(extractFinalMessage("grok", updates), "a.txt, b.txt");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("real grok session directory name keeps '-' and encodes '/' as %2F", () => {
  // Matches the directory grok created for the recording's cwd.
  assert.equal(grokSessionDirName("/tmp/claude-1000/-workspace/x"), "%2Ftmp%2Fclaude-1000%2F-workspace%2Fx");
});
