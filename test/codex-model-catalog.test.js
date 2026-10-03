const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  codexVersionsMatch,
  compatibleReasoningEffort,
  findCatalogModel,
  normalizeCodexVersion,
  parseCodexModelCatalog,
  parseTopLevelTomlString,
  readCodexConfigValue,
  reasoningEffortsForModel,
  resolveCodexModel
} = require("../src/main/codex-model-catalog");

const CATALOG = JSON.stringify({
  models: [
    {
      slug: "gpt-older",
      display_name: "Older",
      visibility: "list",
      priority: 5,
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" }
      ]
    },
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      visibility: "list",
      priority: 1,
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "ultra" },
        { effort: "medium" },
        { effort: "max" },
        { effort: "low" }
      ]
    },
    {
      slug: "hidden-model",
      visibility: "hide",
      supported_reasoning_levels: [{ effort: "high" }]
    }
  ]
});

test("Codex catalog exposes visible models and their current reasoning levels", () => {
  const catalog = parseCodexModelCatalog(`warning\n${CATALOG}`);
  assert.deepEqual(catalog.map((model) => model.slug), ["gpt-5.6-sol", "gpt-older"]);
  assert.deepEqual(
    findCatalogModel(catalog, "gpt-5.6-sol").reasoningEfforts,
    ["low", "medium", "max", "ultra"]
  );
  assert.equal(findCatalogModel(catalog, "hidden-model"), null);
});

test("Codex version normalization compares CLI and cache version strings", () => {
  assert.equal(normalizeCodexVersion("codex-cli 0.144.0-alpha.4"), "0.144.0-alpha.4");
  assert.equal(normalizeCodexVersion("0.142.5"), "0.142.5");
  assert.equal(codexVersionsMatch("0.144.0", "codex-cli 0.144.0-alpha.4"), true);
  assert.equal(codexVersionsMatch("0.144.0-alpha.1", "0.144.0-alpha.4"), false);
  assert.equal(codexVersionsMatch("0.142.5", "codex-cli 0.144.0-alpha.4"), false);
});

test("top-level Codex model config does not read values from profiles", () => {
  const config = [
    'model = "gpt-5.6-sol" # default',
    'model_reasoning_effort = "ultra"',
    "",
    "[profiles.fast]",
    'model = "gpt-older"'
  ].join("\n");
  assert.equal(parseTopLevelTomlString(config, "model"), "gpt-5.6-sol");
  assert.equal(parseTopLevelTomlString(config, "model_reasoning_effort"), "ultra");
});

test("unsupported reasoning effort falls back to the model default", () => {
  const catalog = parseCodexModelCatalog(CATALOG);
  const model = findCatalogModel(catalog, "gpt-older");
  assert.equal(compatibleReasoningEffort(model, "ultra"), "medium");
  assert.equal(compatibleReasoningEffort(model, "high"), "high");
});

test("an unpinned model resolves through config.toml before giving up", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "prts-codex-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  });

  // Nothing pinned anywhere: the CLI picks from the account, so PRTS must
  // report that it does not know which model will run.
  assert.deepEqual(resolveCodexModel(""), { model: "", certain: false });
  assert.deepEqual(resolveCodexModel("gpt-5.6-sol"), { model: "gpt-5.6-sol", certain: true });

  fs.writeFileSync(path.join(home, "config.toml"), 'model = "gpt-older"\n', "utf8");
  assert.equal(readCodexConfigValue("model"), "gpt-older");
  assert.deepEqual(resolveCodexModel(""), { model: "gpt-older", certain: true });
  // A PRTS pin still outranks config.toml.
  assert.deepEqual(resolveCodexModel("gpt-5.6-sol"), { model: "gpt-5.6-sol", certain: true });
});

test("an unknown model offers every level the catalog advertises", () => {
  const catalog = parseCodexModelCatalog(CATALOG);
  // gpt-older tops out at high; gpt-5.6-sol goes to ultra. With no known
  // model, hiding max/ultra would wrongly lock the user out of levels their
  // actual model supports.
  assert.deepEqual(
    reasoningEffortsForModel(catalog, "", false),
    ["low", "medium", "high", "max", "ultra"]
  );
  assert.deepEqual(
    reasoningEffortsForModel(catalog, "gpt-older", true),
    ["low", "medium", "high"]
  );
  // A pinned model missing from the catalog falls back to the same union
  // rather than reporting no levels at all.
  assert.deepEqual(
    reasoningEffortsForModel(catalog, "gpt-unknown", true),
    ["low", "medium", "high", "max", "ultra"]
  );
});

test("readCodexModelCatalogFile reads Codex's own cache for the matching CLI version", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { readCodexModelCatalogFile } = require("../src/main/codex-model-catalog");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "prts-codex-home-"));
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    assert.equal(readCodexModelCatalogFile("0.50.0"), null, "no file yet");
    fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({
      client_version: "0.50.0",
      models: [
        { slug: "gpt-5-codex", display_name: "GPT-5 Codex", visibility: "list", supported_reasoning_levels: ["low", "high"] },
        { slug: "hidden", visibility: "hide" }
      ]
    }));
    const catalog = readCodexModelCatalogFile("0.50.0");
    assert.deepEqual(catalog.map((model) => model.slug), ["gpt-5-codex"]);
    assert.deepEqual(readCodexModelCatalogFile("").map((model) => model.slug), ["gpt-5-codex"]);
    assert.equal(readCodexModelCatalogFile("0.51.0"), null, "another CLI's cache is not trusted");
    fs.writeFileSync(path.join(home, "models_cache.json"), "{not json");
    assert.equal(readCodexModelCatalogFile("0.50.0"), null);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
