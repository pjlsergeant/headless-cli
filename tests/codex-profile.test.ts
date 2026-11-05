import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  codexProfileSeedFiles,
  readCodexProfileFiles,
  readCodexProfileModelSelection,
  validateCodexProfileName,
} from "../src/codex-profile.ts";

test("Codex profile names follow the CLI plain-name grammar", () => {
  for (const profile of ["fugu", "Research42", "research_name", "research-name"]) {
    assert.equal(validateCodexProfileName(profile), profile);
  }
  for (const profile of ["", "-research", "research profile", "research.profile", "research/profile", "fugü"]) {
    assert.throws(() => validateCodexProfileName(profile), /invalid Codex profile/);
  }
});

test("Codex profile seeds rewrite an absolute catalog into the remote home", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-codex-profile-"));
  try {
    const codexHome = join(dir, "codex-home");
    const catalogPath = join(codexHome, "models.json");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "work.config.toml"), `model_catalog_json = ${JSON.stringify(catalogPath)}\n`);
    writeFileSync(catalogPath, '{"models":[]}\n');

    assert.deepEqual(codexProfileSeedFiles({ CODEX_HOME: codexHome }, "work", "/remote/.codex"), [
      {
        content: 'model_catalog_json = "/remote/.codex/models.json"\n',
        relPath: ".codex/work.config.toml",
      },
      { content: '{"models":[]}\n', relPath: ".codex/models.json" },
    ]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("Codex profile seeds reject symlinked profile files", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-codex-profile-"));
  try {
    const codexHome = join(dir, "codex-home");
    const externalProfile = join(dir, "external.config.toml");
    mkdirSync(codexHome);
    writeFileSync(externalProfile, 'model = "external"\n');
    symlinkSync(externalProfile, join(codexHome, "work.config.toml"));

    assert.throws(() => readCodexProfileFiles({ CODEX_HOME: codexHome }, "work"), /ELOOP/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("Codex profile model selection reads top-level model and provider keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-codex-profile-"));
  try {
    writeFileSync(
      join(dir, "zai.config.toml"),
      [
        "# Z.AI through Codex",
        'model = "glm-5.3" # comment',
        "model_provider = 'zai'",
        'model_reasoning_effort = "max"',
        "",
        "[model_providers.zai]",
        'name = "Z.AI"',
        'model = "table-model"',
        "",
      ].join("\n"),
    );
    assert.deepEqual(readCodexProfileModelSelection({ CODEX_HOME: dir }, "zai"), {
      model: "glm-5.3",
      provider: "zai",
    });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("Codex profile model selection ignores keys that only appear inside tables", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-codex-profile-"));
  try {
    writeFileSync(join(dir, "tables.config.toml"), '[model_providers.x]\nmodel = "nope"\nmodel_provider = "nope"\n');
    assert.deepEqual(readCodexProfileModelSelection({ CODEX_HOME: dir }, "tables"), {});
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("Codex profile model selection is empty when the profile cannot be read", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-codex-profile-"));
  try {
    assert.deepEqual(readCodexProfileModelSelection({ CODEX_HOME: dir }, "missing"), {});
    assert.deepEqual(readCodexProfileModelSelection({}, "nohome"), {});
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

function withProfile(profile: string, config: string | undefined, run: (codexHome: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "headless-codex-profile-"));
  try {
    writeFileSync(join(dir, "p.config.toml"), profile);
    if (config !== undefined) writeFileSync(join(dir, "config.toml"), config);
    run(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

test("Codex profile model selection skips assignments inside multiline strings", () => {
  withProfile(
    ['note = """', 'model = "fake"', 'model_provider = "fake"', '"""', 'model = "glm-5.3"', ""].join("\n"),
    undefined,
    (codexHome) => assert.deepEqual(readCodexProfileModelSelection({ CODEX_HOME: codexHome }, "p"), { model: "glm-5.3" }),
  );
});

test("Codex profile model selection reads past brackets inside strings", () => {
  withProfile(
    ['instructions = "[draft] be brief"', 'model = "glm-5.3"', "model_provider = 'zai'", ""].join("\n"),
    undefined,
    (codexHome) =>
      assert.deepEqual(readCodexProfileModelSelection({ CODEX_HOME: codexHome }, "p"), {
        model: "glm-5.3",
        provider: "zai",
      }),
  );
});

test("Codex profile model selection reads quoted keys", () => {
  withProfile(
    ['"model" = "glm-5.3"', "'model_provider' = \"zai\"", ""].join("\n"),
    undefined,
    (codexHome) =>
      assert.deepEqual(readCodexProfileModelSelection({ CODEX_HOME: codexHome }, "p"), {
        model: "glm-5.3",
        provider: "zai",
      }),
  );
});

test("Codex profile model selection is empty for undecodable values", () => {
  for (const profile of ['model = """glm"""\n', "model = 5\n", 'model_provider = ["zai"]\n']) {
    withProfile(profile, 'model = "base"\nmodel_provider = "openai"\n', (codexHome) =>
      assert.deepEqual(readCodexProfileModelSelection({ CODEX_HOME: codexHome }, "p"), {}, profile),
    );
  }
});

test("Codex profile model selection falls back to the root config.toml per key", () => {
  withProfile(
    'model = "glm-5.3"\n',
    'model = "gpt-5.5"\nmodel_provider = "zai"\n\n[profiles.other]\nmodel_provider = "nope"\n',
    (codexHome) =>
      assert.deepEqual(readCodexProfileModelSelection({ CODEX_HOME: codexHome }, "p"), {
        model: "glm-5.3",
        provider: "zai",
      }),
  );
  withProfile('model_provider = "zai"\n', 'model = "glm-5"\n', (codexHome) =>
    assert.deepEqual(readCodexProfileModelSelection({ CODEX_HOME: codexHome }, "p"), {
      model: "glm-5",
      provider: "zai",
    }),
  );
});
