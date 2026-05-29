const path = require("node:path");
const fs = require("node:fs");
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  screen,
  dialog,
  nativeImage,
  shell,
  Notification
} = require("electron");

const settings = require("./settings");
const chat = require("./chat");
const persona = require("./persona");

let conversationFile = null;
let saveTimer = null;
let lastResponseStartedAt = 0;

const ASSETS_DIR = path.join(__dirname, "..", "..", "assets", "character");
const DEDICATED_TRAY_ICON = path.join(ASSETS_DIR, "icon.png");
const POPOVER_DEFAULT_WIDTH = 380;
const POPOVER_DEFAULT_HEIGHT = 560;
const POPOVER_MIN_WIDTH = 320;
const POPOVER_MIN_HEIGHT = 460;
const POPOVER_MAX_WIDTH = 900;
const POPOVER_MAX_HEIGHT = 1000;

let tray;
let popover;
let popoverSizeSaveTimer = null;

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
  const maxWidth = Math.max(POPOVER_MIN_WIDTH, Math.min(POPOVER_MAX_WIDTH, work.width - 8));
  const maxHeight = Math.max(POPOVER_MIN_HEIGHT, Math.min(POPOVER_MAX_HEIGHT, work.height - 8));
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

function resizePopoverTo(size = {}) {
  if (!popover || popover.isDestroyed()) return null;
  const bounds = popover.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const work = display.workArea;
  const next = clampPopoverSize(size, display);
  const x = clampNumber(bounds.x, work.x + 4, work.x + work.width - next.width - 4);
  const y = clampNumber(bounds.y, work.y + 4, work.y + work.height - next.height - 4);
  popover.setBounds({ x, y, width: next.width, height: next.height }, false);
  scheduleSavePopoverSize();
  return next;
}

// Edge/corner drag resize. The renderer captures the window bounds at pointer
// down (start) plus the live screen-space delta (dx/dy); the edge string tells
// us which sides move. We keep the opposite edge anchored even when the size
// clamps to its min/max, so the window never drifts. The top edge is never a
// mover here — the popover hangs from the menu bar.
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

  const maxWidth = Math.max(POPOVER_MIN_WIDTH, Math.min(POPOVER_MAX_WIDTH, work.width - 8));
  const maxHeight = Math.max(POPOVER_MIN_HEIGHT, Math.min(POPOVER_MAX_HEIGHT, work.height - 8));

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

function createPopover() {
  const size = initialPopoverSize();
  popover = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: POPOVER_MIN_WIDTH,
    minHeight: POPOVER_MIN_HEIGHT,
    show: false,
    frame: false,
    resizable: true,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    transparent: true,
    backgroundColor: "#00000000",
    // "under-window" is one of the most translucent NSVisualEffectMaterials —
    // it keeps the macOS liquid-glass blur but lets much more of the desktop
    // read through than the denser "popover" material. Pair it with the low
    // CSS surface tints in styles.css to keep the panel see-through.
    vibrancy: "under-window",
    visualEffectState: "active",
    roundedCorners: true,
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
  // Center the popover under the tray icon, with a small downward gap.
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
  let y = Math.round(trayBounds.y + trayBounds.height + 6);
  // Clamp inside the active display so we never spill off-screen.
  x = Math.max(work.x + 4, Math.min(work.x + work.width - winBounds.width - 4, x));
  y = Math.max(work.y + 4, y);
  popover.setPosition(x, y, false);
}

function togglePopover() {
  if (!popover) createPopover();
  if (popover.isVisible()) {
    popover.hide();
    return;
  }
  positionPopover();
  popover.show();
  popover.focus();
  popover.webContents.send("popover:opened");
}

// ============================================================
//  Tray context menu — right-click for settings + quit.
// ============================================================
async function toggleAgentMode(nextValue) {
  if (nextValue) {
    const result = await dialog.showMessageBox({
      type: "warning",
      title: "Enable agent mode?",
      message:
        "Agent mode lets her run any command on your Mac without asking permission for each tool.",
      detail:
        "She will be able to take screenshots, click and type with AppleScript, read and edit files, " +
        "and run any shell command. macOS will still gate screenshots behind Screen Recording " +
        "permission and mouse/keyboard control behind Accessibility permission — grant those to PRTS " +
        "(or Electron in dev) in System Settings → Privacy & Security if you want her to use them.\n\n" +
        "Only enable this if you trust the conversation. You can turn it off any time from the tray menu.",
      buttons: ["Cancel", "Enable agent mode"],
      defaultId: 0,
      cancelId: 0
    });
    if (result.response !== 1) return;
  }
  settings.set({ agentMode: Boolean(nextValue) });
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
  const availability = chat.refreshProviderAvailability();
  const available = availability.availableProviders;

  if (available.length === 0) {
    return {
      label: "Usage backend: no local CLI found",
      enabled: false
    };
  }

  if (available.length === 1) {
    const provider = availability.providers[available[0]];
    return {
      label: `Usage backend: ${provider.label}`,
      enabled: false
    };
  }

  return {
    label: "Usage backend",
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

function buildContextMenu() {
  const all = settings.getAll();
  return Menu.buildFromTemplate([
    {
      label: "Open Chat",
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
      label: "Agent mode (full screen control)",
      type: "checkbox",
      checked: Boolean(all.agentMode),
      click: (item) => {
        toggleAgentMode(item.checked);
      }
    },
    buildUsageBackendMenuItem(),
    {
      label: "Auto-screenshot each turn",
      type: "checkbox",
      visible: Boolean(all.agentMode),
      checked: all.autoScreenshot !== false,
      click: (item) => settings.set({ autoScreenshot: item.checked })
    },
    {
      label: "Set chat directory…",
      click: async () => {
        const current = (all.chatCwd || "").trim();
        const result = await dialog.showOpenDialog({
          title: "Choose project folder for chat",
          defaultPath: current || app.getPath("home"),
          properties: ["openDirectory", "createDirectory"]
        });
        if (!result.canceled && result.filePaths[0]) {
          settings.set({ chatCwd: result.filePaths[0] });
        }
      }
    },
    {
      label: "Clear chat directory",
      enabled: Boolean((all.chatCwd || "").trim()),
      click: () => settings.set({ chatCwd: "" })
    },
    { type: "separator" },
    {
      label: "Reveal data folder",
      click: () => shell.openPath(app.getPath("userData"))
    },
    { type: "separator" },
    {
      label: "Quit",
      accelerator: "Cmd+Q",
      click: () => app.quit()
    }
  ]);
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

  settings.init();
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
});

app.on("window-all-closed", () => {
  // Menu bar accessory — never quit on window close.
});

// ============================================================
//  IPC
// ============================================================
ipcMain.handle("popover:hide", () => {
  popover?.hide();
});

ipcMain.handle("popover:get-size", () => {
  if (!popover || popover.isDestroyed()) return initialPopoverSize();
  return clampPopoverSize(popover.getBounds(), screen.getDisplayMatching(popover.getBounds()));
});

ipcMain.handle("popover:resize", (_, size) => resizePopoverTo(size));

ipcMain.handle("popover:resize-drag", (_, payload) => resizePopoverDrag(payload));

ipcMain.handle("popover:move", (_, point) => movePopoverTo(point));

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
