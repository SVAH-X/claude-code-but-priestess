const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// VS Code editor context is captured without the Doctor asking, so a
// blacklisted active file must not reach the model — and the Doctor is told.
// Text he explicitly sends is untouched. buildProviderInvocation is stubbed to
// record the message and run a no-op CLI.

function installModuleStub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  const previous = require.cache[resolved];
  const stub = new Module(resolved);
  stub.filename = resolved;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[resolved] = stub;
  return () => {
    if (previous) require.cache[resolved] = previous;
    else delete require.cache[resolved];
  };
}

function writeNoopCli(binDir) {
  const js = path.join(binDir, "noop-cli.js");
  fs.writeFileSync(js, "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));\n", "utf8");
  if (process.platform === "win32") {
    const cmd = path.join(binDir, "noop.cmd");
    fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "%~dp0noop-cli.js" %*\r\n`, "utf8");
    return cmd;
  }
  const sh = path.join(binDir, "noop");
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/noop-cli.js" "$@"\n`, "utf8");
  fs.chmodSync(sh, 0o755);
  return sh;
}

async function waitFor(cond, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("blacklisted active-file context is dropped with a notice; other context passes", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prts-vsctx-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const electronMock = {
    app: { getPath: () => tmp },
    shell: { openExternal: async () => {}, openPath: async () => {} },
    Notification: class { show() {} },
  };
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") return electronMock;
    return originalLoad.apply(this, arguments);
  };
  t.after(() => { Module._load = originalLoad; });

  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const noop = writeNoopCli(binDir);
  const messages = [];
  const restoreChat = installModuleStub("../src/main/chat", {
    getProviderAvailability: () => ({ activeProvider: "claude", providers: {} }),
    buildProviderInvocation: (_provider, message) => {
      messages.push(message);
      return { command: noop, args: [], stdin: "x\n" };
    },
  });
  t.after(restoreChat);
  for (const mod of ["../src/main/vscode-chat", "../src/main/ws-server"]) {
    delete require.cache[require.resolve(mod)];
  }
  t.after(() => {
    for (const mod of ["../src/main/vscode-chat", "../src/main/ws-server"]) {
      delete require.cache[require.resolve(mod)];
    }
  });
  const vscodeChat = require("../src/main/vscode-chat");

  const ws = path.join(tmp, "ws");
  vscodeChat.send("这里写得对吗？", {
    activeFile: path.join(ws, "config", ".env.local"),
    activeFileLanguage: "dotenv",
    cursorLine: 2,
    cursorColumn: 1,
    selection: { text: "STRIPE_KEY=sk_live_abc", startLine: 2, endLine: 2 },
  });
  await waitFor(() => !vscodeChat.isBusy());
  assert.equal(messages.length, 1);
  assert.ok(!messages[0].includes("sk_live_abc"), "selection from a blacklisted file is not sent");
  assert.ok(!messages[0].includes(".env.local"), "nor its file name");
  assert.ok(messages[0].includes("这里写得对吗？"), "the Doctor's own words still go through");
  const notice = vscodeChat.getHistory().find((e) => e.role === "system" && e.text.includes("文件黑名单"));
  assert.ok(notice && notice.text.includes(".env.local"), "the Doctor is told why");

  vscodeChat.send("解释一下", {
    activeFile: path.join(ws, "src", "app.ts"),
    activeFileLanguage: "typescript",
    cursorLine: 1,
    cursorColumn: 1,
    selection: { text: "const answer = 42;", startLine: 1, endLine: 1 },
  });
  await waitFor(() => messages.length === 2 && !vscodeChat.isBusy());
  assert.ok(messages[1].includes("const answer = 42;"), "ordinary context is attached");
  assert.ok(messages[1].includes("app.ts"));

  // B3: a folder name above the file (here "design-tokens") decides nothing.
  vscodeChat.send("这个导出对吗？", {
    activeFile: path.join(tmp, "code", "design-tokens", "src", "index.ts"),
    activeFileLanguage: "typescript",
    cursorLine: 1,
    cursorColumn: 1,
    selection: { text: "export const spacing = 4;", startLine: 1, endLine: 1 },
  });
  await waitFor(() => messages.length === 3 && !vscodeChat.isBusy());
  assert.ok(messages[2].includes("export const spacing = 4;"), "context from design-tokens/ is attached");
  assert.equal(
    vscodeChat.getHistory().filter((e) => e.role === "system" && e.text.includes("文件黑名单")).length,
    1,
    "only the .env.local turn raised a notice"
  );
});
