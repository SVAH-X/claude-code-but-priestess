// ============================================================
//  Auto-update
//
//  Windows: real silent update via electron-updater (NSIS). It downloads in
//  the background and installs on the next quit; a notification + tray item
//  let the Doctor restart-to-update immediately.
//
//  macOS: Squirrel.Mac refuses unsigned updates and these builds are ad-hoc
//  signed, so we don't try to self-install. Instead we check the GitHub
//  Releases API, and if a newer version exists we notify and open the
//  downloads page. (Same lightweight path is used in dev / on Linux.)
//
//  The first build that ships this code can't update *older* installs (they
//  have no checker); from this version on, Windows updates itself.
// ============================================================

const { app, shell, Notification } = require("electron");

const REPO_OWNER = "SVAH-X";
const REPO_NAME = "claude-code-but-priestess";
const RELEASES_PAGE = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const API_LATEST = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const FIRST_CHECK_DELAY_MS = 8 * 1000;

let winUpdater = null;
// Update the Doctor can act on. action: "install" (Windows, downloaded and
// ready) or "download" (macOS, available to fetch from the page).
let pending = null; // { version, action }
let checking = false;

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

// Numeric semver-ish compare ("0.5.10" > "0.5.2"). Ignores any pre-release
// suffix, which is fine: our releases are plain x.y.z.
function isNewer(remote, local) {
  const norm = (v) =>
    String(v)
      .replace(/^v/i, "")
      .split("-")[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const a = norm(remote);
  const b = norm(local);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// macOS / dev / Linux: ask GitHub for the latest release and compare versions.
async function checkViaApi(manual) {
  try {
    const res = await fetch(API_LATEST, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "PRTS-updater" }
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const json = await res.json();
    const tag = json.tag_name || json.name || "";
    if (tag && isNewer(tag, app.getVersion())) {
      pending = { version: String(tag).replace(/^v/i, ""), action: "download" };
      notify(
        "PRTS 有新版本",
        `v${pending.version} 可用 — 点此前往下载。`,
        () => shell.openExternal(RELEASES_PAGE)
      );
    } else if (manual) {
      notify("PRTS 已是最新", `当前 v${app.getVersion()} 已是最新版本。`);
    }
  } catch (error) {
    console.warn("updater: API check failed", error);
    if (manual) notify("检查更新失败", "暂时无法连接到更新服务器，请稍后再试。");
  }
}

// Windows: electron-updater handles download + install.
function initWindows() {
  try {
    // Lazy require so non-Windows / dev never loads it.
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

// Manual "Check for updates…" from the tray. Works in dev too (API path), so
// the Doctor always gets feedback.
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
  if (winUpdater && pending?.action === "install") {
    winUpdater.quitAndInstall();
  }
}

function openDownloadPage() {
  shell.openExternal(RELEASES_PAGE);
}

// Null unless an update is waiting; main.js reads this to add a tray item.
function getPendingUpdate() {
  return pending;
}

module.exports = { init, checkNow, installNow, openDownloadPage, getPendingUpdate };
