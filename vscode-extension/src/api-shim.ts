/**
 * Generates the inline <script> that shims window.chatApi, window.petApi,
 * and window.previewApi inside a VS Code webview. The shim replicates the
 * exact API surface of src/main/preload.js so that renderer.js and
 * desktop-pet.js run unchanged, communicating via postMessage to the
 * extension host instead of Electron IPC.
 */

export function generateApiShim(options: {
  panel: "chat" | "pet";
  characterBaseUri?: string;
}): string {
  const panel = options.panel;
  const isChat = panel === "chat";

  return `
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const isMac = ${process.platform === "darwin"};
  const isWindows = ${process.platform === "win32"};

  // Shared plumbing: one-shot request/response via postMessage
  let reqCounter = 0;
  const pending = new Map();

  window.addEventListener("message", function (e) {
    const msg = e.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.reqId && pending.has(msg.reqId)) {
      const p = pending.get(msg.reqId);
      clearTimeout(p.timer);
      pending.delete(msg.reqId);
      p.resolve(msg);
      return;
    }
    // Route broadcast events to registered listeners
    const handlers = eventHandlers[msg.type];
    if (handlers) {
      for (const fn of handlers) {
        try { fn(msg); } catch (_) { /* ignore */ }
      }
    }
  });

  window.__prts_request = function (type, data) {
    return new Promise(function (resolve, reject) {
      const reqId = String(++reqCounter);
      const timer = setTimeout(function () {
        pending.delete(reqId);
        reject(new Error("Request " + type + " timed out"));
      }, 30000);
      pending.set(reqId, { resolve: resolve, reject: reject, timer: timer });
      vscode.postMessage(Object.assign({ type: type, reqId: reqId }, data || {}));
    });
  };

  const eventHandlers = {};

  function onEvent(type, fn) {
    if (!eventHandlers[type]) eventHandlers[type] = [];
    eventHandlers[type].push(fn);
    return function unsubscribe() {
      const arr = eventHandlers[type];
      if (arr) {
        const idx = arr.indexOf(fn);
        if (idx >= 0) arr.splice(idx, 1);
      }
    };
  }

  // ============ chatApi ============
${isChat
  ? `
  window.chatApi = {
    send: function (text) {
      return window.__prts_request("chat:send", { text: text }).then(function (r) {
        return { ok: r.ok, reason: r.reason, queued: r.queued, queueLength: r.queueLength };
      });
    },
    cancel: function () {
      vscode.postMessage({ type: "chat:cancel" });
      return Promise.resolve({ ok: true });
    },
    clear: function () {
      return window.__prts_request("chat:clear").then(function () {
        return { ok: true };
      });
    },
    getHistory: function () {
      return window.__prts_request("chat:get-history").then(function (r) {
        return r.history || [];
      });
    },
    onChunk: function (fn) { return onEvent("chat:chunk", fn); },
    onStatus: function (fn) { return onEvent("chat:status", fn); },
    onHistory: function (fn) {
      return onEvent("chat:history", function (msg) {
        // Unwrap WS envelope: server sends {type:"chat:history", history:[...]}
        // Electron IPC passes the array directly; VS Code WS wraps it.
        const history = Array.isArray(msg.history) ? msg.history
                      : Array.isArray(msg) ? msg
                      : [];
        fn(history);
      });
    },
    onTool: function (fn) { return onEvent("chat:tool", fn); },
    onMood: function (fn) { return onEvent("chat:mood", fn); },
    onProactive: function (fn) { return onEvent("chat:proactive", fn); },
    onQueue: function (fn) { return onEvent("chat:queue", fn); },
    onContextAttached: function (fn) { return onEvent("chat:context-attached", fn); }
  };
`
  : `
  // Desktop pet panel: minimal chatApi (only what desktop-pet.js needs)
  window.chatApi = {
    send: function () { return Promise.resolve({ ok: false, reason: "not available in pet panel" }); },
    cancel: function () {},
    clear: function () { return Promise.resolve({ ok: true }); },
    getHistory: function () { return Promise.resolve([]); },
    onChunk: function () { return function () {}; },
    onStatus: function () { return function () {}; },
    onHistory: function () { return function () {}; },
    onTool: function () { return function () {}; },
    onMood: function () { return function () {}; },
    onProactive: function () { return function () {}; },
    onQueue: function () { return function () {}; },
    onContextAttached: function () { return function () {}; }
  };
`
}

  // ============ petApi ============
  window.petApi = {
    isWindows: isWindows,
    isMac: isMac,
    getSettings: function () {
      return window.__prts_request("settings:get").then(function (r) {
        return r.state || {};
      });
    },
    onSettings: function (fn) {
      return onEvent("settings:state", function (msg) {
        // Unwrap WS envelope: server sends {type:"settings:state", state:{...}}
        // Electron IPC passes the state object directly; VS Code WS wraps it.
        fn((msg && msg.state) ? msg.state : msg);
      });
    },
    onOpened: function (fn) {
      // VS Code doesn't have a popover opened event — call immediately
      setTimeout(fn, 0);
      return function () {};
    },
    getCatMode: function () {
      return window.__prts_request("desktop-pet:cat-mode-get").then(function (r) {
        return { cat: r.cat, mood: r.mood };
      });
    },
    onCatMode: function (fn) { return onEvent("desktop-pet:cat-mode", fn); },
    // Operations that only make sense in Electron are no-ops in VS Code
    hidePopover: function () { return Promise.resolve(); },
    notePopoverActivity: function () { return Promise.resolve(); },
    openChatFromDesktopPet: function () {
      vscode.postMessage({ type: "focusChat" });
      return Promise.resolve({ ok: true });
    },
    moveDesktopPet: function () { return Promise.resolve({ x: 0, y: 0 }); },
    scaleDesktopPet: function () { return Promise.resolve(1.0); },
    getPopoverBounds: function () { return Promise.resolve(null); },
    resizePopoverDrag: function () { return Promise.resolve(null); },
    movePopover: function () { return Promise.resolve(null); },
    endMovePopover: function () { return Promise.resolve(); },
    pickChatCwd: function () { return Promise.resolve({}); }
  };

  // ============ previewApi ============
${isChat
  ? `
  window.previewApi = {
    open: function (payload) {
      vscode.postMessage({ type: "preview:open", width: payload && payload.width });
      return Promise.resolve();
    },
    close: function () {
      vscode.postMessage({ type: "preview:close" });
      return Promise.resolve();
    },
    openInBrowser: function (payload) {
      vscode.postMessage({ type: "html:open-in-browser", html: payload && payload.html });
      return Promise.resolve({ ok: true });
    }
  };
`
  : `
  window.previewApi = {
    open: function () {},
    close: function () {},
    openInBrowser: function () { return Promise.resolve({ ok: true }); }
  };
`
}

  // ============ Character asset base URI ============
  ${options.characterBaseUri
    ? `window.__CHARACTER_BASE_URI__ = ${JSON.stringify(options.characterBaseUri)};`
    : ""}

  // ============ creditsApi / personaNotesApi / updateApi (stubs) ============
  window.creditsApi = {
    get: function () { return Promise.resolve({ contributors: [] }); },
    openLink: function () {},
    close: function () {}
  };
  window.personaNotesApi = {
    get: function () { return Promise.resolve(""); },
    set: function () { return Promise.resolve(); },
    close: function () {}
  };
  window.updateApi = {
    getState: function () { return Promise.resolve({}); },
    onProgress: function () { return function () {}; }
  };
  window.priestessApi = {
    getConfig: function () { return Promise.resolve({ enabled: false }); },
    setConfig: function () { return Promise.resolve({ ok: true }); },
    testConnection: function () { return Promise.resolve({ ok: false }); },
    closeSettings: function () {}
  };

})();
`;
}
