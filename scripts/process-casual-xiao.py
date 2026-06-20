#!/usr/bin/env python3
"""Fit the new casual 笑 (happy) frame to the other 8 casual frames.

The new source (assets/character/casual/Arknights Pixel Art.png) already has a
transparent background, but its character is drawn ~10% smaller than the other
casual frames. Shipping it as-is would make her visibly shrink when she smiles.

This scales the character to the shared anchor of the existing frames
(feet bottom y, center x, opaque height) and repositions it on the full
1254x1254 canvas, so the renderer's union-bbox crop keeps every frame aligned.
A smooth resample matches the already-resampled look of the other frames.
"""
import glob
import os
from PIL import Image

CASUAL = "/Users/kelvin/Desktop/prts/assets/character/casual"
SRC = os.path.join(CASUAL, "Arknights Pixel Art.png")
OUT = "/tmp/casual-xiao-fitted.png"
EXPR = ["睁眼", "半眯眼", "快闭眼", "闭眼", "生气", "威胁", "哭唧唧", "睡觉"]


def opaque_bbox(img):
    px = img.load()
    w, h = img.size
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if px[x, y][3] > 20:
                if x < minx: minx = x
                if y < miny: miny = y
                if x > maxx: maxx = x
                if y > maxy: maxy = y
    return minx, miny, maxx, maxy


# Derive the shared anchor of the existing frames.
heights, cxs, bottoms = [], [], []
for name in EXPR:
    p = os.path.join(CASUAL, f"{name}.png")
    if not os.path.exists(p):
        continue
    minx, miny, maxx, maxy = opaque_bbox(Image.open(p).convert("RGBA"))
    heights.append(maxy - miny + 1)
    cxs.append((minx + maxx) / 2)
    bottoms.append(maxy)
    print(f"{name:6s} bbox h={maxy-miny+1} cx={(minx+maxx)/2:.0f} bottom={maxy}")


def median(xs):
    xs = sorted(xs)
    n = len(xs)
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


tgt_h = median(heights)
tgt_cx = median(cxs)
tgt_bottom = median(bottoms)
print(f"\nTARGET  height={tgt_h}  center_x={tgt_cx:.0f}  bottom={tgt_bottom}")

# Crop the new character, scale to the target height, paste anchored.
src = Image.open(SRC).convert("RGBA")
W, H = src.size
minx, miny, maxx, maxy = opaque_bbox(src)
sw, sh = maxx - minx + 1, maxy - miny + 1
print(f"new 笑 source bbox h={sh} cx={(minx+maxx)/2:.0f} bottom={maxy}")

scale = tgt_h / sh
new_w, new_h = round(sw * scale), round(sh * scale)
char = src.crop((minx, miny, maxx + 1, maxy + 1)).resize((new_w, new_h), Image.LANCZOS)

canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
left = round(tgt_cx - new_w / 2)
top = round(tgt_bottom + 1 - new_h)
canvas.alpha_composite(char, (left, top))
print(f"scale={scale:.4f}  pasted at ({left},{top})  size {new_w}x{new_h}")
print(f"result bbox = {opaque_bbox(canvas)}")

canvas.save(OUT, "PNG")
print(f"saved -> {OUT}")
