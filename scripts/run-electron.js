const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const electron = require("electron");
const electronPackage = require("electron/package.json");
const projectRoot = path.join(__dirname, "..");

// Reuse the PACKAGED app's bundle identifier for the dev app. macOS 26 (Tahoe)
// gates menu-bar status items behind a per-bundle-ID permission; the installed
// "PRTS" app is already allowed, so by matching its id the dev app inherits
// that permission and its tray icon shows too. (A distinct ".dev" id is treated
// as a brand-new, not-yet-allowed app and stays invisible.)
const projectPackage = require(path.join(projectRoot, "package.json"));
const packagedAppId =
  (projectPackage.build && projectPackage.build.appId) ||
  "local.claude-code-but-priestess.menubar";

function runPlistBuddy(plistPath, command) {
  return spawnSync("/usr/libexec/PlistBuddy", ["-c", command, plistPath], {
    stdio: "ignore"
  });
}

function setPlistValue(plistPath, key, type, value) {
  const setResult = runPlistBuddy(plistPath, `Set :${key} ${value}`);
  if (setResult.status === 0) return;
  const addResult = runPlistBuddy(plistPath, `Add :${key} ${type} ${value}`);
  if (addResult.status !== 0) {
    throw new Error(`failed to update ${key} in ${plistPath}`);
  }
}

function ensureDarwinDevApp(electronBinary) {
  const sourceApp = path.resolve(electronBinary, "..", "..", "..");
  const devRoot = path.join(projectRoot, ".dev");
  const devApp = path.join(devRoot, "PRTS Dev.app");
  const devBinary = path.join(devApp, "Contents", "MacOS", "Electron");
  const markerPath = path.join(devApp, "Contents", "Resources", ".prts-dev-source");
  const marker = `${electronBinary}\n${electronPackage.version}\ncopy-v2\n`;

  if (!fs.existsSync(devBinary) || !fs.existsSync(markerPath) || fs.readFileSync(markerPath, "utf8") !== marker) {
    console.log("[run-electron] building .dev/PRTS Dev.app (fresh copy)…");
    fs.rmSync(devApp, { recursive: true, force: true });
    fs.mkdirSync(devRoot, { recursive: true });
    fs.cpSync(sourceApp, devApp, { recursive: true, verbatimSymlinks: true });
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, marker, "utf8");
  } else {
    console.log("[run-electron] reusing existing .dev/PRTS Dev.app");
  }

  const resourcesDir = path.join(devApp, "Contents", "Resources");
  const iconSource = path.join(projectRoot, "assets", "build", "icon.icns");
  if (fs.existsSync(iconSource)) {
    fs.copyFileSync(iconSource, path.join(resourcesDir, "icon.icns"));
  }

  const plistPath = path.join(devApp, "Contents", "Info.plist");
  setPlistValue(plistPath, "CFBundleName", "string", "PRTS Dev");
  setPlistValue(plistPath, "CFBundleDisplayName", "string", "PRTS Dev");
  setPlistValue(plistPath, "CFBundleIdentifier", "string", packagedAppId);
  setPlistValue(plistPath, "CFBundleIconFile", "string", "icon.icns");
  setPlistValue(plistPath, "LSApplicationCategoryType", "string", "public.app-category.utilities");
  setPlistValue(plistPath, "LSUIElement", "bool", "true");

  // Copying Electron.app and rewriting its Info.plist invalidates the original
  // code signature. On macOS Tahoe (26) an app with an invalid signature gets
  // degraded system integration. Re-sign ad-hoc whenever the signature no
  // longer validates.
  ensureValidSignature(devApp);
  return devApp;
}

function ensureValidSignature(devApp) {
  if (process.platform !== "darwin") return;
  const verify = spawnSync("codesign", ["--verify", "--deep", devApp], { stdio: "ignore" });
  if (verify.status === 0) {
    console.log("[run-electron] code signature: already valid ✓");
    return;
  }
  console.log("[run-electron] code signature: invalid — re-signing ad-hoc…");
  const sign = spawnSync("codesign", ["--force", "--deep", "--sign", "-", devApp], {
    stdio: "ignore"
  });
  if (sign.status === 0) {
    console.log("[run-electron] code signature: re-signed ✓");
  } else {
    console.warn(
      "[run-electron] code signature: re-sign FAILED — the menu-bar tray icon may not appear."
    );
  }
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let child;
let logTail = null;
let devAppPath = null;

if (process.platform === "darwin") {
  devAppPath = ensureDarwinDevApp(electron);
  // Launch through LaunchServices (`open`) instead of exec'ing the Electron
  // binary directly. On macOS Tahoe (26), an app started by a bare exec is not
  // registered the way Finder registers it, and its menu-bar status item (the
  // tray icon) is silently never shown — which is why the dev tray icon was
  // invisible while the packaged app worked. `open` registers it properly so
  // the tray appears in dev too.
  //
  // `open` can't write to /dev/stdout in every context (it fails with launch
  // error -10810), so the app's stdout/stderr go to a temp log file and we
  // `tail -F` that file into this terminal to keep live logs. `-W` keeps this
  // process alive until the app exits; `-n` forces a fresh instance each run.
  const logFile = path.join(os.tmpdir(), "prts-dev.log");
  try {
    fs.writeFileSync(logFile, "");
  } catch {
    /* non-fatal: logs just won't be captured */
  }
  console.log("[run-electron] launching via LaunchServices (open) — look for her head in the menu bar ↑");
  console.log("[run-electron] app logs stream below; press Ctrl-C to quit.\n");
  child = spawn(
    "open",
    [
      "-n",
      "-W",
      "--stdout",
      logFile,
      "--stderr",
      logFile,
      "-a",
      devAppPath,
      "--args",
      projectRoot
    ],
    { cwd: projectRoot, env, stdio: "ignore" }
  );
  logTail = spawn("tail", ["-n", "+1", "-F", logFile], {
    stdio: ["ignore", "inherit", "inherit"]
  });
} else {
  child = spawn(electron, [projectRoot], {
    cwd: projectRoot,
    env,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
}

let shuttingDown = false;

function exitCodeForSignal(signal) {
  return signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
}

// `open` detaches the launched app from this process tree, so killing `child`
// (the `open` waiter) won't stop the app. Terminate the dev app explicitly.
function quitDevApp() {
  if (process.platform !== "darwin" || !devAppPath) return;
  try {
    spawnSync("pkill", ["-f", `${devAppPath}/Contents/MacOS/Electron`], { stdio: "ignore" });
  } catch {
    /* best effort */
  }
}

function stopLogTail() {
  if (logTail && !logTail.killed) {
    try {
      logTail.kill();
    } catch {
      /* best effort */
    }
  }
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  quitDevApp();
  stopLogTail();
  if (!child.killed) {
    child.kill(signal);
  }
  setTimeout(() => process.exit(exitCodeForSignal(signal)), 1200).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

child.on("exit", (code, signal) => {
  stopLogTail();
  if (signal) {
    process.exit(exitCodeForSignal(signal));
    return;
  }
  process.exit(code ?? 0);
});
