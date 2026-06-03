const fs = require("node:fs");
const path = require("node:path");

const required = [
  path.join("src", "main", "main.js"),
  path.join("src", "main", "preload.js"),
  path.join("src", "main", "settings.js"),
  path.join("src", "main", "chat.js"),
  path.join("src", "main", "persona.js"),
  path.join("src", "main", "platform.js"),
  path.join("src", "renderer", "index.html"),
  path.join("src", "renderer", "desktop-pet.html"),
  path.join("src", "renderer", "desktop-pet.js"),
  path.join("src", "renderer", "desktop-pet.css"),
  path.join("src", "renderer", "renderer.js"),
  path.join("src", "renderer", "styles.css"),
  path.join("assets", "character", "睁眼.png"),
  path.join("assets", "character", "半眯眼.png"),
  path.join("assets", "character", "快闭眼.png"),
  path.join("assets", "character", "闭眼.png"),
  path.join("assets", "character", "笑.png"),
  path.join("assets", "character", "生气.png"),
  path.join("assets", "character", "威胁.png"),
  path.join("assets", "character", "哭唧唧.png"),
  path.join("assets", "character", "睡觉.png"),
  path.join("assets", "character", "icon.png")
];

const missing = required.filter((entry) => !fs.existsSync(path.join(process.cwd(), entry)));

if (missing.length > 0) {
  console.error(`Missing required project files:\n${missing.map((entry) => `- ${entry}`).join("\n")}`);
  process.exit(1);
}

console.log("Project files are present.");
