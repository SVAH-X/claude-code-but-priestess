/// <reference types="mocha" />
import * as assert from "assert";
import { isRestoreSafe, shouldOfferRestore } from "../../restore-prompt";

// The restore prompt rewrites the conversation every VS Code window shares,
// so a second window must never be offered it while the first one is mid-turn
// or even just connected. These pin the decision against the tray's
// chat:state answer, including the "cannot tell" cases.

describe("restore-prompt", () => {
  it("is safe only when idle and this window is the single client", () => {
    assert.strictEqual(isRestoreSafe({ busy: false, clients: 1 }), true);
    assert.strictEqual(isRestoreSafe({ busy: true, clients: 1 }), false, "a running turn");
    assert.strictEqual(isRestoreSafe({ busy: false, clients: 2 }), false, "another window shares the conversation");
    assert.strictEqual(isRestoreSafe({ busy: false }), false, "unknown client count");
    assert.strictEqual(isRestoreSafe(null), false);
    assert.strictEqual(isRestoreSafe(undefined), false);
  });

  it("asks the tray through chat:state and honours its answer", async () => {
    const asked: string[] = [];
    const ws = {
      request: async (type: string) => {
        asked.push(type);
        return { type: "chat:state:result", reqId: "9", busy: false, clients: 1 };
      },
    };
    assert.strictEqual(await shouldOfferRestore(ws), true);
    assert.deepStrictEqual(asked, ["chat:state"]);
  });

  it("treats a failed or timed-out query as unsafe", async () => {
    const ws = { request: async () => { throw new Error("Request chat:state timed out"); } };
    assert.strictEqual(await shouldOfferRestore(ws), false);
  });
});
