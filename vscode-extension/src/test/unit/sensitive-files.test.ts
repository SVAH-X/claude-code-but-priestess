/// <reference types="mocha" />
import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { SENSITIVE_FILE_PATTERNS, compilePattern, isSensitiveFile, matchBlacklist, parseBlacklist } from "../../sensitive-files";

// The extension-side check must agree with src/main/file-blacklist.js on the
// Electron side, which repeats it for every chat:inline-complete request.

const SAMPLE_PATHS = [
  "/proj/.env",
  "/proj/.env.local",
  "/proj/.envrc",
  "C:\\proj\\.env.production",
  "C:\\proj\\certs\\SERVER.PEM",
  "/home/doc/.ssh/id_ed25519",
  "C:\\Users\\Doc\\.ssh\\id_rsa",
  "/proj/prod.key",
  "/proj/cert.p12",
  "/home/doc/.npmrc",
  "/home/doc/.git-credentials",
  "/proj/src/app.ts",
  "C:\\proj\\src\\App.tsx",
  "/proj/environment.ts",
  "/proj/src/identity.ts",
  "/proj/keyboard.ts",
  "/proj/Deck.keynote/preview.jpg",
  "/proj/vault/a.ts",
  "C:\\proj\\Vault\\b.ts",
  "/proj/src/secret-config.ts",
  "/srv/secret-work/proj/src/a.ts",
  "src/vault/a.ts",
  "Untitled-1",
];

describe("sensitive-files", () => {
  it("blocks secrets on POSIX and Windows paths, case-insensitively", () => {
    for (const p of SAMPLE_PATHS.slice(0, 11)) {
      assert.strictEqual(isSensitiveFile(p), true, `${p} must be sensitive`);
    }
    for (const p of ["/proj/src/app.ts", "C:\\proj\\src\\App.tsx", "/proj/environment.ts", "/proj/src/identity.ts", "/proj/keyboard.ts", "/proj/Deck.keynote/preview.jpg", "Untitled-1"]) {
      assert.strictEqual(isSensitiveFile(p), false, `${p} must stay allowed`);
    }
    assert.strictEqual(isSensitiveFile(undefined), false);
    assert.strictEqual(isSensitiveFile(""), false);
  });

  it("adds the user's blacklist on top of the built-in floor, relative to the root", () => {
    const raw = "# comment\r\nvault/**\n*secret*";
    assert.deepStrictEqual(parseBlacklist(raw), ["vault/**", "*secret*"]);
    assert.strictEqual(isSensitiveFile("/proj/vault/a.ts", raw, "/proj"), true);
    assert.strictEqual(isSensitiveFile("C:\\proj\\Vault\\b.ts", raw, "c:\\PROJ"), true);
    assert.strictEqual(isSensitiveFile("/proj/src/secret-config.ts", raw, "/proj"), true);
    assert.strictEqual(isSensitiveFile("/proj/src/app.ts", raw, "/proj"), false);
    // Folders above the root never decide.
    assert.strictEqual(isSensitiveFile("/srv/secret-work/proj/src/a.ts", raw, "/srv/secret-work/proj"), false);
    // Outside the root (or with none) only the file name is judged.
    assert.strictEqual(isSensitiveFile("/proj/vault/a.ts", raw), false);
    assert.strictEqual(matchBlacklist("/other/secret.txt", parseBlacklist(raw), "/proj"), "*secret*");
    // An empty blacklist cannot remove the floor.
    assert.strictEqual(isSensitiveFile("/proj/.env", ""), true);
    assert.strictEqual(isSensitiveFile("/proj/.env", []), true);
  });

  it("matches the Electron-side file-blacklist.js exactly", function () {
    // out/src/test/unit -> repo root
    const jsPath = path.resolve(__dirname, "../../../../../src/main/file-blacklist.js");
    if (!fs.existsSync(jsPath)) this.skip();
    const js = require(jsPath);
    assert.deepStrictEqual([...SENSITIVE_FILE_PATTERNS], [...js.SENSITIVE_FILE_PATTERNS], "keep both lists in sync");
    const user = "vault/**\n*secret*\n?.cfg\n/top.json\nbuild/\n[Tt]mp/**\n# c\n!keep";
    assert.deepStrictEqual(parseBlacklist(user), js.parseBlacklist(user));
    const patterns = [...SENSITIVE_FILE_PATTERNS, ...parseBlacklist(user)];
    for (const pattern of patterns) {
      const ours = compilePattern(pattern);
      const theirs = js.compilePattern(pattern);
      assert.deepStrictEqual(
        ours && { ...ours, re: ours.re.source },
        theirs && { ...theirs, re: theirs.re.source },
        `compiled ${pattern}`
      );
    }
    for (const root of ["", "/proj", "C:\\proj", "/srv/secret-work/proj"]) {
      for (const p of SAMPLE_PATHS) {
        assert.strictEqual(
          matchBlacklist(p, patterns, root),
          js.matchBlacklist(p, patterns, { root }),
          `verdict for ${p} under root "${root}"`
        );
      }
    }
  });
});
