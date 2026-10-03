const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const sync = require("../scripts/sync-vscode-assets.js");

const MEDIA = ["media/renderer.js", "media/pet.js", "media/styles.css", "media/pet.css"];
const SPRITE_DIRS = ["", "casual", "普猫猫"];

// Windows checkouts without .gitattributes carry CRLF in every text file, and
// the sync normalizes the scripts it patches to LF; compare content, not EOLs.
const text = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const pngs = (dir) => fs.readdirSync(dir).filter((n) => /\.png$/i.test(n)).sort();

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prts-sync-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("vscode:sync reproduces the committed vscode-extension media and sprites exactly", () => {
  withTempDir((target) => {
    sync.sync({ target, log() {} });
    for (const rel of MEDIA) {
      assert.equal(text(path.join(target, rel)), text(path.join(ROOT, "vscode-extension", rel)),
        `${rel}: the sync output and the committed copy differ — mirror the change on both sides`);
    }
    for (const sub of SPRITE_DIRS) {
      assert.deepEqual(pngs(path.join(target, "assets/character", sub)),
        pngs(path.join(ROOT, "vscode-extension/assets/character", sub)), `assets/character/${sub}`);
    }
  });
});

test("webview patch steps fail loudly instead of silently shipping an unpatched renderer", () => {
  const tray = fs.readFileSync(path.join(ROOT, "src/renderer/renderer.js"), "utf8").replace(/\r\n/g, "\n");
  const patched = sync.applyWebviewPatches(tray, "media/renderer.js");
  assert.notEqual(patched, tray);
  assert.throws(() => sync.applyWebviewPatches("function loadFrame() {}", "x.js"), /anchor for "tainted-canvas guard[^"]*" found 0 times/);
  assert.throws(() => sync.applyWebviewPatches(patched, "x.js"), /found 0 times/, "patching twice is refused");
  assert.throws(() => sync.renameFrameReferences("no frames here", "x.js"), /no character filename/);
});

test("scratch PNGs excluded by package.json build.files stay out of the extension", () => {
  const negations = sync.buildFileNegations(ROOT);
  assert.ok(negations.includes("assets/character/new*.png"), "package.json still excludes new*.png");
  const excluded = sync.buildFileExcluder(negations);
  for (const rel of [
    "assets/character/new1.png",
    "assets/character/newface.PNG".replace("PNG", "png"),
    "assets/character/Nano Banana Workspace Image.png",
    "assets/character/casual-src/闭眼.png"
  ]) assert.equal(excluded(rel), true, `${rel} is scratch`);
  for (const rel of [
    "assets/character/睁眼.png",
    "assets/character/casual/睁眼.png",
    "assets/character/普猫猫/普猫猫.png",
    "assets/character/icon.png"
  ]) assert.equal(excluded(rel), false, `${rel} ships`);
  // Glob translation treats dots literally and `*` as "within one segment".
  assert.equal(sync.globToRegex("a/new*.png").test("a/newXpng"), false);
  assert.equal(sync.globToRegex("a/new*.png").test("a/new/x.png"), false);
});

test("the sync copies shipped sprites (renamed) and skips scratch ones", () => {
  withTempDir((tmp) => {
    const root = path.join(tmp, "root");
    const target = path.join(tmp, "ext");
    for (const rel of ["renderer.js", "desktop-pet.js", "styles.css", "desktop-pet.css"]) {
      fs.mkdirSync(path.join(root, "src/renderer"), { recursive: true });
      fs.copyFileSync(path.join(ROOT, "src/renderer", rel), path.join(root, "src/renderer", rel));
    }
    fs.mkdirSync(path.join(root, "assets/character"), { recursive: true });
    for (const name of ["睁眼.png", "new1.png", "Nano Banana Workspace Image.png"]) {
      fs.writeFileSync(path.join(root, "assets/character", name), "png");
    }
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      build: { files: ["!assets/character/new*.png", "!assets/character/Nano Banana Workspace Image.png"] }
    }));
    const log = [];
    sync.sync({ root, target, log: (line) => log.push(line) });
    assert.deepEqual(pngs(path.join(target, "assets/character")), ["idle.png"]);
    assert.ok(log.some((l) => /SKIP \(not shipped\): assets\/character\/new1\.png/.test(l)));
    assert.ok(log.some((l) => /SKIP \(missing\): assets\/character\/casual/.test(l)));
  });
});
