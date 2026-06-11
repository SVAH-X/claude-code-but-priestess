# Casual-outfit (休闲) frame pipeline

How the casual outfit's 9 frames (`assets/character/casual/`, the long mint
dress) were built in 2026-06. The formal outfit (正装, assets/character root)
is the original art and is not produced by this pipeline.
Sources, kept in `assets/character/`: `new睁眼.png` (eyes-open base, 1024²,
gray background) and `Nano Banana Workspace Image.png` (1254², a 2×2 sheet on
a fake 25px checkerboard: duplicate 睁眼 / 笑 / 睡觉+Zzz / 威胁).

Run order (all via `npx electron scripts/art/<script>.js`, output under the
system temp dir `prts-newdress/`):

1. `extract.js` — removes the checkerboard (edge flood over the two lattice
   tones + halo fade; enclosed pockets are deliberately NOT cleared here) and
   cuts the four quadrant sprites. Also dumps feet anchors and body diffs.
2. `compose.js` — builds all nine frames and writes 1254² canvases to
   `<tmp>/prts-newdress/out/`:
   - every frame shares fig0's body (quadrant bodies wobble ±1–2px, which
     would shimmer on expression swaps);
   - 笑/闭眼 transplant aligned face-diff clusters from fig1/fig2; 睡觉 adds
     fig2's Zzz satellites; 半眯眼/快闭眼 lower the eyelids over fig0's eyes;
     生气 flattens the eye tops and copies the old art's 💢 mark; 哭唧唧 adds
     eye glints and tear columns (old-art tear colors);
   - 威胁 darkens the whole character with a per-channel linear map fitted to
     what the sheet's generator did to the head, takes the head/glow pixels
     from fig3 verbatim, and maps everything the generator left light (dress,
     butterfly) so only the eye diamonds shine.
3. `review.js` — magenta composites + face zooms for visual checking.
4. Copy `out/*.png` into `assets/character/casual/`. (The repo's
   `scripts/flatten-character-assets.js` processes only the formal frames in
   the assets root; the casual frames come out of this pipeline already
   transparent with no enclosed gaps. See `scripts/flatten-hole-seeds.json`
   for the warning about her dress/face/eye whites.)

The constants inside `compose.js` (quadrant regions, head zone, eye-detection
zone) are tuned to this sheet; re-measure with `--inspect`-style analysis if
the source art changes.
