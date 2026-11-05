import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentCommand,
  buildInteractiveAgentCommand,
  getAgentConfig,
  listAgents,
  waitTierForAgent,
} from "../src/agents.ts";
import { BillingError, prepareBillingAttempt } from "../src/billing.ts";
import { BUILTIN_AGENT_DEFAULTS, parseHeadlessConfig } from "../src/config.ts";
import {
  extractAgentError,
  extractFinalMessage,
  extractNativeSessionId,
  extractUsageSummary,
  priceUsageSummary,
} from "../src/output.ts";
import {
  grokNotSignedInLine,
  grokSessionId,
  grokSpend,
  grokStreamingJsonLines,
  grokUpdatesJsonl,
} from "./grok-fixtures.ts";

const sessionId = "11111111-1111-4111-8111-111111111111";

test("headless config accepts grok as default agent and as an [agents.grok] section", () => {
  const config = parseHeadlessConfig(
    '[general]\ndefault_agent = "grok"\n\n[agents.grok]\nmodel = "grok-code-fast"\nreasoning_effort = "high"\n',
  );
  assert.equal(config.general.defaultAgent, "grok");
  assert.deepEqual(config.agents.grok, { model: "grok-code-fast", reasoningEffort: "high" });
  assert.deepEqual(BUILTIN_AGENT_DEFAULTS.grok, { model: "grok-4.6" });
});

test("grok is a listed agent", () => {
  assert.ok(listAgents().includes("grok"));
});

test("builds grok one-shot command with streaming-json output and the default model", () => {
  assert.deepEqual(buildAgentCommand("grok", { prompt: "hello" }, {}), {
    command: "grok",
    args: [
      "--model",
      "grok-4.6",
      "--output-format",
      "streaming-json",
      "--no-auto-update",
      "--always-approve",
      "--single=hello",
    ],
  });
});

test("grok one-shot attaches the prompt to --single so a dash-leading prompt is not parsed as an option", () => {
  const args = buildAgentCommand("grok", { prompt: "- list item\n--flag" }, {}).args;
  assert.equal(args.at(-1), "--single=- list item\n--flag");
});

test("grok one-shot honours GROK_CLI_BIN, model and reasoning effort", () => {
  assert.deepEqual(
    buildAgentCommand("grok", { prompt: "hi", model: "grok-code-fast", reasoningEffort: "xhigh" }, { GROK_CLI_BIN: "/opt/grok" }),
    {
      command: "/opt/grok",
      args: [
        "--model",
        "grok-code-fast",
        "--reasoning-effort",
        "xhigh",
        "--output-format",
        "streaming-json",
        "--no-auto-update",
        "--always-approve",
        "--single=hi",
      ],
    },
  );
});

test("grok read-only one-shot restricts built-in tools and does not auto-approve", () => {
  const args = buildAgentCommand("grok", { prompt: "review", allow: "read-only" }, {}).args;
  assert.deepEqual(args, [
    "--model",
    "grok-4.6",
    "--output-format",
    "streaming-json",
    "--no-auto-update",
    "--tools",
    "read_file,grep,list_dir,web_search,web_fetch",
    "--single=review",
  ]);
});

test("grok one-shot sessions pin a new id or resume a stored one", () => {
  assert.deepEqual(
    buildAgentCommand("grok", { prompt: "hi", sessionMode: "new", sessionId }, {}).args.slice(-3),
    ["--session-id", sessionId, "--single=hi"],
  );
  assert.deepEqual(
    buildAgentCommand("grok", { prompt: "hi", sessionMode: "resume", sessionId }, {}).args.slice(-3),
    ["--resume", sessionId, "--single=hi"],
  );
});

test("builds interactive grok command with the prompt after --", () => {
  assert.deepEqual(buildInteractiveAgentCommand("grok", { prompt: "-hello" }, {}), {
    command: "grok",
    args: ["--model", "grok-4.6", "--no-auto-update", "--trust", "--always-approve", "--", "-hello"],
  });
});

test("interactive grok read-only denies shell, edit and MCP tools and does not trust the folder", () => {
  assert.deepEqual(buildInteractiveAgentCommand("grok", { prompt: "look", allow: "read-only" }, {}).args, [
    "--model",
    "grok-4.6",
    "--no-auto-update",
    "--deny",
    "Bash",
    "--deny",
    "Edit",
    "--deny",
    "MCPTool",
    "--",
    "look",
  ]);
});

test("interactive grok pins a new session id and resumes stored sessions", () => {
  assert.deepEqual(
    buildInteractiveAgentCommand("grok", { prompt: "hi", sessionMode: "new", sessionId, reasoningEffort: "low" }, {}).args,
    [
      "--model",
      "grok-4.6",
      "--reasoning-effort",
      "low",
      "--no-auto-update",
      "--trust",
      "--always-approve",
      "--session-id",
      sessionId,
      "--",
      "hi",
    ],
  );
  const resume = buildInteractiveAgentCommand("grok", { prompt: "hi", sessionMode: "resume", sessionId }, {}).args;
  assert.deepEqual(resume.slice(-4), ["--resume", sessionId, "--", "hi"]);
});

test("grok uses the pin wait tier and seeds only credential/config files into Docker", () => {
  assert.equal(waitTierForAgent("grok"), "pin");
  assert.deepEqual(getAgentConfig("grok"), {
    name: "grok",
    promptFileMode: "argument",
    configRelDir: ".grok",
    workspaceConfigRelDir: ".grok",
    seedPaths: [".grok/auth.json", ".grok/config.toml", ".grok/mcp_credentials.json", ".grok/trusted_folders.toml"],
  });
});

test("grok final message is the last model response's text chunks, ignoring thoughts and tool calls", () => {
  assert.equal(extractFinalMessage("grok", grokStreamingJsonLines()), "The answer is 42.");
});

test("grok final message keeps the last text when no per-response usage lines are emitted", () => {
  const trace = grokStreamingJsonLines()
    .split("\n")
    .filter((line) => !line.includes('"type":"usage"'))
    .join("\n");
  assert.equal(extractFinalMessage("grok", trace), "The answer is 42.");
});

test("grok final message is empty for an error-only trace and the error is reported without a type prefix", () => {
  assert.equal(extractFinalMessage("grok", `${grokNotSignedInLine}\n`), "");
  assert.match(extractAgentError("grok", `${grokNotSignedInLine}\n`), /^grok error: Not signed in\. /);
});

test("grok native session id comes from the end line", () => {
  assert.equal(extractNativeSessionId("grok", grokStreamingJsonLines()), grokSessionId);
});

test("grok final message also reads updates.jsonl envelopes for tmux --wait", () => {
  assert.equal(extractFinalMessage("grok", grokUpdatesJsonl({ completed: true })), "Final pinned answer.");
});

test("grok usage uses the end line totals and the native cost when it is complete", () => {
  const summary = extractUsageSummary("grok", grokStreamingJsonLines(), { provider: "xai", model: "grok-4.6" });
  assert.deepEqual(priceUsageSummary(summary, {}), {
    agent: "grok",
    provider: "xai",
    model: "grok-4.6",
    inputTokens: 1200,
    cacheReadTokens: 800,
    cacheWriteTokens: 0,
    outputTokens: 300,
    reasoningOutputTokens: 120,
    totalTokens: 2300,
    usageStatus: "reported",
    cost: { input: null, cacheRead: null, cacheWrite: null, output: null, total: 0.0123 },
    costBasis: "native-reported",
    pricingSource: "native",
    pricingStatus: "native",
  });
});

test("grok usage falls back to models.dev pricing when grok withholds a partial cost", () => {
  const trace = grokStreamingJsonLines(grokSpend({ partial: true }));
  const summary = priceUsageSummary(extractUsageSummary("grok", trace, {}), {
    xai: { models: { "grok-4.6": { cost: { input: 2, output: 10, cache_read: 0.5, cache_write: 0 } } } },
  });
  assert.equal(summary.provider, "xai");
  assert.equal(summary.model, "grok-4.6");
  assert.equal(summary.pricingStatus, "priced");
  assert.equal(summary.costBasis, "api-list-price-estimate");
  assert.deepEqual(summary.cost, { input: 0.0024, cacheRead: 0.0004, cacheWrite: 0, output: 0.003, total: 0.0058 });
});

test("grok usage flagged incomplete is reported as missing so it never reads as cheap", () => {
  const summary = priceUsageSummary(
    extractUsageSummary("grok", grokStreamingJsonLines(grokSpend({ incomplete: true, cost: 0.5 })), {}),
    { xai: { models: { "grok-4.6": { cost: { input: 2, output: 10, cache_read: 0.5 } } } } },
  );
  assert.equal(summary.usageStatus, "missing");
  assert.equal(summary.cost, null);
  assert.equal(summary.pricingStatus, "missing");
});

test("grok usage reads spend fields carried on an error line", () => {
  const trace = `${JSON.stringify({ type: "error", message: "rate limited", ...grokSpend({ cost: 0.001 }) })}\n`;
  const summary = extractUsageSummary("grok", trace, {});
  assert.equal(summary.inputTokens, 1200);
  assert.equal(summary.cost?.total, 0.001);
  assert.equal(summary.pricingStatus, "native");
});

test("grok usage without an end line is missing", () => {
  const trace = grokStreamingJsonLines()
    .split("\n")
    .filter((line) => !line.includes('"type":"end"'))
    .join("\n");
  assert.equal(extractUsageSummary("grok", trace, { provider: "xai", model: "grok-4.6" }).usageStatus, "missing");
});

test("grok billing is native only", () => {
  const options = { prompt: "hi" };
  assert.equal(prepareBillingAttempt("grok", options, { XAI_API_KEY: "xai-test" }, "auto").route, "native");
  assert.throws(() => prepareBillingAttempt("grok", options, {}, "subscription"), BillingError);
  assert.throws(() => prepareBillingAttempt("grok", options, {}, "api"), BillingError);
});
