const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");

const archive = process.argv[2];
if (!archive) {
  console.error("Usage: node scripts/check-packaged-assets.js <path-to-app.asar>");
  process.exit(1);
}

if (!fs.existsSync(archive)) {
  console.error(`Packaged app archive not found: ${archive}`);
  process.exit(1);
}

const expressions = [
  "睁眼.png",
  "半眯眼.png",
  "快闭眼.png",
  "闭眼.png",
  "笑.png",
  "生气.png",
  "威胁.png",
  "哭唧唧.png",
  "睡觉.png"
];

const required = [
  ...expressions.map((file) => path.posix.join("assets", "character", file)),
  ...expressions.map((file) => path.posix.join("assets", "character", "casual", file)),
  path.posix.join("assets", "character", "普猫猫", "普猫猫.png"),
  path.posix.join("assets", "character", "普猫猫", "普猫猫哭.png"),
  path.posix.join("assets", "character", "icon.png")
];

const packaged = new Set(asar.listPackage(archive).map((entry) => entry.replace(/^\//, "")));
const missing = required.filter((entry) => !packaged.has(entry));

if (missing.length > 0) {
  console.error(`Missing packaged assets:\n${missing.map((entry) => `- ${entry}`).join("\n")}`);
  process.exit(1);
}

console.log(`Packaged character assets are present in ${archive}.`);
