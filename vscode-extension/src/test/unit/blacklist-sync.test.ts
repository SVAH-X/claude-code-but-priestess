/// <reference types="mocha" />
import * as assert from "assert";
import { pushUserBlacklist, userSetBlacklist } from "../../blacklist-sync";
import { vscodeStub, resetVscodeStub } from "./helpers/vscode-stub";

// The tray owns the file blacklist; VS Code may only push a value the Doctor
// explicitly set in his user settings (never the contributed default, never a
// workspace value a repository could plant).

function makeWs(connected = true) {
  const calls: Array<{ type: string; data: any }> = [];
  return {
    calls,
    isConnected: () => connected,
    request: async (type: string, data: any) => {
      calls.push({ type, data });
      return {};
    },
  };
}

describe("blacklist-sync", () => {
  beforeEach(() => resetVscodeStub());

  it("does not push when the setting is unset (only the contributed default)", () => {
    vscodeStub.workspace._inspect.advisorFileBlacklist = { defaultValue: ".env\n*.pem" };
    vscodeStub.workspace._config.advisorFileBlacklist = ".env\n*.pem"; // what get() would return
    const ws = makeWs();
    assert.strictEqual(userSetBlacklist(), undefined);
    assert.strictEqual(pushUserBlacklist(ws), false);
    assert.strictEqual(ws.calls.length, 0, "a tray-edited list must not be clobbered");
  });

  it("pushes a value set in user settings", () => {
    vscodeStub.workspace._inspect.advisorFileBlacklist = { defaultValue: ".env", globalValue: ".env\nsecrets/" };
    const ws = makeWs();
    assert.strictEqual(pushUserBlacklist(ws), true);
    assert.deepStrictEqual(ws.calls, [
      { type: "settings:set", data: { patch: { advisorFileBlacklist: ".env\nsecrets/" } } },
    ]);
  });

  it("pushes an explicitly emptied list too", () => {
    vscodeStub.workspace._inspect.advisorFileBlacklist = { globalValue: "" };
    const ws = makeWs();
    assert.strictEqual(pushUserBlacklist(ws), true);
    assert.strictEqual(ws.calls[0].data.patch.advisorFileBlacklist, "");
  });

  it("ignores workspace and folder values", () => {
    vscodeStub.workspace._inspect.advisorFileBlacklist = { workspaceValue: "", workspaceFolderValue: "" };
    const ws = makeWs();
    assert.strictEqual(pushUserBlacklist(ws), false);
    assert.strictEqual(ws.calls.length, 0);
  });

  it("does nothing while disconnected", () => {
    vscodeStub.workspace._inspect.advisorFileBlacklist = { globalValue: ".env" };
    const ws = makeWs(false);
    assert.strictEqual(pushUserBlacklist(ws), false);
    assert.strictEqual(pushUserBlacklist(null), false);
    assert.strictEqual(ws.calls.length, 0);
  });
});
