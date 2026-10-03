const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Memory-writing rules of the persona prompt and of [[remember:…]] entries:
//   - the 【铭记】 tag is offered on real turns only, never on silent self-turns
//     (a proactive peek must not file the screen as a memory);
//   - companion/advisor turns hold no file tools, so their memory hint points
//     at [[remember:…]]; agent and maintenance turns keep the file-tool wording;
//   - appendMemoryEntry keeps 「近来发生的事」 chronological (newest last — the
//     end that readMemorySnapshot() keeps), writes one line per entry, and a
//     failed atomic write leaves no temp file behind;
//   - the companion popover prompt stays inside its size budget.
//
// electron is intercepted via Module._load (absent on CI); src/main modules
// are purged around each test, as in persona-coding-turn.test.js.

const SRC_MAIN = path.resolve(__dirname, "..", "src", "main") + path.sep;
const REMEMBER_BLOCK = "【铭记】";
const TAG_HINT = "[[remember:…]] 指令记下即可";
const FILE_TOOL_HINT = "用可用的文件编辑工具在 MEMORY.md";
const SILENT_HINT = "不要改动 MEMORY.md";
// Chars, includeLongMemory off, fresh userData: v0.7.6 = 4863, main = 5238.
// Set at main so a new always-on block can't push the popover prompt past it.
const COMPANION_POPOVER_PROMPT_MAX = 5238;

function purgeSrcMain() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_MAIN)) delete require.cache[key];
  }
}

function loadWithFakeElectron(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "prts-persona-memory-"));
  const electronMock = {
    app: { getPath: () => userData, getVersion: () => "0.0.0", isPackaged: false },
    shell: { openExternal: async () => {}, openPath: async () => {} },
    Notification: class { show() {} static isSupported() { return false; } },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    desktopCapturer: { getSources: async () => [] },
    screen: { getPrimaryDisplay: () => ({ size: { width: 1, height: 1 }, scaleFactor: 1 }) },
    systemPreferences: { getMediaAccessStatus: () => "granted" },
    net: { fetch: global.fetch },
  };
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") return electronMock;
    return originalLoad.apply(this, arguments);
  };
  purgeSrcMain();
  t.after(() => {
    Module._load = originalLoad;
    purgeSrcMain();
    fs.rmSync(userData, { recursive: true, force: true });
  });
  return { userData, persona: require("../src/main/persona") };
}

function prompt(persona, overrides = {}) {
  return persona.buildPersonaPrompt({
    vibeCodingMode: "companion",
    provider: "claude",
    includeLongMemory: false,
    coauthorCommits: true,
    ...overrides,
  });
}

test("remember tag: real turns get it, silent turns write nothing", (t) => {
  const { persona } = loadWithFakeElectron(t);

  for (const [label, overrides] of [
    ["companion popover", {}],
    ["advisor popover", { vibeCodingMode: "advisor" }],
    ["VS Code companion", { vscodeTurn: true }],
    ["VS Code advisor", { vibeCodingMode: "advisor", vscodeTurn: true }],
  ]) {
    const p = prompt(persona, overrides);
    assert.ok(p.includes(REMEMBER_BLOCK), `${label} offers the tag`);
    assert.ok(p.includes(TAG_HINT), `${label} is pointed at the tag`);
    assert.ok(!p.includes(FILE_TOOL_HINT), `${label} has no file tools to edit MEMORY.md with`);
  }

  const agent = prompt(persona, { vibeCodingMode: "agent" });
  assert.ok(agent.includes(REMEMBER_BLOCK) && agent.includes(FILE_TOOL_HINT) && !agent.includes(TAG_HINT), "agent keeps file-tool wording");

  for (const mode of ["companion", "advisor", "agent"]) {
    const silent = prompt(persona, { vibeCodingMode: mode, silentTurn: true, coauthorCommits: false });
    assert.ok(!silent.includes(REMEMBER_BLOCK), `silent ${mode} turn has no 铭记 block`);
    assert.ok(!silent.includes("[[remember:"), `silent ${mode} turn never sees the tag`);
    assert.ok(silent.includes(SILENT_HINT), `silent ${mode} turn is told not to write`);
  }
  const maintenance = prompt(persona, { vibeCodingMode: "maintenance", silentTurn: true, coauthorCommits: false });
  assert.ok(!maintenance.includes("[[remember:"), "maintenance never sees the tag");
  assert.ok(maintenance.includes(FILE_TOOL_HINT), "maintenance curates with file tools");

  const priestess = prompt(persona, { provider: "priestess" });
  assert.ok(priestess.includes("这条通道没有文件工具"), "built-in backend wording unchanged");
});

test("insertMemoryEntry: end of 「近来发生的事」, else end of file", (t) => {
  const { persona } = loadWithFakeElectron(t);
  const { insertMemoryEntry } = persona;
  const H = "## 近来发生的事";
  assert.equal(insertMemoryEntry("", "- x"), "- x\n");
  assert.equal(insertMemoryEntry("# 记忆", "- x"), "# 记忆\n- x\n");
  assert.equal(insertMemoryEntry("# 记忆\n", "- x"), "# 记忆\n- x\n");
  assert.equal(insertMemoryEntry(H, "- x"), `${H}\n- x\n`);
  assert.equal(insertMemoryEntry(`${H}\n- a\n`, "- b"), `${H}\n- a\n- b\n`);
  // Fresh template: the entry lands before the blank line that precedes the next heading.
  assert.equal(insertMemoryEntry(`${H}\n\n## 喜好\n\n`, "- b"), `${H}\n- b\n\n## 喜好\n\n`);
  assert.equal(insertMemoryEntry(`${H}\n- a\n\n## 喜好\n- c\n`, "- b"), `${H}\n- a\n- b\n\n## 喜好\n- c\n`);
  // A file re-saved with CRLF line endings (Windows editors) still gets a clean line.
  assert.equal(insertMemoryEntry(`${H}\r\n- a\r\n\r\n## 喜好\r\n`, "- b"), `${H}\r\n- a\n- b\r\n\r\n## 喜好\r\n`);
});

test("appendMemoryEntry: chronological, one line each, atomic", (t) => {
  const { persona } = loadWithFakeElectron(t);
  const file = persona.ensureMemoryFile();
  const dir = path.dirname(file);
  const tmpFiles = () => fs.readdirSync(dir).filter((name) => name.includes(".tmp"));

  assert.equal(persona.appendMemoryEntry("博士喜欢安静"), true);
  assert.equal(persona.appendMemoryEntry("  第二条\n\n## 假章节\n第三行  "), true);
  let content = fs.readFileSync(file, "utf8");
  const section = content.slice(content.indexOf("## 近来发生的事"), content.indexOf("## 博士的喜好与习惯"));
  const lines = section.split("\n").filter(Boolean);
  assert.equal(lines.length, 3, "heading + two entries");
  assert.match(lines[1], /^- \d{4}-\d{2}-\d{2} 博士喜欢安静$/, "first entry stays first");
  assert.match(lines[2], /^- \d{4}-\d{2}-\d{2} 第二条 ## 假章节 第三行$/, "multi-line value collapsed");
  assert.ok(!content.includes("\n## 假章节"), "no fake section");
  assert.ok(section.endsWith("第三行\n\n"), "blank line before the next heading kept");
  assert.ok(content.includes("## 博士的喜好与习惯\n\n## 反复出现的话题\n\n"), "later sections intact");
  assert.deepEqual(tmpFiles(), []);

  assert.equal(persona.appendMemoryEntry(" \n "), false, "blank value writes nothing");
  assert.equal(fs.readFileSync(file, "utf8"), content);

  assert.equal(persona.appendMemoryEntry("长".repeat(400)), true);
  content = fs.readFileSync(file, "utf8");
  assert.ok(content.includes(" " + "长".repeat(300) + "\n") && !content.includes("长".repeat(301)), "entry capped at 300 chars");

  // A failed rename (e.g. EPERM on a locked file on Windows) is logged, keeps
  // the file as it was and leaves no temp file behind.
  const realRename = fs.renameSync;
  const realWarn = console.warn;
  const warnings = [];
  fs.renameSync = () => { const e = new Error("EPERM: locked"); e.code = "EPERM"; throw e; };
  console.warn = (...args) => warnings.push(args);
  try {
    assert.equal(persona.appendMemoryEntry("丢失的一条"), false);
  } finally {
    fs.renameSync = realRename;
    console.warn = realWarn;
  }
  assert.equal(warnings.length, 1);
  assert.equal(fs.readFileSync(file, "utf8"), content, "file untouched");
  assert.deepEqual(tmpFiles(), [], "temp file cleaned up");
});

test("companion popover prompt stays within its size budget", (t) => {
  const { persona } = loadWithFakeElectron(t);
  const companion = prompt(persona);
  assert.ok(
    companion.length <= COMPANION_POPOVER_PROMPT_MAX,
    `companion popover prompt is ${companion.length} chars, budget ${COMPANION_POPOVER_PROMPT_MAX}`
  );
  // Silent turns carry strictly less: no 铭记 block, no coding voice.
  const silent = prompt(persona, { vibeCodingMode: "advisor", silentTurn: true, coauthorCommits: false });
  assert.ok(silent.length < companion.length, "silent turn prompt is smaller than the popover's");
});
