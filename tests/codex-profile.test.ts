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
