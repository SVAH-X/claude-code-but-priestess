const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// chat.js directive handling behind a fake electron (a devDependency, absent
// on CI). The fake is installed once for the whole file: chat.js stays in the
// require cache across these tests, so its userData must outlive them all.
const SKIP = { skip: (() => { try { require.resolve("electron"); return false; } catch { return true; } })() };
let loaded = null;

function loadChat() {
  if (loaded) return loaded;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "prts-directive-test-"));
  const electronPath = require.resolve("electron");
  const previousElectron = require.cache[electronPath];
  const fakeElectron = new Module(electronPath);
  fakeElectron.filename = electronPath;
  fakeElectron.loaded = true;
  fakeElectron.exports = {
    app: { getPath: () => userData },
    shell: { openExternal: async () => {}, openPath: async () => {} },
    Notification: class { show() {} },
    net: { fetch: global.fetch }
  };
  require.cache[electronPath] = fakeElectron;
  loaded = {
    chat: require("../src/main/chat"),
    persona: require("../src/main/persona"),
    settings: require("../src/main/settings"),
    restore() {
      if (previousElectron) require.cache[electronPath] = previousElectron;
      else delete require.cache[electronPath];
      fs.rmSync(userData, { recursive: true, force: true });
    }
  };
  return loaded;
}

test.after(() => { if (loaded) loaded.restore(); });

test("main chat executes a remember directive only once per turn", SKIP, () => {
  const { chat, persona } = loadChat();
  const remembered = [];
  persona.appendMemoryEntry = (text) => remembered.push(text);

  assert.equal(chat.consumeDirectives("你好 [[remember:博士喜欢安静]]"), "你好 ");
  assert.equal(chat.stripDirectiveTags("你好 [[remember:博士喜欢安静]]"), "你好");
  assert.deepEqual(remembered, ["博士喜欢安静"]);

  assert.equal(chat.consumeDirectives("等等 [[mood："), "等等 ");
  assert.equal(chat.consumeDirectives("sad]] 博士"), " 博士");
});

test("silent self-turns strip [[remember:]] without writing; real turns cap at three", SKIP, () => {
  const { chat, persona } = loadChat();
  const remembered = [];
  persona.appendMemoryEntry = (text) => remembered.push(text);

  for (const kind of ["proactive", "maintenance"]) {
    chat._beginTurnForTests(kind);
    assert.equal(chat.consumeDirectives("屏幕上…… [[remember:博士在看某个网页]][[silent]]"), "屏幕上…… ");
    assert.equal(chat.stripDirectiveTags("[[remember:博士在看某个网页]]"), "");
  }
  assert.deepEqual(remembered, [], "nothing written on silent turns");

  chat._beginTurnForTests(null);
  assert.equal(
    chat.consumeDirectives("好。[[remember:一]] [[remember:二]] [[remember:三]] [[remember:四]] [[remember:一]]"),
    "好。    "
  );
  assert.deepEqual(remembered, ["一", "二", "三"], "capped per turn, deduped");
});

test("memory maintenance waits for a running VS Code turn", SKIP, (t) => {
  const { chat, settings } = loadChat();
  const vscodePath = require.resolve("../src/main/vscode-chat");
  const previous = require.cache[vscodePath];
  let busy = true;
  const stub = new Module(vscodePath);
  stub.filename = vscodePath;
  stub.loaded = true;
  stub.exports = { isBusy: () => busy };
  require.cache[vscodePath] = stub;
  t.after(() => {
    if (previous) require.cache[vscodePath] = previous;
    else delete require.cache[vscodePath];
  });

  assert.deepEqual(chat.sendMaintenance(), { ok: false, reason: "vscode-busy" });

  // Not busy: the usual gates take over. Route to the built-in backend, which
  // silent turns refuse, so nothing is spawned here.
  settings.set({ chatProvider: "priestess", priestessEnabled: true, priestessBaseUrl: "http://127.0.0.1:1" });
  assert.equal(settings.get("chatProvider"), "priestess");
  assert.equal(settings.get("priestessEnabled"), true);
  chat.refreshProviderAvailability();
  assert.equal(chat.getProviderAvailability().activeProvider, "priestess");
  busy = false;
  assert.deepEqual(chat.sendMaintenance(), { ok: false, reason: "provider" });
});
