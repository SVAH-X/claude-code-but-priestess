/// <reference types="mocha" />
import * as assert from "assert";
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
