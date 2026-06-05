// ============================================================
//  Auto-update
//
//  Windows: real silent update via electron-updater (NSIS) — downloads in the
//  background, installs on next quit (or tray "Restart to update").
//
//  macOS: ad-hoc signed, so Squirrel.Mac can't self-install. Instead we do a
//  custom in-place update (no Apple Developer cert needed): read latest-mac.yml
//  for the version + zip + sha512, download the zip, VERIFY its hash, extract
//  it, then hand off to a small helper script that atomically swaps the app
//  bundle and relaunches. The Doctor's data lives in userData (separate from
//  the .app), so it is never touched.
//
//  Everything goes through github.com release downloads (NOT the rate-limited
//  api.github.com), via Electron net.fetch (respects the system proxy).
// ============================================================

const { app, net, shell, dialog, Notification } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const REPO_OWNER = "SVAH-X";
const REPO_NAME = "claude-code-but-priestess";
const RELEASES_PAGE = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const LATEST_MAC_YML = `${RELEASES_PAGE}/download/latest-mac.yml`;
const LATEST_YML = `${RELEASES_PAGE}/download/latest.yml`;
const UA = { "User-Agent": "PRTS-updater" };

const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const FIRST_CHECK_DELAY_MS = 8 * 1000;

// Helper that performs the swap AFTER this process exits. Static; the three
// paths come in as $1/$2/$3 so nothing is interpolated into the script body.
// Safety: the new app is first copied onto the target volume (while the live
// app is untouched), then two atomic renames swap it in — the installed app is
// never left half-written. The old app is kept as a backup and restored if the
// rename fails.
const SWAP_SCRIPT = `#!/bin/bash
APP="$1"; NEW="$2"; PID="$3"
DIR="$(dirname "$APP")"
STAGE="$DIR/.prts-update.$$"
OLD="$APP.old.$$"
# wait for the running app to exit (up to ~60s)
for i in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
sleep 1
rm -rf "$STAGE"
# copy the new bundle onto the target volume while APP is still intact
if ! /usr/bin/ditto "$NEW" "$STAGE"; then /usr/bin/open "$APP"; exit 1; fi
/usr/bin/xattr -dr com.apple.quarantine "$STAGE" 2>/dev/null
# atomic swap (APP is only ever the old or the new bundle, never partial)
if mv "$APP" "$OLD" 2>/dev/null && mv "$STAGE" "$APP" 2>/dev/null; then
  rm -rf "$OLD"
else
  if [ -d "$OLD" ] && [ ! -e "$APP" ]; then mv "$OLD" "$APP"; fi
  rm -rf "$STAGE"
fi
/usr/bin/open "$APP"
rm -rf "$NEW" 2>/dev/null
`;

let winUpdater = null;
// What the Doctor can act on. action: "install" (ready — Windows restart, or
// macOS download+install) or "page" (just open the downloads page).
let pending = null; // { version, action, zipName?, sha512? }
let checking = false;
let installing = false;

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  try {
    const n = new Notification({ title, body, silent: false });
    if (onClick) n.on("click", onClick);
    n.show();
  } catch (error) {
    console.warn("updater: notification failed", error);
  }
}

// Numeric semver-ish compare ("0.5.10" > "0.5.2"). Pre-release suffix ignored.
function isNewer(remote, local) {
  const norm = (v) =>
    String(v).replace(/^v/i, "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const a = norm(remote);
  const b = norm(local);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

async function fetchText(url) {
  const res = await net.fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// latest-mac.yml carries version + the update zip's name + its sha512.
async function fetchMacUpdateInfo() {
  try {
    const text = await fetchText(LATEST_MAC_YML);
    const version = text.match(/^version:\s*(.+)$/m)?.[1]?.trim();
    const zipName = text.match(/^path:\s*(.+)$/m)?.[1]?.trim();
    const sha512 = text.match(/^sha512:\s*(.+)$/m)?.[1]?.trim();
    if (!version) return null;
    if (zipName && zipName.endsWith(".zip") && sha512) return { version, zipName, sha512 };
    return { version };
  } catch {
    return null;
  }
}

async function fetchLatestVersion() {
  try {
    const text = await fetchText(LATEST_YML);
    return text.match(/^version:\s*(.+)$/m)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

// /Applications/PRTS.app from .../PRTS.app/Contents/MacOS/PRTS.
function currentAppBundlePath() {
  const exe = process.execPath || "";
  const i = exe.indexOf(".app/");
  return i === -1 ? null : exe.slice(0, i + 4);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

// macOS in-place install: download → verify → extract → atomic swap → relaunch.
async function downloadAndInstallMac() {
  if (installing || !pending || pending.action !== "install") return;
  if (process.platform !== "darwin" || !app.isPackaged) {
    shell.openExternal(RELEASES_PAGE);
    return;
  }
  const appPath = currentAppBundlePath();
  if (!appPath || !pending.zipName || !pending.sha512) {
    shell.openExternal(RELEASES_PAGE);
    return;
  }

  const { version, zipName, sha512 } = pending;
  const choice = await dialog.showMessageBox({
    type: "info",
    title: "PRTS 更新",
    message: `发现新版本 v${version}`,
    detail:
      "点「下载并安装」后，普瑞赛斯会下载、校验并自动重启完成更新。\n" +
      "你的对话、记忆与设置都不受影响（它们存放在别处，不在 app 内）。",
    buttons: ["稍后", "下载并安装"],
    defaultId: 1,
    cancelId: 0
  });
  if (choice.response !== 1) return;

  installing = true;
  const tmpDir = path.join(os.tmpdir(), `prts-update-${Date.now()}`);
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    notify("PRTS 正在更新", `正在下载 v${version}…`);

    // 1) download — staged in temp, the installed app is untouched throughout.
    const res = await net.fetch(`${RELEASES_PAGE}/download/${zipName}`, { headers: UA });
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());

    // 2) verify integrity before anything is installed.
    const got = crypto.createHash("sha512").update(buf).digest("base64");
    if (got !== sha512) throw new Error("sha512 mismatch — download corrupt");

    const zipPath = path.join(tmpDir, zipName);
    fs.writeFileSync(zipPath, buf);

    // 3) extract with ditto (preserves the .app bundle's symlinks/attrs).
    const stage = path.join(tmpDir, "extracted");
    fs.mkdirSync(stage, { recursive: true });
    await run("/usr/bin/ditto", ["-x", "-k", zipPath, stage]);
    const appName = fs.readdirSync(stage).find((n) => n.endsWith(".app"));
    if (!appName) throw new Error("no .app in update zip");
    const newApp = path.join(stage, appName);
    await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", newApp]).catch(() => {});

    // 4) hand off to the detached swap script, then quit so it can replace us.
    const scriptPath = path.join(tmpDir, "prts-swap.sh");
    fs.writeFileSync(scriptPath, SWAP_SCRIPT, { mode: 0o755 });
    spawn("/bin/bash", [scriptPath, appPath, newApp, String(process.pid)], {
      detached: true,
      stdio: "ignore"
    }).unref();
    setTimeout(() => app.quit(), 300);
  } catch (error) {
    installing = false;
    console.warn("updater: mac install failed", error);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    notify("自动更新失败", "无法完成自动安装，点此打开下载页手动更新。", () =>
      shell.openExternal(RELEASES_PAGE)
    );
  }
}

// macOS / dev / Linux check. Offers in-place install when we have the verified
// zip info (packaged macOS); otherwise just points at the downloads page.
async function checkViaApi(manual) {
  try {
    const info = await fetchMacUpdateInfo();
    const version = info?.version || (await fetchLatestVersion());
    if (!version) throw new Error("no version info");

    if (isNewer(version, app.getVersion())) {
      const canInstall =
        process.platform === "darwin" && app.isPackaged && info && info.zipName && info.sha512;
      pending = canInstall
        ? { version, action: "install", zipName: info.zipName, sha512: info.sha512 }
        : { version, action: "page" };
      if (canInstall) {
        notify("PRTS 有新版本", `v${version} — 点此下载并自动安装。`, () => downloadAndInstallMac());
      } else {
        notify("PRTS 有新版本", `v${version} 可用 — 点此前往下载。`, () =>
          shell.openExternal(RELEASES_PAGE)
        );
      }
    } else if (manual) {
      notify("PRTS 已是最新", `当前 v${app.getVersion()} 已是最新版本。`);
    }
  } catch (error) {
    console.warn("updater: version check failed", error);
    if (manual) {
      notify("检查更新失败", "暂时无法获取版本信息，点此打开下载页手动查看。", () =>
        shell.openExternal(RELEASES_PAGE)
      );
    }
  }
}

// Windows: electron-updater handles download + install.
function initWindows() {
  try {
    winUpdater = require("electron-updater").autoUpdater;
  } catch (error) {
    console.warn("updater: electron-updater unavailable", error);
    return;
  }
  winUpdater.autoDownload = true;
  winUpdater.autoInstallOnAppQuit = true;
  winUpdater.on("update-downloaded", (info) => {
    pending = { version: info?.version || "", action: "install" };
    notify(
      "PRTS 更新已就绪",
      `v${pending.version} 已下载，将在下次退出时安装 — 或从托盘菜单立即重启更新。`,
      () => installNow()
    );
  });
  winUpdater.on("error", (error) => console.warn("updater: electron-updater error", error));
  winUpdater.checkForUpdates().catch((error) => console.warn("updater: check failed", error));
}

function useElectronUpdater() {
  return process.platform === "win32" && app.isPackaged;
}

function init() {
  if (!app.isPackaged) return; // dev build: nothing to update
  if (useElectronUpdater()) initWindows();
  else setTimeout(() => checkViaApi(false), FIRST_CHECK_DELAY_MS);

  setInterval(() => {
    if (useElectronUpdater()) winUpdater?.checkForUpdates().catch(() => {});
    else checkViaApi(false);
  }, RECHECK_INTERVAL_MS);
}

// Manual "Check for updates…" from the tray. Works in dev too (notify-only).
function checkNow() {
  if (checking) return;
  checking = true;
  const done = () => {
    checking = false;
  };
  if (useElectronUpdater() && winUpdater) {
    winUpdater.checkForUpdates().then(done, done);
  } else {
    checkViaApi(true).then(done, done);
  }
}

function installNow() {
  if (!pending) return;
  if (useElectronUpdater() && winUpdater) {
    winUpdater.quitAndInstall();
  } else if (process.platform === "darwin" && pending.action === "install") {
    downloadAndInstallMac();
  } else {
    shell.openExternal(RELEASES_PAGE);
  }
}

function openDownloadPage() {
  shell.openExternal(RELEASES_PAGE);
}

function getPendingUpdate() {
  return pending;
}

module.exports = { init, checkNow, installNow, openDownloadPage, getPendingUpdate };
