/// <reference types="mocha" />
import * as assert from "assert";
import { buildRecentChangesSummary } from "../../git-summary";

// git-summary must never block the extension host, and it must degrade
// gracefully when git is missing or the folder is not a repository.

function fakeExec(results: Array<{ ok?: boolean; stdout?: string }>) {
  let calls = 0;
  const fn = async (_cmd: string, _args: string[], _opts: any) => {
    const r = results[Math.min(calls++, results.length - 1)];
    if (r.ok === false) throw new Error("git failed");
    return { stdout: r.stdout || "" };
  };
  return { fn, count: () => calls };
}

describe("git-summary", () => {
  it("returns recent commits and diff stat when git succeeds", async () => {
    const { fn } = fakeExec([
      { stdout: "aaa111 feat: x\naaa222 fix: y\n" },
      { stdout: " src/a.ts | 5 +++\n" },
    ]);
    const out = await buildRecentChangesSummary("C:\\work", fn as any);
    assert.ok(out.includes("aaa111 feat: x"), out);
    assert.ok(out.includes("src/a.ts | 5 +++"), out);
  });

  it("falls back when the folder is not a git repository", async () => {
    const { fn } = fakeExec([{ ok: false }, { ok: false }]);
    const out = await buildRecentChangesSummary("C:\\work", fn as any);
    assert.ok(out.includes("无法获取 git 信息"), out);
  });

  it("still returns the commit list when only the diff fails", async () => {
    const { fn } = fakeExec([{ stdout: "aaa111 feat: x\n" }, { ok: false }]);
    const out = await buildRecentChangesSummary("C:\\work", fn as any);
    assert.ok(out.includes("aaa111 feat: x"), out);
    assert.ok(!out.includes("(无法获取"), out);
  });
});
