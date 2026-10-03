const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isClaudeReasoningEffort,
  parseClaudeEffortLevels
} = require("../src/main/claude-capabilities");

test("Claude help exposes the effort levels accepted by the selected CLI", () => {
  const help = [
    "Options:",
    "  --effort <level>                      Effort level for the current session",
    "                                        (low, medium, high, xhigh, max)",
    "  --model <model>                       Model for the current session"
  ].join("\n");
  assert.deepEqual(
    parseClaudeEffortLevels(help),
    ["low", "medium", "high", "xhigh", "max"]
  );
});

test("Claude effort support stays hidden for an older CLI without the flag", () => {
  assert.deepEqual(parseClaudeEffortLevels("Options:\n  --model <model>"), []);
  assert.equal(isClaudeReasoningEffort("xhigh"), true);
  assert.equal(isClaudeReasoningEffort("ultra"), false);
});

const {
  CLAUDE_MODEL_MIGRATIONS,
  CLAUDE_MODEL_PRESETS,
  migrateClaudeModel
} = require("../src/main/claude-capabilities");

const presetValues = CLAUDE_MODEL_PRESETS
  .filter((preset) => preset.type !== "separator")
  .map((preset) => preset.value);

test("the Claude model menu offers the current lineup and its aliases", () => {
  for (const model of ["", "fable", "opus", "sonnet", "haiku",
    "claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"]) {
    assert.ok(presetValues.includes(model), `missing ${model || "(default)"}`);
  }
  assert.equal(new Set(presetValues).size, presetValues.length, "duplicate preset");
  for (const preset of CLAUDE_MODEL_PRESETS) {
    if (preset.type === "separator") continue;
    assert.ok(preset.label || preset.labelKey, `unlabeled preset ${preset.value}`);
  }
});

test("retired, deprecated and dated Claude ids are not offered", () => {
  for (const model of Object.keys(CLAUDE_MODEL_MIGRATIONS)) {
    assert.ok(!presetValues.includes(model), `${model} is migrated away but still offered`);
  }
  for (const model of presetValues) {
    assert.doesNotMatch(model, /-\d{8}$/, `${model} pins a dated snapshot`);
    assert.doesNotMatch(model, /^claude-(3|sonnet-4-0|opus-4-[015])/, `${model} is retired or deprecated`);
  }
});

test("saved Claude models migrate off retired and dated ids", () => {
  assert.equal(migrateClaudeModel("claude-opus-4-1-20250805"), "");
  assert.equal(migrateClaudeModel("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
  // Still-served ids and free-form custom values are left alone.
  assert.equal(migrateClaudeModel("claude-opus-4-7"), "claude-opus-4-7");
  assert.equal(migrateClaudeModel("deepseek-chat"), "deepseek-chat");
  assert.equal(migrateClaudeModel(""), "");
  // Every migration target is either the default or an offered preset.
  for (const target of Object.values(CLAUDE_MODEL_MIGRATIONS)) {
    assert.ok(presetValues.includes(target), `migration target ${target} not offered`);
  }
});
