/// <reference types="mocha" />
import * as assert from "assert";
import * as path from "path";
import { isPathInside } from "../../path-guard";

// isPathInside guards the Apply button's diff target. The Windows cases run on
// every host through path.win32, since the maintainers cannot run Windows.

describe("path-guard isPathInside", () => {
  describe("posix rules", () => {
    const opts = { pathImpl: path.posix, caseInsensitive: false };

    it("accepts files under the root and the root itself", () => {
      assert.strictEqual(isPathInside("/ws/src/a.ts", "/ws", opts), true);
      assert.strictEqual(isPathInside("/ws", "/ws/", opts), true);
      assert.strictEqual(isPathInside("/ws/./src/../a.ts", "/ws", opts), true);
    });

    it("rejects '..' escapes, sibling prefixes and relative input", () => {
      assert.strictEqual(isPathInside("/ws/../etc/passwd", "/ws", opts), false);
      assert.strictEqual(isPathInside("/ws2/a.ts", "/ws", opts), false);
      assert.strictEqual(isPathInside("/", "/ws", opts), false);
      assert.strictEqual(isPathInside("ws/a.ts", "/ws", opts), false);
      assert.strictEqual(isPathInside("", "/ws", opts), false);
    });

    it("keeps names that merely start with '..' inside", () => {
      assert.strictEqual(isPathInside("/ws/..hidden", "/ws", opts), true);
    });

    it("is case-sensitive unless asked otherwise", () => {
      assert.strictEqual(isPathInside("/WS/a.ts", "/ws", opts), false);
      assert.strictEqual(isPathInside("/WS/a.ts", "/ws", { pathImpl: path.posix, caseInsensitive: true }), true);
    });
  });

  describe("windows rules", () => {
    const opts = { pathImpl: path.win32 };

    it("ignores drive-letter and path case", () => {
      assert.strictEqual(isPathInside("c:\\Users\\Dr\\Proj\\a.ts", "C:\\users\\dr\\proj", opts), true);
      assert.strictEqual(isPathInside("C:/Users/Dr/Proj/src/a.ts", "c:\\Users\\Dr\\Proj\\", opts), true);
    });

    it("rejects '..' escapes and sibling prefixes", () => {
      assert.strictEqual(isPathInside("C:\\ws\\..\\secret.txt", "C:\\ws", opts), false);
      assert.strictEqual(isPathInside("C:\\ws\\sub\\..\\..\\secret.txt", "C:\\ws", opts), false);
      assert.strictEqual(isPathInside("C:\\ws2\\a.ts", "C:\\ws", opts), false);
    });

    it("rejects other drives, UNC shares and drive-relative paths", () => {
      assert.strictEqual(isPathInside("D:\\ws\\a.ts", "C:\\ws", opts), false);
      assert.strictEqual(isPathInside("\\\\server\\share\\ws\\a.ts", "C:\\ws", opts), false);
      assert.strictEqual(isPathInside("C:ws\\a.ts", "C:\\ws", opts), false);
    });

    it("handles drive roots and UNC workspace roots", () => {
      assert.strictEqual(isPathInside("C:\\a.ts", "C:\\", opts), true);
      assert.strictEqual(isPathInside("\\\\Server\\Share\\ws\\a.ts", "\\\\server\\share\\ws", opts), true);
      assert.strictEqual(isPathInside("\\\\server\\other\\a.ts", "\\\\server\\share", opts), false);
    });
  });
});
