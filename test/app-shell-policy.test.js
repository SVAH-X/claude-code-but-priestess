const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  autoScreenshotMenuVisible,
  shouldNotify,
  isAttachmentPathAllowed,
  shouldRequestSingleInstanceLock,
  shouldCollapsePopoverOnVscodeDisconnect,
  wrapHtmlForBrowser
} = require("../src/main/app-shell-policy");

// Pins the pure shell decisions main.js delegates to (no electron needed):
// tray menu visibility, the notification routing table, the attachment
// allowlist, the dev single-instance lock and the VS Code disconnect collapse.

test("auto-screenshot tray toggle follows vibeCodingMode, not the deleted agentMode key", () => {
  // settings.js deletes agentMode on load, so the old gate was never true.
  assert.equal(autoScreenshotMenuVisible({ vibeCodingMode: "agent" }), true);
  assert.equal(autoScreenshotMenuVisible({ vibeCodingMode: "agent", agentMode: false }), true);
  assert.equal(autoScreenshotMenuVisible({ vibeCodingMode: "advisor" }), false);
  assert.equal(autoScreenshotMenuVisible({ vibeCodingMode: "companion" }), false);
  assert.equal(autoScreenshotMenuVisible({}), false);
  assert.equal(autoScreenshotMenuVisible(null), false);
});

test("notification routing table", () => {
  const table = [
    // kind      vscodeActive popoverFocused expected
    ["waifu",    false,       false,         true],
    ["waifu",    true,        false,         true],  // 老婆模式 remark still reaches the Doctor in VS Code
    ["waifu",    false,       true,          false], // already looking at the chat
    ["waifu",    true,        true,          false],
    ["done",     false,       false,         true],
    ["done",     true,        false,         true],  // long-turn done notification survives VS Code
    ["done",     true,        true,          false],
    ["editor",   false,       false,         true],
    ["editor",   true,        false,         false], // editor-context checks stay quiet in VS Code
    ["editor",   true,        true,          false]
  ];
  for (const [kind, vscodeActive, popoverFocused, expected] of table) {
    assert.equal(
      shouldNotify(kind, { vscodeActive, popoverFocused }),
      expected,
      `${kind} vscodeActive=${vscodeActive} popoverFocused=${popoverFocused}`
    );
  }
  assert.equal(shouldNotify("unknown", {}), false);
});

test("attachment allowlist: roots, then anything the Doctor attached himself", () => {
  const roots = ["/Users/doc", "/Users/doc/project", "/tmp"];
  const attachments = ["/Volumes/USB/shot.png", "/Users/other/notes.txt"];
  const opts = { roots, attachments, pathModule: path.posix, caseInsensitive: false };
  assert.equal(isAttachmentPathAllowed("/Users/doc/Pictures/a.png", opts), true);
  assert.equal(isAttachmentPathAllowed("/Users/doc", opts), true);
  assert.equal(isAttachmentPathAllowed("/tmp/x.png", opts), true);
  assert.equal(isAttachmentPathAllowed("/Users/doctor/a.png", opts), false, "prefix of a root is not under it");
  // Attached from outside every root: previewable/openable because he picked it.
  assert.equal(isAttachmentPathAllowed("/Volumes/USB/shot.png", opts), true);
  assert.equal(isAttachmentPathAllowed("/Volumes/USB/../USB/shot.png", opts), true, "compared after resolve");
  assert.equal(isAttachmentPathAllowed("/Volumes/USB/other.png", opts), false, "siblings of an attachment stay blocked");
  assert.equal(isAttachmentPathAllowed("/Users/other/notes.txt", opts), true);
  assert.equal(isAttachmentPathAllowed("/Users/other/.ssh/id_rsa", opts), false);
  assert.equal(isAttachmentPathAllowed("", opts), false);
  assert.equal(isAttachmentPathAllowed(null, opts), false);
  assert.equal(isAttachmentPathAllowed("/Users/doc/a.png", { roots: [], attachments: [], pathModule: path.posix }), false);
});

test("attachment allowlist on Windows: backslashes, drive letters, case-insensitive", () => {
  const opts = {
    roots: ["C:\\Users\\Doc", "C:\\Users\\Doc\\AppData\\Local\\Temp", "C:\\"],
    attachments: ["D:\\Shots\\Cap.PNG"],
    pathModule: path.win32,
    caseInsensitive: true
  };
  assert.equal(isAttachmentPathAllowed("c:\\users\\doc\\Pictures\\x.png", opts), true);
  assert.equal(isAttachmentPathAllowed("C:/Users/Doc/x.png", opts), true, "forward slashes resolve too");
  assert.equal(isAttachmentPathAllowed("C:\\Windows\\notepad.exe", opts), true, "root ending with a separator (drive root)");
  assert.equal(isAttachmentPathAllowed("d:/shots/cap.png", opts), true, "attachment matched case-insensitively");
  assert.equal(isAttachmentPathAllowed("D:\\Shots\\other.png", opts), false);
  assert.equal(isAttachmentPathAllowed("E:\\x.png", opts), false);
});

test("single-instance lock is skipped for dev runs only", () => {
  assert.equal(shouldRequestSingleInstanceLock({ defaultApp: false, env: {} }), true);
  assert.equal(shouldRequestSingleInstanceLock({ defaultApp: true, env: {} }), false, "npm run dev (electron <dir>)");
  assert.equal(shouldRequestSingleInstanceLock({ defaultApp: false, env: { PRTS_DEV: "1" } }), false);
  assert.equal(shouldRequestSingleInstanceLock({ defaultApp: false, env: { PRTS_DEV: "true" } }), false);
  assert.equal(shouldRequestSingleInstanceLock({ defaultApp: false, env: { PRTS_DEV: "0" } }), true);
  assert.equal(shouldRequestSingleInstanceLock({ defaultApp: false, env: { PRTS_DEV: "" } }), true);
  assert.equal(shouldRequestSingleInstanceLock(), true);
});

test("VS Code disconnect collapses the popover only when it was opened during VS Code and is idle", () => {
  assert.equal(shouldCollapsePopoverOnVscodeDisconnect({ openedDuringVscode: true }), true);
  assert.equal(shouldCollapsePopoverOnVscodeDisconnect({ openedDuringVscode: true, turnRunning: true }), false, "mid-reply");
  assert.equal(shouldCollapsePopoverOnVscodeDisconnect({ openedDuringVscode: true, focused: true }), false, "the Doctor is typing");
  assert.equal(shouldCollapsePopoverOnVscodeDisconnect({ openedDuringVscode: false }), false);
  assert.equal(shouldCollapsePopoverOnVscodeDisconnect(), false);
});

test("open in browser writes the HTML without a forced CSP", () => {
  const fragment = '<script src="https://cdn.example/x.js"></script><div id="app"></div>';
  const wrapped = wrapHtmlForBrowser(fragment);
  assert.ok(!/Content-Security-Policy/i.test(wrapped));
  assert.ok(wrapped.includes(fragment));
  assert.ok(/^<!doctype html>/i.test(wrapped));
  assert.ok(/<meta charset="utf-8">/.test(wrapped), "fragments get a charset so Chinese text renders");
  const full = "<!DOCTYPE html>\n<html><head><title>x</title></head><body>hi</body></html>";
  assert.equal(wrapHtmlForBrowser(full), full, "a full document is written as-is");
  const noDoctype = "<html><body>hi</body></html>";
  assert.equal(wrapHtmlForBrowser(noDoctype), noDoctype);
});

// chat.js is loaded against a stub electron (same pattern as chat-directives.test.js).
test("proactive prompt never claims a screenshot that was not taken", { skip: (() => { try { require.resolve("electron"); return false; } catch { return true; } })() }, (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "prts-shell-test-"));
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
  const diag = { errors: 2, warnings: 0, totalFilesWithProblems: 1, details: [] };
  const withShot = chat.buildVibeProactivePrompt({ diagnosticContext: diag }, { screenshot: true });
  assert.match(withShot, /截图/);
  assert.match(withShot, /2 个错误/);
  const textOnly = chat.buildVibeProactivePrompt({ diagnosticContext: diag }, { screenshot: false });
  assert.doesNotMatch(textOnly, /屏幕（截图/);
  assert.doesNotMatch(textOnly, /observe:/, "the observation journal is a 老婆模式 feature");
  assert.match(textOnly, /没有屏幕截图/);
  assert.match(textOnly, /2 个错误/, "the editor context still arrives");
  assert.match(textOnly, /\[\[silent\]\]/);
  const terminal = chat.buildVibeProactivePrompt(
    { terminalEvent: { kind: "test-fail", command: "npm test", exitCode: 1 } },
    { screenshot: false }
  );
  assert.doesNotMatch(terminal, /屏幕（截图/);
  assert.match(terminal, /npm test/);
});
