const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const DEFAULTS = Object.freeze({
  chatProvider: "claude",
  chatCwd: "",
  agentMode: false,
  autoScreenshot: true,
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
