const { randomInt } = require("node:crypto");

const MONSTER_SIREN_ARTIST_ID = "32540734";
const HOT_SONGS_URL = `https://music.163.com/api/artist/${MONSTER_SIREN_ARTIST_ID}`;
const CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 7000;

let cache = null;

function normalizeHotSongs(payload) {
  const songs = Array.isArray(payload?.hotSongs) ? payload.hotSongs : [];
  return songs
    .slice(0, 50)
    .map((song) => ({
      id: String(song?.id || "").trim(),
      name: String(song?.name || "").trim(),
      artists: (Array.isArray(song?.artists) ? song.artists : [])
        .map((artist) => String(artist?.name || "").trim())
        .filter(Boolean)
    }))
    .filter((song) => song.id && song.name);
}

async function fetchMonsterSirenHotSongs(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") {
    throw new Error("当前 Node.js 运行时不支持网络请求");
  }

  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.songs.map((song) => ({ ...song, artists: [...song.artists] }));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(HOT_SONGS_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36",
        Referer: "https://music.163.com/"
      },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`网易云热门歌曲接口返回 HTTP ${response.status}`);
    }

    const songs = normalizeHotSongs(await response.json());
    if (songs.length === 0) {
      throw new Error("网易云没有返回塞壬唱片热门歌曲");
    }

    cache = { fetchedAt: now, songs };
    return songs.map((song) => ({ ...song, artists: [...song.artists] }));
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("读取塞壬唱片热门 50 超时");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function pickRandomHotSong(
  songs,
  pickIndex = (length) => randomInt(length),
  excludedId = ""
) {
  if (!Array.isArray(songs) || songs.length === 0) {
    throw new Error("没有可随机播放的热门歌曲");
  }
  const alternatives = songs.filter(
    (song) => !excludedId || String(song?.id || "") !== String(excludedId)
  );
  const candidates = alternatives.length ? alternatives : songs;
  const index = pickIndex(candidates.length);
  if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
    throw new Error("随机歌曲索引无效");
  }
  return candidates[index];
}

function isRandomMusicRequest(value) {
  return /随便|随机|任意|来一首|放一首|换一首|下一首|再换|别的|random|anything|whatever|surprise/i.test(
    String(value || "")
  );
}

function buildMonsterSirenSearchQuery(title) {
  const normalized = String(title || "").replace(/\s+/g, " ").trim();
  return normalized ? `${normalized} 塞壬唱片` : "";
}

function clearHotSongsCacheForTest() {
  cache = null;
}

module.exports = {
  MONSTER_SIREN_ARTIST_ID,
  HOT_SONGS_URL,
  normalizeHotSongs,
  fetchMonsterSirenHotSongs,
  pickRandomHotSong,
  isRandomMusicRequest,
  buildMonsterSirenSearchQuery,
  clearHotSongsCacheForTest
};
