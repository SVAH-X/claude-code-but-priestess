// Settings validation logic tests — tested in isolation without requiring the
// real settings module (which depends on Electron's app.getPath).
const { test, equal, isTrue, isFalse } = require("./helper");

// Replica of settings.js VALIDATORS and DEFAULTS for isolated testing.
const DEFAULTS = Object.freeze({
  chatProvider: "claude",
  claudeModel: "",
  codexModel: "",
  priestessEnabled: false,
  priestessBaseUrl: "http://127.0.0.1:4000",
  priestessApiKey: "",
  priestessModel: "",
  chatCwd: "",
  theme: "system",
  menuLanguage: "system",
  outfit: "formal",
  vibeCodingMode: "companion",
  vibeCodingDiagnostics: false,
  diagnosticCheckCooldownMin: 5,
  vibeCodingActivityNarration: false,
  activityCheckCooldownMin: 3,
  advisorFileBlacklist: ".env\n.env.*\n*secret*\n*credential*\n*.pem\n*.key\nid_rsa*\n*password*\n*token*",
  coauthorCommits: true,
  skillsEnabled: true,
  updateChannel: "stable",
  autoScreenshot: true,
  waifuMode: false,
  proactiveIntervalMin: 20,
  proactiveCooldownMin: 10,
  proactiveDailyCap: 20,
  proactiveQuietStart: "00:30",
  proactiveQuietEnd: "08:30",
  memoryCuratedAt: 0,
  desktopPet: true,
  desktopPetScale: 1.0,
  desktopPetPosition: null,
  popoverSize: { width: 380, height: 560 },
  personaNotes: ""
});

const VALIDATORS = {
  vibeCodingMode: function (v) { return ["companion", "advisor", "agent"].includes(v); },
  chatProvider: function (v) { return ["claude", "codex", "priestess"].includes(v); },
  theme: function (v) { return ["system", "light", "dark"].includes(v); },
  menuLanguage: function (v) { return ["system", "zh", "en"].includes(v); },
  outfit: function (v) { return ["formal", "casual"].includes(v); },
  updateChannel: function (v) { return ["stable", "prerelease"].includes(v); },
  desktopPetSize: function () { return false; }, // deprecated
};

// Replica of set() sanitization logic (excluding persist/subscribers)
function validatePatch(patch) {
  const sanitized = {};
  for (const key of Object.keys(patch)) {
    if (!(key in DEFAULTS)) continue;               // reject unknown keys
    if (key === "agentMode") continue;               // reject deprecated key
    const validator = VALIDATORS[key];
    if (validator && !validator(patch[key])) continue; // reject invalid enum values
    sanitized[key] = patch[key];
  }
  return sanitized;
}

// ============================================================
// Tests
// ============================================================

test("validatePatch accepts valid vibeCodingMode values", () => {
  const r1 = validatePatch({ vibeCodingMode: "companion" });
  equal(r1.vibeCodingMode, "companion");

  const r2 = validatePatch({ vibeCodingMode: "advisor" });
  equal(r2.vibeCodingMode, "advisor");

  const r3 = validatePatch({ vibeCodingMode: "agent" });
  equal(r3.vibeCodingMode, "agent");
});

test("validatePatch rejects invalid vibeCodingMode", () => {
  const r = validatePatch({ vibeCodingMode: "superadmin" });
  equal(Object.keys(r).length, 0, "invalid mode returns empty");
});

test("validatePatch rejects unknown keys", () => {
  const r = validatePatch({ nonexistentSetting: "evil" });
  equal(Object.keys(r).length, 0);
});

test("validatePatch rejects deprecated agentMode", () => {
  const r = validatePatch({ agentMode: true });
  equal(Object.keys(r).length, 0);
});

test("validatePatch accepts all valid enum keys", () => {
  const valid = {
    vibeCodingMode: "advisor",
    chatProvider: "claude",
    theme: "dark",
    menuLanguage: "zh",
    outfit: "casual",
    updateChannel: "prerelease",
  };
  const r = validatePatch(valid);
  equal(Object.keys(r).length, 6, "all 6 valid keys accepted");
});

test("validatePatch rejects invalid enum values for all keys", () => {
  equal(Object.keys(validatePatch({ chatProvider: "gpt" })).length, 0, "invalid chatProvider");
  equal(Object.keys(validatePatch({ theme: "neon" })).length, 0, "invalid theme");
  equal(Object.keys(validatePatch({ menuLanguage: "jp" })).length, 0, "invalid language");
  equal(Object.keys(validatePatch({ outfit: "swimsuit" })).length, 0, "invalid outfit");
  equal(Object.keys(validatePatch({ updateChannel: "nightly" })).length, 0, "invalid channel");
});

test("validatePatch accepts free-form keys", () => {
  const r = validatePatch({ chatCwd: "/home/user/projects", personaNotes: "hello", advisorFileBlacklist: ".env\n*.log" });
  equal(r.chatCwd, "/home/user/projects");
  equal(r.personaNotes, "hello");
  equal(r.advisorFileBlacklist, ".env\n*.log");
});

test("validatePatch accepts boolean/numeric keys", () => {
  const r = validatePatch({ skillsEnabled: false, waifuMode: true, proactiveDailyCap: 5, desktopPetScale: 1.5 });
  equal(r.skillsEnabled, false);
  equal(r.waifuMode, true);
  equal(r.proactiveDailyCap, 5);
  equal(r.desktopPetScale, 1.5);
});

test("validatePatch rejects desktopPetSize (deprecated)", () => {
  const r = validatePatch({ desktopPetSize: "large" });
  equal(Object.keys(r).length, 0, "deprecated key rejected via validator");
});

test("validatePatch mixed valid and invalid returns only valid", () => {
  const r = validatePatch({ vibeCodingMode: "advisor", badKey: 1, chatProvider: "codex", agentMode: true, theme: "light" });
  equal(Object.keys(r).length, 3, "only 3 valid keys pass");
  equal(r.vibeCodingMode, "advisor");
  equal(r.chatProvider, "codex");
  equal(r.theme, "light");
});

// Migration test
test("agentMode true migration to vibeCodingMode agent", () => {
  // Simulate settings.js migration logic
  const parsed = { agentMode: true };
  if (parsed.agentMode === true && parsed.vibeCodingMode === undefined) {
    parsed.vibeCodingMode = "agent";
  }
  delete parsed.agentMode;
  const cache = { ...DEFAULTS, ...parsed };
  delete cache.agentMode;

  equal(cache.vibeCodingMode, "agent", "migrated to agent");
  isFalse("agentMode" in cache, "agentMode deleted from cache");
});

test("agentMode false does NOT trigger migration", () => {
  const parsed = { agentMode: false };
  if (parsed.agentMode === true && parsed.vibeCodingMode === undefined) {
    parsed.vibeCodingMode = "agent";
  }
  delete parsed.agentMode;
  equal(parsed.vibeCodingMode, undefined, "no migration from false");
});

test("explicit vibeCodingMode takes precedence over agentMode migration", () => {
  const parsed = { agentMode: true, vibeCodingMode: "companion" };
  // vibeCodingMode already set → migration skipped
  if (parsed.agentMode === true && parsed.vibeCodingMode === undefined) {
    parsed.vibeCodingMode = "agent"; // won't execute
  }
  delete parsed.agentMode;
  equal(parsed.vibeCodingMode, "companion", "explicit value preserved");
});
