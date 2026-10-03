/// <reference types="mocha" />
import * as assert from "assert";
import { InlineCompletionProvider } from "../../inline-provider";
import { resetVscodeStub } from "./helpers/vscode-stub";

// The provider's decision logic (minimum prefix, provider gate, debounce +
// race swallowing, ghost-text shaping) is all testable with a mocked ws
// client and plain-object documents.

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeWs(overrides?: any) {
  return {
    providerAvailability: { activeProvider: "codex" },
    isConnected: () => true,
    request: async (_type: string, _data: any) => ({ text: "ghost-text" }),
    ...(overrides || {}),
  };
}

function makeDoc(prefix: string, lang = "typescript", fileName = "app.ts") {
  return {
    languageId: lang,
    fileName,
    getText: () => prefix,
  };
}

function makePosition(line = 0, character = 5) {
  return { line, character };
}

function makeToken() {
  return { isCancellationRequested: false };
}

describe("inline-provider", () => {
  let provider: InlineCompletionProvider | null = null;

  beforeEach(() => resetVscodeStub());
  afterEach(() => {
    if (provider) { provider.dispose(); provider = null; }
  });

  it("returns nothing for a prefix shorter than 3 characters", async () => {
    provider = new InlineCompletionProvider(makeWs() as any);
    const items = await provider.provideInlineCompletionItems(
      makeDoc("ab") as any, makePosition(0, 2) as any, {} as any, makeToken() as any
    );
    assert.deepStrictEqual(items, []);
  });

  it("skips when provider info shows no active CLI provider", async () => {
    provider = new InlineCompletionProvider(makeWs({ providerAvailability: { activeProvider: null } }) as any);
    const items = await provider.provideInlineCompletionItems(
      makeDoc("const x = ") as any, makePosition() as any, {} as any, makeToken() as any
    );
    assert.deepStrictEqual(items, []);
  });

  it("skips when the active provider is the priestess bridge", async () => {
    provider = new InlineCompletionProvider(makeWs({ providerAvailability: { activeProvider: "priestess" } }) as any);
    const items = await provider.provideInlineCompletionItems(
      makeDoc("const x = ") as any, makePosition() as any, {} as any, makeToken() as any
    );
    assert.deepStrictEqual(items, []);
  });

  it("returns a ghost-text item from the backend completion", async () => {
    const calls: any[] = [];
    const ws = makeWs({
      request: async (type: string, data: any) => {
        calls.push({ type, data });
        return { text: "ghost-text" };
      },
    });
    provider = new InlineCompletionProvider(ws as any);
    const items = await provider.provideInlineCompletionItems(
      makeDoc("const x = ") as any, makePosition() as any, {} as any, makeToken() as any
    );
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].insertText, "ghost-text");
    assert.strictEqual(calls.length, 1, "exactly one completion request");
    assert.strictEqual(calls[0].type, "chat:inline-complete");
    assert.strictEqual(calls[0].data.language, "typescript");
    assert.strictEqual(calls[0].data.file, "app.ts");
    assert.ok(calls[0].data.prefix.includes("const x = "));
  });

  it("a rapid second call cancels the pending first result", async () => {
    let requestCallCount = 0;
    let requestResolve: ((v: any) => void) | null = null;
    const ws = makeWs({
      request: () => {
        requestCallCount++;
        return new Promise((resolve) => { requestResolve = resolve; });
      },
    });
    provider = new InlineCompletionProvider(ws as any);

    const first = provider.provideInlineCompletionItems(
      makeDoc("const x = ") as any, makePosition() as any, {} as any, makeToken() as any
    );
    // Second call arrives before the 300ms debounce fires.
    const second = provider.provideInlineCompletionItems(
      makeDoc("const x = 1") as any, makePosition(0, 10) as any, {} as any, makeToken() as any
    );

    const firstItems = await first;
    assert.deepStrictEqual(firstItems, [], "stale request must be swallowed with an empty result");

    await wait(350); // let the debounce fire and the request reach the backend
    assert.strictEqual(requestCallCount, 1, "only the latest request should reach the backend");
    requestResolve!({ text: "late" });

    const secondItems = await second;
    assert.strictEqual(secondItems.length, 1, "the latest request should still complete");
    assert.strictEqual(secondItems[0].insertText, "late");
  });
  it("drops new requests while one is already in flight", async () => {
    let requestCallCount = 0;
    let resolveRequest: ((v: any) => void) | null = null;
    const ws = makeWs({
      request: () => {
        requestCallCount++;
        return new Promise((resolve) => { resolveRequest = resolve; });
      },
    });
    provider = new InlineCompletionProvider(ws as any);

    const first = provider.provideInlineCompletionItems(
      makeDoc("const x = ") as any, makePosition() as any, {} as any, makeToken() as any
    );
    await wait(350); // first request issued and now in flight
    assert.strictEqual(requestCallCount, 1);

    // While the first request is running, a new keystroke pause must not
    // stack a second CLI spawn on the backend.
    const second = provider.provideInlineCompletionItems(
      makeDoc("const x = 1") as any, makePosition(0, 10) as any, {} as any, makeToken() as any
    );
    const secondItems = await second;
    assert.deepStrictEqual(secondItems, []);
    assert.strictEqual(requestCallCount, 1, "no second backend request while in flight");

    resolveRequest!({ text: "ghost" });
    const firstItems = await first;
    assert.strictEqual(firstItems.length, 1, "the in-flight request still completes");
  });

});
