// ============================================================
//  Pure decisions for the tray/popover shell (main.js). No electron here, so
//  node:test can pin them: tray menu visibility, notification routing, the
//  attachment IPC allowlist, the dev single-instance lock, the VS Code
//  disconnect collapse and the "open in browser" document wrapper.
// ============================================================
const path = require("node:path");

// The auto-screenshot toggle belongs to agent mode. `agentMode` is no longer
// a stored setting (settings.js migrates and deletes it), so the menu must
// derive visibility from vibeCodingMode.
function autoScreenshotMenuVisible(state) {
  return Boolean(state) && state.vibeCodingMode === "agent";
}

// Notification routing. A notification is for a Doctor who is not already
// looking at the chat. Plain 老婆模式 remarks ("waifu") and long-turn done
// notifications ("done") reach him even while a VS Code window is connected:
// the popover is hidden then, so the notification is the only way to learn
// she spoke. A check that spoke because of VS Code editor context ("editor")
// stays quiet while VS Code is active — the editor is where he is working.
function shouldNotify(kind, { vscodeActive = false, popoverFocused = false } = {}) {
  if (popoverFocused) return false;
  if (kind === "editor") return !vscodeActive;
  return kind === "waifu" || kind === "done";
}

// Attachment preview/open allowlist: inside one of the roots (home, chat cwd,
// tmp), or a file the Doctor attached himself in the current conversation —
// he picked it from anywhere on disk, so it must stay previewable/openable.
// `pathModule`/`caseInsensitive` default to the host; tests pass path.win32.
function isAttachmentPathAllowed(
  target,
  { roots = [], attachments = [], pathModule = path, caseInsensitive = process.platform === "win32" } = {}
) {
  if (typeof target !== "string" || !target) return false;
  const norm = (p) => {
    const resolved = pathModule.resolve(String(p));
    return caseInsensitive ? resolved.toLowerCase() : resolved;
  };
  const resolved = norm(target);
  const sep = pathModule.sep;
  const underRoot = roots.some((root) => {
    if (typeof root !== "string" || !root) return false;
    const base = norm(root);
    if (resolved === base) return true;
    return resolved.startsWith(base.endsWith(sep) ? base : base + sep);
  });
  if (underRoot) return true;
  return attachments.some((p) => typeof p === "string" && p && norm(p) === resolved);
}

// The single-instance lock exists so two copies of the installed PRTS can't
// run. `npm run dev` (electron loading the project dir → process.defaultApp)
// and an explicit PRTS_DEV=1 skip it, so a dev build can run next to the
// installed app.
function shouldRequestSingleInstanceLock({ defaultApp = false, env = {} } = {}) {
  if (defaultApp) return false;
  const flag = String((env && env.PRTS_DEV) || "").trim().toLowerCase();
  return !flag || flag === "0" || flag === "false";
}

// When VS Code disconnects, the popover only collapses into the desktop pet
// if it was opened while VS Code held her attention (so it never got the idle
// countdown) and is idle: not mid-reply and not under the Doctor's hands.
function shouldCollapsePopoverOnVscodeDisconnect({
  openedDuringVscode = false,
  turnRunning = false,
  focused = false
} = {}) {
  return Boolean(openedDuringVscode) && !turnRunning && !focused;
}

// "Open in Browser" is an explicit user action on content she produced: write
// it as-is (no forced CSP, which broke any page with scripts or CDN assets).
// A fragment gets a document shell with a charset so Chinese text renders.
function wrapHtmlForBrowser(html) {
  const source = String(html || "");
  if (/^\s*<!doctype/i.test(source) || /<html[\s>]/i.test(source)) return source;
  return `<!doctype html>\n<html><head><meta charset="utf-8"></head><body>${source}</body></html>`;
}

module.exports = {
  autoScreenshotMenuVisible,
  shouldNotify,
  isAttachmentPathAllowed,
  shouldRequestSingleInstanceLock,
  shouldCollapsePopoverOnVscodeDisconnect,
  wrapHtmlForBrowser
};
