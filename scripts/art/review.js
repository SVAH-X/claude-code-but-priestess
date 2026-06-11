// Render review images: full magenta composite + face zoom for each frame.
const { app, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const OUTF = require("node:path").join(require("node:os").tmpdir(), "prts-newdress", "out");
const REV = require("node:path").join(require("node:os").tmpdir(), "prts-newdress", "review");
function load(file) {
  const img = nativeImage.createFromPath(file);
  const { width, height } = img.getSize();
  return { data: Buffer.from(img.toBitmap()), width, height };
}
function save(file, data, w, h) {
  const out = Buffer.from(data);
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3];
    if (a === 255) continue;
    out[i] = (out[i] * a / 255) | 0; out[i+1] = (out[i+1] * a / 255) | 0; out[i+2] = (out[i+2] * a / 255) | 0;
  }
  fs.writeFileSync(file, nativeImage.createFromBitmap(out, { width: w, height: h }).toPNG());
}
app.whenReady().then(() => {
  fs.mkdirSync(REV, { recursive: true });
  for (const name of ["睁眼","半眯眼","快闭眼","闭眼","笑","生气","威胁","哭唧唧","睡觉"]) {
    const img = load(path.join(OUTF, `${name}.png`));
    // magenta composite cropped to figure area (430-830, 380-950)
    const cw = 410, ch = 580, cx0 = 425, cy0 = 375;
    const comp = Buffer.alloc(cw * ch * 4);
    for (let y = 0; y < ch; y += 1)
      for (let x = 0; x < cw; x += 1) {
        const si = ((cy0 + y) * img.width + (cx0 + x)) * 4;
        const di = (y * cw + x) * 4;
        const a = img.data[si + 3] / 255;
        comp[di] = Math.round(img.data[si] * a + 255 * (1 - a));
        comp[di + 1] = Math.round(img.data[si + 1] * a);
        comp[di + 2] = Math.round(img.data[si + 2] * a + 255 * (1 - a));
        comp[di + 3] = 255;
      }
    save(path.join(REV, `${name}-full.png`), comp, cw, ch);
    // face zoom 3x: canvas face region (placement offX 435, offY 383; face sprite x90-300,y150-280)
    const fx0 = 525, fy0 = 533, fw = 210, fh = 130, Z = 3;
    const zoom = Buffer.alloc(fw * Z * fh * Z * 4);
    for (let y = 0; y < fh * Z; y += 1)
      for (let x = 0; x < fw * Z; x += 1) {
        const sx = fx0 + ((x / Z) | 0), sy = fy0 + ((y / Z) | 0);
        const si = (sy * img.width + sx) * 4;
        const di = (y * fw * Z + x) * 4;
        const a = img.data[si + 3] / 255;
        zoom[di] = Math.round(img.data[si] * a + 255 * (1 - a));
        zoom[di + 1] = Math.round(img.data[si + 1] * a);
        zoom[di + 2] = Math.round(img.data[si + 2] * a + 255 * (1 - a));
        zoom[di + 3] = 255;
      }
    save(path.join(REV, `${name}-face.png`), zoom, fw * Z, fh * Z);
  }
  console.log("review rendered");
  app.exit(0);
});
