const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("main chat executes a remember directive only once per turn", { skip: (() => { try { require.resolve("electron"); return false; } catch { return true; } })() }, (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "prts-directive-test-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));

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
  t.after(() => {
    if (previousElectron) require.cache[electronPath] = previousElectron;
    else delete require.cache[electronPath];
  });

  const chat = require("../src/main/chat");
  const persona = require("../src/main/persona");
  const remembered = [];
  persona.appendMemoryEntry = (text) => remembered.push(text);

  assert.equal(chat.consumeDirectives("你好 [[remember:博士喜欢安静]]"), "你好 ");
  assert.equal(chat.stripDirectiveTags("你好 [[remember:博士喜欢安静]]"), "你好");
  assert.deepEqual(remembered, ["博士喜欢安静"]);

  assert.equal(chat.consumeDirectives("等等 [[mood："), "等等 ");
  assert.equal(chat.consumeDirectives("sad]] 博士"), " 博士");
});
