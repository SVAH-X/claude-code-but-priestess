const RANDOM_MUSIC_INSTRUCTION =
  "博士说“随便放一首”“随机来一首”“再换一首”“下一首”“来首别的”等没有指定歌名的话时，参数必须原样写成“随机”，即 [[skill:play_music 随机]]，让 PRTS 从塞壬唱片当前的网易云热门 50 中抽取，不要由你自行挑歌。";

function buildRandomMusicInstruction(neteaseClientPlayback) {
  return neteaseClientPlayback ? RANDOM_MUSIC_INSTRUCTION : "";
}

module.exports = { buildRandomMusicInstruction };
