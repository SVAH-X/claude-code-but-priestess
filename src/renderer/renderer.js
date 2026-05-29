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
const cwdLine = document.getElementById("cwdLine");

// ============================================================
//  Frame loading — same edge-flood-fill technique as before.
// ============================================================
const ASSET_DIR = new URL("../../assets/character/", window.location.href);
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

const state = {
  mood: "idle",
  expression: "idle",
  punch: 0,
  tremble: 0,
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

function prepareTransparentFrame(image) {
  const source = document.createElement("canvas");
  source.width = image.naturalWidth;
  source.height = image.naturalHeight;
  const srcCtx = source.getContext("2d", { willReadFrequently: true });
  srcCtx.drawImage(image, 0, 0);
  const imageData = srcCtx.getImageData(0, 0, source.width, source.height);
  const { data, width, height } = imageData;
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

async function loadFrame(fileName) {
  const image = new Image();
  image.decoding = "async";
  image.src = new URL(fileName, ASSET_DIR).href;
  await image.decode();
  return prepareTransparentFrame(image);
}

async function loadAllFrames() {
  const entries = await Promise.all(
    Object.entries(FRAME_FILES).map(async ([name, file]) => [name, await loadFrame(file)])
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

  frames = {};
  for (const [name, { canvas }] of entries) {
    const out = document.createElement("canvas");
    out.width = cropW;
    out.height = cropH;
    out.getContext("2d").drawImage(canvas, uMinX, uMinY, cropW, cropH, 0, 0, cropW, cropH);
    frames[name] = out;
  }
}

// ============================================================
//  Canvas + render
// ============================================================
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
  renderExpression(state.expression);
}

function renderExpression(name) {
  const frame = frames[name];
  if (!frame) return;
  state.expression = name;
  stage.dataset.mood = state.mood;

  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  const scale = Math.min((rect.width - 24) / frame.width, (rect.height - 12) / frame.height);
  const drawW = frame.width * scale;
  const drawH = frame.height * scale;
  const drawX = (rect.width - drawW) / 2;
  const drawY = rect.height - drawH;
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

  // Spring the drag offset back to rest when the user lets go. Exponential
  // ease — settles in roughly 250ms which feels lively without overshoot.
  if (!isDragging) {
    const decay = 1 - Math.exp(-dt * 14);
    state.dragX -= state.dragX * decay;
    state.dragY -= state.dragY * decay;
  }

  const scale = breath + state.punch;
  const tx = state.dragX + shakeX;
  const ty = state.dragY + bob + shakeY;
  canvas.style.transform =
    `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${scale.toFixed(4)})`;

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

const CLICK_TIER = { happy: 1, angry: 2, threat: 3 };

// ============================================================
//  Drag handling on the stage — pull her around inside the box.
//  While dragging she shows the threat face; releasing springs
//  her back to rest (handled by the easing branch in tick()).
// ============================================================
const DRAG_THRESHOLD = 4;             // px before a mousedown becomes a drag
const DRAG_LOCK_DURATION = 10 * 60_000; // long enough that auto-release
                                       // never fires mid-grab; we release manually

let pendingDrag = false;
let isDragging = false;
let dragStartMouseX = 0;
let dragStartMouseY = 0;
let dragStartOffsetX = 0;
let dragStartOffsetY = 0;
let justDragged = false;
let justDraggedTimer = null;

function getDragBounds() {
  const sr = stage.getBoundingClientRect();
  const frame = frames.idle || Object.values(frames)[0];
  if (!frame) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  // Mirror the math in renderExpression so the bounds match the actual
  // on-screen character rect.
  const scale = Math.min((sr.width - 24) / frame.width, (sr.height - 12) / frame.height);
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

function releaseClickLock() {
  clearTimeout(lockReleaseTimer);
  lockUntil = 0;
  lockedMood = null;
  applyMood(baseMood);
}

function handleStageMouseDown(event) {
  if (event.button !== 0) return;
  pendingDrag = true;
  dragStartMouseX = event.clientX;
  dragStartMouseY = event.clientY;
  dragStartOffsetX = state.dragX;
  dragStartOffsetY = state.dragY;
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
    lockMood("threat", { durationMs: DRAG_LOCK_DURATION });
  }
  const b = getDragBounds();
  state.dragX = Math.max(b.minX, Math.min(b.maxX, dragStartOffsetX + dx));
  state.dragY = Math.max(b.minY, Math.min(b.maxY, dragStartOffsetY + dy));
}

function handleDocumentMouseUp(event) {
  if (event.button !== 0) return;
  if (!pendingDrag) return;
  pendingDrag = false;
  if (!isDragging) return; // pure click; let handleStageClick run unchanged.
  isDragging = false;
  stage.classList.remove("is-dragging");
  releaseClickLock();
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

function handleStageClick() {
  if (justDragged) {
    justDragged = false;
    return;
  }
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

// ----- Tiny safe markdown renderer for assistant messages -----
// Supports: fenced code blocks, inline code, **bold**, *italic*, [text](url),
// headings (#/##/###), and line breaks. Escapes HTML; restricts links to http(s).
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

function renderMarkdown(input) {
  if (!input) return "";
  const codeBlocks = [];
  // Pull out fenced blocks first so other rules don't munge their contents.
  let src = String(input).replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push({ lang: lang.toLowerCase(), code });
    return ` CB${codeBlocks.length - 1} `;
  });
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
  // Newlines → <br>; collapse extras
  src = src.replace(/\n{2,}/g, "<br><br>").replace(/\n/g, "<br>");
  // Re-insert code blocks
  src = src.replace(/ CB(\d+) /g, (_, idx) => {
    const { lang, code } = codeBlocks[Number(idx)];
    const langClass = lang ? ` class="lang-${escapeHtml(lang)}"` : "";
    return `<pre><code${langClass}>${escapeHtml(code)}</code></pre>`;
  });
  return src;
}

function buildMsgEl(msg) {
  const el = document.createElement("div");
  el.dataset.id = msg.id;
  if (msg.role === "tool") {
    el.className = "msg tool";
    const pill = document.createElement("span");
    pill.className = "tool-pill";
    pill.textContent = `PRTS · ${msg.text || msg.name || "tool"}`;
    el.append(pill);
    return el;
  }
  el.className = `msg ${msg.role}`;
  if (msg.role === "assistant") {
    // Plain text while streaming (current one), markdown when finalized.
    const isStreaming = chatRunning && msg.id === currentAssistantId;
    if (isStreaming) {
      el.textContent = msg.text || "";
      const cur = document.createElement("span");
      cur.className = "cursor";
      el.append(cur);
    } else {
      el.innerHTML = renderMarkdown(msg.text || "");
    }
  } else {
    el.textContent = msg.text || "";
  }
  return el;
}

function renderHistory(history) {
  lastHistory = history || [];
  chatStream.innerHTML = "";
  if (!lastHistory.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Say something to start.";
    chatStream.append(empty);
    currentAssistantId = null;
    return;
  }
  const assistants = lastHistory.filter((m) => m.role === "assistant");
  currentAssistantId = assistants.length ? assistants[assistants.length - 1].id : null;
  for (const msg of lastHistory) {
    chatStream.append(buildMsgEl(msg));
  }
  chatStream.scrollTop = chatStream.scrollHeight;
}

function appendChunk(messageId, text) {
  if (!messageId) return;
  const el = chatStream.querySelector(`.msg.assistant[data-id="${messageId}"]`);
  if (!el) return;
  const cur = el.querySelector(".cursor");
  if (cur) cur.remove();
  el.append(document.createTextNode(text));
  if (chatRunning) {
    const next = document.createElement("span");
    next.className = "cursor";
    el.append(next);
  }
  const nearBottom = chatStream.scrollHeight - chatStream.scrollTop - chatStream.clientHeight < 80;
  if (nearBottom) chatStream.scrollTop = chatStream.scrollHeight;
}

function setRunning(running) {
  const wasRunning = chatRunning;
  chatRunning = running;
  sendBtn.disabled = running || !backendReady;
  cancelBtn.disabled = !running;
  if (running) {
    setBaseMood("thinking");
  } else {
    setBaseMood("idle");
  }
  // When a stream ends, re-render the last assistant message so it picks up
  // markdown formatting instead of the raw streamed plain text.
  if (wasRunning && !running && lastHistory.length) {
    renderHistory(lastHistory);
  }
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

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = composerInput.value.trim();
  if (!text || chatRunning) return;
  composerInput.value = "";
  autosizeInput();
  flashPunch(0.05);
  resetInactivityTimers();
  // Brief acknowledgement: a single "listening" blink-frame.
  renderExpression("halfClosed");
  setTimeout(() => {
    if (chatRunning) renderExpression(MOOD_FRAME[state.mood] || state.mood);
  }, 200);
  const result = await window.chatApi.send(text);
  if (result?.ok === false && result.reason !== "busy") {
    showBubble(`Send failed: ${result.reason}`, 3000);
  }
});

cancelBtn.addEventListener("click", () => window.chatApi.cancel());

clearBtn.addEventListener("click", () => {
  if (!confirm("Clear current session? Long-term memory will be kept.")) return;
  window.chatApi.clear();
  showBubble("Conversation cleared.", 1800);
});

window.chatApi.onHistory((history) => renderHistory(history));
window.chatApi.onChunk(({ messageId, text }) => appendChunk(messageId, text));
window.chatApi.onStatus((event) => {
  if (!event) return;
  if (event.status === "running") {
    setRunning(true);
  } else if (event.status === "idle") {
    setRunning(false);
    resetInactivityTimers();
    if (event.error) {
      setBaseMood("cry");
      showBubble(`Error: ${event.error}`, 4000);
      setTimeout(() => {
        if (baseMood === "cry") setBaseMood("idle");
      }, 2200);
    } else if (event.cancelled) {
      showBubble("Stopped.", 1600);
    } else {
      flashPunch(0.08);
      setBaseMood("happy");
      setTimeout(() => {
        if (baseMood === "happy") setBaseMood("idle");
      }, 1400);
    }
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

// ============================================================
//  Settings (read-only here; right-click tray menu controls it)
// ============================================================
const agentBadge = document.getElementById("agentBadge");
const providerBadge = document.getElementById("providerBadge");

function renderSettings(payload) {
  const cwd = (payload?.chatCwd || "").trim();
  const availability = payload?.providerAvailability;
  const activeProvider = availability?.activeProvider || payload?.chatProvider;
  const providerInfo = activeProvider ? availability?.providers?.[activeProvider] : null;
  backendReady = !availability || (availability.availableProviders || []).length > 0;
  const provider = backendReady
    ? providerInfo?.shortLabel ||
      (activeProvider === "codex" ? "Codex" : activeProvider ? "Claude" : "No CLI")
    : "No CLI";
  if (cwd) {
    const truncated = cwd.length > 42 ? "…" + cwd.slice(-41) : cwd;
    cwdLine.textContent = `${provider} · cwd · ${truncated}`;
    cwdLine.title = cwd;
  } else {
    cwdLine.textContent = `${provider} · cwd · $HOME  ·  right-click tray to set`;
    cwdLine.title = "";
  }
  if (providerBadge) providerBadge.textContent = provider;
  if (agentBadge) agentBadge.hidden = !payload?.agentMode;
  sendBtn.disabled = chatRunning || !backendReady;
  composerInput.placeholder = backendReady
    ? "Talk to her…  (Shift+Enter for newline)"
    : "Install Claude Code or Codex CLI first…";
}

window.petApi?.onSettings?.(renderSettings);
window.petApi?.getSettings?.().then(renderSettings);

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

// ============================================================
//  Click on the character — angry / threat / wake-up reactions.
// ============================================================
stage.addEventListener("click", handleStageClick);

// ============================================================
//  Boot
// ============================================================
window.addEventListener("resize", resizeCanvas);

loadAllFrames()
  .then(() => {
    resizeCanvas();
    setBaseMood("idle");
    resetInactivityTimers();
    requestAnimationFrame(tick);
  })
  .catch((error) => {
    console.error("Failed to load frames:", error);
    showBubble("Failed to load character frames.", 6000);
  });

window.chatApi.getHistory().then(renderHistory);
