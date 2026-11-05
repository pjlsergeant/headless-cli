import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareBillingAttempt } from "../src/billing.js";
import { buildDockerAgentCommand } from "../src/docker.js";

test("Docker subscription masks override paid backend variables inherited from the image", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-docker-billing-"));
  try {
    const attempt = prepareBillingAttempt("claude", { prompt: "task" },
      { CLAUDE_CODE_OAUTH_TOKEN: "subscription" }, "subscription");
    const command = buildDockerAgentCommand({
      agent: "claude", dockerArgs: [], dockerEnv: [], env: attempt.env, image: "test-image",
      workDir: dir, command: {
        command: process.execPath,
        args: ["-e", "console.log(JSON.stringify({bedrock:process.env.CLAUDE_CODE_USE_BEDROCK,key:process.env.ANTHROPIC_API_KEY,oauth:process.env.CLAUDE_CODE_OAUTH_TOKEN}))"],
        env: Object.fromEntries(Object.entries(attempt.env).filter(([, value]) => value === undefined)),
      },
    });
    const containerArgs = command.args.slice(command.args.indexOf("test-image") + 1);
    const bootstrap = containerArgs.indexOf("-lc") + 1;
    containerArgs[bootstrap] = containerArgs[bootstrap]
      .replaceAll("/headless-home", join(dir, "home"))
      .replaceAll("/tmp/headless-host-home", join(dir, "seed"));
    const result = spawnSync(containerArgs[0], containerArgs.slice(1), {
      encoding: "utf8", env: { ...process.env, CLAUDE_CODE_USE_BEDROCK: "1",
        ANTHROPIC_API_KEY: "image-api-key", CLAUDE_CODE_OAUTH_TOKEN: "subscription" },
    });
    assert.equal(result.status, 0, result.stderr);
    // Compare masked facts, never raw values: a failure must not print a real credential.
    const seen = JSON.parse(result.stdout) as Record<string, string | undefined>;
    assert.deepEqual({
      bedrockSet: seen.bedrock !== undefined,
      apiKeySet: seen.key !== undefined,
      oauthIsSubscription: seen.oauth === "subscription",
    }, { bedrockSet: false, apiKeySet: false, oauthIsSubscription: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
