#!/usr/bin/env python3
"""Remove white background from 普猫猫 images (flood fill from corners).

Threshold mirrors desktop-pet.js isEdgeBackground:
  r+g+b > 670  AND  max(r,g,b)-min(r,g,b) < 30
The cat's dark outline stops the fill from reaching the white body.
"""
import sys
from collections import deque
from PIL import Image

PAIRS = [
    (
        "/Users/kelvin/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_085u6qkp09ut12_9c67/temp/RWTemp/2026-06/9e20f478899dc29eb19741386f9343c8/3e7f41cbb0586fd156f00ce14e66b96c.jpg",
        "/Users/kelvin/Desktop/prts/assets/character/普猫猫/普猫猫.png",
    ),
    (
        "/Users/kelvin/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_085u6qkp09ut12_9c67/temp/RWTemp/2026-06/9e20f478899dc29eb19741386f9343c8/deb43dd1aa9e7c6ea54e0a6bdbb6cc96.jpg",
        "/Users/kelvin/Desktop/prts/assets/character/普猫猫/普猫猫哭.png",
    ),
]


def is_bg(r, g, b):
    return r + g + b > 670 and max(r, g, b) - min(r, g, b) < 30


def flood_remove(img):
    img = img.convert("RGBA")
    pixels = img.load()
    w, h = img.size

    visited = [[False] * w for _ in range(h)]
    queue = deque()

    def try_push(x, y):
        if 0 <= x < w and 0 <= y < h and not visited[y][x]:
            r, g, b, a = pixels[x, y]
            if a > 0 and is_bg(r, g, b):
                visited[y][x] = True
                queue.append((x, y))

    for x in range(w):
        try_push(x, 0)
        try_push(x, h - 1)
    for y in range(1, h - 1):
        try_push(0, y)
        try_push(w - 1, y)

    while queue:
        x, y = queue.popleft()
        pixels[x, y] = (0, 0, 0, 0)
        try_push(x + 1, y)
        try_push(x - 1, y)
        try_push(x, y + 1)
        try_push(x, y - 1)

    # Crop to opaque bounding box with 12px padding (same as JS).
    min_x, min_y, max_x, max_y = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if pixels[x, y][3] > 0:
                min_x = min(min_x, x)
                min_y = min(min_y, y)
                max_x = max(max_x, x)
                max_y = max(max_y, y)

    if max_x < min_x or max_y < min_y:
        return img

    pad = 12
    cx = max(0, min_x - pad)
    cy = max(0, min_y - pad)
    cw = min(w - cx, max_x - min_x + 1 + pad * 2)
    ch = min(h - cy, max_y - min_y + 1 + pad * 2)
    return img.crop((cx, cy, cx + cw, cy + ch))


for src, dst in PAIRS:
    print(f"Processing {src.split('/')[-1]} → {dst.split('/')[-1]} …", flush=True)
    img = Image.open(src)
    result = flood_remove(img)
    result.save(dst, "PNG")
    print(f"  Saved {result.size[0]}×{result.size[1]}px  ✓")

print("Done.")
