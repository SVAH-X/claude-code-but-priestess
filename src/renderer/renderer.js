// ============================================================
//  PRTS Popover — character animation + chat UI.
// ============================================================

const stage = document.getElementById("petStage");
const canvas = document.getElementById("petCanvas");
const ctx = canvas.getContext("2d");
const bubble = document.getElementById("petBubble");

const chatStream = document.getElementById("chatStream");
const composer = document.getElementById("composer");
const composerInput = document.getElementById("composerInput");
const sendBtn = document.getElementById("sendBtn");
const cancelBtn = document.getElementById("cancelBtn");
const clearBtn = document.getElementById("clearBtn");
const closeBtn = document.getElementById("closeBtn");
const cwdLine = document.getElementById("cwdLine");

// HTML Preview Panel
const mainArea = document.getElementById("mainArea");
const htmlPreview = document.getElementById("htmlPreview");
const previewFrame = document.getElementById("previewFrame");
const previewDivider = document.getElementById("previewDivider");
const previewTitle = document.getElementById("previewTitle");
const openInBrowserBtn = document.getElementById("openInBrowserBtn");
const closePreviewBtn = document.getElementById("closePreviewBtn");

const PREVIEW_SPLIT_MIN = 0.28;
const PREVIEW_SPLIT_MAX = 0.68;
const htmlStore = new Map(); // messageId → htmlContent
const dismissedPreviewIds = new Set(); // messageIds the user manually closed
let activePreviewId = null;
let htmlPanelOpen = false;
let splitRatio = 0.5;
try {
  const saved = localStorage.getItem("htmlPanelSplitRatio");
  if (saved != null) {
    const n = parseFloat(saved);
    if (Number.isFinite(n) && n >= PREVIEW_SPLIT_MIN && n <= PREVIEW_SPLIT_MAX) {
      splitRatio = n;
    }
  }
} catch { /* localStorage blocked */ }

// ============================================================
//  i18n — popover UI text follows the language setting (zh / en)
// ============================================================
const RENDERER_TEXT = {
  zh: {
    chat_empty_hint: "和她说点什么吧。",
    send_failed: (r) => `发送失败: ${r}`,
    clear_confirm: "清除当前对话？长期记忆将继续保留。",
    clear_done: "对话已清除。",
    error_prefix: (m) => `错误: ${m}`,
    cancelled: "已停止。",
    sprite_load_failed: "角色立绘加载失败。",
    no_cli: "未检测到 CLI",
    cwd_home: (p) => `${p} · $HOME · 右键托盘菜单设置`,
    cwd_queue: (n) => `${n} 排队中`,
    cwd_running: "发送中",
    ph_ready: "和她说点什么…（Shift+Enter 换行）",
    ph_running: "她在回复时可以继续输入消息排队…（Shift+Enter 换行）",
    ph_no_cli: "请先安装 Claude Code 或 Codex CLI…",
    btn_clear: "清除",
    btn_clear_title: "清除对话",
    btn_stop: "停止回复",
    btn_stop_title: "停止回复",
    btn_close_title: "关闭窗口（不会退出，她仍在托盘）",
    preview_expand: "▼ 预览",
    preview_collapse: "▸ 预览",
    preview_title: "HTML 预览",
    preview_open: "在浏览器中打开",
    preview_open_title: "在默认浏览器中打开",
    preview_close_title: "关闭预览",
    preview_browser_opened: "已在浏览器中打开。",
    preview_browser_failed: "打开浏览器失败。"
  },
  en: {
    chat_empty_hint: "Say something to her.",
    send_failed: (r) => `Send failed: ${r}`,
    clear_confirm: "Clear this conversation? Long-term memory stays.",
    clear_done: "Conversation cleared.",
    error_prefix: (m) => `Error: ${m}`,
    cancelled: "Stopped.",
    sprite_load_failed: "Failed to load character sprites.",
    no_cli: "No CLI detected",
    cwd_home: (p) => `${p} · $HOME · right-click tray to set`,
    cwd_queue: (n) => `${n} queued`,
    cwd_running: "sending",
    ph_ready: "Say something… (Shift+Enter for newline)",
    ph_running: "You can keep typing while she replies… (Shift+Enter newline)",
    ph_no_cli: "Install Claude Code or Codex CLI first…",
    btn_clear: "Clear",
    btn_clear_title: "Clear conversation",
    btn_stop: "Stop",
    btn_stop_title: "Stop replying",
    btn_close_title: "Close window (doesn't quit — she stays in the tray)",
    preview_expand: "▼ Preview",
    preview_collapse: "▸ Preview",
    preview_title: "HTML Preview",
    preview_open: "Open in Browser",
    preview_open_title: "Open in default browser",
    preview_close_title: "Close preview",
    preview_browser_opened: "Opened in browser.",
    preview_browser_failed: "Failed to open browser."
  }
};

function _l10nLang() {
  const setting = (lastSettingsPayload?.menuLanguage ?? "system");
  if (setting === "zh" || setting === "en") return setting;
  const nav = navigator.language || "";
  if (/^zh\b/i.test(nav)) return "zh";
  return "en";
}

function t(key, ...args) {
  const lang = _l10nLang();
  const val = RENDERER_TEXT[lang]?.[key] ?? RENDERER_TEXT.zh[key] ?? key;
  return typeof val === "function" ? val(...args) : val;
}

function applyL10n() {
  if (clearBtn) { clearBtn.textContent = t("btn_clear"); clearBtn.title = t("btn_clear_title"); }
  if (cancelBtn) { cancelBtn.textContent = t("btn_stop"); cancelBtn.title = t("btn_stop_title"); }
  if (closeBtn) closeBtn.title = t("btn_close_title");
  if (openInBrowserBtn) { openInBrowserBtn.textContent = t("preview_open"); openInBrowserBtn.title = t("preview_open_title"); }
  if (closePreviewBtn) closePreviewBtn.title = t("preview_close_title");
}

// ============================================================
//  Frame loading — same edge-flood-fill technique as before.
// ============================================================
// Two outfits ship with the app,同样的九种表情: "formal" (正装, the classic
// coat, assets/character root — default) and "casual" (休闲, the white
// butterfly dress, assets/character/casual). The tray menu switches them.
const CHARACTER_DIR = window.__CHARACTER_BASE_URI__
  ? new URL(window.__CHARACTER_BASE_URI__)
  : new URL("../../assets/character/", window.location.href);
const CAT_DIR = window.__CHARACTER_BASE_URI__
  ? new URL("普猫猫/", CHARACTER_DIR)
  : new URL("../../assets/character/普猫猫/", window.location.href);

function assetDirFor(outfit) {
  return outfit === "casual" ? new URL("casual/", CHARACTER_DIR) : CHARACTER_DIR;
}

function outfitFrom(payload) {
  return payload?.outfit === "casual" ? "casual" : "formal";
}

const FRAME_FILES = {
  idle: "睁眼.png",
  halfClosed: "半眯眼.png",
  almostClosed: "快闭眼.png",
  closed: "闭眼.png",
  happy: "笑.png",
  angry: "生气.png",
  threat: "威胁.png",
  cry: "哭唧唧.png",
  sleep: "睡觉.png"
};

const BLINK_MIN_MS = 4500;
const BLINK_MAX_MS = 9500;
const BLINK_SEQUENCE = [
  ["idle", 70],
  ["halfClosed", 70],
  ["almostClosed", 60],
  ["closed", 110],
  ["idle", 0]
];

const MOOD_PROFILES = {
  idle:    { breathHz: 0.24, breathAmp: 0.014, bobHz: 0.10, bobAmp: 1.8, shake: 0    },
  happy:   { breathHz: 0.38, breathAmp: 0.024, bobHz: 0.50, bobAmp: 3.2, shake: 0    },
  thinking:{ breathHz: 0.45, breathAmp: 0.020, bobHz: 0.35, bobAmp: 2.0, shake: 0    },
  coding:  { breathHz: 0.65, breathAmp: 0.028, bobHz: 0,    bobAmp: 0,   shake: 1.6  },
  cry:     { breathHz: 0.18, breathAmp: 0.020, bobHz: 0,    bobAmp: 0,   shake: 0.5  },
  angry:   { breathHz: 0.65, breathAmp: 0.028, bobHz: 0,    bobAmp: 0,   shake: 1.4  },
  threat:  { breathHz: 0.75, breathAmp: 0.034, bobHz: 0,    bobAmp: 0,   shake: 2.4  },
  sleep:   { breathHz: 0.13, breathAmp: 0.028, bobHz: 0,    bobAmp: 0,   shake: 0    }
};

// Frame to show for each mood (where it differs from the mood name).
const MOOD_FRAME = {
  idle: "idle",
  happy: "happy",
  thinking: "happy",
  coding: "threat",
  cry: "cry",
  angry: "angry",
  threat: "threat",
  sleep: "sleep"
};

const CAT_FRAME_FILES = {
  normal: "普猫猫.png",
  crying: "普猫猫哭.png"
};

let catMode = false;
let catMood = "normal";
let catFrames = {};

const state = {
  mood: "idle",
  expression: "idle",
  punch: 0,
  tremble: 0,
  squeeze: 0,
  dragX: 0,
  dragY: 0
};

// Two-layer mood model:
//  - baseMood reflects chat / inactivity (long-running)
//  - lockedMood is a short override from user clicks (3s)
let baseMood = "idle";
let lockedMood = null;
let lockUntil = 0;
let lockReleaseTimer = null;

const TEMPORARY_MS = 3000;
const CRY_AFTER_MS = 10 * 60 * 1000;
const SLEEP_AFTER_MS = 15 * 60 * 1000;

let clickCount = 0;
let clickCountResetTimer = null;
let cryTimer = null;
let sleepTimer = null;

let frames = {};

function isEdgeBackground(data, index) {
  const r = data[index];
  const g = data[index + 1];
  const b = data[index + 2];
  const a = data[index + 3];
  const lightnessGap = 765 - r - g - b;
  const colorSpan = Math.max(r, g, b) - Math.min(r, g, b);
  return a > 0 && lightnessGap < 95 && colorSpan < 30;
}

// Bounding box of meaningfully-opaque pixels — shared by the pre-flattened
// fast path and the legacy fill path.
function opaqueBbox(data, width, height, alphaMin = 1) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] >= alphaMin) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    return { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1 };
  }
  return { minX, minY, maxX, maxY };
}

function prepareTransparentFrame(image) {
  const source = document.createElement("canvas");
  source.width = image.naturalWidth;
  source.height = image.naturalHeight;
  const srcCtx = source.getContext("2d", { willReadFrequently: true });
  srcCtx.drawImage(image, 0, 0);
  const imageData = srcCtx.getImageData(0, 0, source.width, source.height);
  const { data, width, height } = imageData;

  // Shipped frames have their background (and the enclosed hair gaps, which
  // an edge fill can never reach) baked out by scripts/
  // flatten-character-assets.js. Transparent corners mean there is nothing
  // left to remove — skip the fill and just measure the character. The full
  // fill below stays as a fallback for unprocessed/custom art.
  const cornerIndices = [
    3,
    (width - 1) * 4 + 3,
    (height - 1) * width * 4 + 3,
    (width * height - 1) * 4 + 3
  ];
  if (cornerIndices.every((i) => data[i] === 0)) {
    return { canvas: source, bbox: opaqueBbox(data, width, height) };
  }

  const transparent = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  function tryPush(x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const pixelIndex = y * width + x;
    if (transparent[pixelIndex] === 1) return;
    if (!isEdgeBackground(data, pixelIndex * 4)) return;
    transparent[pixelIndex] = 1;
    queue[tail++] = pixelIndex;
  }

  for (let x = 0; x < width; x++) {
    tryPush(x, 0);
    tryPush(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    tryPush(0, y);
    tryPush(width - 1, y);
  }
  while (head < tail) {
    const pixelIndex = queue[head++];
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    tryPush(x + 1, y);
    tryPush(x - 1, y);
    tryPush(x, y + 1);
    tryPush(x, y - 1);
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pi = y * width + x;
      const di = pi * 4;
      if (transparent[pi] === 1) {
        data[di + 3] = 0;
        continue;
      }
      if (data[di + 3] > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  // Halo cleanup — the flood fill above is binary, so anti-aliased edge
  // pixels (light gray, low saturation) survive as a hazy fringe around the
  // silhouette when rendered over the popover vibrancy. For pixels touching
  // the flooded region that look like background-tinted edges, fade alpha
  // proportionally to how white-leaning they are.
  const HALO_MIN_SUM = 480;   // avg ≥ 160
  const HALO_FULL_SUM = 720;  // avg ≥ 240 → fully transparent
  const HALO_MAX_SAT = 60;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pi = y * width + x;
      if (transparent[pi] === 1) continue;
      const di = pi * 4;
      if (data[di + 3] === 0) continue;
      const r = data[di];
      const g = data[di + 1];
      const b = data[di + 2];
      const sumRGB = r + g + b;
      if (sumRGB < HALO_MIN_SUM) continue;
      const colorSpan = Math.max(r, g, b) - Math.min(r, g, b);
      if (colorSpan > HALO_MAX_SAT) continue;
      const touchesBg =
        (x > 0 && transparent[pi - 1] === 1) ||
        (x < width - 1 && transparent[pi + 1] === 1) ||
        (y > 0 && transparent[pi - width] === 1) ||
        (y < height - 1 && transparent[pi + width] === 1);
      if (!touchesBg) continue;
      const t = Math.min(1, (sumRGB - HALO_MIN_SUM) / (HALO_FULL_SUM - HALO_MIN_SUM));
      data[di + 3] = Math.round(data[di + 3] * (1 - t));
    }
  }

  srcCtx.putImageData(imageData, 0, 0);
  if (maxX < minX || maxY < minY) {
    return { canvas: source, bbox: { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1 } };
  }
  return { canvas: source, bbox: { minX, minY, maxX, maxY } };
}

async function loadFrame(fileName, dir) {
  const image = new Image();
  image.decoding = "async";
  image.src = new URL(fileName, dir).href;
  await image.decode();
  return prepareTransparentFrame(image);
}

async function loadAllFrames(outfit) {
  const dir = assetDirFor(outfit);
  const entries = await Promise.all(
    Object.entries(FRAME_FILES).map(async ([name, file]) => [name, await loadFrame(file, dir)])
  );

  // Crop every frame to the SAME union bounding box. Each pose has a slightly
  // different silhouette (eyes open vs closed, crying tear streaks, etc.); if
  // we cropped each one to its own tight box, frame.width/height would change
  // on every blink and mood swap, which made `renderExpression` recompute the
  // scale and origin and visibly jolt the character.
  let uMinX = Infinity;
  let uMinY = Infinity;
  let uMaxX = -Infinity;
  let uMaxY = -Infinity;
  let sourceWidth = 0;
  let sourceHeight = 0;
  for (const [, { canvas, bbox }] of entries) {
    sourceWidth = canvas.width;
    sourceHeight = canvas.height;
    if (bbox.minX < uMinX) uMinX = bbox.minX;
    if (bbox.minY < uMinY) uMinY = bbox.minY;
    if (bbox.maxX > uMaxX) uMaxX = bbox.maxX;
    if (bbox.maxY > uMaxY) uMaxY = bbox.maxY;
  }
  const pad = 16;
  uMinX = Math.max(0, uMinX - pad);
  uMinY = Math.max(0, uMinY - pad);
  uMaxX = Math.min(sourceWidth - 1, uMaxX + pad);
  uMaxY = Math.min(sourceHeight - 1, uMaxY + pad);
  const cropW = uMaxX - uMinX + 1;
  const cropH = uMaxY - uMinY + 1;

  const loaded = {};
  for (const [name, { canvas }] of entries) {
    const out = document.createElement("canvas");
    out.width = cropW;
    out.height = cropH;
    out.getContext("2d").drawImage(canvas, uMinX, uMinY, cropW, cropH, 0, 0, cropW, cropH);
    loaded[name] = out;
  }
  return loaded;
}

async function loadAllCatFrames() {
  const entries = await Promise.all(
    Object.entries(CAT_FRAME_FILES).map(async ([name, file]) => {
      const { canvas } = await loadFrame(file, CAT_DIR);
      return [name, canvas];
    })
  );
  catFrames = Object.fromEntries(entries);
}

function applyCatMode(payload) {
  catMode = !!payload?.cat;
  catMood = payload?.mood || "normal";
  drawCharacter();
}

// Swap her wardrobe. Loads are token-guarded so a rapid double-switch can't
// install stale frames; the swap itself is a single atomic assignment, safe
// mid-blink and mid-drag.
let loadedOutfit = null;
let pendingOutfit = null;
let outfitLoadToken = 0;

async function applyOutfit(outfit) {
  if (outfit === loadedOutfit || outfit === pendingOutfit) return;
  pendingOutfit = outfit;
  const token = ++outfitLoadToken;
  try {
    const next = await loadAllFrames(outfit);
    if (token !== outfitLoadToken) return;
    frames = next;
    loadedOutfit = outfit;
    resizeCanvas();
    renderExpression(MOOD_FRAME[state.mood] || state.mood);
  } finally {
    if (token === outfitLoadToken) pendingOutfit = null;
  }
}

// ============================================================
//  Canvas + render
// ============================================================
let lastStageWidth = 0;
let lastStageHeight = 0;

// Live animation transform. We bake this into the canvas draw call every frame
// instead of using a CSS transform on the canvas element — a CSS-transformed
// canvas under the stage's overflow:hidden clip leaves an un-cleared sliver of
// the previous paint ("ghost feet"); a full clearRect+drawImage each frame
// cannot.
let animTx = 0;
let animTy = 0;
let animScaleX = 1;
let animScaleY = 1;

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const nextW = Math.max(1, Math.round(rect.width * ratio));
  const nextH = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== nextW || canvas.height !== nextH) {
    canvas.width = nextW;
    canvas.height = nextH;
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  drawCharacter();
  handleStageResize(rect);
}

function renderExpression(name) {
  if (!frames[name]) return;
  state.expression = name;
  stage.dataset.mood = state.mood;
  drawCharacter();
}

// Draw the current frame bottom-anchored, with the live animation scale/offset
// baked into the draw. Clears the whole canvas first, so nothing can linger.
function drawCharacter() {
  const frame = catMode
    ? (catFrames[catMood] || catFrames.normal)
    : frames[state.expression];
  if (!frame) return;
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  const availableW = Math.max(1, rect.width - 24);
  const availableH = Math.max(1, rect.height - 12);
  const base = Math.max(0.01, Math.min(availableW / frame.width, availableH / frame.height));
  const drawW = frame.width * base * animScaleX;
  const drawH = frame.height * base * animScaleY;
  const drawX = (rect.width - drawW) / 2 + animTx;
  const drawY = rect.height - drawH + animTy;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(frame, drawX, drawY, drawW, drawH);
}

// ============================================================
//  Ambient micro-motion via CSS transform on the canvas.
// ============================================================
const TWO_PI = Math.PI * 2;
let lastTick = performance.now();
let breathPhase = Math.random() * TWO_PI;
let bobPhase = Math.random() * TWO_PI;

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function tick(now) {
  const dt = Math.min(0.066, (now - lastTick) / 1000);
  lastTick = now;

  const profile = MOOD_PROFILES[state.mood] || MOOD_PROFILES.idle;
  breathPhase = (breathPhase + dt * profile.breathHz * TWO_PI) % TWO_PI;
  bobPhase = (bobPhase + dt * profile.bobHz * TWO_PI) % TWO_PI;

  const breath = 1 + Math.sin(breathPhase) * profile.breathAmp;
  const bob = Math.sin(bobPhase) * profile.bobAmp;

  state.punch *= Math.exp(-dt * 6);
  state.tremble *= Math.exp(-dt * 4);

  const ambientShake = profile.shake + state.tremble;
  const shakeX = ambientShake ? (Math.random() - 0.5) * ambientShake * 2 : 0;
  const shakeY = ambientShake ? (Math.random() - 0.5) * ambientShake : 0;

  if (!isDragging) {
    const speed = Math.hypot(dragVelocityX, dragVelocityY);
    if (speed > 1) {
      state.dragX += dragVelocityX * dt;
      state.dragY += dragVelocityY * dt;
      const hit = clampDragToBounds();
      if (hit.x) dragVelocityX = 0;
      if (hit.y) dragVelocityY = 0;
      const friction = Math.exp(-dt * 5.2);
      dragVelocityX *= friction;
      dragVelocityY *= friction;
      if (Math.hypot(dragVelocityX, dragVelocityY) < 8) {
        dragVelocityX = 0;
        dragVelocityY = 0;
      }
    } else {
      clampDragToBounds();
    }
  }
  state.squeeze *= Math.exp(-dt * 5);

  const scale = breath + state.punch;
  const squeeze = Math.max(0, Math.min(1, state.squeeze));
  animScaleX = scale * (1 - squeeze * 0.055);
  animScaleY = scale * (1 + squeeze * 0.035);
  animTx = state.dragX + shakeX;
  animTy = state.dragY + bob + shakeY;
  drawCharacter();

  requestAnimationFrame(tick);
}

// ============================================================
//  Blink scheduling — idle mood only.
// ============================================================
let blinkTimer = null;
let blinkStepTimer = null;
let blinkToken = 0;

function clearBlink() {
  blinkToken++;
  clearTimeout(blinkTimer);
  clearTimeout(blinkStepTimer);
}

function scheduleBlink() {
  clearBlink();
  if (state.mood !== "idle") return;
  const token = blinkToken;
  blinkTimer = setTimeout(() => runBlink(token), BLINK_MIN_MS + Math.random() * (BLINK_MAX_MS - BLINK_MIN_MS));
}

function runBlink(token) {
  if (token !== blinkToken || state.mood !== "idle") return;
  let i = 0;
  function step() {
    if (token !== blinkToken || state.mood !== "idle") return;
    const [name, ms] = BLINK_SEQUENCE[i++];
    renderExpression(name);
    if (i >= BLINK_SEQUENCE.length) {
      renderExpression("idle");
      scheduleBlink();
      return;
    }
    blinkStepTimer = setTimeout(step, ms);
  }
  step();
}

// ============================================================
//  Mood transitions — base (chat-driven) vs locked (click-driven).
// ============================================================
function applyMood(mood) {
  state.mood = mood;
  stage.dataset.mood = mood;
  renderExpression(MOOD_FRAME[mood] || mood);
  if (mood === "idle") {
    scheduleBlink();
  } else {
    clearBlink();
  }
}

function effectiveMood() {
  return Date.now() < lockUntil && lockedMood ? lockedMood : baseMood;
}

function setBaseMood(mood) {
  baseMood = mood;
  if (Date.now() >= lockUntil) {
    applyMood(mood);
  }
}

function lockMood(mood, options = {}) {
  const duration = options.durationMs ?? TEMPORARY_MS;
  lockedMood = mood;
  lockUntil = Date.now() + duration;
  applyMood(mood);
  if (mood === "threat" || mood === "angry") {
    state.tremble = mood === "threat" ? 1.8 : 1.2;
  }
  clearTimeout(lockReleaseTimer);
  lockReleaseTimer = setTimeout(() => {
    if (Date.now() >= lockUntil) {
      lockedMood = null;
      applyMood(baseMood);
    }
  }, duration + 20);
}

function flashPunch(amount = 0.06) {
  state.punch = amount;
}

// ============================================================
//  Inactivity — cry after 10 min, sleep after 15 min.
//  Only triggers while base is "idle" (chat not running, no click lock).
// ============================================================
function resetInactivityTimers() {
  clearTimeout(cryTimer);
  clearTimeout(sleepTimer);
  cryTimer = setTimeout(() => {
    if (baseMood === "idle") setBaseMood("cry");
  }, CRY_AFTER_MS);
  sleepTimer = setTimeout(() => {
    if (baseMood === "idle" || baseMood === "cry") setBaseMood("sleep");
  }, SLEEP_AFTER_MS);
}

// ============================================================
//  Click handling on the stage — angry / threat / wake-up.
// ============================================================
function bumpClickCount() {
  clickCount += 1;
  clearTimeout(clickCountResetTimer);
  // Click streaks reset if you pause for ~1.5s.
  clickCountResetTimer = setTimeout(() => {
    clickCount = 0;
  }, 1500);
}

const CLICK_TIER = { cry: 0, happy: 1, angry: 2, threat: 3 };

// ============================================================
//  Drag handling on the stage — pull her around inside the box.
//  While dragging she shows the angry face. On release, her momentum decays
//  in place instead of snapping her back to the center.
// ============================================================
const DRAG_THRESHOLD = 4;             // px before a mousedown becomes a drag
const DRAG_LOCK_DURATION = 10 * 60_000; // long enough that auto-release
                                       // never fires mid-grab; we release manually
const MAX_DRAG_VELOCITY = 1800;       // px / sec, keeps accidental spikes sane

let pendingDrag = false;
let isDragging = false;
let dragStartMouseX = 0;
let dragStartMouseY = 0;
let dragStartOffsetX = 0;
let dragStartOffsetY = 0;
let dragVelocityX = 0;
let dragVelocityY = 0;
let lastDragSampleX = 0;
let lastDragSampleY = 0;
let lastDragSampleAt = 0;
let justDragged = false;
let justDraggedTimer = null;

function getDragBounds() {
  const sr = stage.getBoundingClientRect();
  const frame = frames.idle || Object.values(frames)[0];
  if (!frame) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  // Mirror the math in renderExpression so the bounds match the actual
  // on-screen character rect.
  const availableW = Math.max(1, sr.width - 24);
  const availableH = Math.max(1, sr.height - 12);
  const scale = Math.max(0.01, Math.min(availableW / frame.width, availableH / frame.height));
  const charW = frame.width * scale;
  const charH = frame.height * scale;
  const charLeft = (sr.width - charW) / 2;
  const charTop = sr.height - charH;
  return {
    minX: -charLeft,
    maxX: sr.width - charLeft - charW,
    minY: -charTop,
    maxY: 0
  };
}

function clampDragToBounds() {
  const b = getDragBounds();
  const nextX = clamp(state.dragX, b.minX, b.maxX);
  const nextY = clamp(state.dragY, b.minY, b.maxY);
  const hit = {
    x: Math.abs(nextX - state.dragX) > 0.01,
    y: Math.abs(nextY - state.dragY) > 0.01
  };
  state.dragX = nextX;
  state.dragY = nextY;
  return { ...hit, any: hit.x || hit.y };
}

function reactToSpaceCompression(strength = 0.6) {
  state.squeeze = Math.max(state.squeeze, clamp(strength, 0.25, 1));
  if (!isDragging) {
    lockMood("cry", { durationMs: 1600 });
  }
}

function handleStageResize(rect) {
  if (!rect || !frames.idle) return;
  const hadPrevious = lastStageWidth > 0 && lastStageHeight > 0;
  const shrankWidth = hadPrevious && rect.width < lastStageWidth - 2;
  const shrankHeight = hadPrevious && rect.height < lastStageHeight - 2;
  const clamped = clampDragToBounds();

  if (shrankWidth || shrankHeight || clamped.any) {
    const lostW = Math.max(0, lastStageWidth - rect.width);
    const lostH = Math.max(0, lastStageHeight - rect.height);
    const strength = Math.max(clamped.any ? 0.75 : 0, lostW / 120, lostH / 90);
    reactToSpaceCompression(strength || 0.35);
    if (clamped.x) dragVelocityX = 0;
    if (clamped.y) dragVelocityY = 0;
  }

  lastStageWidth = rect.width;
  lastStageHeight = rect.height;
}

function releaseClickLock() {
  clearTimeout(lockReleaseTimer);
  lockUntil = 0;
  lockedMood = null;
  applyMood(baseMood);
}

// True only when the point lands on one of her actual (opaque) pixels, so
// clicking empty space in the stage box doesn't trigger a reaction or a drag.
function isPointOnCharacter(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const x = Math.floor((clientX - rect.left) * (canvas.width / rect.width));
  const y = Math.floor((clientY - rect.top) * (canvas.height / rect.height));
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false;
  try {
    return ctx.getImageData(x, y, 1, 1).data[3] > 16;
  } catch {
    return true; // if pixel readback is blocked, don't break interaction
  }
}

function handleStageMouseDown(event) {
  if (event.button !== 0) return;
  if (!isPointOnCharacter(event.clientX, event.clientY)) return;
  pendingDrag = true;
  dragStartMouseX = event.clientX;
  dragStartMouseY = event.clientY;
  dragStartOffsetX = state.dragX;
  dragStartOffsetY = state.dragY;
  dragVelocityX = 0;
  dragVelocityY = 0;
  lastDragSampleX = state.dragX;
  lastDragSampleY = state.dragY;
  lastDragSampleAt = performance.now();
}

function handleDocumentMouseMove(event) {
  if (!pendingDrag) return;
  const dx = event.clientX - dragStartMouseX;
  const dy = event.clientY - dragStartMouseY;
  if (!isDragging) {
    if (Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
    // Crossed the threshold — promote from pending to active drag.
    isDragging = true;
    stage.classList.add("is-dragging");
    lockMood("angry", { durationMs: DRAG_LOCK_DURATION });
  }
  const b = getDragBounds();
  const rawX = dragStartOffsetX + dx;
  const rawY = dragStartOffsetY + dy;
  const nextX = clamp(rawX, b.minX, b.maxX);
  const nextY = clamp(rawY, b.minY, b.maxY);
  const now = performance.now();
  const dt = Math.max(0.016, (now - lastDragSampleAt) / 1000);
  dragVelocityX = clamp((nextX - lastDragSampleX) / dt, -MAX_DRAG_VELOCITY, MAX_DRAG_VELOCITY);
  dragVelocityY = clamp((nextY - lastDragSampleY) / dt, -MAX_DRAG_VELOCITY, MAX_DRAG_VELOCITY);
  if (nextX !== rawX) dragVelocityX = 0;
  if (nextY !== rawY) dragVelocityY = 0;
  state.dragX = nextX;
  state.dragY = nextY;
  lastDragSampleX = nextX;
  lastDragSampleY = nextY;
  lastDragSampleAt = now;
}

function handleDocumentMouseUp(event) {
  if (event.button !== 0) return;
  if (!pendingDrag) return;
  pendingDrag = false;
  if (!isDragging) return; // pure click; let handleStageClick run unchanged.
  isDragging = false;
  stage.classList.remove("is-dragging");
  releaseClickLock();
  if (Math.hypot(dragVelocityX, dragVelocityY) < 35) {
    dragVelocityX = 0;
    dragVelocityY = 0;
  }
  // Swallow the click event the browser will dispatch right after this
  // mouseup so we don't immediately switch into happy/angry.
  justDragged = true;
  clearTimeout(justDraggedTimer);
  justDraggedTimer = setTimeout(() => {
    justDragged = false;
  }, 80);
}

stage.addEventListener("mousedown", handleStageMouseDown);
document.addEventListener("mousemove", handleDocumentMouseMove);
document.addEventListener("mouseup", handleDocumentMouseUp);

// ============================================================
//  Window resize — explicit edge handles only. The main process supplies the
//  actual Electron bounds so Windows display scaling cannot shrink the window
//  when a drag begins.
// ============================================================
let activeResizeEdge = null;
let resizePointerId = null;
let resizeStartScreenX = 0;
let resizeStartScreenY = 0;
let resizeStartBounds = null;

async function handleResizePointerDown(event) {
  if (event.button !== 0) return;
  const edge = event.currentTarget?.dataset?.edge;
  if (!edge) return;
  event.preventDefault();
  event.stopPropagation();
  activeResizeEdge = edge;
  resizePointerId = event.pointerId;
  resizeStartScreenX = event.screenX;
  resizeStartScreenY = event.screenY;
  try {
    event.currentTarget.setPointerCapture?.(event.pointerId);
  } catch {
    /* continue without capture */
  }
  const bounds = await window.petApi?.getPopoverBounds?.();
  if (activeResizeEdge !== edge || resizePointerId !== event.pointerId || !bounds) return;
  resizeStartBounds = bounds;
  document.body.classList.add("is-window-resizing");
}

function handleResizePointerMove(event) {
  if (!activeResizeEdge || !resizeStartBounds) return;
  event.preventDefault();
  const dx = event.screenX - resizeStartScreenX;
  const dy = event.screenY - resizeStartScreenY;
  if (Math.hypot(dx, dy) < 4) return;
  window.petApi?.resizePopoverDrag?.({
    edge: activeResizeEdge,
    start: resizeStartBounds,
    dx,
    dy
  })?.catch?.(() => {});
}

function handleResizePointerUp(event) {
  if (!activeResizeEdge) return;
  try {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  } catch {
    /* already released */
  }
  activeResizeEdge = null;
  resizePointerId = null;
  resizeStartBounds = null;
  document.body.classList.remove("is-window-resizing");
}

for (const handle of document.querySelectorAll(".resize-edge")) {
  handle.addEventListener("pointerdown", handleResizePointerDown);
  handle.addEventListener("pointermove", handleResizePointerMove);
  handle.addEventListener("pointerup", handleResizePointerUp);
  handle.addEventListener("pointercancel", handleResizePointerUp);
}

// ============================================================
//  Window move — drag the whole app by its top bar, like a normal window
//  title bar. We move it manually (via the main process) instead of using
//  -webkit-app-region: drag so we can keep her smiling (笑) while she travels.
//  window.screenX/screenY give the window's top-left in screen space; we use
//  the absolute pointer delta from the grab point so the move never drifts.
// ============================================================
const dragHandle = document.getElementById("dragHandle");
let isWindowMoving = false;
let winMoveStartScreenX = 0;
let winMoveStartScreenY = 0;
// NaN sentinel — move IPC skips pointer-move events until the main process
// responds with real bounds, so mixed CSS/device-pixel coordinates on Windows
// DPI scaling cannot drift the window position toward the wrong corner.
let winMoveStartX = NaN;
let winMoveStartY = NaN;

const MOVE_THRESHOLD = 3; // px — ignore sub-pixel jitter on quiet input devices
const IS_WINDOWS = window.petApi?.isWindows === true;

async function handleHeaderPointerDown(event) {
  if (event.button !== 0) return;
  if (event.target.closest("button")) return;
  isWindowMoving = true;
  winMoveStartScreenX = event.screenX;
  winMoveStartScreenY = event.screenY;

  if (IS_WINDOWS) {
    event.preventDefault();
    event.stopPropagation();
    // Tear down any stale listeners from a previous drag whose pointerup
    // was lost (e.g. released outside the window at a screen edge).
    document.removeEventListener("pointermove", handleHeaderPointerMove);
    document.removeEventListener("pointerup", handleHeaderPointerUpOnce);
    document.removeEventListener("pointercancel", handleHeaderPointerUpOnce);
    // Document-level listeners avoid Win32 SetCapture() → spurious WM_SIZE
    // on frameless windows that shrinks the popover while pressed.
    document.addEventListener("pointermove", handleHeaderPointerMove);
    document.addEventListener("pointerup", handleHeaderPointerUpOnce);
    document.addEventListener("pointercancel", handleHeaderPointerUpOnce);
  } else {
    try {
      dragHandle.setPointerCapture(event.pointerId);
    } catch {
      /* continue without capture */
    }
  }

  document.body.classList.add("is-window-moving");
  lockMood("happy", { durationMs: DRAG_LOCK_DURATION });

  const bounds = await window.petApi?.getPopoverBounds?.({ forMove: true });
  if (!isWindowMoving || !bounds) return;
  winMoveStartX = bounds.x;
  winMoveStartY = bounds.y;
}

function handleHeaderPointerMove(event) {
  if (!isWindowMoving) return;
  if (!Number.isFinite(winMoveStartX)) return;

  const dx = event.screenX - winMoveStartScreenX;
  const dy = event.screenY - winMoveStartScreenY;
  if (Math.abs(dx) < MOVE_THRESHOLD && Math.abs(dy) < MOVE_THRESHOLD) return;

  event.preventDefault();
  window.petApi?.movePopover?.({
    x: winMoveStartX + dx,
    y: winMoveStartY + dy
  })?.catch?.(() => {});
}

// Windows only: wrapper that tears down document-level listeners
function handleHeaderPointerUpOnce(event) {
  document.removeEventListener("pointermove", handleHeaderPointerMove);
  document.removeEventListener("pointerup", handleHeaderPointerUpOnce);
  document.removeEventListener("pointercancel", handleHeaderPointerUpOnce);
  handleHeaderPointerUp(event);
}

function handleHeaderPointerUp(event) {
  if (!isWindowMoving) return;
  isWindowMoving = false;
  winMoveStartX = NaN;
  winMoveStartY = NaN;

  if (IS_WINDOWS) {
    // document listeners are torn down by handleHeaderPointerUpOnce above
  } else {
    try {
      dragHandle.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  }

  document.body.classList.remove("is-window-moving");
  releaseClickLock();

  if (IS_WINDOWS) {
    window.petApi?.endMovePopover?.()?.catch?.(() => {});
  }
}

dragHandle?.addEventListener("pointerdown", handleHeaderPointerDown);
if (IS_WINDOWS) {
  // pointermove / pointerup are registered on document during drag so the
  // pointer is tracked even when it leaves the header — without invoking
  // setPointerCapture, whose underlying Win32 SetCapture() causes the
  // spurious WM_SIZE on Windows frameless windows.
} else {
  dragHandle?.addEventListener("pointermove", handleHeaderPointerMove);
  dragHandle?.addEventListener("pointerup", handleHeaderPointerUp);
  dragHandle?.addEventListener("pointercancel", handleHeaderPointerUp);
}

function handleStageClick(event) {
  if (justDragged) {
    justDragged = false;
    return;
  }
  // Only react to clicks that actually land on her, not on empty stage space.
  if (event && !isPointOnCharacter(event.clientX, event.clientY)) return;
  resetInactivityTimers();
  flashPunch(0.05);

  if (baseMood === "sleep") {
    baseMood = "idle";
    clickCount = 0;
    lockMood("angry");
    return;
  }
  if (baseMood === "cry") {
    baseMood = "idle";
    clickCount = 0;
    lockMood("happy");
    return;
  }

  bumpClickCount();

  let next;
  if (clickCount >= 10) {
    clickCount = 0;
    next = "threat";
  } else if (clickCount >= 5) {
    next = "angry";
  } else {
    next = "happy";
  }

  // Re-evaluate every click so a click streak can escalate happy → angry →
  // threat. But don't visually downgrade mid-lock (e.g. threat back to happy
  // when the streak resets), so a stronger mood stays put for its full hold.
  const lockActive = Date.now() < lockUntil;
  if (!lockActive || CLICK_TIER[next] >= CLICK_TIER[lockedMood]) {
    lockMood(next);
  }
}

// ============================================================
//  Speech bubble
// ============================================================
let bubbleTimer = null;
function showBubble(text, durationMs = 3600) {
  if (!text) return;
  bubble.textContent = text;
  bubble.classList.add("show");
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubble.classList.remove("show"), durationMs);
}

// ============================================================
//  Chat UI
// ============================================================
let chatRunning = false;
let backendReady = true;
let currentAssistantId = null;
let lastHistory = [];

// Tool pills are collapsed to a compact label by default, so a run of commands
// and their output can't bury what she actually said (which sits just above the
// pills). This tracks the ones the Doctor has expanded so the choice survives
// the frequent full re-renders of the chat stream.
const toolExpanded = new Set();

// Model-chosen expression for the current reply (from the persona's hidden
// [[mood:X]] tag). Applied to her face when the reply finishes, so her
// expression matches what she just said.
const MODEL_MOOD_FRAME = {
  calm: "idle",
  smile: "happy",
  sad: "cry",
  angry: "angry",
  sleepy: "sleep",
  threat: "threat"
};
let pendingModelMood = null;

// ----- Tiny safe markdown renderer for assistant messages -----
// Supports: fenced code blocks, inline code, **bold**, *italic*, [text](url),
// headings (#/##/###), and line breaks. Escapes HTML; restricts links to http(s).
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

// Inline-level markdown — escape first, then code / bold / italic / links.
// Shared by the main flow and the contents of list items / blockquotes.
function inlineMd(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`\n]+?)`/g, (_, code) => `<code>${code}</code>`);
  s = s.replace(/\*\*([^*\n][^*]*?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
}

function renderMarkdown(input) {
  if (!input) return "";
  const codeBlocks = [];
  // Pull out fenced blocks first so other rules don't munge their contents.
  let src = String(input).replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push({ lang: lang.toLowerCase(), code });
    return `\fCB${codeBlocks.length - 1}\f`;
  });

  // Pull out block elements (lists, blockquotes) into placeholders before the
  // newline -> <br> flattening, rendering their contents with inlineMd.
  const htmlBlocks = [];
  const stash = (html) => `\fHB${htmlBlocks.push(html) - 1}\f`;
  const listItems = (block, marker) =>
    block.trimEnd().split("\n")
      .map((l) => `<li>${inlineMd(l.replace(marker, ""))}</li>`)
      .join("");
  src = src.replace(/(?:^[ \t]*[-*][ \t]+.*(?:\n|$))+/gm,
    (block) => `\n${stash(`<ul>${listItems(block, /^[ \t]*[-*][ \t]+/)}</ul>`)}\n`);
  src = src.replace(/(?:^[ \t]*\d+\.[ \t]+.*(?:\n|$))+/gm,
    (block) => `\n${stash(`<ol>${listItems(block, /^[ \t]*\d+\.[ \t]+/)}</ol>`)}\n`);
  src = src.replace(/(?:^[ \t]*>[ \t]?.*(?:\n|$))+/gm, (block) =>
    `\n${stash(`<blockquote>${block.trimEnd().split("\n")
      .map((l) => inlineMd(l.replace(/^[ \t]*>[ \t]?/, ""))).join("<br>")}</blockquote>`)}\n`);

  src = escapeHtml(src);
  // Inline code
  src = src.replace(/`([^`\n]+?)`/g, (_, code) => `<code>${code}</code>`);
  // Bold
  src = src.replace(/\*\*([^*\n][^*]*?)\*\*/g, "<strong>$1</strong>");
  // Italic (avoid greedy capture across newlines)
  src = src.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
  // Headings
  src = src.replace(/^(#{1,3}) (.+)$/gm, (_, h, t) => `<h${h.length}>${t}</h${h.length}>`);
  // Links — http/https only
  src = src.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  // Newlines -> <br>; collapse extras
  src = src.replace(/\n{2,}/g, "<br><br>").replace(/\n/g, "<br>");
  // Re-insert block elements first (absorbing the <br>s the flattening left
  // around the placeholders, since these are already block-level)…
  src = src.replace(/(?:<br>)*\fHB(\d+)\f(?:<br>)*/g, (_, idx) => htmlBlocks[Number(idx)]);
  // …then the fenced code blocks.
  src = src.replace(/\fCB(\d+)\f/g, (_, idx) => {
    const { lang, code } = codeBlocks[Number(idx)];
    const langClass = lang ? ` class="lang-${escapeHtml(lang)}"` : "";
    return `<pre><code${langClass}>${escapeHtml(code)}</code></pre>`;
  });
  return src;
}

// Rendered-markdown cache. Every history event (each tool pill, each tool
// result) re-renders the whole stream, which made re-parsing every finished
// bubble the hot path in long sessions. Keyed by message id, invalidated by
// text change; pruned in renderHistory so it never outlives the history.
const mdCache = new Map(); // messageId -> { text, html }

function renderMarkdownCached(msg) {
  const cached = mdCache.get(msg.id);
  if (cached && cached.text === msg.text) return cached.html;
  const html = renderMarkdown(msg.text || "");
  mdCache.set(msg.id, { text: msg.text, html });
  return html;
}

let moodResetTimer = null;

function clearMoodResetTimer() {
  if (moodResetTimer) {
    clearTimeout(moodResetTimer);
    moodResetTimer = null;
  }
}

function renderThinkingBubble(el) {
  el.classList.add("thinking");
  el.innerHTML = '<span class="thinking-dots" aria-label="Thinking"><span></span><span></span><span></span></span>';
}

function formatBubbleTime(ts) {
  const date = new Date(Number(ts) || Date.now());
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function appendBubbleTime(el, msg) {
  if (!msg || !["user", "assistant"].includes(msg.role) || !msg.ts) return;
  const meta = document.createElement("span");
  meta.className = "msg-time";
  meta.textContent = formatBubbleTime(msg.ts);
  el.append(meta);
}

// Render the files/images the Doctor attached, inside their own message bubble:
// a thumbnail for images, a filename chip for everything else.
function renderAttachmentList(paths) {
  const wrap = document.createElement("div");
  wrap.className = "msg-attachments";
  for (const p of paths) {
    const name = String(p).split(/[\\/]/).pop() || String(p);
    if (/\.(png|jpe?g|gif|webp|bmp|heic|heif|tiff?)$/i.test(p)) {
      const fig = document.createElement("div");
      fig.className = "msg-attachment image";
      fig.title = name;
      const img = document.createElement("img");
      img.alt = name;
      img.loading = "lazy";
      img.src = window.chatApi?.fileUrl?.(p) || "";
      img.addEventListener("error", () => {
        fig.classList.add("broken");
        fig.textContent = name;
      });
      fig.appendChild(img);
      wrap.appendChild(fig);
    } else {
      const chip = document.createElement("div");
      chip.className = "msg-attachment file";
      chip.textContent = name;
      chip.title = p;
      wrap.appendChild(chip);
    }
  }
  return wrap;
}

function buildMsgEl(msg) {
  const el = document.createElement("div");
  el.dataset.id = msg.id;
  if (msg.role === "tool") {
    el.className = "msg tool";
    // Action-phrased label ("编辑 main.js"), already composed in chat.js.
    // No "PRTS ·" prefix — the pill's shape and tint already mark it as her
    // activity, and the prefix just turned a row of tool calls into a wall of
    // repeated "PRTS".
    const label = msg.summary || msg.name || msg.text || "tool";
    const commandText = (msg.command && String(msg.command).trim()) || "";
    const outputText = msg.output != null ? String(msg.output) : "";
    const hasDetail = Boolean(commandText || outputText);

    const pill = document.createElement(hasDetail ? "button" : "span");
    pill.className = `tool-pill${hasDetail ? " expandable" : ""}`;
    if (hasDetail) pill.type = "button";
    const labelSpan = document.createElement("span");
    labelSpan.className = "tool-pill-label";
    labelSpan.textContent = label;
    pill.append(labelSpan);
    el.append(pill);

    if (hasDetail) {
      const caret = document.createElement("span");
      caret.className = "tool-caret";
      pill.append(caret);

      const detail = document.createElement("pre");
      detail.className = `tool-detail${msg.outputError ? " error" : ""}`;
      const segments = [];
      if (commandText) segments.push(`$ ${commandText}`);
      // Output not back yet → show a placeholder until the tool_result lands.
      segments.push(outputText || "…");
      detail.textContent = segments.join("\n");
      el.append(detail);

      const sync = () => {
        const open = toolExpanded.has(msg.id);
        detail.hidden = !open;
        caret.textContent = open ? "▾" : "▸";
      };
      pill.addEventListener("click", () => {
        if (toolExpanded.has(msg.id)) toolExpanded.delete(msg.id);
        else toolExpanded.add(msg.id);
        sync();
      });
      sync();
    }
    return el;
  }
  el.className = `msg ${msg.role}${msg.queued ? " queued" : ""}`;
  if (msg.role === "user") {
    el.textContent = msg.text || "";
    appendBubbleTime(el, msg);
    // Context badge — show active file, cursor, selection info
    if (msg.context && msg.context.activeFile) {
      const ctx = msg.context;
      const badge = document.createElement("div");
      badge.className = "context-badge";
      const file = ctx.activeFile.split(/[\\/]/).pop();
      let label = `📄 ${file}`;
      if (ctx.activeFileLanguage) label += ` · ${ctx.activeFileLanguage}`;
      if (ctx.cursorLine) label += ` · L${ctx.cursorLine}`;
      if (ctx.selection) label += ` · 已选中 L${ctx.selection.startLine}-${ctx.selection.endLine}`;
      badge.textContent = label;
      badge.title = ctx.activeFile;
      el.append(badge);
    }
  } else if (msg.role === "assistant") {
    const isStreaming = chatRunning && msg.id === currentAssistantId;
    const isThinking = isStreaming && !(msg.text || "").trim();
    if (isThinking) {
      renderThinkingBubble(el);
    } else if (isStreaming) {
      // A re-render can land mid-stream (e.g. a tool pill or its output arrives
      // while she's still typing). The typewriter holds the not-yet-revealed
      // tail in its buffer, which is always a suffix of msg.text. Render only
      // the already-revealed portion so the buffer can finish typing it out —
      // dumping the full text here would let tickTyping re-append the tail and
      // duplicate it.
      const s = typingState.get(msg.id);
      const full = msg.text || "";
      const revealed =
        s && s.buffer && full.length >= s.buffer.length && full.endsWith(s.buffer)
          ? full.slice(0, full.length - s.buffer.length)
          : full;
      el.textContent = revealed;
      const cur = document.createElement("span");
      cur.className = "cursor";
      el.append(cur);
    } else {
      el.innerHTML = renderMarkdownCached(msg);
      appendBubbleTime(el, msg);
    }
  } else {
    el.textContent = msg.text || "";
    if (Array.isArray(msg.attachments) && msg.attachments.length) {
      el.appendChild(renderAttachmentList(msg.attachments));
    }
    appendBubbleTime(el, msg);
  }
  return el;
}

// ============================================================
//  HTML Preview Panel — logic.
// ============================================================
function updateLayoutSplit() {
  if (!htmlPanelOpen) {
    chatStream.style.flexGrow = "1";
    if (htmlPreview) htmlPreview.style.flexGrow = "0";
    return;
  }
  const ratio = Math.min(PREVIEW_SPLIT_MAX, Math.max(PREVIEW_SPLIT_MIN, splitRatio));
  chatStream.style.flexGrow = String(1 - ratio);
  if (htmlPreview) {
    htmlPreview.style.flexGrow = String(ratio);
    htmlPreview.classList.add("open");
  }
}

function syncPreviewButtons() {
  const buttons = chatStream.querySelectorAll(".msg-preview-btn");
  for (const btn of buttons) {
    const mid = btn.dataset.previewId;
    btn.classList.toggle("active", mid === activePreviewId);
    btn.textContent = mid === activePreviewId ? t("preview_expand") : t("preview_collapse");
  }
  if (htmlPanelOpen && activePreviewId) {
    const msg = lastHistory.find((m) => m.id === activePreviewId);
    const label = msg ? (msg.id || "").slice(-8) : activePreviewId.slice(-8);
    previewTitle.textContent = `${t("preview_title")} · ${label}`;
  } else {
    previewTitle.textContent = t("preview_title");
  }
}

function updatePreviewFrame(html) {
  if (previewFrame && previewFrame.srcdoc !== html) {
    previewFrame.srcdoc = html;
  }
}

function switchToMessage(messageId) {
  const html = htmlStore.get(messageId);
  if (!html) return;
  activePreviewId = messageId;
  updatePreviewFrame(html);
  syncPreviewButtons();
}

async function openHtmlPanelFor(messageId) {
  const html = htmlStore.get(messageId);
  if (!html) return;
  dismissedPreviewIds.delete(messageId);
  activePreviewId = messageId;
  htmlPanelOpen = true;
  htmlPreview.hidden = false;
  previewDivider.hidden = false;
  updatePreviewFrame(html);
  updateLayoutSplit();
  syncPreviewButtons();
  try {
    await window.previewApi?.open?.({ width: 200 });
  } catch { /* no-op if IPC missing */ }
}

async function closeHtmlPanel() {
  if (!htmlPanelOpen) return;
  if (activePreviewId) dismissedPreviewIds.add(activePreviewId);
  htmlPanelOpen = false;
  activePreviewId = null;
  htmlPreview.hidden = true;
  previewDivider.hidden = true;
  updateLayoutSplit();
  syncPreviewButtons();
  try {
    await window.previewApi?.close?.();
  } catch { /* no-op */ }
}

function detectHtmlBlocks() {
  htmlStore.clear();
  const codeBlocks = chatStream.querySelectorAll("pre code[class*='lang-html']");
  let latestId = null;
  for (const block of codeBlocks) {
    const msgEl = block.closest(".msg.assistant");
    if (!msgEl) continue;
    const messageId = msgEl.dataset.id;
    if (!messageId) continue;
    const text = (block.textContent || "").trim();
    if (!text) continue;
    htmlStore.set(messageId, text);
    latestId = messageId;
  }
  return latestId;
}

function addPreviewButtons() {
  for (const [messageId] of htmlStore) {
    const msgEl = chatStream.querySelector(`.msg.assistant[data-id="${messageId}"]`);
    if (!msgEl || msgEl.querySelector(".msg-preview-btn")) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "msg-preview-btn";
    btn.dataset.previewId = messageId;
    btn.textContent = messageId === activePreviewId ? t("preview_expand") : t("preview_collapse");
    btn.addEventListener("click", () => {
      if (htmlPanelOpen && activePreviewId === messageId) return;
      if (htmlPanelOpen) {
        switchToMessage(messageId);
      } else {
        openHtmlPanelFor(messageId);
      }
    });
    msgEl.append(btn);
  }
  syncPreviewButtons();
}

// HTML replies restored from a previous run must not pop the panel open the
// moment the app boots — only replies that arrive in THIS session auto-open.
// The Preview button still works for restored ones.
let previewBootstrapped = false;

function checkAndUpdateHtmlPreview() {
  if (chatRunning) return;
  // Remember which message IDs were already in the store so we can tell
  // whether a genuinely new HTML reply arrived (should auto-open) vs an
  // old one the user dismissed (should stay closed).
  const oldIds = new Set(htmlStore.keys());
  const latestId = detectHtmlBlocks();
  if (!previewBootstrapped) {
    // First render is always the boot getHistory result: whatever HTML blocks
    // exist now were restored from disk, not freshly generated.
    previewBootstrapped = true;
    for (const id of htmlStore.keys()) dismissedPreviewIds.add(id);
    addPreviewButtons();
    return;
  }
  // Newly appeared HTML blocks (from a fresh reply) clear their dismissed
  // flag so they auto-open even if a previous block was manually closed.
  for (const id of htmlStore.keys()) {
    if (!oldIds.has(id)) dismissedPreviewIds.delete(id);
  }
  addPreviewButtons();
  if (latestId) {
    if (htmlPanelOpen) {
      switchToMessage(latestId);
    } else if (!dismissedPreviewIds.has(latestId)) {
      openHtmlPanelFor(latestId);
    }
  }
}

function renderHistory(history) {
  // Preserve the reading position: every tool pill / output update re-renders
  // the whole stream, and unconditionally jumping to the bottom yanked the
  // Doctor away from her words (which sit above the pills) on every command.
  // Stay pinned only if he was already at the bottom, or he just sent a new
  // message; otherwise restore where he was.
  const nearBottom =
    chatStream.scrollHeight - chatStream.scrollTop - chatStream.clientHeight < 80;
  const prevScrollTop = chatStream.scrollTop;
  const prevIds = new Set(lastHistory.map((m) => m.id));
  lastHistory = history || [];
  // Drop cached markdown for messages that no longer exist (clears, wipes).
  if (mdCache.size > lastHistory.length + 32) {
    const liveIds = new Set(lastHistory.map((m) => m.id));
    for (const id of mdCache.keys()) {
      if (!liveIds.has(id)) mdCache.delete(id);
    }
  }
  chatStream.innerHTML = "";
  if (!lastHistory.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("chat_empty_hint");
    chatStream.append(empty);
    currentAssistantId = null;
    checkAndUpdateHtmlPreview();
    return;
  }
  const assistants = lastHistory.filter((m) => m.role === "assistant");
  currentAssistantId = assistants.length ? assistants[assistants.length - 1].id : null;
  for (const msg of lastHistory) {
    chatStream.append(buildMsgEl(msg));
  }
  const last = lastHistory[lastHistory.length - 1];
  const sentNewMessage = Boolean(last && last.role === "user" && !prevIds.has(last.id));
  if (nearBottom || sentNewMessage) {
    chatStream.scrollTop = chatStream.scrollHeight;
  } else {
    chatStream.scrollTop = prevScrollTop;
  }
  checkAndUpdateHtmlPreview();
}

// Typewriter — backends often emit chunks in bursts, which makes the response
// pop in feeling instant. Buffer per messageId and reveal characters at a
// steady ~90 chars/sec via rAF so it visibly types. The blinking cursor
// trails the typed text and only goes away once the buffer drains AND the
// stream is finished.
const TYPING_CHARS_PER_SEC = 90;
const typingState = new Map(); // messageId -> { buffer, rafId, lastTickMs }
let pendingFinalRender = false;

function ensureCursor(el) {
  if (!el.querySelector(".cursor")) {
    const cur = document.createElement("span");
    cur.className = "cursor";
    el.append(cur);
  }
}

function removeCursor(el) {
  const cur = el.querySelector(".cursor");
  if (cur) cur.remove();
}

function appendChunk(messageId, text) {
  if (!messageId || !text) return;
  let s = typingState.get(messageId);
  if (!s) {
    s = { buffer: "", rafId: null, lastTickMs: performance.now() };
    typingState.set(messageId, s);
  }
  s.buffer += text;
  if (s.rafId == null) {
    s.lastTickMs = performance.now();
    s.rafId = requestAnimationFrame(() => tickTyping(messageId));
  }
}

function tickTyping(messageId) {
  const s = typingState.get(messageId);
  if (!s) return;
  s.rafId = null;

  const el = chatStream.querySelector(`.msg.assistant[data-id="${messageId}"]`);
  if (!el) {
    typingState.delete(messageId);
    return;
  }

  if (el.classList.contains("thinking")) {
    el.classList.remove("thinking");
    el.replaceChildren();
  }

  const now = performance.now();
  const dtSec = Math.max(0, (now - s.lastTickMs) / 1000);
  s.lastTickMs = now;

  if (s.buffer.length > 0) {
    const advance = Math.max(1, Math.floor(dtSec * TYPING_CHARS_PER_SEC));
    const chunk = s.buffer.slice(0, advance);
    s.buffer = s.buffer.slice(advance);

    removeCursor(el);
    // Extend the trailing text node instead of appending one per frame — a
    // long reply used to accumulate thousands of sibling text nodes.
    const tailNode = el.lastChild;
    if (tailNode && tailNode.nodeType === Node.TEXT_NODE) {
      tailNode.appendData(chunk);
    } else {
      el.append(document.createTextNode(chunk));
    }
    ensureCursor(el);

    const nearBottom =
      chatStream.scrollHeight - chatStream.scrollTop - chatStream.clientHeight < 80;
    if (nearBottom) chatStream.scrollTop = chatStream.scrollHeight;
  }

  if (s.buffer.length > 0 || chatRunning) {
    s.rafId = requestAnimationFrame(() => tickTyping(messageId));
    return;
  }

  // Buffer drained AND the stream is finished — clean up the cursor and let
  // setRunning's deferred render (if any) promote plain text to markdown.
  removeCursor(el);
  typingState.delete(messageId);
  if (pendingFinalRender && typingState.size === 0) {
    pendingFinalRender = false;
    renderHistory(lastHistory);
  }
}

function anyTypingActive() {
  for (const s of typingState.values()) if (s.buffer.length > 0) return true;
  return false;
}

function flushTypingBuffers({ renderMarkdownNow = false } = {}) {
  for (const [messageId, s] of typingState.entries()) {
    if (s.rafId != null) {
      cancelAnimationFrame(s.rafId);
      s.rafId = null;
    }
    const el = chatStream.querySelector(`.msg.assistant[data-id="${messageId}"]`);
    if (el && s.buffer.length > 0) {
      removeCursor(el);
      el.append(document.createTextNode(s.buffer));
      s.buffer = "";
    }
    if (el) removeCursor(el);
    typingState.delete(messageId);
  }
  if (renderMarkdownNow && lastHistory.length) {
    pendingFinalRender = false;
    renderHistory(lastHistory);
  }
}

function setRunning(running, { chained = false } = {}) {
  const wasRunning = chatRunning;
  if (!running && queueLength > 0) {
    flushTypingBuffers({ renderMarkdownNow: true });
    return;
  }
  chatRunning = running;
  if (sendBtn) sendBtn.disabled = !backendReady;
  if (cancelBtn) cancelBtn.disabled = !running;
  if (running) {
    clearMoodResetTimer();
    if (chained) {
      flushTypingBuffers({ renderMarkdownNow: true });
    }
    setBaseMood("thinking");
    ensureThinkingBubbleVisible();
  } else if (!chained) {
    setBaseMood("idle");
  }
  if (wasRunning && !running && lastHistory.length) {
    if (queueLength > 0) {
      flushTypingBuffers({ renderMarkdownNow: true });
      return;
    }
    if (anyTypingActive()) {
      pendingFinalRender = true;
    } else {
      renderHistory(lastHistory);
    }
  }
}

function ensureThinkingBubbleVisible() {
  if (!currentAssistantId) return;
  let el = chatStream.querySelector(`.msg.assistant[data-id="${currentAssistantId}"]`);
  if (!el) {
    renderHistory(lastHistory);
    el = chatStream.querySelector(`.msg.assistant[data-id="${currentAssistantId}"]`);
  }
  if (!el) return;
  const entry = lastHistory.find((m) => m.id === currentAssistantId);
  if (!entry || (entry.text || "").trim()) return;
  renderThinkingBubble(el);
  const nearBottom =
    chatStream.scrollHeight - chatStream.scrollTop - chatStream.clientHeight < 80;
  if (nearBottom) chatStream.scrollTop = chatStream.scrollHeight;
}

function autosizeInput() {
  composerInput.style.height = "auto";
  composerInput.style.height = Math.min(120, composerInput.scrollHeight) + "px";
}

composerInput.addEventListener("input", autosizeInput);

composerInput.addEventListener("keydown", (event) => {
  // event.isComposing / keyCode === 229 → the keypress belongs to an active
  // IME composition (e.g. picking a Pinyin candidate, confirming a partial
  // Latin word inside the IME). Don't submit the form mid-composition; let
  // the IME consume the Enter and only treat a "real" Enter as send.
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.isComposing &&
    event.keyCode !== 229
  ) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

// ============================================================
//  Attachments — "+" button / drag-drop files & images into chat.
//  Paths are handed to the backend; Claude reads them with Read, Codex gets
//  images as -i input. See src/main/chat.js.
// ============================================================
const attachBtn = document.getElementById("attachBtn");
const attachmentChips = document.getElementById("attachmentChips");
let pendingAttachments = []; // [{ path, name }]

function attachmentFileName(p) {
  return String(p).split(/[\\/]/).pop() || String(p);
}

function isImageAttachment(p) {
  return /\.(png|jpe?g|gif|webp|bmp|heic|heif|tiff?)$/i.test(p);
}

function renderChips() {
  attachmentChips.replaceChildren();
  attachmentChips.classList.toggle("has-items", pendingAttachments.length > 0);
  for (const a of pendingAttachments) {
    const chip = document.createElement("span");
    chip.className = "chip" + (isImageAttachment(a.path) ? " image" : "");
    const label = document.createElement("span");
    label.className = "chip-name";
    label.textContent = a.name;
    label.title = a.path;
    chip.appendChild(label);
    const x = document.createElement("button");
    x.type = "button";
    x.className = "chip-remove";
    x.setAttribute("aria-label", "移除");
    x.textContent = "×";
    x.addEventListener("click", () => {
      pendingAttachments = pendingAttachments.filter((it) => it.path !== a.path);
      renderChips();
    });
    chip.appendChild(x);
    attachmentChips.appendChild(chip);
  }
}

function addAttachments(paths) {
  let added = false;
  for (const p of paths || []) {
    if (!p || pendingAttachments.some((a) => a.path === p)) continue;
    pendingAttachments.push({ path: p, name: attachmentFileName(p) });
    added = true;
  }
  if (added) renderChips();
}

function clearAttachments() {
  if (pendingAttachments.length === 0) return;
  pendingAttachments = [];
  renderChips();
}

attachBtn?.addEventListener("click", async () => {
  try {
    const paths = await window.chatApi.pickFiles();
    addAttachments(paths);
  } catch (error) {
    console.error("Failed to pick files:", error);
  }
  composerInput.focus();
});

// Drag a file anywhere onto the chat window → attach it (never navigate).
window.addEventListener("dragover", (event) => {
  if (Array.from(event.dataTransfer?.types || []).includes("Files")) {
    event.preventDefault();
    document.body.classList.add("file-dragging");
  }
});
window.addEventListener("dragleave", (event) => {
  if (event.relatedTarget === null) document.body.classList.remove("file-dragging");
});
window.addEventListener("drop", (event) => {
  document.body.classList.remove("file-dragging");
  const dropped = event.dataTransfer?.files;
  if (!dropped || dropped.length === 0) return;
  event.preventDefault();
  const paths = [];
  for (const file of dropped) {
    const p = window.chatApi?.getPathForFile?.(file);
    if (p) paths.push(p);
  }
  addAttachments(paths);
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = composerInput.value.trim();
  const files = pendingAttachments.map((a) => a.path);
  if (!text && files.length === 0) return;
  composerInput.value = "";
  autosizeInput();
  clearAttachments();
  flashPunch(0.05);
  resetInactivityTimers();
  renderExpression("halfClosed");
  setTimeout(() => {
    if (chatRunning) renderExpression(MOOD_FRAME[state.mood] || state.mood);
  }, 200);
  const result = await window.chatApi.send(text, files);
  if (result?.ok === false) {
    showBubble(t("send_failed", result.reason), 3000);
  }
});

if (cancelBtn) cancelBtn.addEventListener("click", () => window.chatApi.cancel());

// The × hides the popover (collapsing to the desktop pet when it's enabled)
// — the tray-companion convention where closing never quits her; a running
// reply keeps streaming in the background.
if (closeBtn) closeBtn.addEventListener("click", () => {
  window.petApi
    .hidePopover()
    .catch((error) => console.error("Failed to hide popover:", error));
});

// Platform placement: macOS window controls belong on the LEFT of the title
// bar; Windows/Linux keep the × on the right (the static markup). The drag
// handler ignores button clicks, so the moved button stays safe inside the
// drag region.
if (window.petApi?.isMac === true) {
  if (closeBtn) closeBtn.classList.add("mac-left");
  if (dragHandle) dragHandle.prepend(closeBtn);
}

if (clearBtn) clearBtn.addEventListener("click", () => {
  if (!confirm(t("clear_confirm"))) return;
  window.chatApi.clear();
  showBubble(t("clear_done"), 1800);
  htmlStore.clear();
  dismissedPreviewIds.clear();
  if (htmlPanelOpen) closeHtmlPanel();
});

window.chatApi.onHistory((history) => renderHistory(history));
window.chatApi.onChunk(({ messageId, text }) => appendChunk(messageId, text));
window.chatApi.onStatus((event) => {
  if (!event) return;
  // Silent self-turns (proactive checks, memory upkeep) are invisible: don't
  // flip the thinking face, buttons, or the end-of-reply happy flash for them.
  if (event.silent) return;
  if (event.status === "running") {
    setRunning(true, { chained: Boolean(event.chained) });
    refreshComposerMeta();
  } else if (event.status === "idle") {
    if (queueLength > 0) {
      pendingModelMood = null;
      return;
    }
    setRunning(false);
    refreshComposerMeta();
    resetInactivityTimers();
    if (event.error) {
      setBaseMood("cry");
      showBubble(t("error_prefix", event.error), 4000);
      setTimeout(() => {
        if (baseMood === "cry") setBaseMood("idle");
      }, 2200);
    } else if (event.cancelled) {
      showBubble(t("cancelled"), 1600);
    } else {
      flashPunch(0.08);
      // Settle into the expression she chose for this reply; default to happy.
      const target = pendingModelMood || "happy";
      setBaseMood(target);
      const hold = target === "happy" ? 1400 : 2800;
      clearMoodResetTimer();
      moodResetTimer = setTimeout(() => {
        if (baseMood === target) setBaseMood("idle");
        moodResetTimer = null;
      }, hold);
    }
    pendingModelMood = null;
  }
});

// Coding face: any tool_use block from claude → threat expression.
// Returns to "thinking" when claude resumes plain text output.
window.chatApi.onTool?.((payload) => {
  if (!chatRunning) return;
  if (payload?.active) {
    setBaseMood("coding");
  } else {
    setBaseMood("thinking");
  }
});

// Expression chosen by the persona (hidden [[mood:X]] tags, parsed + stripped
// in the main process). A reply may carry several — her face switches live as
// each arrives mid-stream, and the idle handler settles on the last one.
window.chatApi.onMood?.((payload) => {
  const frame = payload && MODEL_MOOD_FRAME[payload.mood];
  if (!frame) return;
  pendingModelMood = frame;
  if (chatRunning) setBaseMood(frame);
});

// She spoke on her own (proactive care). The message itself arrives via
// onHistory; here just let her face react the way a finished reply does.
window.chatApi.onProactive?.((payload) => {
  if (!payload?.spoke) return;
  resetInactivityTimers();
  flashPunch(0.08);
  const target = pendingModelMood || "happy";
  pendingModelMood = null;
  setBaseMood(target);
  clearMoodResetTimer();
  moodResetTimer = setTimeout(() => {
    if (baseMood === target) setBaseMood("idle");
    moodResetTimer = null;
  }, 2800);
});

// ============================================================
//  Settings (read-only here; right-click tray menu controls it)
// ============================================================
const agentBadge = document.getElementById("agentBadge");
const providerBadge = document.getElementById("providerBadge");
const versionBadge = document.getElementById("versionBadge");

let queueLength = 0;
let lastSettingsPayload = null;

function refreshComposerMeta() {
  const payload = lastSettingsPayload;
  const availability = payload?.providerAvailability;
  const activeProvider = availability?.activeProvider || payload?.chatProvider;
  const providerInfo = activeProvider ? availability?.providers?.[activeProvider] : null;
  backendReady = !availability || (availability.availableProviders || []).length > 0;
  const provider = backendReady
    ? providerInfo?.shortLabel ||
      (activeProvider === "codex" ? "Codex" : activeProvider ? "Claude" : "No CLI")
    : "No CLI";
  const cwd = (payload?.chatCwd || "").trim();
  const queueSuffix = queueLength > 0 ? ` · ${t("cwd_queue", queueLength)}` : "";
  const runningSuffix = chatRunning ? ` · ${t("cwd_running")}` : "";
  const mode = payload?.vibeCodingMode || "companion";
  const modeLabel = mode === "agent" ? "agent" : mode === "advisor" ? "advisor" : "陪伴";
  if (cwd) {
    const truncated = cwd.length > 42 ? "…" + cwd.slice(-41) : cwd;
    cwdLine.textContent = `${provider} · ${truncated}${queueSuffix}${runningSuffix} · ${modeLabel}`;
    cwdLine.title = cwd;
  } else {
    cwdLine.textContent = t("cwd_home", provider) + queueSuffix + runningSuffix + ` · ${modeLabel}`;
    cwdLine.title = "";
  }
  if (providerBadge) providerBadge.textContent = provider;
  if (versionBadge && payload?.appVersion) versionBadge.textContent = `v${payload.appVersion}`;
  // Vibe coding mode badge
  if (agentBadge) {
    agentBadge.hidden = false;
    if (mode === "agent") {
      agentBadge.textContent = "⚡ agent";
      agentBadge.style.color = "var(--vscode-charts-orange)";
    } else if (mode === "advisor") {
      agentBadge.textContent = "👁 advisor";
      agentBadge.style.color = "var(--vscode-charts-blue)";
    } else {
      agentBadge.textContent = "💬 companion";
      agentBadge.style.color = "var(--vscode-descriptionForeground)";
    }
  }
  if (sendBtn) sendBtn.disabled = !backendReady;
  composerInput.placeholder = backendReady
    ? chatRunning
      ? t("ph_running")
      : t("ph_ready")
    : t("ph_no_cli");
}

function renderSettings(payload) {
  lastSettingsPayload = payload;
  applyL10n();
  refreshComposerMeta();
  applyOutfit(outfitFrom(payload)).catch((error) => {
    console.error("Failed to switch outfit:", error);
  });
}

window.chatApi.onQueue?.(({ length }) => {
  queueLength = Number(length) || 0;
  refreshComposerMeta();
});

window.petApi?.onSettings?.(renderSettings);
window.petApi?.onCatMode?.(applyCatMode);

// ============================================================
//  Popover-open hook: refocus composer + reset idle timers
//  (interacting via the menu bar counts as activity).
// ============================================================
window.petApi?.onOpened?.(() => {
  composerInput.focus();
  resetInactivityTimers();
  if (baseMood === "sleep" || baseMood === "cry") {
    setBaseMood("idle");
  }
});

let activitySignalTimer = null;
function notePopoverActivity() {
  if (activitySignalTimer) return;
  window.petApi?.notePopoverActivity?.();
  activitySignalTimer = setTimeout(() => {
    activitySignalTimer = null;
  }, 1000);
}

window.addEventListener("pointerdown", notePopoverActivity, { passive: true });
window.addEventListener("keydown", notePopoverActivity, { passive: true });

// ============================================================
//  Click on the character — angry / threat / wake-up reactions.
// ============================================================
stage.addEventListener("click", handleStageClick);

// ============================================================
//  HTML Preview Panel — divider drag + button handlers.
// ============================================================
let splitterDragging = false;

previewDivider.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  splitterDragging = true;
  previewDivider.classList.add("dragging");
  document.body.style.userSelect = "none";
  document.body.style.cursor = "col-resize";
  try { previewDivider.setPointerCapture(event.pointerId); } catch { /* continue */ }
});

document.addEventListener("pointermove", (event) => {
  if (!splitterDragging || !mainArea) return;
  const rect = mainArea.getBoundingClientRect();
  if (rect.width <= 0) return;
  const mouseX = event.clientX - rect.left;
  const rightRatio = 1 - Math.min(1, Math.max(0, mouseX / rect.width));
  splitRatio = Math.min(PREVIEW_SPLIT_MAX, Math.max(PREVIEW_SPLIT_MIN, rightRatio));
  updateLayoutSplit();
});

document.addEventListener("pointerup", (event) => {
  if (!splitterDragging) return;
  splitterDragging = false;
  previewDivider.classList.remove("dragging");
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
  try { previewDivider.releasePointerCapture(event.pointerId); } catch { /* continue */ }
  try { localStorage.setItem("htmlPanelSplitRatio", String(splitRatio)); } catch { /* blocked */ }
});

document.addEventListener("pointercancel", (event) => {
  if (!splitterDragging) return;
  splitterDragging = false;
  previewDivider.classList.remove("dragging");
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
  try { previewDivider.releasePointerCapture(event.pointerId); } catch { /* continue */ }
});

closePreviewBtn.addEventListener("click", () => closeHtmlPanel());

openInBrowserBtn.addEventListener("click", async () => {
  const html = activePreviewId ? htmlStore.get(activePreviewId) : null;
  if (!html) return;
  try {
    const result = await window.previewApi?.openInBrowser?.({ html });
    if (result?.ok) {
      showBubble(t("preview_browser_opened"), 1800);
    }
  } catch {
    showBubble(t("preview_browser_failed"), 3000);
  }
});

// ============================================================
//  Boot
// ============================================================
window.addEventListener("resize", resizeCanvas);
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => resizeCanvas()).observe(stage);
}

// Settings decide which outfit to load, so fetch them before the first frame
// load; if they can't be fetched, fall back to the formal default.
Promise.all([
  (window.petApi?.getSettings?.() ?? Promise.resolve(null)).catch(() => null),
  loadAllCatFrames().catch(console.error)
]).then(([payload]) => {
  if (payload) {
    lastSettingsPayload = payload;
    applyL10n();
    refreshComposerMeta();
  }
  return applyOutfit(outfitFrom(payload));
}).then(() => {
  resizeCanvas();
  setBaseMood("idle");
  resetInactivityTimers();
  requestAnimationFrame(tick);
}).catch((error) => {
  console.error("Failed to load frames:", error);
  showBubble(t("sprite_load_failed"), 6000);
});

window.chatApi.getHistory().then(renderHistory);
