// Grok Build wire fixtures, built from the serde definitions in the grok-build
// source (commit f50904eaee6c, the build that `grok --version` reports) rather
// than from a captured run: no credentials are available to record one.
// Paths are relative to grok-build/crates/codegen.
//
// Real recordings now sit beside these in tests/fixtures/grok (see
// grok-real-fixtures.test.ts). They agree on every key the parsers read; the
// real stream additionally shows per-response `usage` lines without
// messageId/stopReason (xAI backend), repeated `available_commands` lines,
// token-sized text chunks, a status-null tool_call_update, a `cwd` key on
// end/error, UUIDv7 session ids, and the model id grok-4.6-build. Its
// updates.jsonl holds one agent_message_chunk per response, a tool_call with
// no status, and a turn_completed carrying the PromptUsage totals.

// --- `--output-format streaming-json` -------------------------------------
// xai-grok-pager/src/headless/reducer/acp.rs:
//   AcpLine is `#[serde(tag = "type", rename_all = "snake_case")]`; Text and
//   Thought carry their chunk in `data`; ToolCall/ToolCallUpdate rename to
//   toolCallId/toolName/rawInput/rawOutput.
//   AcpUsageLine: {type:"usage", messageId?, stopReason?, usage?: ResponseUsage, signature?};
//   the turn-level line has no messageId.
//   AcpEndLine: {type:"end", stopReason, sessionId, requestId} plus spend fields.
// xai-grok-shell/src/extensions/notification.rs:
//   ResponseUsage fields are snake_case (no rename_all).
//   project_result_usage writes usage{input_tokens (uncached minus cache
//   creation), cache_read_input_tokens, cache_creation_input_tokens,
//   output_tokens, reasoning_tokens, total_tokens}, num_turns,
//   usage_is_incomplete?, cost_is_partial?, total_cost_usd and
//   total_cost_usd_ticks only when cost is complete, and modelUsage rows
//   {inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens,
//   modelCalls, costUSD?}. total_tokens = input + cache_read + cache_creation +
//   output, so reasoning_tokens is already inside output_tokens.

export const grokSessionId = "0d9f8c1e-2b3a-4c5d-8e6f-7a8b9c0d1e2f";

export function grokSpend(options: { cost?: number; partial?: boolean; incomplete?: boolean; modelCost?: number } = {}) {
  return {
    usage: {
      input_tokens: 1200,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 0,
      output_tokens: 300,
      reasoning_tokens: 120,
      total_tokens: 2300,
    },
    num_turns: 2,
    ...(options.incomplete ? { usage_is_incomplete: true } : {}),
    ...(options.partial ? { cost_is_partial: true } : {}),
    ...(options.cost !== undefined ? { total_cost_usd: options.cost, total_cost_usd_ticks: Math.round(options.cost * 1e10) } : {}),
    modelUsage: {
      "grok-4.6": {
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadInputTokens: 800,
        cacheCreationInputTokens: 0,
        modelCalls: 2,
        ...(options.modelCost !== undefined ? { costUSD: options.modelCost } : {}),
      },
    },
  };
}

const responseUsage = {
  input_tokens: 600,
  output_tokens: 150,
  cache_read_input_tokens: 400,
  cache_creation_input_tokens: 0,
  reasoning_tokens: 60,
};

export function grokStreamingJsonLines(endSpend: Record<string, unknown> = grokSpend({ cost: 0.0123, modelCost: 0.0123 })): string {
  return [
    { type: "available_commands", tools: ["read_file", "run_terminal_cmd"], commands: ["review"] },
    { type: "thought", data: "Inspecting the repo" },
    { type: "text", data: "Let me " },
    { type: "text", data: "check." },
    {
      type: "tool_call",
      toolCallId: "call_1",
      title: "Read",
      kind: "read",
      status: "in_progress",
      toolName: "read_file",
      rawInput: { path: "src/main.rs" },
      content: [],
      locations: [],
    },
    { type: "tool_call_update", toolCallId: "call_1", status: "completed", content: [], rawOutput: { lines: 42 }, locations: [] },
    { type: "usage", messageId: "resp_1", stopReason: "tool_use", usage: responseUsage },
    { type: "text", data: "The answer " },
    { type: "text", data: "is 42." },
    { type: "usage", messageId: "resp_2", stopReason: "end_turn", usage: responseUsage },
    { type: "usage", usage: responseUsage },
    { type: "end", stopReason: "end_turn", sessionId: grokSessionId, requestId: "req_1", ...endSpend },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n")
    .concat("\n");
}

// Observed verbatim from grok 1.0.70 with no credentials, an empty
// GROK_HOME and no TTY (exit code 1); the shape matches
// xai-grok-pager/src/headless.rs auth_required_message + AcpReducer::error.
export const grokNotSignedInLine = JSON.stringify({
  type: "error",
  message:
    "Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n\nAlternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser.",
});

// --- $GROK_HOME/sessions/<encoded cwd>/<session id>/updates.jsonl ---------
// xai-grok-shell/src/session/storage/mod.rs SessionUpdateEnvelope:
//   {timestamp: u64 unix SECONDS, method: "session/update" | "_x.ai/session/update", params}.
// ACP params are agent_client_protocol::SessionNotification
//   {sessionId, update: {sessionUpdate: <snake_case tag>, ...}, _meta?}; the
//   exact persisted strings are pinned by xai-grok-shell/src/session/wire_tags.rs
//   tests and appear verbatim in xai-grok-pager/src/app/subagent_tests.rs
//   (e.g. agent_message_chunk content {type:"text", text}).
// xAI params are xai-grok-shell/src/extensions/notification.rs SessionNotification
//   (rename_all camelCase: sessionId, update, _meta). TurnCompleted is the
//   durable turn-end signal written with AppendDurability::Durable
//   (session/acp_session_impl/turn_end.rs) whose fields stay snake_case:
//   prompt_id, stop_reason, agent_result? (error text only), error_kind?,
//   usage? (PromptUsage, camelCase), elapsed_ms?.

export function grokEnvelope(update: Record<string, unknown>, timestamp: number, method = "session/update"): string {
  return JSON.stringify({ timestamp, method, params: { sessionId: grokSessionId, update } });
}

export function grokTextChunk(kind: "user_message_chunk" | "agent_message_chunk", text: string): Record<string, unknown> {
  return { sessionUpdate: kind, content: { type: "text", text } };
}

export function grokTurnCompleted(stopReason = "end_turn", agentResult?: string): Record<string, unknown> {
  return {
    sessionUpdate: "turn_completed",
    prompt_id: "prompt-1",
    stop_reason: stopReason,
    ...(agentResult !== undefined ? { agent_result: agentResult } : {}),
    elapsed_ms: 1200,
  };
}

export function grokUpdatesJsonl(options: { completed?: boolean; pendingTool?: boolean; timestamp?: number } = {}): string {
  const ts = options.timestamp ?? 1_767_000_000;
  const lines = [
    grokEnvelope(grokTextChunk("user_message_chunk", "hello"), ts),
    grokEnvelope({ sessionUpdate: "available_commands_update", availableCommands: [] }, ts),
    grokEnvelope(grokTextChunk("agent_message_chunk", "Looking "), ts),
    grokEnvelope(grokTextChunk("agent_message_chunk", "now."), ts),
    grokEnvelope(
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "bash", kind: "execute", status: "pending" },
      ts,
    ),
  ];
  if (!options.pendingTool) {
    lines.push(
      grokEnvelope({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", content: [] }, ts),
      grokEnvelope(
        { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "text", text: "out" }] },
        ts,
      ),
      grokEnvelope(grokTextChunk("agent_message_chunk", "Final "), ts),
      grokEnvelope(grokTextChunk("agent_message_chunk", "pinned answer."), ts),
    );
  }
  if (options.completed) {
    lines.push(grokEnvelope(grokTurnCompleted(), ts, "_x.ai/session/update"));
  }
  return `${lines.join("\n")}\n`;
}
