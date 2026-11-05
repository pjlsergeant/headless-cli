import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentCommand,
  buildInteractiveAgentCommand,
  getAgentConfig,
  listAgents,
  waitTierForAgent,
} from "../src/agents.ts";
import { BUILTIN_AGENT_DEFAULTS, parseHeadlessConfig } from "../src/config.ts";

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
    seedPaths: [".grok"],
    dockerSeedFiles: {
      ".grok": ["auth.json", "config.toml", "mcp_credentials.json", "trusted_folders.toml"],
    },
  });
});
