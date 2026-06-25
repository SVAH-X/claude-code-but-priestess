const canvas = document.getElementById("petCanvas");
const ctx = canvas.getContext("2d");
// Outfit folders mirror the popover renderer: "formal" = assets/character
// root (default), "casual" = assets/character/casual.
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
  idle: "idle.png",
  halfClosed: "half_closed.png",
  almostClosed: "almost_closed.png",
  closed: "closed.png",
  happy: "smile.png",
  sleep: "sleep.png",
  angry: "angry.png"
};
const CAT_FRAME_FILES = {
  normal: "cat_normal.png",
  crying: "cat_crying.png"
};
const BLINK_SEQUENCE = [
  ["halfClosed", 70],
  ["almostClosed", 60],
  ["closed", 110],
  ["idle", 0]
];

let frames = {};
let catFrames = {};
let catMode = false;
let catMood = "normal";
let expression = "idle";
let bobPhase = Math.random() * Math.PI * 2;
let lastTick = performance.now();
let blinkTimer = null;
let dragging = false;
let moved = false;
let startScreenX = 0;
let startScreenY = 0;
let startWindowX = 0;
let startWindowY = 0;
let canvasWidth = 0;
let canvasHeight = 0;
let action = "idle";
let actionUntil = 0;
let nextActionAt = performance.now() + 4000 + Math.random() * 5000;

function isEdgeBackground(data, index) {
  const r = data[index];
  const g = data[index + 1];
  const b = data[index + 2];
  const a = data[index + 3];
  return a > 0 && 765 - r - g - b < 95 && Math.max(r, g, b) - Math.min(r, g, b) < 30;
}

function cropToOpaqueBbox(source, data, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > 0) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < minX || maxY < minY) return source;
  const pad = 12;
  const x = Math.max(0, minX - pad);
  const y = Math.max(0, minY - pad);
  const w = Math.min(width - x, maxX - minX + 1 + pad * 2);
  const h = Math.min(height - y, maxY - minY + 1 + pad * 2);
  const cropped = document.createElement("canvas");
  cropped.width = w;
  cropped.height = h;
  cropped.getContext("2d").drawImage(source, x, y, w, h, 0, 0, w, h);
  return cropped;
}

function prepareTransparentFrame(image) {
  const source = document.createElement("canvas");
  source.width = image.naturalWidth;
  source.height = image.naturalHeight;
  const sourceCtx = source.getContext("2d", { willReadFrequently: true });
  sourceCtx.drawImage(image, 0, 0);
  const imageData = sourceCtx.getImageData(0, 0, source.width, source.height);
  const { data, width, height } = imageData;

  // Pre-flattened frames (transparent corners) skip the background fill —
  // see scripts/flatten-character-assets.js; the fill below remains as a
  // fallback for unprocessed art.
  const corners = [
    3,
    (width - 1) * 4 + 3,
    (height - 1) * width * 4 + 3,
    (width * height - 1) * 4 + 3
  ];
  if (corners.every((i) => data[i] === 0)) {
    return cropToOpaqueBbox(source, data, width, height);
  }

  const transparent = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  function push(x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const pixel = y * width + x;
    if (transparent[pixel] || !isEdgeBackground(data, pixel * 4)) return;
    transparent[pixel] = 1;
    queue[tail++] = pixel;
  }

  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    push(0, y);
    push(width - 1, y);
  }
  while (head < tail) {
    const pixel = queue[head++];
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const index = pixel * 4;
      if (transparent[pixel]) data[index + 3] = 0;
      if (data[index + 3] > 0) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  sourceCtx.putImageData(imageData, 0, 0);
  if (maxX < minX || maxY < minY) return source;
  const pad = 12;
  const x = Math.max(0, minX - pad);
  const y = Math.max(0, minY - pad);
  const w = Math.min(width - x, maxX - minX + 1 + pad * 2);
  const h = Math.min(height - y, maxY - minY + 1 + pad * 2);
  const cropped = document.createElement("canvas");
  cropped.width = w;
  cropped.height = h;
  cropped.getContext("2d").drawImage(source, x, y, w, h, 0, 0, w, h);
  return cropped;
}

async function loadFrame(fileName, dir) {
  const image = new Image();
  image.src = new URL(fileName, dir).href;
  await image.decode();
  return prepareTransparentFrame(image);
}

async function loadFrames(outfit) {
  const dir = assetDirFor(outfit);
  const entries = await Promise.all(
    Object.entries(FRAME_FILES).map(async ([name, file]) => [name, await loadFrame(file, dir)])
  );
  return Object.fromEntries(entries);
}

async function loadCatFrames() {
  const entries = await Promise.all(
    Object.entries(CAT_FRAME_FILES).map(async ([name, file]) => [name, await loadFrame(file, CAT_DIR)])
  );
  catFrames = Object.fromEntries(entries);
}

function applyCatMode(payload) {
  catMode = !!payload?.cat;
  catMood = payload?.mood || "normal";
}

let loadedOutfit = null;
let outfitLoadToken = 0;

async function applyOutfit(payload) {
  const outfit = outfitFrom(payload);
  if (outfit === loadedOutfit) return;
  const token = ++outfitLoadToken;
  const next = await loadFrames(outfit);
  if (token !== outfitLoadToken) return;
  frames = next;
  loadedOutfit = outfit;
}

function draw(now = performance.now()) {
  // Being carried around: she protests with the angry face until released.
  const carried = dragging && moved;
  const frame = catMode
    ? catFrames[catMood] || catFrames.normal
    : (carried ? frames.angry : frames[expression]) || frames.idle;
  if (!frame) return;
  const dt = Math.min(0.066, (now - lastTick) / 1000);
  lastTick = now;
  bobPhase += dt * 0.1 * Math.PI * 2;
  if (carried) {
    // No scripted sway/bounce while she's held; reset so release lands on idle.
    if (action !== "idle") {
      action = "idle";
      expression = "idle";
    }
    // Sulk grace period: no cheerful action right after being put down.
    nextActionAt = Math.max(nextActionAt, now + 2500);
  } else if (now >= nextActionAt && now >= actionUntil) {
    action = Math.random() < 0.55 ? "sway" : "bounce";
    actionUntil = now + 900 + Math.random() * 700;
    nextActionAt = actionUntil + 4500 + Math.random() * 6500;
    expression = Math.random() < 0.45 ? "happy" : "idle";
  } else if (action !== "idle" && now >= actionUntil) {
    action = "idle";
    expression = "idle";
  }
  const actionProgress = actionUntil > now ? 1 - (actionUntil - now) / 1400 : 0;
  const actionWave = Math.sin(Math.max(0, actionProgress) * Math.PI * 2);
  const sway = action === "sway" ? actionWave * 5 : 0;
  const bounce = action === "bounce" ? -Math.abs(actionWave) * 8 : 0;
  const bob = Math.sin(bobPhase) * 1.8 + bounce;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const nextWidth = Math.max(1, Math.round(width * ratio));
  const nextHeight = Math.max(1, Math.round(height * ratio));
  if (canvasWidth !== nextWidth || canvasHeight !== nextHeight) {
    canvas.width = nextWidth;
    canvas.height = nextHeight;
    canvasWidth = nextWidth;
    canvasHeight = nextHeight;
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const base = Math.min((width - 12) / frame.width, (height - 8) / frame.height);
  const drawW = frame.width * base;
  const drawH = frame.height * base;
  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(frame, (width - drawW) / 2 + sway, height - drawH + bob, drawW, drawH);
  requestAnimationFrame(draw);
}

function scheduleBlink() {
  clearTimeout(blinkTimer);
  blinkTimer = setTimeout(() => {
    let index = 0;
    function step() {
      const [name, delay] = BLINK_SEQUENCE[index++];
      expression = name;
      if (index < BLINK_SEQUENCE.length) setTimeout(step, delay);
      else scheduleBlink();
    }
    step();
  }, 4500 + Math.random() * 5000);
}

canvas.addEventListener("pointerdown", (event) => {
  dragging = true;
  moved = false;
  startScreenX = event.screenX;
  startScreenY = event.screenY;
  startWindowX = window.screenX;
  startWindowY = window.screenY;
  try {
    canvas.setPointerCapture(event.pointerId);
  } catch {
    /* continue without capture */
  }
  document.body.classList.add("is-dragging");
});

canvas.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  const dx = event.screenX - startScreenX;
  const dy = event.screenY - startScreenY;
  if (Math.hypot(dx, dy) > 4) moved = true;
  if (moved) window.petApi.moveDesktopPet({ x: startWindowX + dx, y: startWindowY + dy });
});

canvas.addEventListener("pointerup", (event) => {
  dragging = false;
  try {
    canvas.releasePointerCapture(event.pointerId);
  } catch {
    /* already released */
  }
  document.body.classList.remove("is-dragging");
});

canvas.addEventListener("pointercancel", () => {
  // A cancelled pointer never delivers pointerup — without this the pet would
  // keep tracking the cursor on the next hover.
  dragging = false;
  document.body.classList.remove("is-dragging");
});

// Scroll over the pet to scale her freely (the tray presets remain as quick
// stops). For silky resizing we DON'T throttle or step by a fixed factor:
// instead we accumulate the wheel delta and flush it once per animation frame
// as a single proportional (exponential) zoom. Coalescing per frame caps the
// IPC/resize rate at the display refresh while still reacting to scroll speed,
// and the main process persists the result only after scrolling settles.
const WHEEL_SENSITIVITY = 0.0011; // ~10% per mouse notch; trackpad stays smooth
let pendingWheelDelta = 0;
let wheelFlushScheduled = false;

function normalizedWheelDelta(event) {
  // deltaMode: 0 = pixels (trackpad / most mice), 1 = lines, 2 = pages.
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * 400;
  return event.deltaY;
}

function flushWheelScale() {
  wheelFlushScheduled = false;
  const delta = pendingWheelDelta;
  pendingWheelDelta = 0;
  if (!delta) return;
  // Up (negative delta) grows, down shrinks; exponential keeps it multiplicative
  // and symmetric, so a given scroll feels the same at any current size.
  const factor = Math.exp(-delta * WHEEL_SENSITIVITY);
  window.petApi?.scaleDesktopPet?.(factor)?.catch?.(() => {});
}

window.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    pendingWheelDelta += normalizedWheelDelta(event);
    if (wheelFlushScheduled) return;
    wheelFlushScheduled = true;
    requestAnimationFrame(flushWheelScale);
  },
  { passive: false }
);

canvas.addEventListener("click", () => {
  if (moved) {
    moved = false;
    return;
  }
  window.petApi.openChatFromDesktopPet().catch((error) => {
    console.error("Failed to reopen chat from desktop pet:", error);
  });
});

window.petApi?.onSettings?.((payload) => {
  applyOutfit(payload).catch((error) => console.error("Failed to switch outfit:", error));
});

window.petApi?.onCatMode?.(applyCatMode);

Promise.all([
  (window.petApi?.getSettings?.() ?? Promise.resolve(null)).catch(() => null),
  (window.petApi?.getCatMode?.() ?? Promise.resolve(null)).catch(() => null),
  loadCatFrames().catch(console.error)
]).then(([settingsPayload, catPayload]) => {
  applyCatMode(catPayload);
  return applyOutfit(settingsPayload);
}).then(() => {
  scheduleBlink();
  requestAnimationFrame(draw);
}).catch((error) => console.error("Failed to load frames:", error));
