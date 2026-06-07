const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  screen,
  dialog,
  nativeImage,
  nativeTheme,
  shell,
  Notification
} = require("electron");

const settings = require("./settings");
const chat = require("./chat");
const persona = require("./persona");
const platform = require("./platform");
const updater = require("./updater");
const { spawnCli } = require("./cli-spawn");

let conversationFile = null;
let saveTimer = null;
let lastResponseStartedAt = 0;

const ASSETS_DIR = path.join(__dirname, "..", "..", "assets", "character");
const DEDICATED_TRAY_ICON = path.join(ASSETS_DIR, "icon.png");
const POPOVER_DEFAULT_WIDTH = 380;
const POPOVER_DEFAULT_HEIGHT = 560;
const POPOVER_MIN_WIDTH = 320;
const POPOVER_MIN_HEIGHT = 460;
// Gap kept between the popover edge and the display work-area edge. The window
// position is clamped 4px inside each side, so 8px total keeps the max size
// consistent with that and prevents the window from spilling off-screen. There
// is no fixed maximum: the active display's work area is the only ceiling, so
// the popover can grow right up to the screen edges on large monitors.
const POPOVER_EDGE_MARGIN = 8;
const DESKTOP_PET_IDLE_MS = Number(process.env.PRTS_DESKTOP_PET_IDLE_MS) || 60 * 1000;
const DESKTOP_PET_SIZES = Object.freeze({
  small: { width: 120, height: 144 },
  medium: { width: 150, height: 180 },
  large: { width: 180, height: 216 }
});

let tray;
let popover;
let popoverSizeSaveTimer = null;
let desktopPet;
let desktopPetTimer = null;
let desktopPetPositionSaveTimer = null;
let windowFadeTimer = null;

// ============================================================
//  Tray icon — prefer the dedicated centered icon.png, fallback
//  to a cropped head from the smiling sprite.
// ============================================================
function buildTrayIcon() {
  const dedicated = nativeImage.createFromPath(DEDICATED_TRAY_ICON);
  if (!dedicated.isEmpty()) {
    return prepareTrayImage(dedicated, { size: 22 });
  }

  const base = nativeImage.createFromPath(path.join(ASSETS_DIR, "笑.png"));
  if (base.isEmpty()) return nativeImage.createEmpty();

  // The chibi sprite sits centered in a 1254x1254 canvas. The head occupies
  // roughly the top-center quarter; this rectangle isolates it.
  const head = base.crop({ x: 377, y: 110, width: 500, height: 500 });
  return prepareTrayImage(head, { chromaKeyLightPixels: true, size: 20 });
}

// Crop to the character's alpha bbox, then emit explicit 1x/2x menu-bar sizes.
// The smiling fallback also cleans up its light background; the dedicated
// icon.png keeps its original alpha and colors intact.
function prepareTrayImage(image, options = {}) {
  const { chromaKeyLightPixels = false, size = 20 } = options;
  const { width, height } = image.getSize();
  const buf = Buffer.from(image.toBitmap());
  if (chromaKeyLightPixels) {
    const HARD = 245;
    const SOFT = 215;
    for (let i = 0; i < buf.length; i += 4) {
      const minC = Math.min(buf[i], buf[i + 1], buf[i + 2]);
      if (minC >= HARD) {
        buf[i + 3] = 0;
      } else if (minC >= SOFT) {
        buf[i + 3] = Math.round((255 * (HARD - minC)) / (HARD - SOFT));
      }
    }
  }
  let cropped = nativeImage.createFromBitmap(buf, { width, height });

  // Scan for the bounding box of meaningfully-opaque pixels, then expand it
  // to a square so the character isn't stretched when resized.
  const ALPHA = 24;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (buf[(y * width + x) * 4 + 3] >= ALPHA) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX >= minX && maxY >= minY) {
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const side = Math.max(bw, bh);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    let x = Math.round(cx - side / 2);
    let y = Math.round(cy - side / 2);
    x = Math.max(0, Math.min(width - side, x));
    y = Math.max(0, Math.min(height - side, y));
    cropped = cropped.crop({ x, y, width: side, height: side });
  }

  const icon = cropped.resize({ width: size, height: size, quality: "best" });
  const retina = cropped.resize({ width: size * 2, height: size * 2, quality: "best" });
  icon.addRepresentation({
    scaleFactor: 2.0,
    width: size * 2,
    height: size * 2,
    buffer: retina.toBitmap()
  });
  icon.setTemplateImage(false);
  return icon;
}

// ============================================================
//  Popover window — frameless panel that drops below the tray icon.
// ============================================================
function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function clampPopoverSize(size = {}, display = screen.getPrimaryDisplay()) {
  const work = display.workArea;
  const maxWidth = Math.max(POPOVER_MIN_WIDTH, work.width - POPOVER_EDGE_MARGIN);
  const maxHeight = Math.max(POPOVER_MIN_HEIGHT, work.height - POPOVER_EDGE_MARGIN);
  return {
    width: clampNumber(size.width ?? POPOVER_DEFAULT_WIDTH, POPOVER_MIN_WIDTH, maxWidth),
    height: clampNumber(size.height ?? POPOVER_DEFAULT_HEIGHT, POPOVER_MIN_HEIGHT, maxHeight)
  };
}

function initialPopoverSize() {
  const saved = settings.get("popoverSize");
  return clampPopoverSize(saved && typeof saved === "object" ? saved : {});
}

function scheduleSavePopoverSize() {
  if (!popover || popover.isDestroyed()) return;
  clearTimeout(popoverSizeSaveTimer);
  popoverSizeSaveTimer = setTimeout(() => {
    if (!popover || popover.isDestroyed()) return;
    const size = clampPopoverSize(popover.getBounds(), screen.getDisplayMatching(popover.getBounds()));
    settings.set({ popoverSize: size });
  }, 350);
}

function resizePopoverDrag({ edge = "se", start = {}, dx = 0, dy = 0 } = {}) {
  if (!popover || popover.isDestroyed()) return null;
  const sx = Number(start.x);
  const sy = Number(start.y);
  const sw = Number(start.width);
  const sh = Number(start.height);
  if (![sx, sy, sw, sh].every(Number.isFinite)) return null;

  const display = screen.getDisplayMatching(popover.getBounds());
  const work = display.workArea;
  const e = String(edge);
  const right = sx + sw;
  const bottom = sy + sh;
  const maxWidth = Math.max(POPOVER_MIN_WIDTH, work.width - POPOVER_EDGE_MARGIN);
  const maxHeight = Math.max(POPOVER_MIN_HEIGHT, work.height - POPOVER_EDGE_MARGIN);

  let width = sw + (e.includes("e") ? dx : 0) - (e.includes("w") ? dx : 0);
  let height = sh + (e.includes("s") ? dy : 0) - (e.includes("n") ? dy : 0);
  width = clampNumber(width, POPOVER_MIN_WIDTH, maxWidth);
  height = clampNumber(height, POPOVER_MIN_HEIGHT, maxHeight);

  let x = e.includes("w") ? right - width : sx;
  let y = e.includes("n") ? bottom - height : sy;
  x = clampNumber(x, work.x + 4, work.x + work.width - width - 4);
  y = clampNumber(y, work.y + 4, work.y + work.height - height - 4);
  popover.setBounds({ x, y, width, height }, false);
  scheduleSavePopoverSize();
  return { x, y, width, height };
}

// Move the popover to an absolute screen position, clamped so it stays within
// the work area of whichever display the target point lands on. Used by the
// "carry her around the screen" gesture in the renderer.
function movePopoverTo(point = {}) {
  if (!popover || popover.isDestroyed()) return null;
  const bounds = popover.getBounds();
  const targetX = Number(point.x);
  const targetY = Number(point.y);
  if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) return null;
  const display = screen.getDisplayNearestPoint({
    x: Math.round(targetX),
    y: Math.round(targetY)
  });
  const work = display.workArea;
  const x = clampNumber(targetX, work.x, work.x + work.width - bounds.width);
  const y = clampNumber(targetY, work.y, work.y + work.height - bounds.height);
  popover.setPosition(x, y, false);
  return { x, y };
}

// ============================================================
//  Appearance / theme
// ============================================================
// macOS draws the popover with vibrancy, so its background follows the
// resolved appearance automatically. Windows/Linux have no vibrancy and paint
// an opaque window, so we choose the matching fill here and keep it in sync as
// the appearance changes. The light tone roughly mirrors the macOS light
// vibrancy material the green text palette was tuned for.
const POPOVER_BG_DARK = "#11151a";
const POPOVER_BG_LIGHT = "#e9edf2";

function popoverBackgroundColor() {
  if (process.platform === "darwin") return "#00000000";
  return nativeTheme.shouldUseDarkColors ? POPOVER_BG_DARK : POPOVER_BG_LIGHT;
}

// Push the saved preference into Electron's nativeTheme. Setting themeSource
// overrides prefers-color-scheme in every renderer (all platforms) and the
// native window appearance on macOS, so the renderer palette and the window
// chrome stay consistent from this single switch.
function applyThemeSource() {
  const theme = settings.get("theme");
  nativeTheme.themeSource = theme === "light" || theme === "dark" ? theme : "system";
}

function syncPopoverBackground() {
  if (process.platform === "darwin") return;
  if (popover && !popover.isDestroyed()) {
    popover.setBackgroundColor(popoverBackgroundColor());
  }
}

function createPopover() {
  const size = initialPopoverSize();
  popover = new BrowserWindow({
    width: size.width,
    height: size.height,
    show: false,
    frame: false,
    // Resize only through the renderer's explicit edge handles. Native resize
    // on a frameless Windows window can treat a long press near the border as
    // an OS resize gesture and fight the custom drag implementation.
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    transparent: process.platform === "darwin",
    backgroundColor: popoverBackgroundColor(),
    ...(process.platform === "darwin"
      ? {
          // Keep the macOS liquid-glass material without passing unsupported
          // visual effect options to Windows.
          vibrancy: "under-window",
          visualEffectState: "active",
          roundedCorners: true
        }
      : {}),
    alwaysOnTop: false,
    title: "PRTS",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  popover.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Sit in the normal window stacking order — other apps can come over the
  // top. The popover still only disappears when the tray icon is clicked
  // again (no blur-to-hide handler), so it doesn't vanish on focus change.

  popover.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  popover.on("resize", scheduleSavePopoverSize);

  popover.on("closed", () => {
    clearTimeout(popoverSizeSaveTimer);
    popover = null;
  });
}

function positionPopover() {
  if (!popover || !tray) return;
  const trayBounds = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const work = display.workArea;
  const winBounds = popover.getBounds();
  // Center the popover beside the tray icon. Windows commonly puts the tray
  // at the bottom of the screen, while macOS puts it at the top.
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
  const below = Math.round(trayBounds.y + trayBounds.height + 6);
  const above = Math.round(trayBounds.y - winBounds.height - 6);
  let y = below + winBounds.height <= work.y + work.height ? below : above;
  // Clamp inside the active display so we never spill off-screen.
  x = Math.max(work.x + 4, Math.min(work.x + work.width - winBounds.width - 4, x));
  y = Math.max(work.y + 4, Math.min(work.y + work.height - winBounds.height - 4, y));
  popover.setPosition(x, y, false);
}

function togglePopover() {
  if (!popover) createPopover();
  if (popover.isVisible()) {
    collapsePopoverToDesktopPet();
    return;
  }
  hideDesktopPet();
  positionPopover();
  showPopover();
}

// ============================================================
//  Desktop pet — appears after the chat stays hidden for a while.
// ============================================================
function defaultDesktopPetPosition(display = screen.getPrimaryDisplay()) {
  const work = display.workArea;
  const size = desktopPetSize();
  return {
    x: work.x + work.width - size.width - 24,
    y: work.y + work.height - size.height - 24
  };
}

function desktopPetSize() {
  return DESKTOP_PET_SIZES[settings.get("desktopPetSize")] || DESKTOP_PET_SIZES.medium;
}

function clampDesktopPetPosition(point = {}) {
  const target = {
    x: Number(point.x),
    y: Number(point.y)
  };
  const valid = Number.isFinite(target.x) && Number.isFinite(target.y);
  const display = valid
    ? screen.getDisplayNearestPoint({ x: Math.round(target.x), y: Math.round(target.y) })
    : screen.getPrimaryDisplay();
  const work = display.workArea;
  const fallback = defaultDesktopPetPosition(display);
  const size = desktopPetSize();
  return {
    x: valid ? clampNumber(target.x, work.x, work.x + work.width - size.width) : fallback.x,
    y: valid ? clampNumber(target.y, work.y, work.y + work.height - size.height) : fallback.y
  };
}

function initialDesktopPetPosition() {
  const saved = settings.get("desktopPetPosition");
  return clampDesktopPetPosition(saved && typeof saved === "object" ? saved : {});
}

function createDesktopPet() {
  if (desktopPet && !desktopPet.isDestroyed()) return desktopPet;
  const position = initialDesktopPetPosition();
  const size = desktopPetSize();
  desktopPet = new BrowserWindow({
    ...position,
    ...size,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    focusable: true,
    title: "PRTS Desktop Pet",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  desktopPet.loadFile(path.join(__dirname, "..", "renderer", "desktop-pet.html"));
  desktopPet.on("closed", () => {
    desktopPet = null;
  });
  return desktopPet;
}

function hideDesktopPet() {
  clearTimeout(desktopPetTimer);
  desktopPetTimer = null;
  desktopPet?.hide();
}

function clearWindowFade() {
  clearInterval(windowFadeTimer);
  windowFadeTimer = null;
}

function fadeWindow(window, from, to, durationMs, onDone) {
  clearWindowFade();
  const startedAt = Date.now();
  window.setOpacity(from);
  windowFadeTimer = setInterval(() => {
    if (!window || window.isDestroyed()) {
      clearWindowFade();
      return;
    }
    const progress = Math.min(1, (Date.now() - startedAt) / durationMs);
    window.setOpacity(from + (to - from) * progress);
    if (progress < 1) return;
    clearWindowFade();
    onDone?.();
  }, 16);
}

function desktopPetPositionFromPopover() {
  if (!popover || popover.isDestroyed()) return initialDesktopPetPosition();
  const bounds = popover.getBounds();
  const size = desktopPetSize();
  const stageHeight = Math.min(460, Math.max(180, Math.round(bounds.height * 0.34)));
  return clampDesktopPetPosition({
    x: bounds.x + Math.round((bounds.width - size.width) / 2),
    y: bounds.y + 32 + stageHeight - size.height
  });
}

function showDesktopPet() {
  if (!settings.get("desktopPet")) return;
  if (popover?.isVisible()) {
    collapsePopoverToDesktopPet();
    return;
  }
  createDesktopPet().showInactive();
}

function scheduleDesktopPet() {
  clearTimeout(desktopPetTimer);
  desktopPetTimer = null;
  if (!settings.get("desktopPet")) return;
  desktopPetTimer = setTimeout(showDesktopPet, DESKTOP_PET_IDLE_MS);
}

function moveDesktopPetTo(point = {}) {
  const position = clampDesktopPetPosition(point);
  createDesktopPet().setBounds({ ...position, ...desktopPetSize() }, false);
  clearTimeout(desktopPetPositionSaveTimer);
  desktopPetPositionSaveTimer = setTimeout(() => {
    settings.set({ desktopPetPosition: position });
  }, 350);
  return position;
}

function setDesktopPetSize(sizeKey) {
  const nextKey = DESKTOP_PET_SIZES[sizeKey] ? sizeKey : "medium";
  settings.set({ desktopPetSize: nextKey });
  if (!desktopPet || desktopPet.isDestroyed()) return;
  const position = clampDesktopPetPosition(desktopPet.getBounds());
  desktopPet.setBounds({ ...position, ...desktopPetSize() }, false);
  settings.set({ desktopPetPosition: position });
}

function openChatFromDesktopPet() {
  if (!popover) createPopover();
  const restoredSize = initialPopoverSize();
  popover.setSize(restoredSize.width, restoredSize.height, false);
  const petBounds = desktopPet?.getBounds();
  hideDesktopPet();
  try {
    if (petBounds) {
      const bounds = popover.getBounds();
      const display = screen.getDisplayMatching(petBounds);
      const work = display.workArea;
      const x = clampNumber(
        petBounds.x + Math.round((petBounds.width - bounds.width) / 2),
        work.x + 4,
        work.x + work.width - bounds.width - 4
      );
      const y = clampNumber(
        petBounds.y + petBounds.height - Math.min(460, Math.max(180, Math.round(bounds.height * 0.34))) - 32,
        work.y + 4,
        work.y + work.height - bounds.height - 4
      );
      popover.setPosition(x, y, false);
    } else {
      positionPopover();
    }
  } catch (error) {
    console.warn("main: failed to anchor popover to desktop pet", error);
  }
  showPopover();
  return { ok: true };
}

function showPopover() {
  clearWindowFade();
  const bounds = popover.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const work = display.workArea;
  const size = clampPopoverSize(bounds, display);
  popover.setBounds({
    x: clampNumber(bounds.x, work.x + 4, work.x + work.width - size.width - 4),
    y: clampNumber(bounds.y, work.y + 4, work.y + work.height - size.height - 4),
    ...size
  }, false);
  const fadeIn = process.platform !== "win32";
  popover.setOpacity(fadeIn ? 0 : 1);
  popover.show();
  popover.focus();
  popover.webContents.send("popover:opened");
  scheduleDesktopPet();
  if (fadeIn) fadeWindow(popover, 0, 1, 180);
}

function collapsePopoverToDesktopPet() {
  clearTimeout(desktopPetTimer);
  desktopPetTimer = null;
  if (!settings.get("desktopPet")) {
    hideDesktopPet();
    clearWindowFade();
    if (popover && !popover.isDestroyed()) {
      popover.hide();
      popover.setOpacity(1);
    }
    return;
  }
  if (!popover || popover.isDestroyed() || !popover.isVisible()) {
    createDesktopPet().showInactive();
    return;
  }
  const position = desktopPetPositionFromPopover();
  const pet = createDesktopPet();
  pet.setPosition(position.x, position.y, false);
  settings.set({ desktopPetPosition: position });
  fadeWindow(popover, popover.getOpacity(), 0, 220, () => {
    popover.hide();
    popover.setOpacity(1);
    pet.showInactive();
  });
}

// ============================================================
//  Tray context menu — right-click for settings + quit.
// ============================================================
const MENU_TEXT = {
  zh: {
    openChat: "打开聊天",
    appearance: "外观",
    language: "语言",
    languageSystem: "跟随系统",
    languageZh: "简体中文",
    languageEn: "English",
    system: "跟随系统",
    light: "浅色",
    dark: "深色",
    skills: "允许她使用技能（音乐 / 搜索 / 应用）",
    agentMode: "Agent mode（完整屏幕控制）",
    enableAgentTitle: "开启 agent mode？",
    enableAgent: "开启 agent mode",
    cancel: "取消",
    usageNoCli: "使用后端：未找到本地 CLI",
    usageBackend: "使用后端",
    usageBackendOne: (provider) => `使用后端：${provider}`,
    modelClaude: "模型（Claude）",
    modelCodex: "模型（Codex）",
    defaultClaude: "默认（CLI/账户）",
    defaultCodex: "默认（CLI/config）",
    opusAlias: "Opus（最新别名）",
    sonnetAlias: "Sonnet（最新别名）",
    haikuAlias: "Haiku（最新别名）",
    currentCustom: (model) => `当前自定义：${model}`,
    autoScreenshot: "每轮自动截图",
    desktopPet: "闲置时显示桌宠",
    showDesktopPet: "立即显示桌宠",
    desktopPetSize: "桌宠尺寸",
    sizeSmall: "小",
    sizeMedium: "中",
    sizeLarge: "大",
    setChatDirectory: "设置聊天工作目录…",
    chooseProjectFolder: "选择聊天使用的项目文件夹",
    clearChatDirectory: "清除聊天工作目录",
    restartPriestess: "重启普瑞赛斯",
    revealDataFolder: "打开数据目录",
    checkUpdates: "检查更新…",
    downloadInstallUpdate: (version) => `下载并安装 v${version}…`,
    restartUpdate: (version) => `重启并更新（v${version}）`,
    downloadUpdate: (version) => `下载更新（v${version}）…`,
    quit: "退出"
  },
  en: {
    openChat: "Open Chat",
    appearance: "Appearance",
    language: "Language",
    languageSystem: "System",
    languageZh: "简体中文",
    languageEn: "English",
    system: "System",
    light: "Light",
    dark: "Dark",
    skills: "Let her use skills (music · search · apps)",
    agentMode: "Agent mode (full screen control)",
    enableAgentTitle: "Enable agent mode?",
    enableAgent: "Enable agent mode",
    cancel: "Cancel",
    usageNoCli: "Usage backend: no local CLI found",
    usageBackend: "Usage backend",
    usageBackendOne: (provider) => `Usage backend: ${provider}`,
    modelClaude: "Model (Claude)",
    modelCodex: "Model (Codex)",
    defaultClaude: "Default (CLI/account)",
    defaultCodex: "Default (CLI/config)",
    opusAlias: "Opus (latest alias)",
    sonnetAlias: "Sonnet (latest alias)",
    haikuAlias: "Haiku (latest alias)",
    currentCustom: (model) => `Current custom: ${model}`,
    autoScreenshot: "Auto-screenshot each turn",
    desktopPet: "Desktop pet while idle",
    showDesktopPet: "Show desktop pet now",
    desktopPetSize: "Desktop pet size",
    sizeSmall: "Small",
    sizeMedium: "Medium",
    sizeLarge: "Large",
    setChatDirectory: "Set chat directory…",
    chooseProjectFolder: "Choose project folder for chat",
    clearChatDirectory: "Clear chat directory",
    restartPriestess: "Restart Priestess",
    revealDataFolder: "Reveal data folder",
    checkUpdates: "Check for updates…",
    downloadInstallUpdate: (version) => `Download and install v${version}…`,
    restartUpdate: (version) => `Restart to update (v${version})`,
    downloadUpdate: (version) => `Download update (v${version})…`,
    quit: "Quit"
  }
};

function menuLanguage() {
  const selected = String(settings.get("menuLanguage") || "system").toLowerCase();
  if (selected === "zh" || selected === "en") return selected;
  try {
    const preferred = app.getPreferredSystemLanguages?.() || [];
    if (preferred[0]) return /^zh\b/i.test(String(preferred[0])) ? "zh" : "en";
  } catch {
    /* ignore */
  }
  try {
    return /^zh\b/i.test(String(app.getLocale() || "")) ? "zh" : "en";
  } catch {
    /* ignore */
  }
  return "en";
}

function mt(key, ...args) {
  const dict = MENU_TEXT[menuLanguage()] || MENU_TEXT.en;
  const value = dict[key] ?? MENU_TEXT.en[key] ?? key;
  return typeof value === "function" ? value(...args) : value;
}

async function toggleAgentMode(nextValue) {
  if (nextValue) {
    const warning = platform.agentModeWarning();
    const result = await dialog.showMessageBox({
      type: "warning",
      title: mt("enableAgentTitle"),
      message: warning.message,
      detail: warning.detail,
      buttons: [mt("cancel"), mt("enableAgent")],
      defaultId: 0,
      cancelId: 0
    });
    if (result.response !== 1) return;
  }
  settings.set({ agentMode: Boolean(nextValue) });
}

function setTheme(value) {
  const next = value === "light" || value === "dark" ? value : "system";
  settings.set({ theme: next });
  applyThemeSource();
}

function setMenuLanguage(value) {
  const next = value === "zh" || value === "en" ? value : "system";
  settings.set({ menuLanguage: next });
}

function buildSettingsState() {
  const providerAvailability = chat.getProviderAvailability({ refresh: false });
  return {
    ...settings.getAll(),
    chatProvider: providerAvailability.activeProvider || settings.get("chatProvider"),
    providerAvailability
  };
}

function buildUsageBackendMenuItem() {
  const availability = chat.getProviderAvailability({ refresh: false });
  const available = availability.availableProviders;

  if (available.length === 0) {
    return {
      label: mt("usageNoCli"),
      enabled: false
    };
  }

  if (available.length === 1) {
    const provider = availability.providers[available[0]];
    return {
      label: mt("usageBackendOne", provider.label),
      enabled: false
    };
  }

  return {
    label: mt("usageBackend"),
    submenu: available.map((providerKey) => {
      const provider = availability.providers[providerKey];
      return {
        label: provider.label,
        type: "radio",
        checked: availability.activeProvider === providerKey,
        click: () => settings.set({ chatProvider: providerKey })
      };
    })
  };
}

// Model presets per backend, passed to the CLI as `--model` (empty = the CLI's
// own default). Claude accepts aliases plus full names; Codex exposes the
// current account-visible model catalog via `codex debug models`.
const MODEL_PRESETS = {
  claude: [
    { labelKey: "defaultClaude", value: "" },
    { labelKey: "opusAlias", value: "opus" },
    { labelKey: "sonnetAlias", value: "sonnet" },
    { labelKey: "haikuAlias", value: "haiku" },
    { type: "separator" },
    { label: "Opus 4.8", value: "claude-opus-4-8" },
    { label: "Opus 4.7", value: "claude-opus-4-7" },
    { label: "Opus 4.6", value: "claude-opus-4-6" },
    { label: "Opus 4.5 (2025-11-01)", value: "claude-opus-4-5-20251101" },
    { label: "Opus 4.1 (2025-08-05)", value: "claude-opus-4-1-20250805" },
    { type: "separator" },
    { label: "Sonnet 4.6", value: "claude-sonnet-4-6" },
    { label: "Sonnet 4.5 (2025-09-29)", value: "claude-sonnet-4-5-20250929" },
    { label: "Sonnet 4 (2025-05-14)", value: "claude-sonnet-4-20250514" },
    { type: "separator" },
    { label: "Haiku 4.5 (2025-10-01)", value: "claude-haiku-4-5-20251001" }
  ],
  codex: [
    { labelKey: "defaultCodex", value: "" }
  ]
};

let codexModelPresetCache = {
  command: null,
  ts: 0,
  presets: null,
  refreshing: false
};

function modelSettingKey(provider) {
  return provider === "codex" ? "codexModel" : "claudeModel";
}

function parseCodexModelCatalog(stdout) {
  const raw = String(stdout || "").trim();
  const line = raw
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.startsWith("{") && part.includes("\"models\""));
  for (const candidate of [raw, line].filter(Boolean)) {
    try {
      const parsed = JSON.parse(candidate);
      if (!Array.isArray(parsed.models)) continue;
      const models = parsed.models
        .filter((model) => model && model.visibility === "list" && model.slug)
        .map((model) => ({
          label: model.display_name || model.slug,
          value: model.slug
        }));
      if (models.length) return models;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

function codexDefaultPreset() {
  return { labelKey: "defaultCodex", value: "" };
}

function readCodexModelPresetsFromFile() {
  try {
    const file = path.join(os.homedir(), ".codex", "models_cache.json");
    if (!fs.existsSync(file)) return null;
    return parseCodexModelCatalog(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function setCodexModelPresetCache(command, presets) {
  if (!presets || !presets.length) return null;
  codexModelPresetCache = {
    command,
    ts: Date.now(),
    presets: [codexDefaultPreset(), ...presets],
    refreshing: false
  };
  return codexModelPresetCache.presets;
}

function refreshCodexModelPresetsInBackground(command) {
  if (!command || codexModelPresetCache.refreshing) return;
  codexModelPresetCache.refreshing = true;
  let stdout = "";
  let killed = false;
  try {
    const proc = spawnCli(command, ["debug", "models"], {
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "ignore"]
    });
    const timer = setTimeout(() => {
      killed = true;
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, 3500);
    proc.stdout.on("data", (chunk) => {
      if (stdout.length < 8 * 1024 * 1024) stdout += chunk.toString("utf8");
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      codexModelPresetCache.refreshing = false;
      if (code !== 0 || killed) return;
      setCodexModelPresetCache(command, parseCodexModelCatalog(stdout));
    });
    proc.on("error", () => {
      clearTimeout(timer);
      codexModelPresetCache.refreshing = false;
    });
  } catch {
    codexModelPresetCache.refreshing = false;
  }
}

function codexModelPresetsForMenu() {
  const availability = chat.getProviderAvailability({ refresh: false });
  const command = availability.providers.codex?.command;
  if (!command) return null;
  const now = Date.now();
  if (
    codexModelPresetCache.command === command &&
    codexModelPresetCache.presets
  ) {
    if (now - codexModelPresetCache.ts > 5 * 60 * 1000) {
      refreshCodexModelPresetsInBackground(command);
    }
    return codexModelPresetCache.presets;
  }

  const filePresets = setCodexModelPresetCache(command, readCodexModelPresetsFromFile());
  refreshCodexModelPresetsInBackground(command);
  return filePresets || MODEL_PRESETS.codex;
}

function modelPresetsForProvider(provider) {
  if (provider === "codex") {
    return codexModelPresetsForMenu();
  }
  return MODEL_PRESETS[provider] || null;
}

function includeCurrentModelPreset(presets, current) {
  if (!current || presets.some((item) => item.value === current)) return presets;
  return [
    ...presets,
    { type: "separator" },
    { label: mt("currentCustom", current), value: current }
  ];
}

function modelPresetLabel(preset) {
  if (preset.labelKey) return mt(preset.labelKey);
  return preset.label || preset.value || "";
}

function desktopPetSizeLabel(sizeKey) {
  switch (sizeKey) {
    case "small": return mt("sizeSmall");
    case "large": return mt("sizeLarge");
    case "medium":
    default:
      return mt("sizeMedium");
  }
}

// A "Model" submenu for whichever backend is active. Returned as an array so it
// can be spread into the menu (empty when no backend / presets are available).
function buildModelMenuItems() {
  const availability = chat.getProviderAvailability({ refresh: false });
  const provider = availability.activeProvider;
  const presets = provider && modelPresetsForProvider(provider);
  if (!presets) return [];
  const key = modelSettingKey(provider);
  let current = String(settings.get(key) || "");
  if (provider === "codex" && current && !presets.some((item) => item.value === current)) {
    settings.set({ [key]: "" });
    current = "";
  }
  const visiblePresets = includeCurrentModelPreset(presets, current);
  const label = provider === "codex" ? mt("modelCodex") : mt("modelClaude");
  return [
    {
      label,
      submenu: visiblePresets.map((m) => (
        m.type === "separator"
          ? { type: "separator" }
          : {
              label: modelPresetLabel(m),
              type: "radio",
              checked: current === m.value,
              click: () => settings.set({ [key]: m.value })
            }
      ))
    }
  ];
}

function buildContextMenu() {
  const all = settings.getAll();
  return Menu.buildFromTemplate([
    {
      label: mt("openChat"),
      click: () => {
        if (!popover) createPopover();
        if (!popover.isVisible()) {
          positionPopover();
          popover.show();
          popover.focus();
        }
      }
    },
    { type: "separator" },
    {
      label: mt("appearance"),
      submenu: [
        {
          label: mt("system"),
          type: "radio",
          checked: (all.theme || "system") === "system",
          click: () => setTheme("system")
        },
        {
          label: mt("light"),
          type: "radio",
          checked: all.theme === "light",
          click: () => setTheme("light")
        },
        {
          label: mt("dark"),
          type: "radio",
          checked: all.theme === "dark",
          click: () => setTheme("dark")
        }
      ]
    },
    {
      label: mt("language"),
      submenu: [
        {
          label: mt("languageSystem"),
          type: "radio",
          checked: (all.menuLanguage || "system") === "system",
          click: () => setMenuLanguage("system")
        },
        {
          label: mt("languageZh"),
          type: "radio",
          checked: all.menuLanguage === "zh",
          click: () => setMenuLanguage("zh")
        },
        {
          label: mt("languageEn"),
          type: "radio",
          checked: all.menuLanguage === "en",
          click: () => setMenuLanguage("en")
        }
      ]
    },
    {
      label: mt("skills"),
      type: "checkbox",
      checked: all.skillsEnabled !== false,
      click: (item) => settings.set({ skillsEnabled: item.checked })
    },
    {
      label: mt("agentMode"),
      type: "checkbox",
      checked: Boolean(all.agentMode),
      click: (item) => {
        toggleAgentMode(item.checked);
      }
    },
    buildUsageBackendMenuItem(),
    ...buildModelMenuItems(),
    {
      label: mt("autoScreenshot"),
      type: "checkbox",
      visible: Boolean(all.agentMode),
      checked: all.autoScreenshot !== false,
      click: (item) => settings.set({ autoScreenshot: item.checked })
    },
    {
      label: mt("desktopPet"),
      type: "checkbox",
      checked: all.desktopPet !== false,
      click: (item) => {
        settings.set({ desktopPet: item.checked });
        if (item.checked) {
          scheduleDesktopPet();
        } else {
          hideDesktopPet();
        }
      }
    },
    {
      label: mt("showDesktopPet"),
      enabled: all.desktopPet !== false,
      click: () => showDesktopPet()
    },
    {
      label: mt("desktopPetSize"),
      enabled: all.desktopPet !== false,
      submenu: Object.keys(DESKTOP_PET_SIZES).map((sizeKey) => ({
        label: desktopPetSizeLabel(sizeKey),
        type: "radio",
        checked: (all.desktopPetSize || "medium") === sizeKey,
        click: () => setDesktopPetSize(sizeKey)
      }))
    },
    {
      label: mt("setChatDirectory"),
      click: async () => {
        const current = (all.chatCwd || "").trim();
        const result = await dialog.showOpenDialog({
          title: mt("chooseProjectFolder"),
          defaultPath: current || app.getPath("home"),
          properties: ["openDirectory", "createDirectory"]
        });
        if (!result.canceled && result.filePaths[0]) {
          settings.set({ chatCwd: result.filePaths[0] });
        }
      }
    },
    {
      label: mt("clearChatDirectory"),
      enabled: Boolean((all.chatCwd || "").trim()),
      click: () => settings.set({ chatCwd: "" })
    },
    { type: "separator" },
    {
      label: mt("restartPriestess"),
      click: () => restartApp()
    },
    {
      label: mt("revealDataFolder"),
      click: () => shell.openPath(app.getPath("userData"))
    },
    ...buildUpdateMenuItems(),
    { type: "separator" },
    {
      label: mt("quit"),
      accelerator: "CmdOrCtrl+Q",
      click: () => app.quit()
    }
  ]);
}

// Quit and relaunch. The main use is macOS Screen Recording: that permission
// only takes effect after a restart, so once the Doctor grants it this makes
// "grant → restart" a single click instead of a manual quit + reopen.
function restartApp() {
  app.relaunch();
  app.exit(0);
}

// Update controls: a manual check plus, when something is waiting, an action
// item (install now on Windows / open the download page on macOS).
function buildUpdateMenuItems() {
  const pending = updater.getPendingUpdate();
  const items = [{ label: mt("checkUpdates"), click: () => updater.checkNow() }];
  if (pending) {
    if (pending.action === "install") {
      // macOS downloads + installs in place; Windows restarts into the staged
      // installer.
      const label =
        process.platform === "darwin"
          ? mt("downloadInstallUpdate", pending.version)
          : mt("restartUpdate", pending.version);
      items.push({ label, click: () => updater.installNow() });
    } else {
      items.push({
        label: mt("downloadUpdate", pending.version),
        click: () => updater.openDownloadPage()
      });
    }
  }
  return items;
}

function syncTrayTooltip() {
  if (!tray) return;
  const cwd = (settings.get("chatCwd") || "").trim();
  const availability = chat.getProviderAvailability({ refresh: false });
  const active = availability.activeProvider;
  const provider = active ? availability.providers[active].shortLabel : "Ready";
  tray.setToolTip(cwd ? `PRTS · ${provider} · ${cwd}` : `PRTS · ${provider}`);
}

// ============================================================
//  App lifecycle
// ============================================================
// ============================================================
//  Conversation persistence — history + sessionId across restarts.
// ============================================================
function loadConversation() {
  try {
    if (!conversationFile || !fs.existsSync(conversationFile)) return;
    const raw = fs.readFileSync(conversationFile, "utf8");
    const parsed = JSON.parse(raw);
    chat.hydrate(parsed);
  } catch (error) {
    console.warn("main: failed to load conversation", error);
  }
}

function scheduleSaveConversation() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveConversation, 600);
}

function saveConversation() {
  if (!conversationFile) return;
  try {
    fs.writeFileSync(
      conversationFile,
      JSON.stringify(
        {
          sessionIds: chat.getSessionIds(),
          history: chat.getPersistableHistory(),
          longMemoryDormant: chat.isLongMemoryDormant()
        },
        null,
        2
      ),
      "utf8"
    );
  } catch (error) {
    console.warn("main: failed to save conversation", error);
  }
}

function wipePersistedConversation() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  chat.wipeSession();
  if (!conversationFile) return;
  try {
    fs.writeFileSync(
      conversationFile,
      JSON.stringify(
        {
          sessionIds: chat.getSessionIds(),
          history: [],
          longMemoryDormant: true
        },
        null,
        2
      ),
      "utf8"
    );
  } catch (error) {
    console.warn("main: failed to wipe conversation on boundary quit", error);
  }
}

function maybeNotifyDoneNotification(event) {
  if (event.status !== "idle") return;
  if (event.error || event.cancelled) return;
  const duration = chat.getLastTurnDurationMs();
  if (duration < 20000) return;
  // Only fire if the popover isn't currently focused — no point notifying
  // about something the Doctor is already watching.
  if (popover && popover.isVisible() && popover.isFocused()) return;
  if (!Notification.isSupported()) return;
  try {
    new Notification({
      title: "PRTS",
      body: "Response complete.",
      silent: false
    }).show();
  } catch (error) {
    console.warn("main: notification failed", error);
  }
}

app.whenReady().then(() => {
  // On macOS, become a status-menu accessory BEFORE creating the Tray.
  // Packaged builds set LSUIElement=true in Info.plist so they already launch
  // as accessories; dev (`npm run dev`) and raw Electron.app launches need an
  // explicit transition. setActivationPolicy is the documented modern API and
  // avoids the timing pitfalls of app.dock.hide(), which can transition the
  // activation policy after the Tray is created and drop the status item —
  // the exact cause of the missing dev menu-bar icon.
  if (process.platform === "darwin") {
    app.setActivationPolicy("accessory");
  }

  if (process.platform === "win32") {
    // A stable AppUserModelID so Windows attributes toast notifications (rest
    // reminders, "update ready", "response complete") to PRTS — without it,
    // toasts can be dropped or shown under a generic name.
    app.setAppUserModelId("local.claude-code-but-priestess.menubar");
  }

  settings.init();
  applyThemeSource();
  // Keep the opaque (non-macOS) popover fill aligned with the resolved
  // appearance. Fires both when the OS theme changes while in "system" mode
  // and when we flip themeSource via the Appearance menu.
  nativeTheme.on("updated", syncPopoverBackground);
  chat.refreshProviderAvailability();
  conversationFile = path.join(app.getPath("userData"), "conversation.json");
  persona.ensureMemoryFile();
  persona.ensureConversationArchiveFile();
  persona.ensureConversationSummaryFile();
  loadConversation();
  Menu.setApplicationMenu(null);

  tray = new Tray(buildTrayIcon());
  tray.setToolTip("PRTS");
  tray.setIgnoreDoubleClickEvents(true);

  tray.on("click", () => togglePopover());
  tray.on("right-click", () => tray.popUpContextMenu(buildContextMenu()));

  // Background update check (Windows self-updates; macOS notifies + opens the
  // download page). No-op in dev / unpackaged builds.
  updater.init();

  setTimeout(() => {
    chat.refreshProviderAvailability();
    syncTrayTooltip();
    if (popover && !popover.isDestroyed()) {
      popover.webContents.send("settings:state", buildSettingsState());
    }
  }, 0);

  settings.subscribe(() => {
    syncTrayTooltip();
    if (popover && !popover.isDestroyed()) {
      popover.webContents.send("settings:state", buildSettingsState());
    }
  });

  chat.subscribe((event) => {
    if (event.kind === "history") {
      scheduleSaveConversation();
    } else if (event.kind === "status") {
      maybeNotifyDoneNotification(event);
      if (event.status === "running") {
        hideDesktopPet();
      } else if (event.status === "idle") {
        scheduleDesktopPet();
      }
    }
    if (!popover || popover.isDestroyed()) return;
    if (event.kind === "history") {
      popover.webContents.send("chat:history", event.history);
    } else if (event.kind === "chunk") {
      popover.webContents.send("chat:chunk", {
        messageId: event.messageId,
        text: event.text
      });
    } else if (event.kind === "status") {
      popover.webContents.send("chat:status", event);
    } else if (event.kind === "tool") {
      popover.webContents.send("chat:tool", {
        active: event.active,
        name: event.name,
        summary: event.summary
      });
    } else if (event.kind === "mood") {
      popover.webContents.send("chat:mood", { mood: event.mood });
    } else if (event.kind === "quit") {
      wipePersistedConversation();
      setTimeout(() => app.exit(0), 1500);
    } else if (event.kind === "queue") {
      popover.webContents.send("chat:queue", { length: event.length });
    }
  });

  createPopover();
  scheduleDesktopPet();
});

app.on("window-all-closed", () => {
  // Menu bar accessory — never quit on window close.
});

// ============================================================
//  IPC
// ============================================================
ipcMain.handle("popover:hide", () => {
  collapsePopoverToDesktopPet();
});

ipcMain.handle("popover:activity", () => {
  scheduleDesktopPet();
});

ipcMain.handle("desktop-pet:open-chat", () => openChatFromDesktopPet());

ipcMain.handle("desktop-pet:move", (_, point) => moveDesktopPetTo(point));

ipcMain.handle("popover:move", (_, point) => movePopoverTo(point));

ipcMain.handle("popover:get-bounds", () => {
  if (!popover || popover.isDestroyed()) return null;
  return popover.getBounds();
});

ipcMain.handle("popover:resize-drag", (_, payload) => resizePopoverDrag(payload));

ipcMain.handle("chat:send", (_, text) => chat.send(text));
ipcMain.handle("chat:cancel", () => {
  chat.cancel();
  return { ok: true };
});
ipcMain.handle("chat:clear", () => {
  chat.clear();
  return { ok: true };
});
ipcMain.handle("chat:get-history", () => chat.getHistory());

ipcMain.handle("settings:get", () => buildSettingsState());

ipcMain.handle("settings:pick-cwd", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose project folder for chat",
    defaultPath: settings.get("chatCwd") || app.getPath("home"),
    properties: ["openDirectory", "createDirectory"]
  });
  if (!result.canceled && result.filePaths[0]) {
    settings.set({ chatCwd: result.filePaths[0] });
  }
  return buildSettingsState();
});
