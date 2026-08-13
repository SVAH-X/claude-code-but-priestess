const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MONSTER_SIREN_ARTIST_ID,
  HOT_SONGS_URL,
  normalizeHotSongs,
  fetchMonsterSirenHotSongs,
  pickRandomHotSong,
  isRandomMusicRequest,
  buildMonsterSirenSearchQuery,
  clearHotSongsCacheForTest
} = require("../src/main/netease-hot-songs");

test("normalizes at most 50 usable NetEase hot songs", () => {
  const hotSongs = Array.from({ length: 55 }, (_, index) => ({
    id: 1000 + index,
    name: `Song ${index + 1}`,
    artists: [{ name: "塞壬唱片-MSR" }]
  }));
  hotSongs[3] = { id: null, name: "broken" };

  const songs = normalizeHotSongs({ hotSongs });
  assert.equal(songs.length, 49);
  assert.deepEqual(songs[0], {
    id: "1000",
    name: "Song 1",
    artists: ["塞壬唱片-MSR"]
  });
  assert.equal(songs.at(-1).name, "Song 50");
});

test("fetches Monster Siren's artist endpoint and caches the top songs", async () => {
  clearHotSongsCacheForTest();
  let calls = 0;
  const fakeFetch = async (url, options) => {
    calls += 1;
    assert.equal(url, HOT_SONGS_URL);
    assert.match(url, new RegExp(MONSTER_SIREN_ARTIST_ID));
    assert.equal(options.headers.Referer, "https://music.163.com/");
    return {
      ok: true,
      async json() {
        return {
          hotSongs: [
            {
              id: 1403774122,
              name: "Speed of Light",
              artists: [{ name: "塞壬唱片-MSR" }, { name: "DJ OKAWARI" }]
            }
          ]
        };
      }
    };
  };

  const first = await fetchMonsterSirenHotSongs(fakeFetch);
  first[0].artists.length = 0;
  const second = await fetchMonsterSirenHotSongs(fakeFetch);

  assert.equal(calls, 1);
  assert.deepEqual(second[0].artists, ["塞壬唱片-MSR", "DJ OKAWARI"]);
});

test("random picker accepts deterministic index injection and avoids an immediate repeat", () => {
  const songs = [
    { id: "1", name: "one" },
    { id: "2", name: "two" },
    { id: "3", name: "three" }
  ];
  assert.equal(pickRandomHotSong(songs, (length) => length - 1).name, "three");
  assert.equal(pickRandomHotSong(songs, () => 0, "1").name, "two");
  assert.equal(pickRandomHotSong([songs[0]], () => 0, "1").name, "one");
  assert.throws(() => pickRandomHotSong([], () => 0), /没有可随机播放/);
  assert.throws(() => pickRandomHotSong(songs, () => 3), /索引无效/);
});

test("detects explicit random music requests without treating an empty arg as random", () => {
  assert.equal(isRandomMusicRequest("随便放一首"), true);
  assert.equal(isRandomMusicRequest("随机来一首吧"), true);
  assert.equal(isRandomMusicRequest("再换一首"), true);
  assert.equal(isRandomMusicRequest("下一首别的"), true);
  assert.equal(isRandomMusicRequest("surprise me"), true);
  assert.equal(isRandomMusicRequest("Eclipse"), false);
  assert.equal(isRandomMusicRequest(""), false);
});

test("Monster Siren searches are constrained to the correct NetEase artist", () => {
  assert.equal(
    buildMonsterSirenSearchQuery("  Speed   of Light  "),
    "Speed of Light 塞壬唱片"
  );
  assert.equal(buildMonsterSirenSearchQuery(""), "");
});
