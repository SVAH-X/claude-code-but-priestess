// ============================================================
//  One-off asset pipeline: bake background transparency into the character
//  frame PNGs so the renderers no longer need their startup flood fill.
//
//  Mirrors renderer.js prepareTransparentFrame exactly (edge-connected
//  near-white flood fill + halo fade), and additionally clears chosen
//  ENCLOSED near-white regions (the two gaps inside her hair) that an
//  edge-connected fill can never reach. Eye whites are also enclosed
//  regions, so holes are cleared only by explicit seed points — never by
//  "remove all white", which would blank her eyes.
//
//  Usage:
//    npx electron scripts/flatten-character-assets.js --inspect
//        Writes /tmp/prts-flatten/<name>-debug.png (background → magenta,
//        enclosed candidates → red) and prints every enclosed component, so
//        a human can pick the hole seeds below.
//    npx electron scripts/flatten-character-assets.js --apply
//        Overwrites the frame PNGs in assets/character (originals are in
//        git — `git checkout -- assets/character` reverts).
// ============================================================

const { app, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const ASSETS_DIR = path.join(__dirname, "..", "assets", "character");
const FRAME_FILES = [
  "睁眼.png",
  "半眯眼.png",
  "快闭眼.png",
  "闭眼.png",
  "笑.png",
  "生气.png",
  "威胁.png",
  "哭唧唧.png",
  "睡觉.png"
];

// Enclosed regions to clear, as image-space seed points (decided by running
// --inspect and looking at the debug renders). A seed clears any enclosed
// near-white component within `radius` px of it; seeds that land on nothing
// are ignored, so shared seeds are safe across frames with shifted art.
const { seeds: HOLE_SEEDS, radius: HOLE_SEED_RADIUS } = require("./flatten-hole-seeds.json");

// Same criteria as renderer.js isEdgeBackground.
function isBackgroundish(data, index) {
  const r = data[index];
  const g = data[index + 1];
  const b = data[index + 2];
  const a = data[index + 3];
  return a > 0 && 765 - r - g - b < 95 && Math.max(r, g, b) - Math.min(r, g, b) < 30;
}

function floodFrom(seeds, data, width, height, eligible, visited) {
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const tryPush = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const pixel = y * width + x;
    if (visited[pixel] || !eligible(data, pixel * 4)) return;
    visited[pixel] = 1;
    queue[tail++] = pixel;
  };
  for (const [x, y] of seeds) tryPush(x, y);
  const collected = [];
  while (head < tail) {
    const pixel = queue[head++];
    collected.push(pixel);
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    tryPush(x + 1, y);
    tryPush(x - 1, y);
    tryPush(x, y + 1);
    tryPush(x, y - 1);
  }
  return collected;
}

function edgeSeeds(width, height) {
  const seeds = [];
  for (let x = 0; x < width; x += 1) {
    seeds.push([x, 0], [x, height - 1]);
  }
  for (let y = 1; y < height - 1; y += 1) {
    seeds.push([0, y], [width - 1, y]);
  }
  return seeds;
}

// All enclosed near-white components (background-like but unreachable from
// the image edge): hair gaps, eye whites, shirt highlights, …
function findEnclosedComponents(data, width, height, bgMask) {
  const seen = new Uint8Array(bgMask); // copy — bg already "seen"
  const components = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (seen[pixel] || !isBackgroundish(data, pixel * 4)) continue;
      const pixels = floodFrom([[x, y]], data, width, height, isBackgroundish, seen);
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      let sumX = 0;
      let sumY = 0;
      let sumC0 = 0;
      let sumC1 = 0;
      let sumC2 = 0;
      for (const p of pixels) {
        const px = p % width;
        const py = Math.floor(p / width);
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
        sumX += px;
        sumY += py;
        sumC0 += data[p * 4];
        sumC1 += data[p * 4 + 1];
        sumC2 += data[p * 4 + 2];
      }
      components.push({
        pixels,
        area: pixels.length,
        bbox: { minX, minY, maxX, maxY },
        centroid: { x: Math.round(sumX / pixels.length), y: Math.round(sumY / pixels.length) },
        // BGRA order, but the white checks are channel-symmetric.
        avgColor: [
          Math.round(sumC0 / pixels.length),
          Math.round(sumC1 / pixels.length),
          Math.round(sumC2 / pixels.length)
        ]
      });
    }
  }
  components.sort((a, b) => b.area - a.area);
  return components;
}

// Same halo cleanup as renderer.js: fade white-leaning, low-saturation pixels
// that touch a cleared pixel. `data` colors stay straight (unpremultiplied)
// here; premultiplication happens once at encode time.
function fadeHalo(data, width, height, clearedMask) {
  const HALO_MIN_SUM = 480;
  const HALO_FULL_SUM = 720;
  const HALO_MAX_SAT = 60;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (clearedMask[pixel]) continue;
      const index = pixel * 4;
      if (data[index + 3] === 0) continue;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const sumRGB = r + g + b;
      if (sumRGB < HALO_MIN_SUM) continue;
      if (Math.max(r, g, b) - Math.min(r, g, b) > HALO_MAX_SAT) continue;
      const touchesCleared =
        (x > 0 && clearedMask[pixel - 1]) ||
        (x < width - 1 && clearedMask[pixel + 1]) ||
        (y > 0 && clearedMask[pixel - width]) ||
        (y < height - 1 && clearedMask[pixel + width]);
      if (!touchesCleared) continue;
      const t = Math.min(1, (sumRGB - HALO_MIN_SUM) / (HALO_FULL_SUM - HALO_MIN_SUM));
      data[index + 3] = Math.round(data[index + 3] * (1 - t));
    }
  }
}

function loadBitmap(file) {
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) throw new Error(`cannot read ${file}`);
  const { width, height } = image.getSize();
  // BGRA premultiplied — source frames are fully opaque, so colors are
  // unscaled; channel order doesn't matter for the symmetric white checks.
  return { data: Buffer.from(image.toBitmap()), width, height };
}

function writeBitmapAsPng(file, data, width, height) {
  // createFromBitmap expects premultiplied colors: scale RGB by alpha.
  const out = Buffer.from(data);
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3];
    if (a === 255) continue;
    out[i] = Math.round((out[i] * a) / 255);
    out[i + 1] = Math.round((out[i + 1] * a) / 255);
    out[i + 2] = Math.round((out[i + 2] * a) / 255);
  }
  const image = nativeImage.createFromBitmap(out, { width, height });
  fs.writeFileSync(file, image.toPNG());
}

function processFrame(name, { apply }) {
  const file = path.join(ASSETS_DIR, name);
  const { data, width, height } = loadBitmap(file);

  const bgMask = new Uint8Array(width * height);
  floodFrom(edgeSeeds(width, height), data, width, height, isBackgroundish, bgMask);
  const components = findEnclosedComponents(data, width, height, bgMask);

  // Resolve hole seeds → components to clear. A component matches when any of
  // its pixels lies within HOLE_SEED_RADIUS (Chebyshev) of a seed — centroids
  // of staircase-shaped gaps can fall outside their own pixels.
  const holes = [];
  for (const seed of HOLE_SEEDS) {
    for (const c of components) {
      if (holes.includes(c)) continue;
      if (
        seed.x < c.bbox.minX - HOLE_SEED_RADIUS || seed.x > c.bbox.maxX + HOLE_SEED_RADIUS ||
        seed.y < c.bbox.minY - HOLE_SEED_RADIUS || seed.y > c.bbox.maxY + HOLE_SEED_RADIUS
      ) {
        continue;
      }
      const near = c.pixels.some((p) => {
        const px = p % width;
        const py = Math.floor(p / width);
        return Math.abs(px - seed.x) <= HOLE_SEED_RADIUS && Math.abs(py - seed.y) <= HOLE_SEED_RADIUS;
      });
      if (near) holes.push(c);
    }
  }

  const cleared = new Uint8Array(bgMask);
  for (const hole of holes) {
    for (const p of hole.pixels) cleared[p] = 1;
  }

  if (!apply) {
    // Debug render: background magenta, enclosed candidates red (cleared ones
    // dark red), everything else untouched.
    const dbg = Buffer.from(data);
    for (let p = 0; p < width * height; p += 1) {
      const i = p * 4;
      if (bgMask[p]) {
        dbg[i] = 255; dbg[i + 1] = 0; dbg[i + 2] = 255; dbg[i + 3] = 255;
      }
    }
    for (const c of components) {
      const isHole = holes.includes(c);
      for (const p of c.pixels) {
        const i = p * 4;
        dbg[i] = isHole ? 160 : 255; dbg[i + 1] = 0; dbg[i + 2] = 0; dbg[i + 3] = 255;
      }
    }
    const outDir = "/tmp/prts-flatten";
    fs.mkdirSync(outDir, { recursive: true });
    writeBitmapAsPng(path.join(outDir, `${name.replace(/\.png$/, "")}-debug.png`), dbg, width, height);
    return {
      name,
      bgPixels: bgMask.reduce((n, v) => n + v, 0),
      cornerColor: [data[0], data[1], data[2]],
      components: components.slice(0, 20).map((c) => ({
        area: c.area,
        bbox: c.bbox,
        centroid: c.centroid,
        avgColor: c.avgColor,
        cleared: holes.includes(c)
      }))
    };
  }

  for (let p = 0; p < width * height; p += 1) {
    if (!cleared[p]) continue;
    const i = p * 4;
    data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0;
  }
  fadeHalo(data, width, height, cleared);
  writeBitmapAsPng(file, data, width, height);
  return { name, holesCleared: holes.map((h) => ({ area: h.area, centroid: h.centroid })) };
}

// Post-apply check: composite each frame over magenta (making transparency
// visible for human review) and assert alpha at known sample points — the
// background corners and hair gaps must be clear, face and eyes must not.
function verifyFrame(name) {
  const file = path.join(ASSETS_DIR, name);
  const { data, width, height } = loadBitmap(file);
  const alphaAt = (x, y) => data[(y * width + x) * 4 + 3];
  const clearNear = (x, y) => {
    for (let dy = -HOLE_SEED_RADIUS; dy <= HOLE_SEED_RADIUS; dy += 1) {
      for (let dx = -HOLE_SEED_RADIUS; dx <= HOLE_SEED_RADIUS; dx += 1) {
        if (alphaAt(x + dx, y + dy) === 0) return true;
      }
    }
    return false;
  };
  const problems = [];
  for (const [x, y] of [[2, 2], [width - 3, 2], [2, height - 3], [width - 3, height - 3]]) {
    if (alphaAt(x, y) !== 0) problems.push(`expected transparent corner (${x},${y})`);
  }
  // Seeds may be pose-specific — require at least half of them (rounded up)
  // to be cleared in every frame. No seeds means nothing to check.
  if (HOLE_SEEDS.length) {
    const seedsCleared = HOLE_SEEDS.filter((s) => clearNear(s.x, s.y)).length;
    const need = Math.ceil(HOLE_SEEDS.length / 2);
    if (seedsCleared < need) {
      problems.push(`only ${seedsCleared}/${HOLE_SEEDS.length} seed areas transparent`);
    }
  }
  for (const [x, y] of [[626, 562], [629, 660]]) { // face cheek, collar/chest
    if (alphaAt(x, y) === 0) problems.push(`expected opaque at (${x},${y})`);
  }
  // Magenta composite for human review.
  const out = Buffer.alloc(data.length);
  for (let p = 0; p < width * height; p += 1) {
    const i = p * 4;
    const a = data[i + 3] / 255;
    out[i] = Math.round(data[i] * a + 255 * (1 - a));
    out[i + 1] = Math.round(data[i + 1] * a);
    out[i + 2] = Math.round(data[i + 2] * a + 255 * (1 - a));
    out[i + 3] = 255;
  }
  const outDir = "/tmp/prts-flatten";
  fs.mkdirSync(outDir, { recursive: true });
  writeBitmapAsPng(path.join(outDir, `${name.replace(/\.png$/, "")}-verify.png`), out, width, height);
  return { name, width, height, ok: problems.length === 0, problems };
}

app.whenReady().then(() => {
  const apply = process.argv.includes("--apply");
  const verify = process.argv.includes("--verify");
  const results = FRAME_FILES.map((name) =>
    verify ? verifyFrame(name) : processFrame(name, { apply })
  );
  console.log(JSON.stringify(results, null, 2));
  app.exit(0);
});
