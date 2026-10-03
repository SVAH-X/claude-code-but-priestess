const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// renderer.js is a browser script (no exports), and the VS Code copy in
// vscode-extension/media/ is hand-patched rather than regenerated. These tests
// lift the composer / drop / bubble / mode-badge code out of both copies by
// name, check the copies agree, and drive it against a tiny fake DOM in a vm.

const ROOT = path.resolve(__dirname, "..");
// Values built inside the vm come from another realm; compare structure, not prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));
const COPIES = {
  tray: path.join(ROOT, "src/renderer/renderer.js"),
  vscode: path.join(ROOT, "vscode-extension/media/renderer.js")
};

// Source of `function name(...) { ... }` (or `const name = { ... };`, or a
// `window.addEventListener("x", (event) => { ... }` listener), found by brace
// matching. The lifted snippets only contain balanced braces.
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

const SNIPPETS = [
  "const RENDERER_TEXT = ",
  "function _l10nLang(",
  "function t(",
  "function renderAttachmentList(",
  "function buildMsgEl(",
  "function dragHasFiles(",
  'window.addEventListener("dragover", (event) => ',
  'window.addEventListener("drop", (event) => ',
  "function checkComposerDraft(",
  'composer.addEventListener("submit", async (event) => ',
  "function vibeModeLabel(",
  "function refreshComposerMeta("
];

function fakeEl(tag) {
  const classes = new Set();
  return {
    tag,
    children: [],
    dataset: {},
    style: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c)
    },
    addEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    append(...nodes) { this.children.push(...nodes); }
  };
}

function load(file) {
  const src = fs.readFileSync(file, "utf8");
  const max = /const MAX_USER_MESSAGE_CHARS = ([0-9_]+);/.exec(src);
  assert.ok(max, "renderer declares MAX_USER_MESSAGE_CHARS");
  const code = [
    // State the lifted code reads or assigns.
    "let lastSettingsPayload = null;",
    "let chatRunning = false; let currentAssistantId = null; let backendReady = false;",
    "let queueLength = 0; let pendingAttachments = [];",
    "const typingState = new Map(); const toolExpanded = new Set();",
    "const attachmentImageCache = new Map();",
    "const MOOD_FRAME = {}; const state = { mood: 'idle' };",
    "function appendBubbleTime() {} function renderThinkingBubble() {}",
    "function renderMarkdownCached(m) { return m.text; } function attachApplyButtons() {}",
    "function openLightbox() {} function autosizeInput() {} function flashPunch() {}",
    "function resetInactivityTimers() {} function renderExpression() {}",
    "function clearAttachments() { pendingAttachments = []; }",
    "function addAttachments(paths) { __calls.attach.push(paths); }",
    "function showBubble(text) { __calls.bubble.push(text); }",
    `const MAX_USER_MESSAGE_CHARS = ${max[1]};`,
    ...SNIPPETS.map((h) => lift(src, h) + (h.startsWith("function") || h.startsWith("const") ? "" : ");")),
    "globalThis.__api = { RENDERER_TEXT, MAX_USER_MESSAGE_CHARS, checkComposerDraft, buildMsgEl,",
    "  dragHasFiles, vibeModeLabel, refreshComposerMeta,",
    "  setPayload(p) { lastSettingsPayload = p; } };"
  ].join("\n");
  const listeners = {};
  const calls = { attach: [], bubble: [], send: [] };
  const composerInput = { value: "", placeholder: "", focus() {} };
  const ctx = {
    __calls: calls,
    console,
    Promise,
    setTimeout: () => 0,
    navigator: { language: "zh-CN" },
    document: { body: fakeEl("body"), createElement: fakeEl },
    window: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      chatApi: {
        getPathForFile: (f) => f.path,
        attachmentDataUri: () => null,
        send: async (text, files) => { calls.send.push({ text, files }); return { ok: true }; }
      }
    },
    composer: { addEventListener: (type, fn) => { listeners[type] = fn; } },
    composerInput,
    cwdLine: {},
    providerBadge: {},
    versionBadge: {},
    agentBadge: { hidden: true, style: {} },
    sendBtn: {}
  };
  vm.runInNewContext(code, ctx);
  return { src, api: ctx.__api, listeners, calls, els: { composerInput, agentBadge: ctx.agentBadge, cwdLine: ctx.cwdLine } };
}

test("the tray and VS Code renderer copies agree on the lifted code", () => {
  const tray = fs.readFileSync(COPIES.tray, "utf8");
  const vscode = fs.readFileSync(COPIES.vscode, "utf8");
  for (const header of SNIPPETS) {
    assert.equal(lift(vscode, header), lift(tray, header), `${header} drifted between copies`);
  }
});

for (const [name, file] of Object.entries(COPIES)) {
  test(`[${name}] user bubbles render their attachments (R1)`, () => {
    const { api } = load(file);
    const el = api.buildMsgEl({ id: "u1", role: "user", text: "看看", attachments: ["/pics/a.png", "C:\\docs\\b.txt"] });
    assert.equal(el.className, "msg user");
    const list = el.children.find((c) => c.className === "msg-attachments");
    assert.ok(list, "user bubble has an attachment list");
    assert.deepEqual(list.children.map((c) => c.className), ["msg-attachment image", "msg-attachment file"]);
    assert.equal(list.children[1].textContent, "b.txt");
    const bare = api.buildMsgEl({ id: "u2", role: "user", text: "hi" });
    assert.equal(bare.children.find((c) => c.className === "msg-attachments"), undefined);
  });

  test(`[${name}] context badge selection text is localized (R4)`, () => {
    const { api } = load(file);
    const msg = {
      id: "u1", role: "user", text: "x",
      context: { activeFile: "C:\\ws\\a.ts", activeFileLanguage: "ts", cursorLine: 4, selection: { startLine: 3, endLine: 5 } }
    };
    const zh = api.buildMsgEl(msg).children.find((c) => c.className === "context-badge");
    assert.equal(zh.textContent, "📄 a.ts · ts · L4 · 已选中 L3-5");
    api.setPayload({ menuLanguage: "en" });
    const en = api.buildMsgEl(msg).children.find((c) => c.className === "context-badge");
    assert.equal(en.textContent, "📄 a.ts · ts · L4 · selected L3-5");
  });

  test(`[${name}] only file drops are intercepted; text drops reach the composer (R2)`, () => {
    const { listeners, calls } = load(file);
    const drop = (types, files) => {
      let prevented = false;
      listeners.drop({ dataTransfer: { types, files }, preventDefault: () => { prevented = true; } });
      return prevented;
    };
    assert.equal(drop(["text/plain"], []), false, "a text drop is left to the browser");
    assert.deepEqual(calls.attach, []);
    assert.equal(drop(["Files"], [{ path: "/x/a.png" }, { path: "" }]), true, "a file drop is ours");
    assert.deepEqual(plain(calls.attach), [["/x/a.png"]]);
    let prevented = false;
    listeners.dragover({ dataTransfer: { types: ["text/uri-list"] }, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, false, "a text drag is not accepted window-wide");
  });

  test(`[${name}] an over-long draft is refused before the composer is cleared (R3)`, async () => {
    const { api, listeners, calls, els } = load(file);
    const chatJs = fs.readFileSync(path.join(ROOT, "src/main/chat.js"), "utf8");
    const mainMax = /const MAX_USER_MESSAGE_CHARS = ([0-9_]+);/.exec(chatJs);
    assert.equal(api.MAX_USER_MESSAGE_CHARS, Number(mainMax[1].replace(/_/g, "")), "renderer limit mirrors chat.js");
    const max = api.MAX_USER_MESSAGE_CHARS;
    const check = (text, files) => plain(api.checkComposerDraft(text, files));
    assert.deepEqual(check("", 0), { ok: false, reason: "empty" });
    assert.deepEqual(check("", 1), { ok: true });
    assert.deepEqual(check("x".repeat(max), 0), { ok: true });
    assert.deepEqual(check("x".repeat(max + 1), 0), { ok: false, reason: "too-long" });

    const long = "字".repeat(max + 1);
    els.composerInput.value = long;
    await listeners.submit({ preventDefault() {} });
    assert.equal(els.composerInput.value, long, "the draft is kept");
    assert.deepEqual(calls.send, [], "nothing was sent");
    assert.deepEqual(calls.bubble, [`消息太长了（上限 ${max} 字），请精简后再发送。`]);

    els.composerInput.value = " ok ";
    await listeners.submit({ preventDefault() {} });
    assert.equal(els.composerInput.value, "", "a valid draft is cleared on send");
    assert.deepEqual(plain(calls.send), [{ text: "ok", files: [] }]);
  });

  test(`[${name}] the agent warning badge shows only in agent mode, via t() (R4)`, () => {
    const { api, els } = load(file);
    const run = (payload) => { api.setPayload(payload); api.refreshComposerMeta(); };
    run({ vibeCodingMode: "companion", chatCwd: "/ws" });
    assert.equal(els.agentBadge.hidden, true);
    assert.match(els.cwdLine.textContent, / · 陪伴$/);
    run({ vibeCodingMode: "advisor", chatCwd: "/ws" });
    assert.equal(els.agentBadge.hidden, true);
    assert.match(els.cwdLine.textContent, / · 顾问$/);
    run({ vibeCodingMode: "agent", chatCwd: "/ws" });
    assert.equal(els.agentBadge.hidden, false);
    assert.equal(els.agentBadge.textContent, api.RENDERER_TEXT.zh.badge_agent);
    assert.equal(els.agentBadge.style.color, undefined, "the .agent-badge warning colour is not overridden inline");
    run({ vibeCodingMode: "agent", menuLanguage: "en" });
    assert.equal(els.agentBadge.textContent, "⚡ agent");
    assert.match(els.cwdLine.textContent, / · agent$/);
    assert.equal(api.vibeModeLabel("companion"), "companion");
  });
}
