const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Pins two prompt-budget rules:
//   - the coding voice (【编程时的你】) rides only on coding turns: VS Code turns
//     and popover advisor/agent turns the Doctor sent himself. Companion popover
//     chat and silent turns (proactive / maintenance) keep the always-on persona
//     prompt flat;
//   - the write-only per-workspace project notes are gone: no prompt section,
//     no userData/project-notes files.
//
// electron is a devDependency and absent on CI (npm install --omit=dev), so it
// is intercepted via Module._load. src/main modules are purged from the require
// cache before and after, because test/run.js loads every test file into one
// process and other files cache these modules against their own electron fakes.

const SRC_MAIN = path.resolve(__dirname, "..", "src", "main") + path.sep;
const CODING = "【编程时的你】";

function purgeSrcMain() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_MAIN)) delete require.cache[key];
  }
}

function loadWithFakeElectron(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "prts-coding-turn-"));
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
  return { userData };
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

test("isCodingTurn: VS Code and self-sent advisor/agent turns only", (t) => {
  loadWithFakeElectron(t);
  const { isCodingTurn } = require("../src/main/persona");
  const cases = [
    // [mode, vscodeTurn, silentTurn, expected]
    ["companion", false, false, false], // popover chat
    ["advisor", false, false, true],
    ["agent", false, false, true],
    ["companion", true, false, true], // VS Code companion
    ["advisor", true, false, true],
    ["advisor", false, true, false], // proactive check (advisor-forced)
    ["agent", false, true, false], // proactive check, agent mode
    ["maintenance", false, true, false],
    ["maintenance", false, false, false],
    ["advisor", true, true, false], // silent always wins
  ];
  for (const [mode, vscodeTurn, silentTurn, expected] of cases) {
    assert.equal(
      isCodingTurn({ mode, vscodeTurn, silentTurn }),
      expected,
      `mode=${mode} vscode=${vscodeTurn} silent=${silentTurn}`
    );
  }
  assert.equal(isCodingTurn(), false, "defaults = companion popover");
});

test("persona prompt keeps the coding voice off companion and silent turns", (t) => {
  loadWithFakeElectron(t);
  const persona = require("../src/main/persona");

  const companion = prompt(persona);
  assert.ok(!companion.includes(CODING), "companion popover has no coding block");
  assert.ok(!companion.includes("【技术深度的你】"), "old always-on depth block is gone");

  for (const mode of ["advisor", "agent"]) {
    const silent = prompt(persona, {
      vibeCodingMode: mode,
      screenshotPath: path.join(os.tmpdir(), "shot.png"),
      coauthorCommits: false,
      silentTurn: true,
    });
    assert.ok(!silent.includes(CODING), `silent ${mode} turn has no coding block`);
  }
  const maintenance = prompt(persona, { vibeCodingMode: "maintenance", coauthorCommits: false, silentTurn: true });
  assert.ok(!maintenance.includes(CODING), "maintenance turn has no coding block");

  for (const mode of ["advisor", "agent"]) {
    assert.ok(prompt(persona, { vibeCodingMode: mode }).includes(CODING), `popover ${mode} gets it`);
  }
  const vscodeCompanion = prompt(persona, { vscodeTurn: true });
  assert.ok(vscodeCompanion.includes(CODING), "VS Code companion turn gets it");

  // The block is the only difference, and it stays small (it was ~900 chars
  // of always-on text before).
  const added = vscodeCompanion.length - companion.length;
  assert.ok(added > 0 && added <= 300, `coding block costs ${added} chars`);
  assert.equal(vscodeCompanion.replace(/【编程时的你】[\s\S]*?\n\n/, ""), companion);
});

test("project notes: appended per workspace, newest entries read back, VS Code coding turns only", (t) => {
  const { userData } = loadWithFakeElectron(t);
  const persona = require("../src/main/persona");
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "prts-ws-"));
  t.after(() => fs.rmSync(workspacePath, { recursive: true, force: true }));

  assert.equal(persona.readProjectNotes(workspacePath), "", "no file yet");
  assert.ok(!prompt(persona, { vibeCodingMode: "advisor", vscodeTurn: true, workspacePath }).includes("【项目笔记"));

  persona.appendProjectNote(workspacePath, "把登录页改成\n深色主题", "改了 LoginPage.css，## 不是标题");
  const file = persona.projectNotesPath(workspacePath);
  assert.ok(file.startsWith(path.join(userData, "project-notes")));
  const first = fs.readFileSync(file, "utf8");
  assert.match(first, /^# 项目笔记/);
  assert.match(first, /\n- \d{4}-\d{2}-\d{2} \d{2}:\d{2} 博士: 把登录页改成 深色主题\n  - 普瑞赛斯: 改了 LoginPage.css，## 不是标题\n$/);

  // Newest entries win once the budget is exceeded, and the read starts on an
  // entry boundary (the old implementation returned only empty headings here).
  for (let i = 0; i < 60; i += 1) persona.appendProjectNote(workspacePath, `第${i}轮 ` + "x".repeat(150), "y".repeat(100));
  const notes = persona.readProjectNotes(workspacePath);
  assert.ok(notes.length <= 2001, `capped (${notes.length})`);
  assert.ok(notes.startsWith("…\n- "), "starts at an entry boundary after an ellipsis");
  assert.ok(notes.includes("第59轮"), "newest entry present");
  assert.ok(!notes.includes("登录页"), "oldest entry dropped from the prompt");

  // The file itself is pruned from the front, header kept.
  for (let i = 0; i < 300; i += 1) persona.appendProjectNote(workspacePath, "z".repeat(200), "w".repeat(300));
  const pruned = fs.readFileSync(file, "utf8");
  assert.ok(Buffer.byteLength(pruned, "utf8") <= 64 * 1024, "file capped at 64KB");
  assert.match(pruned, /^# 项目笔记/);
  assert.ok(pruned.includes("- 项目路径:"), "header kept");
  assert.ok(/^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} 博士: z/m.test(pruned), "oldest surviving entry is whole");

  // Injected only into VS Code coding turns.
  const vscode = prompt(persona, { vibeCodingMode: "advisor", vscodeTurn: true, workspacePath });
  assert.ok(vscode.includes("【项目笔记") && vscode.includes("博士: zzz"), "newest notes injected");
  assert.ok(!prompt(persona, { vibeCodingMode: "advisor", workspacePath }).includes("【项目笔记"), "popover advisor: no notes");
  assert.ok(!prompt(persona, { vibeCodingMode: "companion", vscodeTurn: true, workspacePath, silentTurn: true }).includes("【项目笔记"), "silent: no notes");
  assert.ok(!prompt(persona, { vibeCodingMode: "advisor", vscodeTurn: true }).includes("【项目笔记"), "no workspace: no notes");
});

test("chat.buildProviderInvocation threads vscodeTurn into the persona prompt", (t) => {
  loadWithFakeElectron(t);
  const chat = require("../src/main/chat");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "prts-coding-cwd-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const systemPrompt = (provider, mode, turnOptions) => {
    const inv = chat.buildProviderInvocation(provider, "看看这个函数", cwd, mode, null, "", null, {}, turnOptions);
    try {
      if (provider === "codex") return inv.stdin;
      const i = inv.args.indexOf("--append-system-prompt-file");
      return i >= 0
        ? fs.readFileSync(inv.args[i + 1], "utf8")
        : inv.args[inv.args.indexOf("--append-system-prompt") + 1];
    } finally {
      for (const dir of inv.cleanupDirs || []) fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  for (const provider of ["claude", "codex"]) {
    assert.ok(!systemPrompt(provider, "companion").includes(CODING), `${provider}: popover companion`);
    assert.ok(!systemPrompt(provider, "companion", null).includes(CODING), `${provider}: null options`);
    assert.ok(systemPrompt(provider, "advisor").includes(CODING), `${provider}: popover advisor`);
    assert.ok(systemPrompt(provider, "companion", { vscodeTurn: true }).includes(CODING), `${provider}: VS Code companion`);
    assert.ok(systemPrompt(provider, "advisor", { vscodeTurn: true }).includes(CODING), `${provider}: VS Code advisor`);
  }
});
