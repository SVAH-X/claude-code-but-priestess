const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const DEFAULTS = Object.freeze({
  chatProvider: process.platform === "win32" ? "codex" : "claude",
  // Optional model override per backend, passed to the CLI as `--model`. Empty
  // string = let the CLI / account pick its default.
  claudeModel: "",
  codexModel: "",
  // Built-in "Priestess" backend — she speaks to an OpenAI-compatible server
  // directly (no local CLI needed). Defaults to a local LiteLLM proxy. The
  // API key and URL live ONLY in this local settings.json (userData); they
  // are never sent anywhere except the server the Doctor configures.
  priestessEnabled: false,
  priestessBaseUrl: "http://127.0.0.1:4000",
  priestessApiKey: "",
  priestessModel: "",
  chatCwd: "",
  // Appearance: "system" follows the OS light/dark setting; "light"/"dark"
  // force a fixed appearance. Drives nativeTheme.themeSource, which in turn
  // flips the renderer's prefers-color-scheme palette and (on macOS) the
  // popover vibrancy material.
  theme: "system",
  // Menu language: "system" follows the OS preferred language, "zh" forces
  // Simplified Chinese, and "en" forces English.
  menuLanguage: "system",
  agentMode: false,
  // Lets Priestess trigger curated local actions (play music, web search, open
  // a URL/app) via hidden [[skill:…]] directives. Closed whitelist + sanitized
  // args, so it's safe without agent mode. PRTS-internal only.
  skillsEnabled: true,
  // Update channel: "stable" (default) only ever offers full releases.
  // "prerelease" is a developer/tester flag — there is deliberately no menu
  // option for it; flip it by hand in settings.json (tray → 打开数据目录) to
  // receive prerelease builds for testing before they are promoted.
  updateChannel: "stable",
  autoScreenshot: true,
  desktopPet: true,
  desktopPetSize: "medium",
  desktopPetPosition: null,
  popoverSize: { width: 380, height: 560 }
});

let cache = { ...DEFAULTS };
let filePath = null;
const subscribers = new Set();

function init() {
  filePath = path.join(app.getPath("userData"), "settings.json");
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      cache = { ...DEFAULTS, ...parsed };
    }
  } catch (error) {
    console.warn("settings: failed to load, using defaults", error);
    cache = { ...DEFAULTS };
  }
}

function getAll() {
  return { ...cache };
}

function get(key) {
  return cache[key];
}

function set(patch) {
  cache = { ...cache, ...patch };
  persist();
  for (const sub of subscribers) {
    try {
      sub(cache, patch);
    } catch (error) {
      console.warn("settings subscriber threw", error);
    }
  }
}

function persist() {
  if (!filePath) return;
  try {
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), "utf8");
  } catch (error) {
    console.warn("settings: failed to persist", error);
  }
}

function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

module.exports = { init, getAll, get, set, subscribe, DEFAULTS };
