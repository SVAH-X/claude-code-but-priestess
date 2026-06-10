// ============================================================
//  Auto-update
//
//  Windows: real silent update via electron-updater (NSIS) — downloads in the
//  background, installs on next quit (or tray "Restart to update").
//
//  macOS: ad-hoc signed, so Squirrel.Mac can't self-install. Instead we do a
//  custom in-place update (no Apple Developer cert needed): resolve the newest
//  release (GitHub API, prereleases included), read its latest-mac.yml for the
//  version + zip + sha512, download the zip, VERIFY its hash, extract it, then
//  hand off to a small helper script that atomically swaps the app bundle and
//  relaunches. The Doctor's data lives in userData (separate from the .app),
//  so it is never touched.
//
//  Version discovery goes through api.github.com (releases list) because the
//  `releases/latest` redirect silently swallows the newest release while it is
//  still a prerelease — that's how the 0.6.8 prerelease testing round looked
//  like "no update" on both platforms (issue #4). Prereleases themselves are
//  only offered on the opt-in "prerelease" channel (settings.json
//  updateChannel, developers/testers only — regular users stay on stable).
//  Asset downloads still go through github.com release downloads (not
//  rate-limited), via Electron net.fetch (respects the system proxy).
//
//  Manual "Check for updates…" gives its feedback through dialogs, not
//  notifications: macOS quietly drops/coalesces repeat notifications from
//  ad-hoc-signed apps, which made the manual check look like it did nothing.
// ============================================================

const { app, net, shell, dialog, Notification } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const settings = require("./settings");

const REPO_OWNER = "SVAH-X";
const REPO_NAME = "claude-code-but-priestess";
const RELEASES_PAGE = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const RELEASES_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=15`;
const UA = {
  "User-Agent": "PRTS-updater",
  // Defeat any intermediate HTTP cache — a stale yml made the checker report
  // "already latest" right after a release went out.
  "Cache-Control": "no-cache",
  Pragma: "no-cache"
};

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
let pending = null; // { version, tag?, action, zipName?, sha512? }
let checking = false;
let installing = false;
// True while a tray-menu "Check for updates…" is in flight on Windows, so the
// electron-updater event handlers know to give explicit feedback.
let manualWinCheck = false;

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

function infoDialog(message, detail) {
  return dialog.showMessageBox({
    type: "info",
    title: "PRTS 更新",
    message,
    detail: detail || undefined,
    buttons: ["好"],
    defaultId: 0
  });
}

async function failureDialog() {
  const choice = await dialog.showMessageBox({
    type: "warning",
    title: "PRTS 更新",
    message: "暂时无法完成检查更新",
    detail: "可能是网络问题。可以打开下载页手动查看最新版本。",
    buttons: ["关闭", "打开下载页"],
    defaultId: 1,
    cancelId: 0
  });
  if (choice.response === 1) shell.openExternal(RELEASES_PAGE);
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
  const res = await net.fetch(url, { headers: UA, cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Prerelease builds are for developers/testers only — opt in by hand via
// settings.json, never through the UI.
function onPrereleaseChannel() {
  return String(settings.get("updateChannel") || "stable").toLowerCase() === "prerelease";
}

// Newest non-draft release. Unlike the `releases/latest` redirect this sees
// prereleases too, but only the prerelease channel is offered them.
async function fetchLatestReleaseInfo() {
  try {
    const res = await net.fetch(RELEASES_API, {
      headers: { ...UA, Accept: "application/vnd.github+json" },
      cache: "no-store"
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const releases = await res.json();
    const allowPre = onPrereleaseChannel();
    const release = Array.isArray(releases)
      ? releases.find((r) => r && !r.draft && r.tag_name && (allowPre || !r.prerelease))
      : null;
    if (!release) return null;
    return {
      tag: String(release.tag_name),
      version: String(release.tag_name).replace(/^v/i, ""),
      prerelease: Boolean(release.prerelease)
    };
  } catch (error) {
    console.warn("updater: releases API failed, falling back to latest page", error);
    return null;
  }
}

function releaseDownloadUrl(tag, fileName) {
  // Tag known → pin to that release; otherwise fall back to the stable-only
  // `latest` redirect (still correct when the newest release is not a prerelease).
  return tag
    ? `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${tag}/${fileName}`
    : `${RELEASES_PAGE}/download/${fileName}`;
}

// latest-mac.yml carries version + the update zip's name + its sha512.
async function fetchMacUpdateInfo(tag) {
  try {
    const text = await fetchText(releaseDownloadUrl(tag, "latest-mac.yml"));
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

async function fetchLatestVersion(tag) {
  try {
    const text = await fetchText(releaseDownloadUrl(tag, "latest.yml"));
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

  const { version, tag, zipName, sha512 } = pending;
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
    const res = await net.fetch(releaseDownloadUrl(tag, zipName), {
      headers: UA,
      cache: "no-store"
    });
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
    const release = await fetchLatestReleaseInfo();
    const tag = release?.tag || null;
    const info = process.platform === "darwin" ? await fetchMacUpdateInfo(tag) : null;
    const version = release?.version || info?.version || (await fetchLatestVersion(tag));
    if (!version) throw new Error("no version info");

    if (isNewer(version, app.getVersion())) {
      const canInstall =
        process.platform === "darwin" && app.isPackaged && info && info.zipName && info.sha512;
      pending = canInstall
        ? { version, tag, action: "install", zipName: info.zipName, sha512: info.sha512 }
        : { version, tag, action: "page" };
      if (manual) {
        // The Doctor explicitly asked — answer with the install dialog (or the
        // download page offer) directly instead of a droppable notification.
        if (canInstall) {
          await downloadAndInstallMac();
        } else {
          const choice = await dialog.showMessageBox({
            type: "info",
            title: "PRTS 更新",
            message: `发现新版本 v${version}`,
            detail: "这个安装方式不支持自动更新，请前往下载页手动更新。",
            buttons: ["稍后", "打开下载页"],
            defaultId: 1,
            cancelId: 0
          });
          if (choice.response === 1) shell.openExternal(RELEASES_PAGE);
        }
      } else if (canInstall) {
        notify("PRTS 有新版本", `v${version} — 点此下载并自动安装。`, () => downloadAndInstallMac());
      } else {
        notify("PRTS 有新版本", `v${version} 可用 — 点此前往下载。`, () =>
          shell.openExternal(RELEASES_PAGE)
        );
      }
    } else if (manual) {
      await infoDialog(`当前 v${app.getVersion()} 已是最新版本。`);
    }
  } catch (error) {
    console.warn("updater: version check failed", error);
    if (manual) await failureDialog();
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
  // Stable channel by default; prereleases only for the opt-in developer flag.
  winUpdater.allowPrerelease = onPrereleaseChannel();
  winUpdater.on("update-available", (info) => {
    const version = info?.version || "";
    if (manualWinCheck) {
      manualWinCheck = false;
      infoDialog(
        `发现新版本 v${version}`,
        "正在后台静默下载，完成后会提醒；也可稍后从托盘菜单「重启并更新」。"
      );
    } else {
      // Background check — same heads-up macOS users get, so the silent
      // download isn't a surprise when the "restart to update" item appears.
      notify("PRTS 有新版本", `v${version} 正在后台下载，完成后会提醒安装。`);
    }
  });
  winUpdater.on("update-not-available", () => {
    if (manualWinCheck) {
      manualWinCheck = false;
      infoDialog(`当前 v${app.getVersion()} 已是最新版本。`);
    }
  });
  winUpdater.on("update-downloaded", (info) => {
    pending = { version: info?.version || "", action: "install" };
    notify(
      "PRTS 更新已就绪",
      `v${pending.version} 已下载，将在下次退出时安装 — 或从托盘菜单立即重启更新。`,
      () => installNow()
    );
  });
  winUpdater.on("error", (error) => {
    console.warn("updater: electron-updater error", error);
    if (manualWinCheck) {
      manualWinCheck = false;
      failureDialog();
    }
  });
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

// Manual "Check for updates…" from the tray. Works in dev too (dialog-only).
function checkNow() {
  if (checking) return;
  checking = true;
  const done = () => {
    checking = false;
    manualWinCheck = false;
  };
  if (useElectronUpdater() && winUpdater) {
    manualWinCheck = true;
    // Re-read the channel so flipping settings.json takes effect without a
    // full restart.
    winUpdater.allowPrerelease = onPrereleaseChannel();
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
