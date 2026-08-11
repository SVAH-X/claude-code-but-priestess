const test = require("node:test");
const assert = require("node:assert/strict");

const { buildRandomMusicInstruction } = require("../src/main/music-prompt");

test("does not advertise NetEase random playback when the client setting is off", () => {
  assert.equal(buildRandomMusicInstruction(false), "");
});

test("advertises the NetEase hot-song random path only when enabled", () => {
  const instruction = buildRandomMusicInstruction(true);
  assert.match(instruction, /\[\[skill:play_music 随机\]\]/);
  assert.match(instruction, /网易云热门 50/);
});
