// Compose the 9 new-dress frames. All bodies come from fig0 (so expression
// swaps never shimmer); faces are transplanted from the sheet variants or
// synthesized in the old art's style. Run: npx electron compose.js
const { app, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const DIR = require("node:path").join(__dirname, "..", "..", "assets", "character");
const OUT = require("node:path").join(require("node:os").tmpdir(), "prts-newdress");
const OUTF = path.join(OUT, "out");

// ---------- io ----------
function load(file) {
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) throw new Error("cannot read " + file);
  const { width, height } = img.getSize();
  return { data: Buffer.from(img.toBitmap()), width, height }; // BGRA premult (opaque src ⇒ straight)
}
function savePng(file, img) {
  const out = Buffer.from(img.data);
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3];
    if (a === 255) continue;
    out[i] = Math.round((out[i] * a) / 255);
    out[i + 1] = Math.round((out[i + 1] * a) / 255);
    out[i + 2] = Math.round((out[i + 2] * a) / 255);
  }
  fs.writeFileSync(file, nativeImage.createFromBitmap(out, { width: img.width, height: img.height }).toPNG());
}
const clone = (img) => ({ data: Buffer.from(img.data), width: img.width, height: img.height });
const A = (img, x, y) => img.data[(y * img.width + x) * 4 + 3];
const idx = (img, x, y) => (y * img.width + x) * 4;

// ---------- components ----------
function components(img, alphaMin = 128) {
  const { width: W, height: H } = img;
  const seen = new Uint8Array(W * H);
  const out = [];
  const queue = new Int32Array(W * H);
  for (let s = 0; s < W * H; s += 1) {
    if (seen[s] || img.data[s * 4 + 3] < alphaMin) continue;
    let head = 0, tail = 0;
    seen[s] = 1; queue[tail++] = s;
    const px = [];
    let minX = W, minY = H, maxX = -1, maxY = -1;
    while (head < tail) {
      const p = queue[head++];
      px.push(p);
      const x = p % W, y = (p / W) | 0;
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const np = ny * W + nx;
        if (seen[np] || img.data[np * 4 + 3] < alphaMin) continue;
        seen[np] = 1; queue[tail++] = np;
      }
    }
    out.push({ px, area: px.length, bbox: [minX, minY, maxX, maxY] });
  }
  out.sort((a, b) => b.area - a.area);
  return out;
}

// Keep main component (plus its low-alpha fringe); return satellites.
function cleanSprite(img, keepSatellitesMin = 25) {
  const comps = components(img);
  const main = comps[0];
  const keepMask = new Uint8Array(img.width * img.height);
  for (const p of main.px) keepMask[p] = 1;
  // grow mask by 2 to keep anti-aliased fringe of the main body
  for (let pass = 0; pass < 2; pass += 1) {
    const grown = Uint8Array.from(keepMask);
    for (let y = 0; y < img.height; y += 1)
      for (let x = 0; x < img.width; x += 1) {
        const p = y * img.width + x;
        if (keepMask[p]) continue;
        if (
          (x > 0 && keepMask[p - 1]) || (x < img.width - 1 && keepMask[p + 1]) ||
          (y > 0 && keepMask[p - img.width]) || (y < img.height - 1 && keepMask[p + img.width])
        ) grown[p] = 1;
      }
    grown.forEach((v, i) => { keepMask[i] = v; });
  }
  const satellites = comps.slice(1).filter((c) => c.area >= keepSatellitesMin);
  const satMask = new Uint8Array(img.width * img.height);
  for (const c of satellites) for (const p of c.px) satMask[p] = 1;
  const cleaned = clone(img);
  for (let p = 0; p < img.width * img.height; p += 1) {
    if (!keepMask[p]) {
      const i = p * 4;
      cleaned.data[i] = 0; cleaned.data[i + 1] = 0; cleaned.data[i + 2] = 0; cleaned.data[i + 3] = 0;
    }
  }
  return { cleaned, satellites, satMask, mainBbox: main.bbox };
}

// ---------- alignment ----------
// Best (dx,dy) aligning `other` onto `base` over a band, minimizing mean diff.
function bestShift(base, other, band, range = 8) {
  let best = { dx: 0, dy: 0, score: Infinity };
  for (let dy = -range; dy <= range; dy += 1)
    for (let dx = -range; dx <= range; dx += 1) {
      let sum = 0, n = 0;
      for (let y = band.y0; y <= band.y1; y += 3)
        for (let x = band.x0; x <= band.x1; x += 3) {
          const sx = x - dx, sy = y - dy;
          if (sx < 0 || sy < 0 || sx >= other.width || sy >= other.height) continue;
          const a0 = A(base, x, y) > 128, a1 = A(other, sx, sy) > 128;
          if (!a0 && !a1) continue;
          if (a0 !== a1) { sum += 160; n += 1; continue; }
          const i0 = idx(base, x, y), i1 = idx(other, sx, sy);
          sum += Math.abs(base.data[i0] - other.data[i1]) +
                 Math.abs(base.data[i0 + 1] - other.data[i1 + 1]) +
                 Math.abs(base.data[i0 + 2] - other.data[i1 + 2]);
          n += 1;
        }
      const score = sum / Math.max(1, n);
      if (score < best.score) best = { dx, dy, score };
    }
  return best;
}

// ---------- face-diff transplant ----------
function diffMask(base, other, shift, zone, tol = 26) {
  const { width: W, height: H } = base;
  const mask = new Uint8Array(W * H);
  for (let y = zone.y0; y <= zone.y1; y += 1)
    for (let x = zone.x0; x <= zone.x1; x += 1) {
      const sx = x - shift.dx, sy = y - shift.dy;
      if (sx < 0 || sy < 0 || sx >= other.width || sy >= other.height) continue;
      const a0 = A(base, x, y) > 128, a1 = A(other, sx, sy) > 128;
      if (!a0 || !a1) continue; // outline wobble handled by erosion anyway
      const i0 = idx(base, x, y), i1 = idx(other, sx, sy);
      const d = Math.max(
        Math.abs(base.data[i0] - other.data[i1]),
        Math.abs(base.data[i0 + 1] - other.data[i1 + 1]),
        Math.abs(base.data[i0 + 2] - other.data[i1 + 2])
      );
      if (d > tol) mask[y * W + x] = 1;
    }
  // erode 1 (kills 1px wobble lines), then dilate 3 (rejoin + margin)
  const erode = (m) => {
    const o = new Uint8Array(m.length);
    for (let y = 1; y < H - 1; y += 1)
      for (let x = 1; x < W - 1; x += 1) {
        const p = y * W + x;
        if (m[p] && m[p - 1] && m[p + 1] && m[p - W] && m[p + W]) o[p] = 1;
      }
    return o;
  };
  const dilate = (m) => {
    const o = Uint8Array.from(m);
    for (let y = 1; y < H - 1; y += 1)
      for (let x = 1; x < W - 1; x += 1) {
        const p = y * W + x;
        if (m[p]) { o[p - 1] = 1; o[p + 1] = 1; o[p - W] = 1; o[p + W] = 1; }
      }
    return o;
  };
  let m = erode(mask);
  m = dilate(dilate(dilate(m)));
  // drop tiny clusters
  const tmp = { data: Buffer.alloc(W * H * 4), width: W, height: H };
  for (let p = 0; p < W * H; p += 1) tmp.data[p * 4 + 3] = m[p] ? 255 : 0;
  const clusters = components(tmp).filter((c) => c.area >= 30);
  const final = new Uint8Array(W * H);
  for (const c of clusters) for (const p of c.px) final[p] = 1;
  return final;
}

function transplant(base, other, shift, mask) {
  const out = clone(base);
  for (let p = 0; p < base.width * base.height; p += 1) {
    if (!mask[p]) continue;
    const x = p % base.width, y = (p / base.width) | 0;
    const sx = x - shift.dx, sy = y - shift.dy;
    if (sx < 0 || sy < 0 || sx >= other.width || sy >= other.height) continue;
    const i0 = p * 4, i1 = idx(other, sx, sy);
    for (let k = 0; k < 4; k += 1) out.data[i0 + k] = other.data[i1 + k];
  }
  return out;
}

// ---------- eyes ----------
function detectEyes(img, zone) {
  const { width: W } = img;
  const tmp = { data: Buffer.alloc(W * img.height * 4), width: W, height: img.height };
  for (let y = zone.y0; y <= zone.y1; y += 1)
    for (let x = zone.x0; x <= zone.x1; x += 1) {
      const i = idx(img, x, y);
      if (img.data[i + 3] < 128) continue;
      const b = img.data[i], g = img.data[i + 1], r = img.data[i + 2];
      const lum = (r + g + b) / 3;
      // Iris is lavender-gray: blue-leaning vs the warm hair/skin, mid-tone.
      if (b >= r - 2 && b > g + 4 && lum > 60 && lum < 215) {
        tmp.data[(y * W + x) * 4 + 3] = 255;
      }
    }
  const eyes = components(tmp)
    .filter((c) => c.area >= 120 && c.bbox[2] - c.bbox[0] >= 16)
    .slice(0, 2);
  eyes.sort((a, b) => a.bbox[0] - b.bbox[0]);
  return eyes.map((e) => ({ x0: e.bbox[0], y0: e.bbox[1], x1: e.bbox[2], y1: e.bbox[3] }));
}

function sampleMedian(img, x0, y0, x1, y1, filter) {
  const ch = [[], [], []];
  for (let y = y0; y <= y1; y += 1)
    for (let x = x0; x <= x1; x += 1) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const i = idx(img, x, y);
      if (img.data[i + 3] < 128) continue;
      if (filter && !filter(img.data[i], img.data[i + 1], img.data[i + 2])) continue;
      ch[0].push(img.data[i]); ch[1].push(img.data[i + 1]); ch[2].push(img.data[i + 2]);
    }
  if (!ch[0].length) return null;
  const med = (a) => a.sort((x, y) => x - y)[(a.length / 2) | 0];
  return [med(ch[0]), med(ch[1]), med(ch[2])]; // BGR
}

// Lower the eyelid: keep the bottom `keep` fraction of each eye, draw a dark
// lid stroke on the new top edge, fill above with skin.
function lowerLids(base, eyes, keep, lidThickness, skin, lid) {
  const out = clone(base);
  for (const e of eyes) {
    const h = e.y1 - e.y0 + 1;
    const newTop = e.y1 - Math.max(2, Math.round(h * keep)) + 1;
    for (let y = e.y0 - 2; y < newTop; y += 1)
      for (let x = e.x0; x <= e.x1; x += 1) {
        const i = idx(out, x, y);
        if (out.data[i + 3] < 128) continue;
        // only overwrite eye-ish/dark pixels, not hair already above the eye
        const b = out.data[i], g = out.data[i + 1], r = out.data[i + 2];
        const isEyeish = b > r + 8 || (r + g + b) / 3 < 210;
        if (!isEyeish) continue;
        out.data[i] = skin[0]; out.data[i + 1] = skin[1]; out.data[i + 2] = skin[2]; out.data[i + 3] = 255;
      }
    for (let y = newTop; y < Math.min(newTop + lidThickness, e.y1); y += 1)
      for (let x = e.x0; x <= e.x1; x += 1) {
        const i = idx(out, x, y);
        if (out.data[i + 3] < 128) continue;
        out.data[i] = lid[0]; out.data[i + 1] = lid[1]; out.data[i + 2] = lid[2]; out.data[i + 3] = 255;
      }
  }
  return out;
}

app.whenReady().then(() => {
  fs.mkdirSync(OUTF, { recursive: true });
  const figs = {};
  const sats = {};
  const raws = {};
  for (const name of ["fig0", "fig1", "fig2", "fig3"]) {
    const raw = load(path.join(OUT, `${name}-sprite.png`));
    const { cleaned, satellites } = cleanSprite(raw);
    figs[name] = cleaned;
    sats[name] = satellites;
    raws[name] = raw; // satellites live only here — cleanSprite erased them
  }
  const f0 = figs.fig0;
  const report = { satellites: Object.fromEntries(Object.entries(sats).map(([k, v]) => [k, v.map((s) => ({ area: s.area, bbox: s.bbox }))])) };

  // Alignment over the dress band (head excluded).
  const band = { x0: 60, y0: 300, x1: 330, y1: 540 };
  const shifts = {};
  for (const name of ["fig1", "fig2", "fig3"]) shifts[name] = bestShift(f0, figs[name], band);
  report.shifts = shifts;

  const HEAD = { x0: 40, y0: 20, x1: 340, y1: 285 };

  // 笑 from fig1, 闭眼 from fig2.
  const maskSmile = diffMask(f0, figs.fig1, shifts.fig1, HEAD);
  const smile = transplant(f0, figs.fig1, shifts.fig1, maskSmile);
  const maskClosed = diffMask(f0, figs.fig2, shifts.fig2, HEAD);
  const closed = transplant(f0, figs.fig2, shifts.fig2, maskClosed);
  report.maskAreas = { smile: maskSmile.reduce((n, v) => n + v, 0), closed: maskClosed.reduce((n, v) => n + v, 0) };

  // 睡觉 = 闭眼 + fig2's Zzz satellites (shift-corrected). Filter to the
  // three real Z letters (upper-left, chunky) — the satellite list also
  // catches 1-2px checkerboard residue strips below the feet.
  const zzz = sats.fig2.filter(
    (s) => s.area >= 100 && s.bbox[0] < 130 && s.bbox[1] < 200 && s.bbox[3] - s.bbox[1] >= 8
  );
  const sleep = clone(closed);
  for (const sat of zzz) {
    for (const p of sat.px) {
      const sx = p % raws.fig2.width, sy = (p / raws.fig2.width) | 0;
      const x = sx + shifts.fig2.dx, y = sy + shifts.fig2.dy;
      if (x < 0 || y < 0 || x >= sleep.width || y >= sleep.height) continue;
      const i0 = idx(sleep, x, y), i1 = idx(raws.fig2, sx, sy);
      for (let k = 0; k < 4; k += 1) sleep.data[i0 + k] = raws.fig2.data[i1 + k];
    }
  }

  // 威胁: per-channel linear fit fig0→fig3 on changed, non-glow head pixels.
  const maskThreat = diffMask(f0, figs.fig3, shifts.fig3, { x0: 0, y0: 0, x1: f0.width - 1, y1: f0.height - 1 });
  const fit = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]]; // per ch: n, sx, sy, sxx, sxy
  for (let p = 0; p < f0.width * f0.height; p += 1) {
    if (!maskThreat[p]) continue;
    const x = p % f0.width, y = (p / f0.width) | 0;
    const sx = x - shifts.fig3.dx, sy = y - shifts.fig3.dy;
    if (sx < 0 || sy < 0 || sx >= figs.fig3.width || sy >= figs.fig3.height) continue;
    const i0 = p * 4, i1 = idx(figs.fig3, sx, sy);
    if (figs.fig3.data[i1 + 3] < 128 || f0.data[i0 + 3] < 128) continue;
    const b = figs.fig3.data[i1], g = figs.fig3.data[i1 + 1], r = figs.fig3.data[i1 + 2];
    if ((r + b) / 2 - g > 22 && (r + g + b) / 3 > 100) continue; // glow
    for (let c = 0; c < 3; c += 1) {
      const X = f0.data[i0 + c], Y = figs.fig3.data[i1 + c];
      fit[c][0] += 1; fit[c][1] += X; fit[c][2] += Y; fit[c][3] += X * X; fit[c][4] += X * Y;
    }
  }
  const map = fit.map(([n, sx_, sy_, sxx, sxy]) => {
    const denom = n * sxx - sx_ * sx_;
    const a = denom ? (n * sxy - sx_ * sy_) / denom : 0.45;
    const b = n ? (sy_ - a * sx_) / n : 0;
    return [a, b];
  });
  report.threatMap = map;
  // Per-pixel source: take fig3 only where the generator actually darkened it
  // (or where the eye glow lives); everywhere else darken fig0 with the fitted
  // map. Mask-edge pixels must never copy fig3's still-light values verbatim.
  const threat = clone(f0);
  for (let p = 0; p < f0.width * f0.height; p += 1) {
    const i0 = p * 4;
    if (threat.data[i0 + 3] === 0) continue;
    const x = p % f0.width, y = (p / f0.width) | 0;
    const sx = x - shifts.fig3.dx, sy = y - shifts.fig3.dy;
    if (sx >= 0 && sy >= 0 && sx < figs.fig3.width && sy < figs.fig3.height && A(figs.fig3, sx, sy) > 128) {
      const i1 = idx(figs.fig3, sx, sy);
      const lum0 = (f0.data[i0] + f0.data[i0 + 1] + f0.data[i0 + 2]) / 3;
      const lum3 = (figs.fig3.data[i1] + figs.fig3.data[i1 + 1] + figs.fig3.data[i1 + 2]) / 3;
      const b3 = figs.fig3.data[i1], g3 = figs.fig3.data[i1 + 1], r3 = figs.fig3.data[i1 + 2];
      const glow = (r3 + b3) / 2 - g3 > 22 && lum3 > 100;
      // "Really darkened" means roughly the generator's own ~0.5× — the dress
      // it left at ~0.87× must NOT be taken verbatim, or it stays light.
      if (glow || lum3 < lum0 * 0.72) {
        for (let k = 0; k < 4; k += 1) threat.data[i0 + k] = figs.fig3.data[i1 + k];
        continue;
      }
    }
    for (let c = 0; c < 3; c += 1) {
      threat.data[i0 + c] = Math.max(0, Math.min(255, Math.round(map[c][0] * threat.data[i0 + c] + map[c][1])));
    }
  }

  // Eyes + colors for synthesized faces.
  const eyes = detectEyes(f0, { x0: 100, y0: 155, x1: 280, y1: 225 });
  report.eyes = eyes;
  const midX = Math.round((eyes[0].x1 + eyes[1].x0) / 2);
  const skin = sampleMedian(f0, midX - 8, eyes[0].y0 + 4, midX + 8, eyes[0].y0 + 20,
    (b, g, r) => (r + g + b) / 3 > 200);
  const lid = sampleMedian(f0, eyes[0].x0, eyes[0].y0, eyes[0].x1, eyes[0].y0 + 5,
    (b, g, r) => (r + g + b) / 3 < 150) || [70, 50, 55];
  report.skin = skin; report.lid = lid;

  const half = lowerLids(f0, eyes, 0.52, 6, skin, lid);
  const almost = lowerLids(f0, eyes, 0.24, 7, skin, lid);

  // 生气: flatten eye tops (cut top ~30%) + red anger mark from the old art.
  const angry0 = lowerLids(f0, eyes, 0.7, 6, skin, lid);
  const oldAngry = load(path.join(DIR, "生气.png"));
  // find the red mark in the old frame (upper-right of the head)
  const redTmp = { data: Buffer.alloc(oldAngry.width * oldAngry.height * 4), width: oldAngry.width, height: oldAngry.height };
  for (let y = 300; y < 560; y += 1)
    for (let x = 620; x < 840; x += 1) {
      const i = idx(oldAngry, x, y);
      if (oldAngry.data[i + 3] < 128) continue;
      const b = oldAngry.data[i], g = oldAngry.data[i + 1], r = oldAngry.data[i + 2];
      if (r > 140 && r > g + 50 && r > b + 50) redTmp.data[(y * oldAngry.width + x) * 4 + 3] = 255;
    }
  // The mark is the classic 💢 cross: four big clusters forming one symbol.
  const marks = components(redTmp).filter((c) => c.area > 1000);
  report.angerMarks = marks.map((m) => ({ area: m.area, bbox: m.bbox }));
  const angry = clone(angry0);
  if (marks.length) {
    const mb = [
      Math.min(...marks.map((m) => m.bbox[0])),
      Math.min(...marks.map((m) => m.bbox[1])),
      Math.max(...marks.map((m) => m.bbox[2])),
      Math.max(...marks.map((m) => m.bbox[3]))
    ];
    const f0c = components(f0)[0].bbox;
    // scale by figure-width ratio so the mark keeps its proportion
    const scale = (f0c[2] - f0c[0]) / (835 - 420);
    const relX = (mb[0] - 420) / (835 - 420), relY = (mb[1] - 290) / (928 - 290);
    // Nudged down-left so the mark sits on open hair instead of covering the
    // butterfly ornament (which the old art didn't have).
    const dstX = Math.round(f0c[0] + relX * (f0c[2] - f0c[0])) - 10;
    const dstY = Math.round(f0c[1] + relY * (f0c[3] - f0c[1])) + 14;
    for (let y = mb[1]; y <= mb[3]; y += 1)
      for (let x = mb[0]; x <= mb[2]; x += 1) {
        const i = idx(oldAngry, x, y);
        if (oldAngry.data[i + 3] < 128) continue;
        const b = oldAngry.data[i], g = oldAngry.data[i + 1], r = oldAngry.data[i + 2];
        if (!(r > 140 && r > g + 50 && r > b + 50)) continue;
        const tx = dstX + Math.round((x - mb[0]) * scale);
        const ty = dstY + Math.round((y - mb[1]) * scale);
        if (tx < 0 || ty < 0 || tx >= angry.width || ty >= angry.height) continue;
        const o = idx(angry, tx, ty);
        angry.data[o] = b; angry.data[o + 1] = g; angry.data[o + 2] = r; angry.data[o + 3] = 255;
      }
  }

  // 哭唧唧: open eyes + glints + blue tears down the cheeks (old tear colors).
  const oldCry = load(path.join(DIR, "哭唧唧.png"));
  const tearCore = sampleMedian(oldCry, 540, 530, 760, 600,
    (b, g, r) => b > 200 && b > r + 40) || [250, 214, 168];
  report.tearCore = tearCore;
  const tearEdge = [Math.max(0, tearCore[0] - 40), Math.max(0, tearCore[1] - 60), Math.max(0, tearCore[2] - 70)];
  const cry = clone(f0);
  for (const e of eyes) {
    const cx = Math.round((e.x0 + e.x1) / 2);
    const w = 9;
    const yStart = e.y1 + 2;
    const yEnd = Math.min(cry.height - 1, e.y1 + 52);
    for (let y = yStart; y <= yEnd; y += 1)
      for (let x = cx - ((w / 2) | 0); x < cx - ((w / 2) | 0) + w; x += 1) {
        const i = idx(cry, x, y);
        if (cry.data[i + 3] < 128) continue;
        const edge = x === cx - ((w / 2) | 0) || x === cx - ((w / 2) | 0) + w - 1 || y === yEnd;
        const c = edge ? tearEdge : tearCore;
        cry.data[i] = c[0]; cry.data[i + 1] = c[1]; cry.data[i + 2] = c[2]; cry.data[i + 3] = 255;
      }
    // glint: small white block upper-middle of the eye
    const gx = Math.round(e.x0 + (e.x1 - e.x0) * 0.3);
    const gy = Math.round(e.y0 + (e.y1 - e.y0) * 0.25);
    for (let y = gy; y < gy + 6; y += 1)
      for (let x = gx; x < gx + 7; x += 1) {
        const i = idx(cry, x, y);
        if (cry.data[i + 3] < 128) continue;
        cry.data[i] = 252; cry.data[i + 1] = 250; cry.data[i + 2] = 248;
      }
  }

  // ---------- canvas assembly ----------
  const CANVAS = 1254;
  const TARGET_BOTTOM = 928;
  const TARGET_CX = 627;
  // anchor from fig0's feet (bottom 14 rows of the main component)
  const f0bbox = components(f0)[0].bbox;
  let sumX = 0, n = 0;
  for (let y = f0bbox[3] - 13; y <= f0bbox[3]; y += 1)
    for (let x = 0; x < f0.width; x += 1)
      if (A(f0, x, y) > 128) { sumX += x; n += 1; }
  const feetCX = Math.round(sumX / n);
  const offX = TARGET_CX - feetCX;
  const offY = TARGET_BOTTOM - f0bbox[3];
  report.placement = { feetCX, f0bbox, offX, offY };

  const frames = {
    "睁眼": f0, "笑": smile, "闭眼": closed, "睡觉": sleep, "威胁": threat,
    "半眯眼": half, "快闭眼": almost, "生气": angry, "哭唧唧": cry
  };
  for (const [name, spr] of Object.entries(frames)) {
    const canvas = { data: Buffer.alloc(CANVAS * CANVAS * 4), width: CANVAS, height: CANVAS };
    for (let y = 0; y < spr.height; y += 1)
      for (let x = 0; x < spr.width; x += 1) {
        const tx = x + offX, ty = y + offY;
        if (tx < 0 || ty < 0 || tx >= CANVAS || ty >= CANVAS) continue;
        const i0 = idx(canvas, tx, ty), i1 = idx(spr, x, y);
        for (let k = 0; k < 4; k += 1) canvas.data[i0 + k] = spr.data[i1 + k];
      }
    savePng(path.join(OUTF, `${name}.png`), canvas);
  }

  console.log(JSON.stringify(report, null, 2));
  app.exit(0);
});
