/// <reference types="mocha" />
import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { minimatch } from "minimatch";

// Pins what .vscodeignore lets into the VSIX. The filter below is vsce's own
// algorithm (collectFiles in @vscode/vsce/out/package.js): every line that is
// not a glob also gets a "<line>/**" twin, "!" lines re-include, minimatch
// runs with { dot: true }. minimatch comes from vsce's own dependency tree.

function vsceKeeps(files: string[], raw: string): string[] {
  const lines = raw
    .split(/[\n\r]/)
    .map((s) => s.trim())
    .filter((s) => !!s)
    .filter((i) => !/^\s*#/.test(i));
  const expanded = [
    ...lines,
    ...lines
      .filter((i) => !/(^|\/)[^/]*\*[^/]*$/.test(i))
      .map((i) => (/\/$/.test(i) ? `${i}**` : `${i}/**`)),
  ];
  const ignore = expanded.filter((e) => !/^\s*!/.test(e));
  const negate = expanded.filter((e) => /^\s*!/.test(e));
  const opts = { dot: true };
  return files.filter(
    (f) => !ignore.some((i) => minimatch(f, i, opts)) || negate.some((i) => minimatch(f, i.substr(1), opts))
  );
}

describe(".vscodeignore", () => {
  const raw = fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", ".vscodeignore"), "utf8");

  it("ships compiled code, media and the sprites the webviews load", () => {
    const shipped = [
      "package.json",
      "out/extension.js",
      "out/src/chat-panel.js",
      "media/renderer.js",
      "media/styles.css",
      "assets/character/idle.png",
      "assets/character/sleep.png",
      "assets/character/casual/smile.png",
      "assets/character/普猫猫/cat_normal.png",
      "assets/character/普猫猫/cat_crying.png",
    ];
    assert.deepStrictEqual(vsceKeeps(shipped, raw), shipped);
  });

  it("drops TypeScript sources, maps, packages and scratch PNGs", () => {
    const dropped = [
      "extension.ts",
      "src/chat-panel.ts",
      "src/test/unit/chat-panel.test.ts",
      "out/extension.js.map",
      "out/src/test/unit/chat-panel.test.js",
      "prts-vscode-0.7.6.vsix",
      "assets/character/icon.png",
      "assets/character/scratch.png",
      "assets/character/new-skin-draft.png",
      "assets/character/casual-src/idle.png",
      "assets/character/easteregg/idle.png",
      "assets/.DS_Store",
    ];
    assert.deepStrictEqual(vsceKeeps(dropped, raw), []);
  });
});
