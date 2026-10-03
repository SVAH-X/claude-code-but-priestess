// NetEase client playback (Windows only): title cleaning, serialized helper
// runs, the awaited skill call and the persona gate. electron and the helper
// process are faked through Module._load; src/main modules are purged from the
// require cache around each test so the fakes apply.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SRC_MAIN = path.resolve(__dirname, "..", "src", "main") + path.sep;

function purgeSrcMain() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_MAIN)) delete require.cache[key];
  }
}

// `overrides` maps a require() request (as written in the src file) to the
// fake module returned for it; `parentSuffix` limits it to one requiring file.
function withFakes(t, { platform, overrides = {} } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "prts-netease-"));
  const electronMock = {
    app: { getPath: () => userData, getVersion: () => "0.0.0", isPackaged: false },
    shell: { openExternal: async () => {}, openPath: async () => {} },
    Notification: class { show() {} static isSupported() { return false; } }
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent) {
    if (request === "electron") return electronMock;
    const override = overrides[request];
    if (override && (!override.parentSuffix || String(parent?.filename || "").endsWith(override.parentSuffix))) {
      return override.module;
    }
    return originalLoad.apply(this, arguments);
  };
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (platform) Object.defineProperty(process, "platform", { value: platform, configurable: true });
  purgeSrcMain();
  t.after(() => {
    Module._load = originalLoad;
    if (platform) Object.defineProperty(process, "platform", platformDescriptor);
    purgeSrcMain();
    fs.rmSync(userData, { recursive: true, force: true });
  });
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.finish = (json, code = 0) => {
    child.stdout.emit("data", Buffer.from(`${json}\n`, "utf8"));
    child.emit("close", code);
  };
  return child;
}

const decodeArg = (args, key) =>
  Buffer.from(args[args.indexOf(key) + 1], "base64").toString("utf8");

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("stripServiceWords only removes anchored request phrases and service names", (t) => {
  withFakes(t);
  const { stripServiceWords } = require("../src/main/skills");
  const cases = [
    // titles that contain former "filler" characters survive untouched
    ["夜曲", "夜曲"],
    ["后来", "后来"],
    ["我的歌声里", "我的歌声里"],
    ["周杰伦 晴天", "周杰伦 晴天"],
    ["听妈妈的话", "听妈妈的话"],
    ["在水一方", "在水一方"],
    ["小情歌", "小情歌"],
    ["Speed of Light", "Speed of Light"],
    // request phrases and service names are stripped from the edges
    ["在b站放 Eclipse", "Eclipse"],
    ["在网易云放一首夜曲", "夜曲"],
    ["网易云 Eclipse", "Eclipse"],
    ["来首晴天", "晴天"],
    ["放 Eclipse", "Eclipse"],
    ["请帮我放一首夜曲吧", "夜曲"],
    ["我想听夜曲", "夜曲"],
    ["放一首周杰伦的歌", "周杰伦"],
    ["在b站上放 Eclipse", "Eclipse"],
    ["播放后来这首歌", "后来"]
  ];
  for (const [input, expected] of cases) {
    assert.equal(stripServiceWords(input), expected, `stripServiceWords(${JSON.stringify(input)})`);
  }
});

test("helper runs are serialized and a newer request supersedes the queued one", async (t) => {
  const spawned = [];
  withFakes(t, {
    platform: "win32",
    overrides: {
      "node:child_process": {
        parentSuffix: "netease-client.js",
        module: { spawn: (exe, args) => { const child = fakeChild(); spawned.push({ args, child }); return child; } }
      },
      "node:fs": { parentSuffix: "netease-client.js", module: { ...fs, existsSync: () => true } }
    }
  });
  const client = require("../src/main/netease-client");
  assert.ok(client.HELPER_TIMEOUT_MS >= 40000, "JS backstop must outlast the helper's own ~20s deadline");

  const first = client.playInNeteaseClient({ title: "夜曲", query: "夜曲" });
  await tick(); // the first request starts its helper
  const second = client.playInNeteaseClient({ title: "晴天", query: "晴天" });
  const third = client.playInNeteaseClient({ title: "后来", query: "后来" });
  await assert.rejects(second, /取代/);
  await tick();
  assert.equal(spawned.length, 1, "only one helper runs at a time");
  assert.equal(decodeArg(spawned[0].args, "--title-b64"), "夜曲");

  spawned[0].child.finish('{"ok":true,"method":"search","title":"\\u591c\\u66f2"}');
  const firstResult = await first;
  assert.equal(firstResult.title, "夜曲", "ASCII-escaped helper JSON decodes back to Chinese");
  await tick();
  assert.equal(spawned.length, 2, "the superseding request runs after the first finishes");
  assert.equal(decodeArg(spawned[1].args, "--title-b64"), "后来");
  assert.equal(decodeArg(spawned[1].args, "--query-b64"), "后来");

  spawned[1].child.finish('{"ok":false,"error":"\\u7f51\\u6613\\u4e91\\u97f3\\u4e50\\u5df2\\u4e0d\\u5728\\u524d\\u53f0"}', 1);
  await assert.rejects(third, /网易云音乐已不在前台/);

  // The chain recovers after a failure.
  const fourth = client.playInNeteaseClient({ title: "Eclipse", query: "Eclipse" });
  await tick();
  assert.equal(spawned.length, 3);
  spawned[2].child.finish('{"ok":true,"method":"search","title":"Eclipse"}');
  assert.equal((await fourth).ok, true);
});

test("play_music reports a NetEase helper failure as {ok:false} instead of rejecting", async (t) => {
  withFakes(t, {
    platform: "win32",
    overrides: {
      "./netease-client": {
        parentSuffix: "skills.js",
        module: { playInNeteaseClient: async () => { throw new Error("网易云客户端响应超时"); } }
      },
      "./settings": {
        parentSuffix: "skills.js",
        module: { get: (key) => (key === "windowsNeteaseClientControl" ? true : undefined) }
      }
    }
  });
  const { runSkill } = require("../src/main/skills");
  const result = await runSkill("play_music", "夜曲");
  assert.deepEqual(result, { ok: false, error: "网易云客户端响应超时" });
});

test("the persona only mentions the NetEase client when that playback is enabled", (t) => {
  withFakes(t);
  const persona = require("../src/main/persona");
  const build = (neteaseClientPlayback) =>
    persona.buildPersonaPrompt({
      vibeCodingMode: "companion",
      provider: "claude",
      includeLongMemory: false,
      coauthorCommits: true,
      neteaseClientPlayback
    });
  const off = build(false);
  assert.match(off, /默认在 Bilibili 播放/);
  assert.doesNotMatch(off, /网易云客户端控制|网易云桌面客户端/);
  const on = build(true);
  assert.match(on, /网易云桌面客户端播放/);
  assert.doesNotMatch(on, /默认在 Bilibili 播放/);
});

test("the helper build fails on CI when the C# compiler is missing, and only skips locally", () => {
  const { spawnSync } = require("node:child_process");
  const script = path.resolve(__dirname, "..", "scripts", "build-windows-helper.js");
  // Pretend to be Windows with no .NET Framework installed (empty WINDIR).
  const run = (ci) =>
    spawnSync(
      process.execPath,
      [
        "-e",
        `Object.defineProperty(process, "platform", { value: "win32" }); require(${JSON.stringify(script)});`
      ],
      {
        encoding: "utf8",
        env: { ...process.env, WINDIR: path.join(os.tmpdir(), "prts-no-windir"), CI: ci }
      }
    );
  const local = run("");
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stderr, /skipped/);
  const onCI = run("true");
  assert.equal(onCI.status, 1, onCI.stderr);
  assert.match(onCI.stderr, /FAILED on CI/);
});
