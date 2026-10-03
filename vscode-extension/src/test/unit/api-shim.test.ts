/// <reference types="mocha" />
import * as assert from "assert";
import * as vm from "vm";
import { generateApiShim } from "../../api-shim";

// api-shim.ts is a pure string builder (no vscode dependency), so it is the
// cheapest module to pin down. These tests guard the webview API surface the
// renderer relies on: breaking a method name here breaks the chat UI.

describe("api-shim", () => {
  it("chat panel shim exposes the full chatApi surface", () => {
    const html = generateApiShim({ panel: "chat", characterBaseUri: "https://x/" });
    for (const member of [
      "window.chatApi",
      "send", "cancel", "clear", "getHistory",
      "onChunk", "onStatus", "onHistory", "onTool", "onMood",
      "onProactive", "onQueue", "onContextAttached", "applyFix",
    ]) {
      assert.ok(html.includes(member), `chat shim should include ${member}`);
    }
    assert.ok(html.includes("window.petApi"), "chat shim should expose petApi");
    assert.ok(html.includes("window.previewApi"), "chat shim should expose previewApi");
    assert.ok(html.includes("__CHARACTER_BASE_URI__"), "shim should stamp the character base URI");
    assert.ok(html.includes("https://x/"), "shim should contain the given characterBaseUri");
  });

  it("pet panel shim gets a minimal chatApi and no preview api", () => {
    const html = generateApiShim({ panel: "pet" });
    assert.ok(html.includes('not available in pet panel'), "pet send() should be a no-op stub");
    assert.ok(!html.includes("applyFix"), "pet shim should not expose applyFix");
    assert.ok(!html.includes("__CHARACTER_BASE_URI__"), "no characterBaseUri means no global stamp");
  });

  it("shim request plumbing carries reqId and routes replies", () => {
    const html = generateApiShim({ panel: "chat" });
    assert.ok(html.includes("window.__prts_request"), "shim must define __prts_request");
    assert.ok(html.includes("reqId"), "request/response correlation requires reqId");
    assert.ok(html.includes("acquireVsCodeApi()"), "shim must call acquireVsCodeApi");
  });
});

// Behavioural tests: the shim runs in a vm context with a stand-in window /
// document, so the message-source guard and the opt-in preview can be
// exercised without a webview.
function runShim() {
  const listeners: Record<string, Function[]> = {};
  const docListeners: Function[] = [];
  const posted: any[] = [];
  const closeClicks: string[] = [];
  const parent = { name: "webview host frame" };
  const window: any = {
    parent,
    addEventListener: (type: string, fn: Function) => { (listeners[type] = listeners[type] || []).push(fn); },
  };
  const dataset: Record<string, string> = {};
  const document = {
    documentElement: { dataset },
    addEventListener: (_type: string, fn: Function) => { docListeners.push(fn); },
    getElementById: (id: string) => (id === "closePreviewBtn" ? { click: () => closeClicks.push(id) } : null),
  };
  const sandbox: any = {
    window, document, console, setTimeout, clearTimeout,
    acquireVsCodeApi: () => ({ postMessage: (m: any) => posted.push(m) }),
  };
  vm.runInNewContext(generateApiShim({ panel: "chat" }), sandbox);
  return {
    window, posted, closeClicks, dataset,
    deliver(data: any, source: any) {
      for (const fn of listeners.message || []) fn({ data, source, origin: "vscode-webview://x" });
    },
    clickPreviewButton() {
      for (const fn of docListeners) fn({ target: { closest: (sel: string) => (sel === ".msg-preview-btn" ? {} : null) } });
    },
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1));
}

describe("api-shim behaviour", () => {
  it("only accepts messages from the webview host frame (not from the preview iframe)", async () => {
    const h = runShim();
    const chunks: any[] = [];
    h.window.chatApi.onChunk((m: any) => chunks.push(m));
    const p = h.window.chatApi.send("hi");
    const reqId = h.posted[0].reqId;
    let settled = false;
    p.then(() => { settled = true; });

    // A sandboxed iframe posting to its parent: event.source is that frame.
    const iframe = { name: "preview iframe" };
    h.deliver({ type: "chat:chunk", text: "forged" }, iframe);
    h.deliver({ type: "chat:send:result", reqId, ok: true }, iframe);
    h.deliver({ type: "theme", scheme: "light" }, iframe);
    await tick();
    assert.strictEqual(chunks.length, 0, "forged event must not reach handlers");
    assert.strictEqual(settled, false, "forged reply must not resolve a pending request");
    assert.strictEqual(h.dataset.theme, undefined, "forged theme must not be applied");

    h.deliver({ type: "chat:chunk", text: "real" }, h.window.parent);
    h.deliver({ type: "chat:send:result", reqId, ok: true }, h.window.parent);
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual((await p).ok, true);
  });

  it("undoes an automatic preview open through the close button", async () => {
    const h = runShim();
    await h.window.previewApi.open({ width: 200 });
    assert.deepStrictEqual(h.closeClicks, ["closePreviewBtn"]);
    assert.ok(!h.posted.some((m) => m.type === "preview:open"));
  });

  it("honours a preview open started by the message's preview button", async () => {
    const h = runShim();
    h.clickPreviewButton();
    await h.window.previewApi.open({ width: 200 });
    assert.deepStrictEqual(h.closeClicks, [], "an opt-in open stays open");
    assert.ok(h.posted.some((m) => m.type === "preview:open"));
    // The click only covers its own dispatch: a later automatic open is undone again.
    await tick();
    await h.window.previewApi.open({ width: 200 });
    assert.deepStrictEqual(h.closeClicks, ["closePreviewBtn"]);
  });
});
