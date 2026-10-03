const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildNodeTestArgs, listTestFiles } = require("../scripts/run-tests");

const root = path.resolve(__dirname, "..");

test("npm test runs node --test through the cross-platform runner", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  // A shell glob here is not expanded by cmd.exe, so Node 20 on Windows
  // would find no tests at all.
  assert.equal(pkg.scripts.test, "node scripts/run-tests.js");
});

test("the runner picks up every test file and nothing else", () => {
  const onDisk = fs.readdirSync(path.join(root, "test")).filter((name) => name.endsWith(".test.js"));
  const listed = listTestFiles();
  assert.deepEqual(listed, onDisk.map((name) => `test/${name}`).sort());
  assert.ok(listed.includes("test/run-tests.test.js"));
  assert.ok(!listed.some((file) => file.endsWith("/helper.js")), "helpers are not test files");
  for (const file of listed) {
    assert.ok(!file.includes("\\"), `${file} must use forward slashes (Node 22+ reads it as a glob)`);
  }
});

test("extra npm test arguments go to node --test ahead of the files", () => {
  assert.deepEqual(
    buildNodeTestArgs(["test/a.test.js", "test/b.test.js"], ["--test-name-pattern", "queue"]),
    ["--test", "--test-name-pattern", "queue", "test/a.test.js", "test/b.test.js"]
  );
  assert.deepEqual(buildNodeTestArgs(["test/a.test.js"]), ["--test", "test/a.test.js"]);
});
