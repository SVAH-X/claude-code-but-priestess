const { test, equal, isTrue, isFalse } = require("./helper");
const { patternToRegex, parseBlacklist, isBlacklisted, findBlacklistedFiles } = require("../src/main/file-blacklist");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

test("parseBlacklist handles gitignore string with comments and blanks", () => {
  const raw = "# comment\n.env\n\n*secret*\n*.pem\n# another\nid_rsa*";
  const p = parseBlacklist(raw);
  equal(p.length, 4, "4 patterns after filtering comment+blank");
  isTrue(p.includes(".env"), "keeps .env");
  isTrue(p.includes("*secret*"), "keeps *secret*");
  isFalse(p.includes("# comment"), "drops comments");
});

test("parseBlacklist handles legacy array format", () => {
  const p = parseBlacklist([".env", "  *.pem  ", "", null, "id_rsa*"]);
  equal(p.length, 3, "filters empties and non-strings");
  isTrue(p.includes("id_rsa*"), "keeps valid");
});

test("patternToRegex matches filename anywhere in path", () => {
  const re = patternToRegex(".env");
  isTrue(re.test(path.join("proj", ".env")), "matches .env in subdir");
  isFalse(re.test(path.join("proj", ".env.local")), "does not match .env.local as same file");
});

test("isBlacklisted denies exact paths", () => {
  const patterns = parseBlacklist(".env\n*secret*\n*.pem");
  isTrue(isBlacklisted(path.join(process.cwd(), ".env"), patterns), ".env denied");
  isTrue(isBlacklisted(path.join(process.cwd(), "src", "secret-notes.md"), patterns), "*secret* denied");
  isTrue(isBlacklisted(path.join(process.cwd(), "keys", "private.pem"), patterns), "*.pem denied");
  isFalse(isBlacklisted(path.join(process.cwd(), "src", "index.ts"), patterns), "normal file allowed");
});

test("findBlacklistedFiles scans workspace", () => {
  const root = path.join(process.cwd(), "test", ".bltmp-" + Date.now());
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(root, "main.ts"), "export const a = 1;");
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "key.pem"), "key");
  const found = findBlacklistedFiles(root, parseBlacklist(".env\n*.pem"));
  const names = found.map((f) => path.basename(f));
  isTrue(names.includes(".env"), "found .env");
  isTrue(names.includes("key.pem"), "found key.pem");
  isFalse(names.includes("main.ts"), "normal file not blacklisted");
  fs.rmSync(root, { recursive: true, force: true });
});
