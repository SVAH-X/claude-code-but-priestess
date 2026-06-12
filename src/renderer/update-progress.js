// Renders the update pipeline state pushed from src/main/updater.js:
// download (live byte counter) → verify → install → restart. Like the
// updater dialogs, this window is Chinese-only.
const titleEl = document.getElementById("title");
const barEl = document.getElementById("bar");
const fillEl = document.getElementById("fill");
const statusEl = document.getElementById("status");

const MB = 1024 * 1024;

function mb(bytes) {
  const value = (bytes || 0) / MB;
  if (value >= 100) return String(Math.round(value));
  return value.toFixed(1).replace(/\.0$/, "");
}

function setBar(percent) {
  if (percent === null) {
    barEl.classList.add("indeterminate");
    return;
  }
  barEl.classList.remove("indeterminate");
  fillEl.style.width = `${percent}%`;
}

function render(state) {
  if (!state) return;
  if (state.version) titleEl.textContent = `正在更新到 v${state.version}…`;
  const { phase, transferred = 0, total = 0 } = state;
  if (phase === "download") {
    if (total > 0) {
      const percent = Math.min(100, Math.floor((transferred / total) * 100));
      setBar(percent);
      statusEl.textContent = `下载中 ${percent}%（${mb(transferred)} / ${mb(total)} MB）`;
    } else {
      setBar(null);
      statusEl.textContent = `下载中（已下载 ${mb(transferred)} MB）`;
    }
  } else if (phase === "verify") {
    setBar(null);
    statusEl.textContent = "校验中…";
  } else if (phase === "install") {
    setBar(null);
    statusEl.textContent = "安装中…";
  } else if (phase === "restart") {
    setBar(100);
    statusEl.textContent = "即将重启完成更新…";
  }
}

window.updateApi?.onProgress?.(render);
window.updateApi
  ?.getState?.()
  .then(render)
  .catch(() => {});
