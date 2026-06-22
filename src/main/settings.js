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
  // Her outfit: "formal" (正装 — the classic coat, assets/character root) or
  // "casual" (休闲 — the white butterfly dress, assets/character/casual).
  // Both sets share the same nine expression frames.
  outfit: "formal",
  agentMode: false,
  // When she commits on the Doctor's behalf, sign the commit with an honest
  // Co-Authored-By trailer (普瑞赛斯 <prts.priestess@outlook.com>) so she shows
  // up as a real contributor — the same idea as Claude Code's trailer. On by
  // default, documented in the README, toggleable from the tray menu.
  coauthorCommits: true,
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
  // 老婆模式 (waifu mode) — she periodically looks at the screen on her own
  // and quietly takes care of the Doctor: gentle check-ins, jealousy when he
  // is fawning over someone who isn't her, sharp warnings on NSFW, and a
  // local-only observation journal (memory/OBSERVATIONS.jsonl). Off by
  // default; the tray toggle shows a consent dialog because every check is a
  // paid model call and needs screen access. Interval/cooldown are minutes;
  // quiet hours are local "HH:MM" and may wrap past midnight; the daily cap
  // counts checks. The tuning knobs have no menu UI — edit them here by hand
  // (tray → 打开数据目录), like updateChannel.
  waifuMode: false,
  proactiveIntervalMin: 20,
  proactiveCooldownMin: 10,
  proactiveDailyCap: 20,
  proactiveQuietStart: "00:30",
  proactiveQuietEnd: "08:30",
  // Timestamp of the last automatic memory-curation pass (see proactive.js).
  memoryCuratedAt: 0,
  desktopPet: true,
  // Continuous pet scale (1.0 = 150×180, the former "medium"). Scroll over
  // the pet to fine-tune; the tray menu offers preset stops.
  desktopPetScale: 1.0,
  desktopPetPosition: null,
  popoverSize: { width: 380, height: 560 },
  // Freeform persona supplement written by the Doctor in-app. Appended after
  // the base persona as 【博士的补充校准】. Max ~1500 chars; empty = inactive.
  personaNotes: ""
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
      // Migration: 主动关心 + 观察日志 merged into 老婆模式 (waifu mode).
      if (parsed.waifuMode === undefined &&
          (parsed.proactiveEnabled === true || parsed.observationJournal === true)) {
        parsed.waifuMode = true;
      }
      delete parsed.proactiveEnabled;
      delete parsed.observationJournal;
      // Migration: fixed small/medium/large pet sizes → continuous scale.
      if (parsed.desktopPetScale === undefined && parsed.desktopPetSize) {
        parsed.desktopPetScale =
          parsed.desktopPetSize === "small" ? 0.8 : parsed.desktopPetSize === "large" ? 1.2 : 1.0;
      }
      delete parsed.desktopPetSize;
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
