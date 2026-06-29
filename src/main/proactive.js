// ============================================================
//  老婆模式 (waifu mode) checks + memory upkeep — background loops that let
//  her act on her own. The check design follows Sakura's guardrails
//  (interval, cooldown, hard off-switch, screen gating) and adds quiet hours
//  plus a daily cap, since every check is a paid model call.
//
//  - Proactive check: when enabled and every gate passes, run a silent chat
//    turn that screenshots the screen and lets the model decide whether to
//    speak ([[silent]] = stay quiet; see chat.sendProactive).
//  - Memory curation: at most ~weekly, when MEMORY.md has grown big and the
//    chat has been idle a while, run a silent turn asking her to tidy it.
// ============================================================
const fs = require("node:fs");
const settings = require("./settings");
const chat = require("./chat");
const persona = require("./persona");
// wsServer is lazy-required inside functions to break the ws-server→chat→proactive→ws-server cycle.
function getWsServer() { return require("./ws-server"); }

const TICK_MS = 60 * 1000;
const MAINTENANCE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const MAINTENANCE_RETRY_MS = 6 * 60 * 60 * 1000;
const MAINTENANCE_MEMORY_MIN_BYTES = 16 * 1024;
const MAINTENANCE_IDLE_MS = 5 * 60 * 1000;
const BOOT_GRACE_MS = 10 * 60 * 1000;

// wsServer accessed via getWsServer() to break circular require (see top of file).

let tickTimer = null;
let lastProactiveAttemptAt = 0;
let lastMaintenanceAttemptAt = 0;
let lastDiagnosticAttemptAt = 0;
let lastActivityAttemptAt = 0;
// Daily cap state is in-memory on purpose: a tray app stays up for days, and
// a restart at worst resets the day's budget once.
let daily = { day: "", count: 0 };

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function localDayKey(date = new Date()) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function parseHHMM(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

// Quiet hours may wrap past midnight (e.g. 23:30 → 08:30).
function inQuietHours(date = new Date()) {
  const start = parseHHMM(settings.get("proactiveQuietStart"));
  const end = parseHHMM(settings.get("proactiveQuietEnd"));
  if (start == null || end == null || start === end) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}

function intervalMs() {
  return clampNumber(settings.get("proactiveIntervalMin"), 5, 24 * 60, 20) * 60 * 1000;
}

function cooldownMs() {
  return clampNumber(settings.get("proactiveCooldownMin"), 1, 12 * 60, 10) * 60 * 1000;
}

function dailyCap() {
  return clampNumber(settings.get("proactiveDailyCap"), 1, 500, 20);
}

// Both loops need a CLI backend: proactive checks need the screenshot
// pipeline, maintenance needs file tools. The built-in backend has neither.
function hasCliProvider() {
  const availability = chat.getProviderAvailability({ refresh: false });
  const active = availability.activeProvider;
  return active === "claude" || active === "codex";
}

// ---- Vibe coding: diagnostic proactive checks ----

function diagnosticCooldownMs() {
  return clampNumber(settings.get("diagnosticCheckCooldownMin"), 1, 60, 5) * 60 * 1000;
}

function activityCooldownMs() {
  return clampNumber(settings.get("activityCheckCooldownMin"), 1, 60, 3) * 60 * 1000;
}

function shouldRunDiagnosticCheck(now) {
  if (!getWsServer().isVscodeActive()) return false;
  if (settings.get("vibeCodingDiagnostics") !== true) return false;
  if (now - lastDiagnosticAttemptAt < diagnosticCooldownMs()) return false;
  if (chat.isBusy()) return false;
  if (inQuietHours()) return false;
  const day = localDayKey();
  if (daily.day !== day) {
    daily = { day, count: 0 };
    lastDiagnosticAttemptAt = 0;
    lastActivityAttemptAt = 0;
    lastProactiveAttemptAt = 0;
  }
  if (daily.count >= dailyCap()) return false;
  if (!hasCliProvider()) return false;
  const diag = getWsServer().getLatestDiagnostics();
  if (!diag || diag.errors === 0) return false;
  const lastTs = chat.getLastConversationTs();
  if (lastTs && now - lastTs < cooldownMs()) return false;
  return true;
}

function shouldRunActivityCheck(now) {
  if (!getWsServer().isVscodeActive()) return false;
  if (settings.get("vibeCodingActivityNarration") !== true) return false;
  if (now - lastActivityAttemptAt < activityCooldownMs()) return false;
  if (chat.isBusy()) return false;
  if (inQuietHours()) return false;
  const day = localDayKey();
  if (daily.day !== day) {
    daily = { day, count: 0 };
    lastDiagnosticAttemptAt = 0;
    lastActivityAttemptAt = 0;
    lastProactiveAttemptAt = 0;
  }
  if (daily.count >= dailyCap()) return false;
  if (!hasCliProvider()) return false;
  const activities = getWsServer().getRecentActivities();
  if (!activities || activities.length === 0) return false;
  // Only trigger if there's a recent activity (within last 2 minutes)
  const recent = activities.some((a) => now - a.timestamp < 2 * 60 * 1000);
  if (!recent) return false;
  const lastTs = chat.getLastConversationTs();
  if (lastTs && now - lastTs < cooldownMs()) return false;
  return true;
}

function shouldRunProactive(now) {
  if (settings.get("waifuMode") !== true) return false;
  if (now - lastProactiveAttemptAt < intervalMs()) return false;
  if (inQuietHours()) return false;
  const day = localDayKey();
  if (daily.day !== day) {
    daily = { day, count: 0 };
    lastDiagnosticAttemptAt = 0;
    lastActivityAttemptAt = 0;
    lastProactiveAttemptAt = 0;
  }
  if (daily.count >= dailyCap()) return false;
  if (chat.isBusy()) return false;
  if (!hasCliProvider()) return false;
  const lastTs = chat.getLastConversationTs();
  if (lastTs && now - lastTs < cooldownMs()) return false;
  return true;
}

function memoryFileBytes() {
  try {
    return fs.statSync(persona.memoryPath()).size;
  } catch {
    return 0;
  }
}

function shouldRunMaintenance(now) {
  if (now - lastMaintenanceAttemptAt < MAINTENANCE_RETRY_MS) return false;
  if (now - Number(settings.get("memoryCuratedAt") || 0) < MAINTENANCE_INTERVAL_MS) return false;
  if (chat.isBusy()) return false;
  if (!hasCliProvider()) return false;
  const lastTs = chat.getLastConversationTs();
  if (lastTs && now - lastTs < MAINTENANCE_IDLE_MS) return false;
  return memoryFileBytes() >= MAINTENANCE_MEMORY_MIN_BYTES;
}

function tick() {
  const now = Date.now();
  try {
    // Priority: diagnostics > activity > generic proactive > maintenance
    // Each tick fires at most one self-turn to avoid flooding the model.

    if (shouldRunDiagnosticCheck(now)) {
      lastDiagnosticAttemptAt = now;
      const diag = getWsServer().getLatestDiagnostics();
      if (chat.sendProactive({ diagnosticContext: diag })?.ok) {
        daily.count += 1;
      }
      return;
    }

    if (shouldRunActivityCheck(now)) {
      lastActivityAttemptAt = now;
      if (chat.sendProactive({ activityContext: true })?.ok) {
        daily.count += 1;
      }
      return;
    }

    if (shouldRunProactive(now)) {
      // Attempts move the interval forward even when dispatch fails, so a
      // broken backend can't make her retry every minute.
      lastProactiveAttemptAt = now;
      if (chat.sendProactive()?.ok) {
        daily.count += 1;
      }
      return;
    }

    if (shouldRunMaintenance(now)) {
      lastMaintenanceAttemptAt = now;
      if (chat.sendMaintenance()?.ok) {
        settings.set({ memoryCuratedAt: now });
      }
    }
  } catch (error) {
    console.warn("proactive: tick failed", error);
  }
}

function start() {
  if (tickTimer) return;
  const now = Date.now();
  // The first proactive check waits one full interval after boot; maintenance
  // gets a short grace so app start never immediately spawns a model call.
  lastProactiveAttemptAt = now;
  lastMaintenanceAttemptAt = now - MAINTENANCE_RETRY_MS + BOOT_GRACE_MS;
  tickTimer = setInterval(tick, TICK_MS);
  tickTimer.unref?.();
}

module.exports = { start };
