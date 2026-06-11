// Step 2: extract the 4 sheet sprites with clean alpha + alignment data.
// Checker removal = edge flood over lattice-matching pixels + enclosed
// lattice-verified pockets; then halo fade. Also dumps pairwise body diffs.
const { app, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const DIR = require("node:path").join(__dirname, "..", "..", "assets", "character");
const OUT = require("node:path").join(require("node:os").tmpdir(), "prts-newdress");
const TILE = 25;
const TONE_A = [242, 243, 242];
const TONE_B = [251, 251, 251];
const TOL = 8;

function load(file) {
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) throw new Error("cannot read " + file);
  const { width, height } = img.getSize();
  return { data: Buffer.from(img.toBitmap()), width, height };
}

function savePng(file, data, width, height) {
  const out = Buffer.from(data);
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3];
    if (a === 255) continue;
    out[i] = Math.round((out[i] * a) / 255);
    out[i + 1] = Math.round((out[i + 1] * a) / 255);
    out[i + 2] = Math.round((out[i + 2] * a) / 255);
  }
  fs.writeFileSync(file, nativeImage.createFromBitmap(out, { width, height }).toPNG());
}

const distRGB = (d, i, t) =>
  Math.max(Math.abs(d[i] - t[0]), Math.abs(d[i + 1] - t[1]), Math.abs(d[i + 2] - t[2]));

app.whenReady().then(() => {
  const sheet = load(path.join(DIR, "Nano Banana Workspace Image.png"));
  const { data, width: W, height: H } = sheet;
  const toneAt = (x, y) =>
    ((Math.floor(x / TILE) + Math.floor(y / TILE)) % 2 === 0 ? TONE_A : TONE_B);
  const latticeMatch = (x, y) => distRGB(data, (y * W + x) * 4, toneAt(x, y)) <= TOL;

  // Edge flood over lattice-matching pixels.
  const bg = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let head = 0;
  let tail = 0;
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const p = y * W + x;
    if (bg[p] || !latticeMatch(x, y)) return;
    bg[p] = 1;
    queue[tail++] = p;
  };
  for (let x = 0; x < W; x += 1) { push(x, 0); push(x, H - 1); }
  for (let y = 1; y < H - 1; y += 1) { push(0, y); push(W - 1, y); }
  while (head < tail) {
    const p = queue[head++];
    const x = p % W, y = (p / W) | 0;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }

  // Enclosed lattice pockets: components of lattice-matching pixels not in bg,
  // cleared only when ≥70% of pixels match the expected lattice tone AND the
  // bbox spans at least 2 tiles in some direction OR area small & fully match.
  const seen = new Uint8Array(bg);
  const pockets = [];
  for (let start = 0; start < W * H; start += 1) {
    if (seen[start]) continue;
    const sx = start % W, sy = (start / W) | 0;
    if (!latticeMatch(sx, sy)) continue;
    let h2 = 0, t2 = 0;
    const q2 = [];
    seen[start] = 1; q2[t2++] = start;
    const px = [];
    while (h2 < t2) {
      const p = q2[h2++];
      px.push(p);
      const x = p % W, y = (p / W) | 0;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const np = ny * W + nx;
        if (seen[np] || !latticeMatch(nx, ny)) continue;
        seen[np] = 1;
        q2[t2++] = np;
      }
    }
    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (const p of px) {
      const x = p % W, y = (p / W) | 0;
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    pockets.push({ pixels: px, area: px.length, bbox: [minX, minY, maxX, maxY] });
  }
  // Enclosed pockets are NOT cleared here: heuristics kept eating collar
  // whites / eye glints. The final frames go through the repo's seed-based
  // flatten pipeline instead, where each enclosed region is human-verified
  // (same flow that protected her eyes in the old art).
  const clearedPockets = [];

  // Apply transparency + halo fade.
  const rgba = Buffer.from(data);
  for (let p = 0; p < W * H; p += 1) {
    if (!bg[p]) continue;
    const i = p * 4;
    rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = 0;
  }
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const p = y * W + x;
      if (bg[p]) continue;
      const i = p * 4;
      if (rgba[i + 3] === 0) continue;
      const sum = rgba[i] + rgba[i + 1] + rgba[i + 2];
      const span = Math.max(rgba[i], rgba[i + 1], rgba[i + 2]) - Math.min(rgba[i], rgba[i + 1], rgba[i + 2]);
      if (sum < 600 || span > 30) continue;
      const touches =
        (x > 0 && bg[p - 1]) || (x < W - 1 && bg[p + 1]) ||
        (y > 0 && bg[p - W]) || (y < H - 1 && bg[p + W]);
      if (!touches) continue;
      const t = Math.min(1, (sum - 600) / 165);
      rgba[i + 3] = Math.round(rgba[i + 3] * (1 - t));
    }
  }

  // Figure regions (from analyze step, generous margins).
  const regions = {
    fig0: [180, 30, 560, 620],
    fig1: [680, 30, 1060, 620],
    fig2: [180, 625, 580, 1220],
    fig3: [680, 625, 1060, 1230]
  };
  const sprites = {};
  for (const [name, [x0, y0, x1, y1]] of Object.entries(regions)) {
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const buf = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y += 1)
      for (let x = 0; x < w; x += 1) {
        const si = ((y0 + y) * W + (x0 + x)) * 4;
        const di = (y * w + x) * 4;
        for (let k = 0; k < 4; k += 1) buf[di + k] = rgba[si + k];
      }
    sprites[name] = { data: buf, width: w, height: h };
    savePng(path.join(OUT, `${name}-sprite.png`), buf, w, h);
  }

  // Feet anchors: opaque-pixel bbox bottom + centerX over the bottom 14 rows.
  const anchors = {};
  for (const [name, s] of Object.entries(sprites)) {
    let maxY = -1;
    for (let y = s.height - 1; y >= 0 && maxY === -1; y -= 1)
      for (let x = 0; x < s.width; x += 1)
        if (s.data[(y * s.width + x) * 4 + 3] > 128) { maxY = y; break; }
    let sumX = 0, n = 0;
    for (let y = Math.max(0, maxY - 13); y <= maxY; y += 1)
      for (let x = 0; x < s.width; x += 1)
        if (s.data[(y * s.width + x) * 4 + 3] > 128) { sumX += x; n += 1; }
    anchors[name] = { bottom: maxY, feetCenterX: Math.round(sumX / Math.max(1, n)) };
  }

  // Pairwise body diff fig0 vs others, feet-anchored.
  const f0 = sprites.fig0;
  const a0 = anchors.fig0;
  const diffs = {};
  for (const name of ["fig1", "fig2", "fig3"]) {
    const s = sprites[name];
    const a = anchors[name];
    const dx = a0.feetCenterX - a.feetCenterX;
    const dy = a0.bottom - a.bottom;
    let differing = 0, compared = 0;
    const heat = Buffer.alloc(f0.width * f0.height * 4);
    let minDX = f0.width, minDY = f0.height, maxDX = -1, maxDY = -1;
    for (let y = 0; y < f0.height; y += 1)
      for (let x = 0; x < f0.width; x += 1) {
        const sx = x - dx, sy = y - dy;
        const i0 = (y * f0.width + x) * 4;
        const a0p = f0.data[i0 + 3] > 128;
        const inS = sx >= 0 && sy >= 0 && sx < s.width && sy < s.height;
        const i1 = inS ? (sy * s.width + sx) * 4 : -1;
        const a1p = inS && s.data[i1 + 3] > 128;
        if (!a0p && !a1p) continue;
        compared += 1;
        const d = !a0p !== !a1p
          ? 255
          : Math.max(
              Math.abs(f0.data[i0] - s.data[i1]),
              Math.abs(f0.data[i0 + 1] - s.data[i1 + 1]),
              Math.abs(f0.data[i0 + 2] - s.data[i1 + 2])
            );
        if (d > 24) {
          differing += 1;
          heat[i0] = 0; heat[i0 + 1] = 0; heat[i0 + 2] = 255; heat[i0 + 3] = 255;
          if (x < minDX) minDX = x; if (y < minDY) minDY = y;
          if (x > maxDX) maxDX = x; if (y > maxDY) maxDY = y;
        } else if (a0p) {
          heat[i0] = f0.data[i0]; heat[i0 + 1] = f0.data[i0 + 1]; heat[i0 + 2] = f0.data[i0 + 2]; heat[i0 + 3] = 90;
        }
      }
    diffs[name] = {
      shift: { dx, dy },
      differing,
      compared,
      pct: Math.round((differing / compared) * 1000) / 10,
      diffBbox: maxDX === -1 ? null : [minDX, minDY, maxDX, maxDY]
    };
    savePng(path.join(OUT, `diff-${name}.png`), heat, f0.width, f0.height);
  }

  console.log(JSON.stringify({ clearedPockets, anchors, diffs }, null, 2));
  app.exit(0);
});
