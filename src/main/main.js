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
const proactive = require("./proactive");
const updater = require("./updater");
const priestessProvider = require("./priestess-provider");
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
const HTML_PANEL_MIN_WIDTH = 200;
// Base pet size at scale 1.0; the actual size is base × desktopPetScale,
// continuously adjustable (scroll over the pet) within these bounds.
const DESKTOP_PET_BASE = Object.freeze({ width: 150, height: 180 });
const DESKTOP_PET_SCALE_MIN = 0.4;
const DESKTOP_PET_SCALE_MAX = 3.0;
const DESKTOP_PET_SCALE_PRESETS = Object.freeze([
  { labelKey: "sizeSmall", scale: 0.8 },
  { labelKey: "sizeMedium", scale: 1.0 },
  { labelKey: "sizeLarge", scale: 1.2 },
  { labelKey: "sizeXL", scale: 1.6 }
]);

let tray;
let popover;
let popoverSizeSaveTimer = null;
let isMovingPopover = false;
// The authoritative popover size. Only legitimate resize paths (creation,
// explicit edge-handle drags, show-time clamping) update it; any other size
// the window reports on Windows is a spurious WM_SIZE and gets reverted.
// This must NOT be re-read from getBounds() at move start — on high-DPI the
// spurious shrink can land before the move begins, which would lock the
// wrong (small) size in for the whole drag.
let popoverExpectedSize = null;
let moveEndFallbackTimer = null;
let desktopPet;
let desktopPetTimer = null;
let desktopPetPositionSaveTimer = null;
// Transient scale during active scroll-resizing. While set, it overrides the
// persisted setting so resizing never has to round-trip through a synchronous
// settings disk write; the final value is persisted once, debounced, after the
// scroll settles.
let liveDesktopPetScale = null;
let desktopPetScalePersistTimer = null;
let pendingDesktopPetScalePosition = null;
// Fixed bottom-centre anchor held for the duration of a scroll-resize gesture
// (cx, bottom as floats). Seeded from the real window when a gesture starts,
// then held — re-reading getBounds() every tick drifts because it lags our own
// rapid setBounds() calls.
let desktopPetScaleAnchor = null;
let desktopPetScaleLastAt = 0;
let windowFadeTimer = null;
let priestessSettingsWindow = null;
let personaNotesWindow = null;
let creditsWindow = null;

// Contributors, ordered by first contribution. Roles are one concise line each
// (a credits screen, not a changelog). The artist is listed last with her own
// links; her 普猫猫 art ships with permission (see LICENSE).
const CREDITS = [
  {
    name: "SVAH-X",
    role: { zh: "作者 · 维护者 · 普瑞赛斯人格与剧情考据", en: "Author · maintainer · Priestess persona & lore" },
    links: [
      { label: "GitHub @SVAH-X", url: "https://github.com/SVAH-X" },
      { label: "B站 @SVAH-X", url: "https://space.bilibili.com/279608882" }
    ]
  },
  {
    name: "Leoluis0705",
    role: { zh: "Windows 支持 · 桌宠模式", en: "Windows support · desktop pet mode" },
    links: [{ label: "GitHub @Leoluis0705", url: "https://github.com/Leoluis0705" }]
  },
  {
    name: "aklnaaw",
    role: { zh: "Linux 适配 · 相关包维护", en: "Linux support · package maintenance" },
    links: [
      { label: "GitHub @aklnaaw", url: "https://github.com/aklnaaw" },
      { label: "B站 @阿卡莲娜-official", url: "https://space.bilibili.com/1179951835" }
    ]
  },
  {
    name: "Karl_Higmut",
    role: { zh: "HTML 预览面板 · 更新器改进", en: "HTML preview panel · updater improvements" },
    links: [
      { label: "GitHub @Karl-441", url: "https://github.com/Karl-441" },
      { label: "牢普，可爱，喜欢！", url: null }
    ],
  },
  {
    name: "-浅蓝笑",
    role: { zh: "「普猫猫」彩蛋美术（经授权收录）", en: "“普猫猫” Easter-egg art (included with permission)" },
    links: [
      { label: "B站 @-浅蓝笑", url: "https://space.bilibili.com/3493287025445075" },
      { label: "抖音 26916156149", url: null },
      { label: "原作品视频 BV1ZKVY6sESy", url: "https://www.bilibili.com/video/BV1ZKVY6sESy" }
    ]
  },
  {
    name: "十月祈雨",
    role: { zh: "图像资源增强性修复", en: "Image assets enhancement" },
    links: [
      { label: "B站 @十月祈雨", url: "https://space.bilibili.com/129931520" },
      { label: "GitHub @OctoberPrayRain", url: "https://github.com/OctoberPrayRain" }
    ]
  }
];
// Ephemeral cat Easter egg state — not persisted, changes on each transition.
// 3.14% per transition (π); a rare, easy-to-miss surprise. When it fires, the
// chat window also tells the persona prompt so she's aware she's a cat.
let currentCatMode = { cat: false, mood: "normal" };

function maybeSendCatMode(petWindow) {
  currentCatMode =
    Math.random() < 0.0314
      ? { cat: true, mood: Math.random() < 0.7 ? "normal" : "crying" }
      : { cat: false, mood: "normal" };
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send("desktop-pet:cat-mode", currentCatMode);
  }
}

// ============================================================
//  Built-in Priestess backend settings — a small local-only window. The
//  server URL / API key / model are stored in settings.json inside userData
//  and are only ever sent to the server the Doctor configures there.
// ============================================================
function openPersonaNotesWindow() {
  if (personaNotesWindow && !personaNotesWindow.isDestroyed()) {
    personaNotesWindow.show();
    personaNotesWindow.focus();
    return;
  }
  personaNotesWindow = new BrowserWindow({
    width: 500,
    height: 480,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: "PRTS · 补充校准",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#11151a" : "#e9edf2",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  personaNotesWindow.setMenuBarVisibility?.(false);
  hardenWebContents(personaNotesWindow.webContents);
  personaNotesWindow.loadFile(
    path.join(__dirname, "..", "renderer", "persona-notes.html")
  );
  personaNotesWindow.once("ready-to-show", () => {
    personaNotesWindow?.show();
    personaNotesWindow?.focus();
  });
  personaNotesWindow.on("closed", () => {
    personaNotesWindow = null;
  });
}

// In-app contributors / credits list. Static content driven by the CREDITS
// table above; links are opened through the main process (shell.openExternal)
// because the window's webContents are hardened against navigation.
function openCreditsWindow() {
  if (creditsWindow && !creditsWindow.isDestroyed()) {
    creditsWindow.show();
    creditsWindow.focus();
    return;
  }
  creditsWindow = new BrowserWindow({
    width: 460,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: "PRTS · 制作者名单",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#11151a" : "#e9edf2",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  creditsWindow.setMenuBarVisibility?.(false);
  hardenWebContents(creditsWindow.webContents);
  creditsWindow.loadFile(path.join(__dirname, "..", "renderer", "credits.html"));
  creditsWindow.once("ready-to-show", () => {
    creditsWindow?.show();
    creditsWindow?.focus();
  });
  creditsWindow.on("closed", () => {
    creditsWindow = null;
  });
}

function openPriestessSettings() {
  if (priestessSettingsWindow && !priestessSettingsWindow.isDestroyed()) {
    priestessSettingsWindow.show();
    priestessSettingsWindow.focus();
    return;
  }
  priestessSettingsWindow = new BrowserWindow({
    width: 460,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: "PRTS · 内置普瑞赛斯",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#11151a" : "#e9edf2",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  priestessSettingsWindow.setMenuBarVisibility?.(false);
  hardenWebContents(priestessSettingsWindow.webContents);
  priestessSettingsWindow.loadFile(
    path.join(__dirname, "..", "renderer", "priestess-settings.html")
  );
  priestessSettingsWindow.once("ready-to-show", () => {
    priestessSettingsWindow?.show();
    priestessSettingsWindow?.focus();
  });
  priestessSettingsWindow.on("closed", () => {
    priestessSettingsWindow = null;
  });
}
let htmlPanelOpen = false;
let htmlPanelWidth = 0;

// ============================================================
//  Tray icon — prefer the dedicated centered icon.png, fallback
//  to a cropped head from the smiling sprite.
// ============================================================
function buildTrayIcon() {
  const dedicated = nativeImage.createFromPath(DEDICATED_TRAY_ICON);
  if (!dedicated.isEmpty()) {
    return prepareTrayImage(dedicated, { size: 22 });
  }

  // Fallback: crop the smiling frame's head from the active outfit. The head
  // sits higher in the formal art than in the casual dress art.
  const casual = settings.get("outfit") === "casual";
  const base = nativeImage.createFromPath(
    casual
      ? path.join(ASSETS_DIR, "casual", "笑.png")
      : path.join(ASSETS_DIR, "笑.png")
  );
  if (base.isEmpty()) return nativeImage.createEmpty();

  const head = casual
    ? base.crop({ x: 377, y: 290, width: 500, height: 500 })
    : base.crop({ x: 377, y: 110, width: 500, height: 500 });
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
  const effectiveMinWidth = htmlPanelOpen
    ? POPOVER_MIN_WIDTH + HTML_PANEL_MIN_WIDTH
    : POPOVER_MIN_WIDTH;
  const maxWidth = Math.max(effectiveMinWidth, work.width - POPOVER_EDGE_MARGIN);
  const maxHeight = Math.max(POPOVER_MIN_HEIGHT, work.height - POPOVER_EDGE_MARGIN);
  return {
    width: clampNumber(size.width ?? POPOVER_DEFAULT_WIDTH, effectiveMinWidth, maxWidth),
    height: clampNumber(size.height ?? POPOVER_DEFAULT_HEIGHT, POPOVER_MIN_HEIGHT, maxHeight)
  };
}

function initialPopoverSize() {
  const saved = settings.get("popoverSize");
  return clampPopoverSize(saved && typeof saved === "object" ? saved : {});
}

function scheduleSavePopoverSize() {
  if (!popover || popover.isDestroyed()) return;
  // Windows may fire a spurious WM_SIZE during setPosition on frameless
  // windows — skip the save while a move is in flight so a transient
  // wrong size is never persisted to settings.
  if (process.platform === 'win32' && isMovingPopover) return;
  clearTimeout(popoverSizeSaveTimer);
  popoverSizeSaveTimer = setTimeout(() => {
    if (!popover || popover.isDestroyed()) return;
    const bounds = popover.getBounds();
    const size = clampPopoverSize(bounds, screen.getDisplayMatching(bounds));
    // Save the base width without the HTML panel, so restarting the app
    // doesn't open a wide window while the panel is hidden.
    if (htmlPanelOpen && htmlPanelWidth > 0) {
      size.width = Math.max(POPOVER_MIN_WIDTH, size.width - htmlPanelWidth);
    }
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
  const effectiveMinWidth = htmlPanelOpen
    ? POPOVER_MIN_WIDTH + HTML_PANEL_MIN_WIDTH
    : POPOVER_MIN_WIDTH;
  const maxWidth = Math.max(effectiveMinWidth, work.width - POPOVER_EDGE_MARGIN);
  const maxHeight = Math.max(POPOVER_MIN_HEIGHT, work.height - POPOVER_EDGE_MARGIN);

  let width = sw + (e.includes("e") ? dx : 0) - (e.includes("w") ? dx : 0);
  let height = sh + (e.includes("s") ? dy : 0) - (e.includes("n") ? dy : 0);
  width = clampNumber(width, effectiveMinWidth, maxWidth);
  height = clampNumber(height, POPOVER_MIN_HEIGHT, maxHeight);

  let x = e.includes("w") ? right - width : sx;
  let y = e.includes("n") ? bottom - height : sy;
  x = clampNumber(x, work.x + 4, work.x + work.width - width - 4);
  y = clampNumber(y, work.y + 4, work.y + work.height - height - 4);
  popoverExpectedSize = { width, height };
  popover.setBounds({ x, y, width, height }, false);
  scheduleSavePopoverSize();
  return { x, y, width, height };
}

// Shared fallback: if the renderer crashes or the pointer is released outside
// the window (no pointerup on document), reset after 5 s of inactivity so the
// size-save guard does not stay locked forever.  Reset on every move so an
// active long-press never trips the timeout.
function resetMoveEndFallback() {
  clearTimeout(moveEndFallbackTimer);
  moveEndFallbackTimer = setTimeout(() => {
    isMovingPopover = false;
  }, 5000);
}

// Move the popover to an absolute screen position, clamped so it stays within
// the work area of whichever display the target point lands on. Used by the
// "carry her around the screen" gesture in the renderer.
function movePopoverTo(point = {}) {
  if (!popover || popover.isDestroyed()) return null;
  const bounds = popover.getBounds();
  // On Windows, clamp and move with the authoritative size — bounds may be
  // momentarily wrong if a spurious WM_SIZE landed mid-drag.
  const width = (process.platform === 'win32' && popoverExpectedSize?.width) || bounds.width;
  const height = (process.platform === 'win32' && popoverExpectedSize?.height) || bounds.height;
  const targetX = Number(point.x);
  const targetY = Number(point.y);
  if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) return null;
  const display = screen.getDisplayNearestPoint({
    x: Math.round(targetX),
    y: Math.round(targetY)
  });
  const work = display.workArea;
  const x = clampNumber(targetX, work.x, work.x + work.width - width);
  const y = clampNumber(targetY, work.y, work.y + work.height - height);
  if (process.platform === 'win32') {
    isMovingPopover = true;
    resetMoveEndFallback();
    popover.setBounds({ x, y, width, height }, false);
  } else {
    popover.setPosition(x, y, false);
  }
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

// All windows load only local files. Any window.open / navigation that points
// elsewhere goes to the system browser instead of a new Electron window —
// markdown links in chat are target="_blank", and a file dropped onto the
// popover must not navigate the UI away.
function hardenWebContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (url !== contents.getURL()) event.preventDefault();
  });
}

function createPopover() {
  const size = initialPopoverSize();
  popoverExpectedSize = { width: size.width, height: size.height };
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

  hardenWebContents(popover.webContents);
  popover.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Sit in the normal window stacking order — other apps can come over the
  // top. The popover still only disappears when the tray icon is clicked
  // again (no blur-to-hide handler), so it doesn't vanish on focus change.

  popover.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  // The renderer's edge handles are the only legitimate user resize path
  // (the window is not natively resizable), so block any OS-initiated resize
  // gesture outright — on Windows a frameless window can receive one while
  // the header is pressed or dragged on high-DPI displays.
  popover.on("will-resize", (event) => {
    if (process.platform === "win32") event.preventDefault();
  });

  popover.on("resize", () => {
    if (
      process.platform === "win32" &&
      popoverExpectedSize &&
      popover &&
      !popover.isDestroyed()
    ) {
      const bounds = popover.getBounds();
      if (
        bounds.width !== popoverExpectedSize.width ||
        bounds.height !== popoverExpectedSize.height
      ) {
        // Spurious WM_SIZE (header press/drag on high-DPI) — restore the
        // authoritative size instead of letting the shrink stick or be saved.
        popover.setBounds({ x: bounds.x, y: bounds.y, ...popoverExpectedSize }, false);
        return;
      }
    }
    scheduleSavePopoverSize();
  });

  popover.on("closed", () => {
    clearTimeout(popoverSizeSaveTimer);
    htmlPanelOpen = false;
    htmlPanelWidth = 0;
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

function desktopPetScale() {
  if (liveDesktopPetScale != null) return liveDesktopPetScale;
  const raw = Number(settings.get("desktopPetScale"));
  if (!Number.isFinite(raw)) return 1.0;
  return Math.min(DESKTOP_PET_SCALE_MAX, Math.max(DESKTOP_PET_SCALE_MIN, raw));
}

function desktopPetSize() {
  const s = desktopPetScale();
  return {
    width: Math.round(DESKTOP_PET_BASE.width * s),
    height: Math.round(DESKTOP_PET_BASE.height * s)
  };
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
  hardenWebContents(desktopPet.webContents);
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

function showDesktopPet() {
  if (!settings.get("desktopPet")) return;
  if (popover?.isVisible()) {
    collapsePopoverToDesktopPet();
    return;
  }
  const pet = createDesktopPet();
  maybeSendCatMode(pet);
  pet.showInactive();
}

function scheduleDesktopPet() {
  clearTimeout(desktopPetTimer);
  desktopPetTimer = null;
  if (!settings.get("desktopPet")) return;
  desktopPetTimer = setTimeout(showDesktopPet, DESKTOP_PET_IDLE_MS);
}

function moveDesktopPetTo(point = {}) {
  // Dragging relocates her, so any held resize anchor is now stale.
  desktopPetScaleAnchor = null;
  const position = clampDesktopPetPosition(point);
  createDesktopPet().setBounds({ ...position, ...desktopPetSize() }, false);
  clearTimeout(desktopPetPositionSaveTimer);
  desktopPetPositionSaveTimer = setTimeout(() => {
    settings.set({ desktopPetPosition: position });
  }, 350);
  return position;
}

function setDesktopPetScale(scale) {
  const next = Math.min(DESKTOP_PET_SCALE_MAX, Math.max(DESKTOP_PET_SCALE_MIN, Number(scale) || 1));
  // Apply immediately via the transient scale; desktopPetSize() reads it so the
  // window resizes this frame without touching disk.
  liveDesktopPetScale = next;
  if (desktopPet && !desktopPet.isDestroyed()) {
    const size = desktopPetSize();
    // Keep her feet planted: resize around a FIXED bottom-centre anchor. The
    // anchor is seeded from the real window only when a fresh gesture starts
    // (or after a >200ms pause); during a continuous scroll it is held, so the
    // position is always recomputed from the same fixed point and never drifts.
    const now = Date.now();
    if (!desktopPetScaleAnchor || now - desktopPetScaleLastAt > 200) {
      const b = desktopPet.getBounds();
      desktopPetScaleAnchor = { cx: b.x + b.width / 2, bottom: b.y + b.height };
    }
    desktopPetScaleLastAt = now;
    const a = desktopPetScaleAnchor;
    const position = clampDesktopPetPosition({
      x: Math.round(a.cx - size.width / 2),
      y: Math.round(a.bottom - size.height)
    });
    desktopPet.setBounds({ ...position, ...size }, false);
    pendingDesktopPetScalePosition = position;
  }
  // Persist once, ~250ms after the last change — a single combined disk write
  // instead of two per scroll tick, which is what made resizing feel choppy.
  clearTimeout(desktopPetScalePersistTimer);
  desktopPetScalePersistTimer = setTimeout(() => {
    desktopPetScalePersistTimer = null;
    const patch = { desktopPetScale: liveDesktopPetScale };
    if (pendingDesktopPetScalePosition) patch.desktopPetPosition = pendingDesktopPetScalePosition;
    pendingDesktopPetScalePosition = null;
    settings.set(patch);
  }, 250);
}

// Scroll over the pet: factor > 1 grows, < 1 shrinks. Resizes live; the scale
// is persisted on a debounce by setDesktopPetScale.
function scaleDesktopPetBy(factor) {
  const f = Number(factor);
  if (!Number.isFinite(f) || f <= 0) return desktopPetScale();
  setDesktopPetScale(desktopPetScale() * f);
  return desktopPetScale();
}

function openChatFromDesktopPet() {
  if (!popover) createPopover();
  const restoredSize = initialPopoverSize();
  popoverExpectedSize = { width: restoredSize.width, height: restoredSize.height };
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
  const chatCat =
    Math.random() < 0.0314
      ? { cat: true, mood: Math.random() < 0.7 ? "normal" : "crying" }
      : { cat: false, mood: "normal" };
  if (popover && !popover.isDestroyed()) {
    popover.webContents.send("desktop-pet:cat-mode", chatCat);
  }
  // Keep her self-awareness in sync with what the Doctor sees: the persona
  // prompt acknowledges the cat form only while it's actually on screen.
  chat.setChatCatMode(chatCat);
  return { ok: true };
}

function showPopover() {
  clearWindowFade();
  const bounds = popover.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const work = display.workArea;
  const size = clampPopoverSize(popoverExpectedSize || bounds, display);
  popoverExpectedSize = { width: size.width, height: size.height };
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
    const pet = createDesktopPet();
    maybeSendCatMode(pet);
    pet.showInactive();
    return;
  }
  // She returns to where she stood before the chat opened (her saved spot) —
  // closing the window must never relocate her to wherever the popover sat.
  const position = initialDesktopPetPosition();
  const pet = createDesktopPet();
  pet.setBounds({ ...position, ...desktopPetSize() }, false);
  fadeWindow(popover, popover.getOpacity(), 0, 220, () => {
    popover.hide();
    popover.setOpacity(1);
    maybeSendCatMode(pet);
    pet.showInactive();
  });
}

// ============================================================
//  HTML Preview side panel — expand / shrink the popover width.
// ============================================================
function openHtmlPanel(width) {
  if (htmlPanelOpen || !popover || popover.isDestroyed()) return;
  const panelWidth = Math.max(HTML_PANEL_MIN_WIDTH, Number.isFinite(width) ? width : HTML_PANEL_MIN_WIDTH);
  const bounds = popover.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const work = display.workArea;
  const newWidth = Math.min(bounds.width + panelWidth, work.width - POPOVER_EDGE_MARGIN);
  if (newWidth <= bounds.width) return;
  let newX = bounds.x;
  if (bounds.x + newWidth > work.x + work.width - POPOVER_EDGE_MARGIN) {
    newX = Math.max(work.x + 4, work.x + work.width - newWidth - POPOVER_EDGE_MARGIN);
  }
  htmlPanelOpen = true;
  htmlPanelWidth = panelWidth;
  // Keep the authoritative size in sync — otherwise the Windows spurious-
  // WM_SIZE guard in the resize handler reverts the expansion immediately.
  popoverExpectedSize = { width: newWidth, height: bounds.height };
  popover.setBounds({ x: newX, y: bounds.y, width: newWidth, height: bounds.height }, true);
  scheduleSavePopoverSize();
}

function closeHtmlPanel() {
  if (!htmlPanelOpen || !popover || popover.isDestroyed()) return;
  htmlPanelOpen = false;
  const bounds = popover.getBounds();
  const newWidth = Math.max(POPOVER_MIN_WIDTH, bounds.width - htmlPanelWidth);
  popoverExpectedSize = { width: newWidth, height: bounds.height };
  popover.setBounds({ x: bounds.x, y: bounds.y, width: newWidth, height: bounds.height }, true);
  htmlPanelWidth = 0;
  scheduleSavePopoverSize();
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
    outfit: "她的服装",
    outfitFormal: "正装（默认）",
    outfitCasual: "休闲",
    skills: "允许她使用技能（音乐 / 搜索 / 应用）",
    coauthorCommits: "提交时署名普瑞赛斯（共同作者）",
    agentMode: "Agent mode（完整屏幕控制）",
    enableAgentTitle: "开启 agent mode？",
    enableAgent: "开启 agent mode",
    waifuMode: "老婆模式",
    enableWaifuTitle: "开启老婆模式？",
    enableWaifu: "开启老婆模式",
    waifuWarnMessage: "让普瑞赛斯时不时自己看一眼屏幕，安静地照看你？",
    waifuWarnDetail:
      "开启后，她每隔约 20 分钟悄悄看一眼屏幕，自己决定要不要开口：累了劝你休息、卡住了搭把手、" +
      "看见你流连别的角色会吃醋（看的是她自己就不会）、看见不该看的东西会拉下脸。" +
      "大多数时候她什么都不说——真正的照看本来就不出声。她还会留一份只存在本机的观察日志，记得你这些天的样子。\n\n" +
      "· 每次查看都是一次模型调用（消耗额度/计费）\n" +
      "· 仅在 Claude Code / Codex backend 下生效\n" +
      "· macOS 需要「屏幕录制」权限\n" +
      "· 默认深夜不打扰、每天最多 20 次（间隔 / 安静时段 / 上限可在 settings.json 调整）",
    responseDone: "回复完成。",
    notificationTitle: "PRTS · 普瑞赛斯",
    cancel: "取消",
    usageNoCli: "使用后端：未找到本地 CLI",
    usageBackend: "使用后端",
    usageBackendOne: (provider) => `使用后端：${provider}`,
    priestessSettings: "内置普瑞赛斯设置…",
    personaNotes: "补充校准…",
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
    sizeXL: "特大",
    sizeScrollHint: "在桌宠上滚动滚轮可无级缩放",
    setChatDirectory: "设置聊天工作目录…",
    chooseProjectFolder: "选择聊天使用的项目文件夹",
    clearChatDirectory: "清除聊天工作目录",
    restartPriestess: "重启普瑞赛斯",
    revealDataFolder: "打开数据目录",
    credits: "制作者名单…",
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
    outfit: "Her outfit",
    outfitFormal: "正装 · Formal (default)",
    outfitCasual: "休闲 · Casual",
    skills: "Let her use skills (music · search · apps)",
    coauthorCommits: "Co-author commits as 普瑞赛斯",
    agentMode: "Agent mode (full screen control)",
    enableAgentTitle: "Enable agent mode?",
    enableAgent: "Enable agent mode",
    waifuMode: "老婆模式 · Waifu mode",
    enableWaifuTitle: "Enable waifu mode?",
    enableWaifu: "Enable waifu mode",
    waifuWarnMessage: "Let Priestess quietly peek at your screen now and then and look after you herself?",
    waifuWarnDetail:
      "Every ~20 minutes she takes a quiet look and decides for herself whether to speak: a rest nudge when you've worked too long, a hand when you're stuck, jealousy if you're fawning over someone who isn't her (she recognizes herself), and a sharp word if she catches something NSFW. Most checks stay silent — real care doesn't announce itself. She also keeps a local-only observation journal of what you've been up to.\n\n" +
      "- Every check is one model call (quota/billing)\n" +
      "- Works only with the Claude Code / Codex backends\n" +
      "- macOS needs Screen Recording permission\n" +
      "- Quiet hours and a 20/day cap apply by default (tune interval / quiet hours / cap in settings.json)",
    responseDone: "Response complete.",
    notificationTitle: "PRTS · Priestess",
    cancel: "Cancel",
    usageNoCli: "Usage backend: no local CLI found",
    usageBackend: "Usage backend",
    usageBackendOne: (provider) => `Usage backend: ${provider}`,
    priestessSettings: "Built-in Priestess settings…",
    personaNotes: "Persona supplement…",
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
    sizeXL: "X-Large",
    sizeScrollHint: "Scroll on the pet to scale freely",
    setChatDirectory: "Set chat directory…",
    chooseProjectFolder: "Choose project folder for chat",
    clearChatDirectory: "Clear chat directory",
    restartPriestess: "Restart Priestess",
    revealDataFolder: "Reveal data folder",
    credits: "Contributors…",
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

// 老婆模式 (waifu mode) is opt-in behind a consent dialog, like agent mode:
// it means periodic screenshots and a model call per check.
async function toggleWaifuMode(nextValue) {
  if (nextValue) {
    const result = await dialog.showMessageBox({
      type: "warning",
      title: mt("enableWaifuTitle"),
      message: mt("waifuWarnMessage"),
      detail: mt("waifuWarnDetail"),
      buttons: [mt("cancel"), mt("enableWaifu")],
      defaultId: 0,
      cancelId: 0
    });
    if (result.response !== 1) return;
  }
  settings.set({ waifuMode: Boolean(nextValue) });
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
    providerAvailability,
    appVersion: app.getVersion()
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
    { label: "Fable 5", value: "claude-fable-5" },
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
      label: mt("outfit"),
      submenu: [
        {
          label: mt("outfitFormal"),
          type: "radio",
          checked: all.outfit !== "casual",
          click: () => settings.set({ outfit: "formal" })
        },
        {
          label: mt("outfitCasual"),
          type: "radio",
          checked: all.outfit === "casual",
          click: () => settings.set({ outfit: "casual" })
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
      label: mt("coauthorCommits"),
      type: "checkbox",
      checked: all.coauthorCommits !== false,
      click: (item) => settings.set({ coauthorCommits: item.checked })
    },
    {
      label: mt("agentMode"),
      type: "checkbox",
      checked: Boolean(all.agentMode),
      click: (item) => {
        toggleAgentMode(item.checked);
      }
    },
    {
      label: mt("waifuMode"),
      type: "checkbox",
      checked: all.waifuMode === true,
      click: (item) => {
        toggleWaifuMode(item.checked);
      }
    },
    buildUsageBackendMenuItem(),
    ...buildModelMenuItems(),
    {
      label: mt("priestessSettings"),
      click: () => openPriestessSettings()
    },
    {
      label: mt("personaNotes"),
      click: () => openPersonaNotesWindow()
    },
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
      submenu: [
        ...DESKTOP_PET_SCALE_PRESETS.map((preset) => ({
          label: mt(preset.labelKey),
          type: "radio",
          checked: Math.abs((Number(all.desktopPetScale) || 1) - preset.scale) < 0.05,
          click: () => setDesktopPetScale(preset.scale)
        })),
        { type: "separator" },
        { label: mt("sizeScrollHint"), enabled: false }
      ]
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
    {
      label: mt("credits"),
      click: () => openCreditsWindow()
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
  // app.exit() skips before-quit — kill a mid-turn CLI subprocess explicitly
  // so it doesn't keep running (and billing) past the restart.
  chat.cancel();
  app.relaunch();
  app.exit(0);
}

// Update controls: a manual check plus, when something is waiting, an action
// item. "download" = Windows found an update and the Doctor decides when to
// download (installs automatically once done); "install" = ready to install;
// "page" = just open the downloads page.
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
    } else if (pending.action === "download") {
      items.push({
        label: mt("downloadInstallUpdate", pending.version),
        click: () => updater.installNow()
      });
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

// She spoke up on her own (proactive care) — surface it with a notification
// carrying her words, unless the Doctor is already looking at the chat.
// Clicking the notification opens the popover.
function notifyProactiveMessage(text) {
  if (popover && popover.isVisible() && popover.isFocused()) return;
  if (!Notification.isSupported()) return;
  try {
    const notification = new Notification({
      title: mt("notificationTitle"),
      body: String(text).replace(/\s+/g, " ").trim().slice(0, 160),
      silent: false
    });
    notification.on("click", () => {
      try {
        hideDesktopPet();
        if (!popover) createPopover();
        if (!popover.isVisible()) {
          positionPopover();
          showPopover();
        } else {
          popover.focus();
        }
      } catch (error) {
        console.warn("main: failed to open chat from notification", error);
      }
    });
    notification.show();
  } catch (error) {
    console.warn("main: proactive notification failed", error);
  }
}

function maybeNotifyDoneNotification(event) {
  if (event.status !== "idle") return;
  if (event.error || event.cancelled || event.silent) return;
  const duration = chat.getLastTurnDurationMs();
  if (duration < 20000) return;
  // Only fire if the popover isn't currently focused — no point notifying
  // about something the Doctor is already watching.
  if (popover && popover.isVisible() && popover.isFocused()) return;
  if (!Notification.isSupported()) return;
  try {
    new Notification({
      title: "PRTS",
      body: mt("responseDone"),
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

  // Background self-turns: proactive screen checks (opt-in) and occasional
  // memory tidy-ups. All gating — interval, cooldown, quiet hours, daily cap,
  // backend availability — lives in proactive.js.
  proactive.start();

  setTimeout(() => {
    chat.refreshProviderAvailability();
    syncTrayTooltip();
    if (popover && !popover.isDestroyed()) {
      popover.webContents.send("settings:state", buildSettingsState());
    }
  }, 0);

  settings.subscribe((_, patch) => {
    syncTrayTooltip();
    // The dedicated icon.png doesn't change with the outfit, but the cropped
    // head fallback does — refresh it so the tray follows an outfit switch.
    if (patch && "outfit" in patch && tray) {
      tray.setImage(buildTrayIcon());
    }
    if (popover && !popover.isDestroyed()) {
      popover.webContents.send("settings:state", buildSettingsState());
    }
    if (patch && "outfit" in patch && desktopPet && !desktopPet.isDestroyed()) {
      desktopPet.webContents.send("settings:state", buildSettingsState());
    }
  });

  chat.subscribe((event) => {
    if (event.kind === "history") {
      scheduleSaveConversation();
    } else if (event.kind === "status") {
      maybeNotifyDoneNotification(event);
      // Silent self-turns (proactive checks, memory upkeep) must not make the
      // desktop pet blink out and back for something invisible.
      if (!event.silent) {
        if (event.status === "running") {
          hideDesktopPet();
        } else if (event.status === "idle") {
          scheduleDesktopPet();
        }
      }
    } else if (event.kind === "proactive") {
      if (event.spoke && event.text) notifyProactiveMessage(event.text);
    } else if (event.kind === "quit") {
      // Boundary quit must run even if the popover window is gone.
      wipePersistedConversation();
      setTimeout(() => app.exit(0), 1500);
      return;
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
    } else if (event.kind === "proactive") {
      popover.webContents.send("chat:proactive", {
        spoke: Boolean(event.spoke),
        text: event.text || ""
      });
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

app.on("before-quit", () => {
  // Don't orphan a mid-turn CLI subprocess — it would keep running (and
  // consuming the Doctor's quota) with no UI attached.
  chat.cancel();
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

ipcMain.handle("desktop-pet:scale", (_, factor) => scaleDesktopPetBy(factor));

ipcMain.handle("popover:move", (_, point) => movePopoverTo(point));

ipcMain.handle("popover:get-bounds", (_, options) => {
  if (!popover || popover.isDestroyed()) return null;
  const bounds = popover.getBounds();
  if (process.platform === 'win32') {
    // Only a header *move* needs the size-save guard. Edge-handle resizes
    // also fetch bounds here, and flagging those used to block their size
    // from being saved for 5 s after the drag started.
    if (options?.forMove) {
      isMovingPopover = true;
      resetMoveEndFallback();
    }
    // Report the authoritative size: a spurious WM_SIZE shrink may already
    // have landed during the press, before this IPC arrived.
    if (popoverExpectedSize) {
      return { ...bounds, ...popoverExpectedSize };
    }
  }
  return bounds;
});

ipcMain.handle("popover:move-end", () => {
  if (process.platform !== 'win32') return;
  isMovingPopover = false;
  clearTimeout(moveEndFallbackTimer);
  scheduleSavePopoverSize();
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

// Built-in Priestess backend config — read/written only to local settings.json.
ipcMain.handle("priestess:get-config", () => ({
  enabled: Boolean(settings.get("priestessEnabled")),
  baseUrl: String(settings.get("priestessBaseUrl") || ""),
  apiKey: String(settings.get("priestessApiKey") || ""),
  model: String(settings.get("priestessModel") || "")
}));

ipcMain.handle("priestess:set-config", (_, cfg) => {
  settings.set({
    priestessEnabled: Boolean(cfg?.enabled),
    priestessBaseUrl: String(cfg?.baseUrl ?? "").trim(),
    priestessApiKey: String(cfg?.apiKey ?? "").trim(),
    priestessModel: String(cfg?.model ?? "").trim()
  });
  chat.refreshProviderAvailability();
  syncTrayTooltip();
  return { ok: true };
});

ipcMain.handle("priestess:test-connection", (_, cfg) =>
  priestessProvider.testConnection({
    baseUrl: String(cfg?.baseUrl ?? settings.get("priestessBaseUrl") ?? ""),
    apiKey: String(cfg?.apiKey ?? settings.get("priestessApiKey") ?? "")
  })
);

ipcMain.handle("priestess:close-settings", () => {
  priestessSettingsWindow?.close();
});

ipcMain.handle("desktop-pet:cat-mode-get", () => currentCatMode);

ipcMain.handle("persona-notes:get", () => settings.get("personaNotes") || "");
ipcMain.handle("persona-notes:set", (_, notes) => {
  settings.set({ personaNotes: typeof notes === "string" ? notes.slice(0, 1500) : "" });
});
ipcMain.handle("persona-notes:close", () => {
  personaNotesWindow?.close();
});

ipcMain.handle("credits:get", () => ({
  lang: menuLanguage(),
  appVersion: app.getVersion(),
  contributors: CREDITS
}));
ipcMain.handle("credits:open-link", (_, url) => {
  if (typeof url === "string" && /^https:\/\//.test(url)) shell.openExternal(url);
});
ipcMain.handle("credits:close", () => {
  creditsWindow?.close();
});

ipcMain.handle("popover:preview-open", (_, payload) => {
  openHtmlPanel(payload?.width);
});

ipcMain.handle("popover:preview-close", () => {
  closeHtmlPanel();
});

ipcMain.handle("html:open-in-browser", async (_, payload) => {
  const html = String(payload?.html || "");
  if (!html.trim()) return { ok: false, reason: "empty content" };
  const tempFile = path.join(os.tmpdir(), `prts-preview-${Date.now()}.html`);
  try {
    fs.writeFileSync(tempFile, html, "utf8");
    const error = await shell.openPath(tempFile);
    if (error) {
      console.warn("main: shell.openPath failed:", error);
      return { ok: false, reason: error };
    }
    return { ok: true, path: tempFile };
  } catch (err) {
    console.warn("main: failed to write temp HTML:", err);
    return { ok: false, reason: err.message };
  }
});
