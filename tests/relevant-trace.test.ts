import assert from "node:assert/strict";
import test from "node:test";

import { compactOversizedTraceLine } from "../src/relevant-trace.ts";

test("oversized trace compaction preserves only valid top-level usage", () => {
  assert.equal(compactOversizedTraceLine("claude", '{"type":"result","usage":'), "");

  const compacted = compactOversizedTraceLine(
    "claude",
    JSON.stringify({
      type: "tool",
      payload: { usage: { input_tokens: 999 }, total_cost_usd: 99 },
      result: "x".repeat(300_000),
    }),
  );

  assert.deepEqual(JSON.parse(compacted), { type: "tool" });
});

test("oversized Pi trace compaction preserves assistant usage identity", () => {
  const compacted = compactOversizedTraceLine(
    "pi",
    JSON.stringify({
      type: "message_end",
      result: "x".repeat(300_000),
      message: {
        role: "assistant",
        model: "gpt-test",
        provider: "openai",
        usage: { input: 10, cacheRead: 3, cacheWrite: 0, output: 2 },
      },
    }),
  );

  assert.equal(JSON.parse(compacted).message.role, "assistant");
});

test("oversized grok end-line compaction keeps the trust flags and per-model usage rows", () => {
  const compacted = compactOversizedTraceLine(
    "grok",
    JSON.stringify({
      type: "end",
      stopReason: "end_turn",
      sessionId: "s-1",
      structured_output: { blob: "x".repeat(300_000) },
      usage: { input_tokens: 10, cache_read_input_tokens: 3, output_tokens: 2, reasoning_tokens: 1, total_tokens: 15 },
      usage_is_incomplete: true,
      cost_is_partial: true,
      modelUsage: { "grok-4.6": { inputTokens: 10, cacheReadInputTokens: 3, outputTokens: 2, note: "x" } },
    }),
  );

  assert.deepEqual(JSON.parse(compacted), {
    type: "end",
    sessionId: "s-1",
    usage: { input_tokens: 10, cache_read_input_tokens: 3, output_tokens: 2, reasoning_tokens: 1, total_tokens: 15 },
    usage_is_incomplete: true,
    cost_is_partial: true,
    modelUsage: { "grok-4.6": { inputTokens: 10, cacheReadInputTokens: 3, outputTokens: 2 } },
  });
});
