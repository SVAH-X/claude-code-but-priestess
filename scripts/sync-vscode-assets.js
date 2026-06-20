// Copies renderer scripts, styles, and character PNGs from the Electron
// source tree into the vscode-extension directory so the extension always
// ships the same UI code as the tray app. Run before compile / package.
//
// Character PNGs are renamed to ASCII-safe filenames because VSIX (ZIP)
// central-directory encoding is not reliably UTF-8 across installers.
// The copied renderer scripts are patched in-place to match.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "vscode-extension");

// Chinese → ASCII filename map for character PNGs.
// Keys are the source filenames; values are the target filenames.
// Both the file copy step and the renderer patch step use this map.
const NAME_MAP = {
  // Formal / casual expressions
  "睁眼.png":     "idle.png",
  "半眯眼.png":   "half_closed.png",
  "快闭眼.png":   "almost_closed.png",
  "闭眼.png":     "closed.png",
  "笑.png":       "smile.png",
  "生气.png":     "angry.png",
  "威胁.png":     "threat.png",
  "哭唧唧.png":   "cry.png",
  "睡觉.png":     "sleep.png",
  // Cat mode
  "普猫猫.png":   "cat_normal.png",
  "普猫猫哭.png": "cat_crying.png",
};

// icon.png is already ASCII — no mapping needed.

// ---- helpers ----

function copyFile(srcRel, dstRel) {
  const src = path.join(ROOT, srcRel);
  const dst = path.join(TARGET, dstRel);
  const dstDir = path.dirname(dst);
  fs.mkdirSync(dstDir, { recursive: true });
  fs.copyFileSync(src, dst);
  console.log("  " + dstRel);
}

// Copy a single PNG, renaming if it has a mapping.
function copyPng(srcRel, dstDirRel, fileName) {
  const newName = NAME_MAP[fileName] || fileName;
  const src = path.join(ROOT, srcRel, fileName);
  const dst = path.join(TARGET, dstDirRel, newName);
  const dstDir = path.dirname(dst);
  fs.mkdirSync(dstDir, { recursive: true });
  fs.copyFileSync(src, dst);
  console.log("  " + dstDirRel + "/" + newName);
}

function copyPngDir(srcRel, dstRel) {
  const src = path.join(ROOT, srcRel);
  if (!fs.existsSync(src)) {
    console.warn("  SKIP (missing): " + srcRel);
    return;
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && /\.png$/i.test(entry.name)) {
      copyPng(srcRel, dstRel, entry.name);
    }
  }
}

// Patch a renderer JS file: replace every Chinese filename reference
// with its ASCII equivalent.
function patchRendererFile(dstRel) {
  const filePath = path.join(TARGET, dstRel);
  let content = fs.readFileSync(filePath, "utf8");
  let changed = false;
  for (const [cn, ascii] of Object.entries(NAME_MAP)) {
    const before = content;
    content = content.split(cn).join(ascii);
    if (content !== before) changed = true;
  }
  if (changed) {
    fs.writeFileSync(filePath, content, "utf8");
    console.log("  (patched) " + dstRel);
  }
}

// ---- run ----

console.log("Syncing assets to vscode-extension/ …");

// Renderer scripts & styles (plain copies)
console.log("\n[media]");
copyFile("src/renderer/renderer.js",    "media/renderer.js");
copyFile("src/renderer/desktop-pet.js", "media/pet.js");
copyFile("src/renderer/styles.css",     "media/styles.css");
copyFile("src/renderer/desktop-pet.css","media/pet.css");

// Patch the copied JS so filenames match the renamed PNGs
patchRendererFile("media/renderer.js");
patchRendererFile("media/pet.js");

// Character sprites (renamed)
console.log("\n[assets/character]");
copyPngDir("assets/character", "assets/character");

// Casual outfit
console.log("\n[assets/character/casual]");
copyPngDir("assets/character/casual", "assets/character/casual");

// Cat mode
console.log("\n[assets/character/普猫猫]");
copyPngDir("assets/character/普猫猫", "assets/character/普猫猫");

// Remove old Chinese-named files that may exist from a previous sync
console.log("\n[cleanup]");
for (const [cn] of Object.entries(NAME_MAP)) {
  for (const sub of ["", "casual/", "普猫猫/"]) {
    const stale = path.join(TARGET, "assets", "character", sub, cn);
    if (fs.existsSync(stale)) {
      fs.unlinkSync(stale);
      console.log("  removed stale: assets/character/" + sub + cn);
    }
  }
}

console.log("\nSync complete.");
