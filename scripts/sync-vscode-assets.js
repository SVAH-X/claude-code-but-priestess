// Copies renderer scripts, styles, and character PNGs from the Electron
// source tree into the vscode-extension directory so the extension always
// ships the same UI code as the tray app. Run before compile / package.
//
// Character PNGs are renamed to ASCII-safe filenames because VSIX (ZIP)
// central-directory encoding is not reliably UTF-8 across installers.
// The copied renderer scripts are patched in-place to match.
//
// vscode-extension/media/renderer.js is the tray renderer plus the webview-only
// fixes below. Every one of those fixes is an explicit patch step with an
// anchor, and a missing anchor aborts the sync instead of silently shipping a
// renderer without the fix (which is how 3590f0a's sidebar fix got reverted
// by `npm run vscode:compile` once). test/sync-vscode-assets.test.js runs the
// sync into a temp dir and asserts it reproduces the committed media/ files
// byte for byte, so a change to either side must land on both.

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

// The VS Code webview serves character frames from a different origin than the
// document (vscode-webview:// vs the extension's webview URI), which taints the
// canvas that prepareTransparentFrame reads back. The webview build therefore
// needs CORS-aware frame loading and a tainted-canvas fallback, while the
// Electron popover serves frames same-origin and keeps the simpler code.
// Each step replaces `from` (which must occur exactly once) with `to`.
const WEBVIEW_PATCHES = [
  {
    // Guard the pixel read in prepareTransparentFrame: a tainted canvas throws
    // on getImageData; degrade to an untrimmed frame instead of throwing and
    // blanking the stage.
    name: "tainted-canvas guard in prepareTransparentFrame",
    from:
      "  srcCtx.drawImage(image, 0, 0);\n" +
      "  const imageData = srcCtx.getImageData(0, 0, source.width, source.height);\n" +
      "  const { data, width, height } = imageData;\n",
    to:
      "  srcCtx.drawImage(image, 0, 0);\n" +
      "  let imageData;\n" +
      "  try {\n" +
      "    imageData = srcCtx.getImageData(0, 0, source.width, source.height);\n" +
      "  } catch {\n" +
      "    // A tainted canvas denies pixel reads. The shipped frames already carry\n" +
      "    // their alpha, so the fill has nothing to remove and only the crop is\n" +
      "    // lost: an untrimmed character still renders, which beats a blank stage.\n" +
      "    return {\n" +
      "      canvas: source,\n" +
      "      bbox: { minX: 0, minY: 0, maxX: source.width - 1, maxY: source.height - 1 }\n" +
      "    };\n" +
      "  }\n" +
      "  const { data, width, height } = imageData;\n"
  },
  {
    // Load frames CORS-first (with a plain retry): asking for anonymous CORS
    // keeps the trim working on hosts that send CORS headers; hosts that send
    // none fail the decode instead of the later pixel read.
    name: "CORS-first loadFrame",
    from:
      "async function loadFrame(fileName, dir) {\n" +
      "  const image = new Image();\n" +
      "  image.decoding = \"async\";\n" +
      "  image.src = new URL(fileName, dir).href;\n" +
      "  await image.decode();\n" +
      "  return prepareTransparentFrame(image);\n" +
      "}\n",
    to:
      "function decodeImage(href, crossOrigin) {\n" +
      "  const image = new Image();\n" +
      "  image.decoding = \"async\";\n" +
      "  if (crossOrigin) image.crossOrigin = crossOrigin;\n" +
      "  image.src = href;\n" +
      "  return image.decode().then(() => image);\n" +
      "}\n" +
      "\n" +
      "async function loadFrame(fileName, dir) {\n" +
      "  const href = new URL(fileName, dir).href;\n" +
      "  // Frames are served from a different origin than the document in the VS Code\n" +
      "  // webview, and drawing one in taints the canvas that prepareTransparentFrame\n" +
      "  // reads back. Ask for CORS first so the trim below keeps working; hosts that\n" +
      "  // serve the frames same-origin (the Electron popover) ignore the attribute,\n" +
      "  // and a host that sends no CORS headers fails the decode instead of the\n" +
      "  // pixel read — hence the plain retry.\n" +
      "  const image = await decodeImage(href, \"anonymous\").catch(() => decodeImage(href, null));\n" +
      "  return prepareTransparentFrame(image);\n" +
      "}\n"
  }
];

// ---- pure helpers (unit-tested) ----

// Rename every Chinese frame filename reference to its ASCII equivalent.
// Throws when nothing matched: the file no longer references the frames the
// way the map expects, and shipping it unpatched would 404 every sprite.
function renameFrameReferences(content, fileLabel) {
  let out = content;
  for (const [cn, ascii] of Object.entries(NAME_MAP)) out = out.split(cn).join(ascii);
  if (out === content) {
    throw new Error(`sync-vscode-assets: no character filename to rename in ${fileLabel}`);
  }
  return out;
}

// Apply the webview-only patch steps. Each anchor must occur exactly once;
// otherwise the hand-patched fix would be lost (or duplicated) silently.
function applyWebviewPatches(content, fileLabel) {
  let out = content;
  for (const step of WEBVIEW_PATCHES) {
    const count = out.split(step.from).length - 1;
    if (count !== 1) {
      throw new Error(
        `sync-vscode-assets: anchor for "${step.name}" found ${count} times in ${fileLabel} ` +
          "(expected exactly 1) — re-base the webview patch in scripts/sync-vscode-assets.js"
      );
    }
    out = out.replace(step.from, step.to);
  }
  return out;
}

// electron-builder's `build.files` "!" entries name the scratch art the app
// doesn't ship (new*.png, Nano Banana …); the VSIX leaves the same files out.
// Only the pattern subset those entries use is supported: `**`, `*`, literals.
function globToRegex(glob) {
  const escape = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const source = glob
    .split("**")
    .map((part) => part.split("*").map(escape).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${source}$`);
}

function buildFileExcluder(negations) {
  const regexes = negations.map(globToRegex);
  return (relPath) => regexes.some((re) => re.test(relPath));
}

function buildFileNegations(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  return (pkg.build?.files || [])
    .filter((entry) => typeof entry === "string" && entry.startsWith("!"))
    .map((entry) => entry.slice(1));
}

// ---- sync ----

function sync(options = {}) {
  const root = options.root || ROOT;
  const target = options.target || TARGET;
  const log = options.log || console.log;
  const excluded = buildFileExcluder(buildFileNegations(root));

  function copyFile(srcRel, dstRel) {
    const dst = path.join(target, dstRel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(root, srcRel), dst);
    log("  " + dstRel);
  }

  // Copy a single PNG, renaming if it has a mapping.
  function copyPng(srcRel, dstDirRel, fileName) {
    const newName = NAME_MAP[fileName] || fileName;
    const dst = path.join(target, dstDirRel, newName);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(root, srcRel, fileName), dst);
    log("  " + dstDirRel + "/" + newName);
  }

  function copyPngDir(srcRel, dstRel) {
    const src = path.join(root, srcRel);
    if (!fs.existsSync(src)) {
      log("  SKIP (missing): " + srcRel);
      return;
    }
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.png$/i.test(entry.name)) continue;
      if (excluded(`${srcRel}/${entry.name}`)) {
        log("  SKIP (not shipped): " + srcRel + "/" + entry.name);
        continue;
      }
      copyPng(srcRel, dstRel, entry.name);
    }
  }

  // Rewrite a copied script in place: normalize line endings so the anchors
  // match regardless of the source EOL style (Electron sources are CRLF on
  // Windows checkouts), then run the given transforms.
  function patchScript(dstRel, ...transforms) {
    const filePath = path.join(target, dstRel);
    let content = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
    for (const transform of transforms) content = transform(content, dstRel);
    fs.writeFileSync(filePath, content, "utf8");
    log("  (patched) " + dstRel);
  }

  log("Syncing assets to " + target + " …");

  // Renderer scripts & styles (plain copies)
  log("\n[media]");
  copyFile("src/renderer/renderer.js",    "media/renderer.js");
  copyFile("src/renderer/desktop-pet.js", "media/pet.js");
  copyFile("src/renderer/styles.css",     "media/styles.css");
  copyFile("src/renderer/desktop-pet.css","media/pet.css");

  // Patch the copied JS so filenames match the renamed PNGs, then apply the
  // webview-only fixes to the chat renderer.
  patchScript("media/renderer.js", renameFrameReferences, applyWebviewPatches);
  patchScript("media/pet.js", renameFrameReferences);

  // Character sprites (renamed)
  log("\n[assets/character]");
  copyPngDir("assets/character", "assets/character");

  // Casual outfit
  log("\n[assets/character/casual]");
  copyPngDir("assets/character/casual", "assets/character/casual");

  // Cat mode
  log("\n[assets/character/普猫猫]");
  copyPngDir("assets/character/普猫猫", "assets/character/普猫猫");

  // Remove old Chinese-named files that may exist from a previous sync
  log("\n[cleanup]");
  for (const cn of Object.keys(NAME_MAP)) {
    for (const sub of ["", "casual/", "普猫猫/"]) {
      const stale = path.join(target, "assets", "character", sub, cn);
      if (fs.existsSync(stale)) {
        fs.unlinkSync(stale);
        log("  removed stale: assets/character/" + sub + cn);
      }
    }
  }

  log("\nSync complete.");
}

module.exports = {
  NAME_MAP,
  WEBVIEW_PATCHES,
  renameFrameReferences,
  applyWebviewPatches,
  globToRegex,
  buildFileExcluder,
  buildFileNegations,
  sync
};

if (require.main === module) sync();
