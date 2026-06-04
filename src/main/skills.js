// ============================================================
//  Skills — small, curated local actions Priestess can trigger
//  from inside PRTS only.
//
//  She emits a hidden directive [[skill:NAME ARG]] (see persona.js for the
//  prompt, chat.js for the parsing) which PRTS strips from her visible text
//  and runs here. This is a CLOSED whitelist with sanitized arguments: every
//  target is either an http(s)/app-scheme URL opened through Electron's shell
//  or an app name passed as a spawn arg array — never a raw shell string. That
//  is what makes it safe to keep enabled without agent mode, and it never
//  touches the user's normal claude/codex CLI usage.
// ============================================================

const { shell, Notification } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const settings = require("./settings");

const SKILL_NAMES = Object.freeze([
  "play_music",
  "web_search",
  "open_url",
  "open_app",
  "remind",
  "note"
]);

// ----------------------------------------------------------------
//  Music — curated Arknights song registry.
//
//  Links are the official ones (verified against the Arknights wiki / official
//  uploads — see README). Default playback source is Bilibili: opening a
//  Bilibili video page autoplays, and it fits the Chinese / Arknights context.
//  Add more songs by dropping another entry here with whatever service ids are
//  known; only the ids present are offered.
// ----------------------------------------------------------------
const SONGS = [
  {
    // Aimer「Eclipse」— Arknights 6th Anniversary theme. Its associated
    // characters are literally "Doctor and Priestess", so it's her song.
    label: "Aimer — Eclipse",
    aliases: ["eclipse", "日蚀", "日食", "定情曲", "博普"],
    bilibili: "BV1NFLdzREbG",
    youtube: "DCMV49XZiZY",
    spotify: "5syUIljMeRXFhqbrCGrxRH",
    apple: "1807476664",
    netease: "2694779693"
  },
  {
    label: "DJ Okawari feat. Ai Ninomiya — Speed of Light",
    aliases: ["speed of light", "光速", "企鹅物流"],
    monstersiren: "880374"
  },
  {
    label: "ManiFesto",
    aliases: ["manifesto", "宣言"],
    monstersiren: "514575"
  }
];

const SERVICE_BUILDERS = {
  bilibili: (e) => e.bilibili && `https://www.bilibili.com/video/${e.bilibili}/`,
  youtube: (e) => e.youtube && `https://www.youtube.com/watch?v=${e.youtube}`,
  monstersiren: (e) => e.monstersiren && `https://monster-siren.hypergryph.com/music/${e.monstersiren}`,
  netease: (e) => e.netease && `https://music.163.com/#/song?id=${e.netease}`,
  apple: (e) => e.apple && `https://music.apple.com/song/${e.apple}`,
  spotify: (e) => e.spotify && `https://open.spotify.com/track/${e.spotify}`
};

// When no service is named, prefer the ones that actually start playing on
// their own (Bilibili first, per the Doctor's preference).
const DEFAULT_SERVICE_ORDER = ["bilibili", "monstersiren", "youtube", "netease", "apple", "spotify"];
const AUTOPLAY_SERVICES = new Set(["bilibili", "youtube", "monstersiren"]);

const SERVICE_KEYWORDS = [
  ["bilibili", /bilibili|哔哩|b\s*站|bili/i],
  ["youtube", /youtube|油管|yt\b/i],
  ["spotify", /spotify/i],
  ["netease", /netease|网易|云音乐|163/i],
  ["apple", /apple\s*music|itunes|苹果音乐/i],
  ["monstersiren", /monster\s*siren|塞壬/i]
];

const SERVICE_SEARCH = {
  bilibili: (q) => `https://search.bilibili.com/all?keyword=${q}`,
  youtube: (q) => `https://www.youtube.com/results?search_query=${q}`,
  spotify: (q) => `https://open.spotify.com/search/${q}`,
  netease: (q) => `https://music.163.com/#/search/m/?s=${q}`,
  apple: (q) => `https://music.apple.com/search?term=${q}`,
  monstersiren: () => `https://monster-siren.hypergryph.com/`
};

function detectService(arg) {
  for (const [svc, re] of SERVICE_KEYWORDS) {
    if (re.test(arg)) return svc;
  }
  return null;
}

function stripServiceWords(arg) {
  let s = arg;
  for (const [, re] of SERVICE_KEYWORDS) {
    s = s.replace(new RegExp(re.source, "gi"), " ");
  }
  // Drop common filler so "在b站放 Eclipse" → "Eclipse".
  s = s.replace(/[在听放点歌曲首的上来给我]/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

function findSong(query) {
  const q = query.toLowerCase();
  if (!q) return SONGS[0]; // no song named → Eclipse is the natural default
  return (
    SONGS.find((s) =>
      s.aliases.some((a) => {
        const al = a.toLowerCase();
        return q.includes(al) || al.includes(q);
      })
    ) || null
  );
}

// Resolve a play_music arg to a concrete URL + display label. Known songs get a
// direct, autoplaying link (Bilibili by default); unknown songs fall back to a
// search on the chosen service (Bilibili by default), which the Doctor clicks.
function resolveMusic(arg) {
  const service = detectService(arg);
  const query = stripServiceWords(arg);
  const song = findSong(query);

  if (song) {
    const order = service ? [service, ...DEFAULT_SERVICE_ORDER] : DEFAULT_SERVICE_ORDER;
    for (const svc of order) {
      const url = SERVICE_BUILDERS[svc] && SERVICE_BUILDERS[svc](song);
      if (url) return { url, label: song.label, autoplay: AUTOPLAY_SERVICES.has(svc) };
    }
  }

  const q = encodeURIComponent(query || "Aimer Eclipse Arknights");
  const svc = service || "bilibili";
  const build = SERVICE_SEARCH[svc] || SERVICE_SEARCH.bilibili;
  return { url: build(q), label: query || "Aimer — Eclipse", autoplay: false };
}

// ----------------------------------------------------------------
//  Apps — open by name. macOS `open -a` / Windows `start` look the app up by
//  its REAL installed name, so a Chinese nickname ("网易云音乐") won't find an
//  app registered in English ("NetEase Music"). Map the common ones, and try
//  candidates in order, reporting honest success/failure from the exit code.
// ----------------------------------------------------------------
const APP_ALIASES = [
  [/^(网易云音乐|网易云|网易音乐|网易|netease\s*(cloud\s*)?music|netease)$/i, ["NetEase Music", "NeteaseMusic"]],
  [/^(qq音乐|qqmusic|qq\s*music)$/i, ["QQMusic", "QQ音乐"]],
  [/^(微信|wechat)$/i, ["WeChat"]],
  [/^(qq)$/i, ["QQ"]],
  [/^(苹果音乐|apple\s*music)$/i, ["Music"]],
  [/^(spotify|声破天)$/i, ["Spotify"]],
  [/^(微博|weibo)$/i, ["Weibo"]],
  [/^(b站|哔哩哔哩|bilibili)$/i, ["哔哩哔哩", "bilibili"]]
];

function appCandidates(name) {
  const n = name.trim();
  for (const [re, list] of APP_ALIASES) {
    if (re.test(n)) return Array.from(new Set([...list, n]));
  }
  return [n];
}

// App names may be non-ASCII (e.g. 网易云音乐), so validate by *blocking* shell /
// cmd.exe metacharacters and control chars rather than allow-listing ASCII. This
// matters because the Windows path runs `cmd /c start "" <name>`, where &, |, <,
// >, ^, %, quotes, etc. are operators. Spaces and hyphens stay allowed.
const APP_NAME_BAD_CHARS = "&|;<>^`$%\"'\\/";
function isSafeAppName(name) {
  if (typeof name !== "string" || name.length < 1 || name.length > 64) return false;
  for (const ch of name) {
    if (APP_NAME_BAD_CHARS.includes(ch)) return false;
    if (ch.charCodeAt(0) < 0x20) return false; // control chars incl. tab/newline
  }
  return true;
}

// http(s) plus the app URL schemes we knowingly hand to the OS. shell.openExternal
// launches the registered app for these (Spotify, NetEase Cloud Music, Apple Music).
const URL_SCHEME_RE = /^(https?|spotify|orpheus|music):/i;

function clip(text, max) {
  return String(text == null ? "" : text).replace(/\s+/g, " ").trim().slice(0, max);
}

function shortUrl(url) {
  return String(url).replace(/^https?:\/\//i, "").slice(0, 50);
}

function openExternal(target) {
  // shell.openExternal resolves once the OS accepts the request; it does not
  // tell us whether an app or the browser handled it. Treat acceptance as ok.
  return shell.openExternal(target);
}

// Launch one candidate, resolving true only if the OS reports it actually
// opened (exit code 0). macOS `open -a` exits non-zero when no app by that name
// exists, which is exactly how we detect a wrong/missing name.
function launchApp(name) {
  return new Promise((resolve) => {
    let cmd;
    let args;
    if (process.platform === "darwin") {
      cmd = "open";
      args = ["-a", name];
    } else if (process.platform === "win32") {
      // "" is the mandatory (empty) window title so the name is the target.
      cmd = "cmd";
      args = ["/c", "start", "", name];
    } else {
      cmd = "xdg-open";
      args = [name];
    }
    let child;
    try {
      child = spawn(cmd, args, { stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (ok) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
  });
}

async function openApp(name) {
  for (const candidate of appCandidates(name)) {
    // eslint-disable-next-line no-await-in-loop
    if (await launchApp(candidate)) return { ok: true, opened: candidate };
  }
  return { ok: false };
}

// ----------------------------------------------------------------
//  Reminders — she sets a timer and the OS notifies the Doctor (in her voice)
//  when it fires. In-memory only: timers are cleared if the app quits, which is
//  fine for a tray companion that stays running.
// ----------------------------------------------------------------
const MAX_REMINDER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const pendingReminders = new Set();

// Parse "25" / "25m" / "1h" / "30s" / "22:30" into a delay from now (ms).
function parseDelayMs(spec) {
  const s = String(spec || "").trim().toLowerCase();
  const hm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const h = Number(hm[1]);
    const m = Number(hm[2]);
    if (h > 23 || m > 59) return null;
    const now = new Date();
    const t = new Date(now);
    t.setHours(h, m, 0, 0);
    if (t <= now) t.setDate(t.getDate() + 1); // already passed today → tomorrow
    return t.getTime() - now.getTime();
  }
  const rel = s.match(/^(\d+(?:\.\d+)?)\s*([a-z一-龥]*)$/);
  if (!rel) return null;
  const n = parseFloat(rel[1]);
  const u = rel[2];
  let mult;
  if (u === "s" || u === "sec" || u === "秒") mult = 1000;
  else if (u === "h" || u === "hr" || u === "小时" || u === "时") mult = 3600 * 1000;
  else if (u === "" || u === "m" || u === "min" || u === "分" || u === "分钟") mult = 60 * 1000;
  else return null;
  return n * mult;
}

function humanizeDelay(ms) {
  if (ms < 60 * 1000) return `${Math.round(ms / 1000)} 秒后`;
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} 分钟后`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分后` : `${h} 小时后`;
}

function scheduleReminder(delay, message) {
  const id = setTimeout(() => {
    pendingReminders.delete(id);
    if (!Notification.isSupported()) return;
    try {
      new Notification({ title: "PRTS · 普瑞赛斯", body: message, silent: false }).show();
    } catch {
      /* ignore */
    }
  }, delay);
  pendingReminders.add(id);
}

function runRemind(value) {
  const m = String(value).match(/^(\S+)\s*([\s\S]*)$/);
  if (!m) return { ok: false, error: "提醒格式：时间 + 内容（如 25m 休息）" };
  const delay = parseDelayMs(m[1]);
  if (delay == null) return { ok: false, error: "听不懂这个时间（试试 25m / 1h / 30s / 22:30）" };
  if (delay <= 0) return { ok: false, error: "这个时间已经过去了" };
  if (delay > MAX_REMINDER_MS) return { ok: false, error: "提醒最多设到 7 天内" };
  const message = (m[2] || "").trim() || "博士，说好的时间到了。";
  scheduleReminder(delay, message);
  return { ok: true, receipt: `⏰ 已设提醒 · ${humanizeDelay(delay)} · ${clip(message, 40)}` };
}

// ----------------------------------------------------------------
//  Notes — append to a plain .txt in the Doctor's working folder (the chat
//  directory). If no project folder is set (so the effective folder is home),
//  don't litter the home folder — write to the Desktop instead.
// ----------------------------------------------------------------
const NOTES_FILENAME = "PRTS-notes.txt";

function isDir(p) {
  try {
    return Boolean(p) && fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function noteTarget() {
  const home = os.homedir();
  let cwd = "";
  try {
    cwd = String(settings.get("chatCwd") || "").trim();
  } catch {
    cwd = "";
  }
  // A real project folder (not home) → write there. Otherwise → Desktop.
  let dir = cwd && cwd !== home && isDir(cwd) ? cwd : home;
  if (dir === home) {
    const desktop = path.join(home, "Desktop");
    if (isDir(desktop)) dir = desktop;
  }
  const label = dir === path.join(home, "Desktop") ? "桌面" : path.basename(dir) || dir;
  return { file: path.join(dir, NOTES_FILENAME), label };
}

function runNote(value) {
  if (!value) return { ok: false, error: "要记什么呢，博士？" };
  try {
    const { file, label } = noteTarget();
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, "博士的笔记 —— 普瑞赛斯替你记下的\n\n", "utf8");
    }
    const stamp = new Date().toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
    fs.appendFileSync(file, `[${stamp}] ${value}\n`, "utf8");
    return { ok: true, receipt: `📝 记下了（${label}）· ${clip(value, 36)}` };
  } catch {
    return { ok: false, error: "没能写进笔记" };
  }
}

// Run one skill. Returns { ok, receipt } on success (receipt is the short label
// shown as a pill in chat) or { ok: false, error } on failure. Never throws.
async function runSkill(name, arg) {
  const skill = String(name || "").toLowerCase();
  const value = clip(arg, 200);
  try {
    switch (skill) {
      case "play_music": {
        const { url, label, autoplay } = resolveMusic(value);
        await openExternal(url);
        return {
          ok: true,
          receipt: autoplay ? `♪ 为博士播放 ${label}` : `♪ 为博士找到 ${label}（请点开播放）`
        };
      }
      case "web_search": {
        if (!value) return { ok: false, error: "没有要搜索的内容" };
        await openExternal(`https://www.google.com/search?q=${encodeURIComponent(value)}`);
        return { ok: true, receipt: `搜索网页 “${clip(value, 50)}”` };
      }
      case "open_url": {
        const url = value;
        if (!URL_SCHEME_RE.test(url)) return { ok: false, error: "不是有效的网址" };
        await openExternal(url);
        return { ok: true, receipt: `打开 ${shortUrl(url)}` };
      }
      case "open_app": {
        const appName = value;
        if (!isSafeAppName(appName)) return { ok: false, error: "应用名不合法" };
        const res = await openApp(appName);
        if (!res.ok) return { ok: false, error: `没能打开 ${appName}（试试它的本地名称，如 NetEase Music）` };
        return { ok: true, receipt: `打开 ${appName}` };
      }
      case "remind":
        return runRemind(value);
      case "note":
        return runNote(value);
      default:
        return { ok: false, error: `未知技能：${skill}` };
    }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

module.exports = { runSkill, SKILL_NAMES };
