const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { shell } = require("electron");

const HELPER_TIMEOUT_MS = 25000;

function helperPath() {
  const bundled = path.join(__dirname, "../native/windows/NeteaseController.exe");
  return bundled.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeArg(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64");
}

function runHelper(title, query) {
  const executable = helperPath();
  if (!fs.existsSync(executable)) {
    throw new Error("网易云客户端控制组件缺失，请重新安装或重新构建 PRTS");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      ["--title-b64", encodeArg(title), "--query-b64", encodeArg(query)],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error("网易云客户端响应超时"));
    }, HELPER_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      let result = null;
      try {
        result = JSON.parse(lines.at(-1) || "{}");
      } catch {
        // Keep the more useful helper error below.
      }
      if (code === 0 && result?.ok) {
        finish(resolve, result);
        return;
      }
      finish(
        reject,
        new Error(result?.error || stderr.trim() || "没能控制网易云音乐客户端")
      );
    });
  });
}

async function playInNeteaseClient({ id = "", title, query }) {
  if (process.platform !== "win32") {
    throw new Error("网易云客户端自动播放目前只支持 Windows");
  }

  // The official protocol is fast when the installed client accepts autoplay.
  // The helper always verifies the result and falls back to an exact UI search.
  if (/^\d+$/.test(String(id))) {
    try {
      await shell.openExternal(`orpheus://song/${id}/?autoplay=1`);
      await wait(1400);
    } catch {
      // The UI helper can also launch the client, so a broken protocol handler
      // is not fatal.
    }
  }

  return runHelper(title, query || title);
}

module.exports = { playInNeteaseClient, helperPath };
