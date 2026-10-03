const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// renderer.js is a browser script (no exports), and the VS Code copy in
// vscode-extension/media/ is hand-patched rather than regenerated. These tests
// lift the Apply-button helpers out of both copies by name, check the copies
// agree, and run the pure parts in a vm.

const ROOT = path.resolve(__dirname, "..");
const COPIES = {
  tray: path.join(ROOT, "src/renderer/renderer.js"),
  vscode: path.join(ROOT, "vscode-extension/media/renderer.js")
};

// Source of `function name(...) { ... }` (or `const name = { ... };`), found
// by brace matching. The lifted snippets only contain balanced braces.
function lift(source, header) {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `missing: ${header}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced: ${header}`);
}

const HELPERS = [
  "function canApplyFix(",
  "function applyTargetsFor(",
  "function labelApplyButton(",
  "function attachApplyButtons("
];

function load(file, chatApi) {
  const src = fs.readFileSync(file, "utf8");
  const code = [
    lift(src, "const RENDERER_TEXT = ") + ";",
    lift(src, "function escapeHtml("),
    lift(src, "function inlineMd("),
    lift(src, "function renderMarkdown("),
    ...HELPERS.map((h) => lift(src, h)),
    "globalThis.__api = { RENDERER_TEXT, renderMarkdown, canApplyFix, applyTargetsFor };"
  ].join("\n");
  const ctx = { window: { chatApi } };
  vm.runInNewContext(code, ctx);
  return { src, api: ctx.__api };
}

const HISTORY = [
  { id: "u1", role: "user", text: "a", context: { activeFile: "/ws/a.js" } },
  { id: "a1", role: "assistant", text: "```js\nconst a = 1;\n```" },
  { id: "t1", role: "tool", name: "Read" },
  { id: "u2", role: "user", text: "b", context: { activeFile: "C:\\ws\\b.js" } },
  { id: "a2", role: "assistant", text: "```js\nconst b = 2;\n```" },
  { id: "u3", role: "user", text: "no editor open" },
  { id: "a3", role: "assistant", text: "```\nplain\n```" },
  { id: "u4", role: "user", text: "unsaved buffer", context: { activeFile: "Untitled-1" } },
  { id: "a4", role: "assistant", text: "```\nx\n```" },
  { id: "u5", role: "user", text: "unc", context: { activeFile: "\\\\srv\\share\\c.ts" } },
  { id: "a5", role: "assistant", text: "```\ny\n```" }
];

test("the tray and VS Code renderer copies carry identical Apply helpers", () => {
  const tray = fs.readFileSync(COPIES.tray, "utf8");
  const vscode = fs.readFileSync(COPIES.vscode, "utf8");
  for (const header of HELPERS) {
    assert.equal(lift(vscode, header), lift(tray, header), `${header} drifted between copies`);
  }
});

for (const [name, file] of Object.entries(COPIES)) {
  test(`${name}: each reply is bound to its own turn's file`, () => {
    const { api } = load(file, { applyFix() {} });
    const targets = api.applyTargetsFor(HISTORY);
    // Rebuild the entries in this realm: vm arrays have a foreign prototype.
    const entries = Array.from(targets, ([id, target]) => [id, target]);
    assert.deepEqual(entries, [
      ["a1", "/ws/a.js"],
      ["a2", "C:\\ws\\b.js"],
      ["a5", "\\\\srv\\share\\c.ts"]
    ]);
  });

  test(`${name}: no Apply targets where the host has no applyFix (tray preload)`, () => {
    const { api } = load(file, { send() {} });
    assert.equal(api.canApplyFix(), false);
    assert.equal(api.applyTargetsFor(HISTORY).size, 0);
  });

  test(`${name}: markdown carries no hard-coded Apply button; label is localised`, () => {
    const { src, api } = load(file, { applyFix() {} });
    const html = api.renderMarkdown("```js\nconst x = 1;\n```");
    assert.match(html, /class="code-block-wrapper"/);
    assert.doesNotMatch(html, /apply-fix-btn/);
    assert.doesNotMatch(src, />Apply</);
    assert.equal(api.RENDERER_TEXT.zh.apply_fix, "对比");
    assert.equal(api.RENDERER_TEXT.en.apply_fix, "Diff");
    assert.match(api.RENDERER_TEXT.zh.apply_fix_title("b.js"), /b\.js/);
    assert.match(api.RENDERER_TEXT.en.apply_fix_title("b.js"), /b\.js/);
  });
}
