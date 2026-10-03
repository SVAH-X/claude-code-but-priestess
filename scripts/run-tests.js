// `npm test`: run every test/*.test.js file under Node's built-in test runner
// (`node --test`), identically on macOS, Linux and Windows.
//
// Why not `node --test test/*.test.js` in package.json: the glob is expanded by
// sh on macOS/Linux, but npm runs scripts through cmd.exe on Windows, which
// hands the pattern over literally. Node 22+ expands it itself; Node 20 does not
// and fails with "Could not find 'test/*.test.js'". `node --test test/` is no
// way out either: Node 22+ treats the directory as a single test file. Listing
// the files here gives every platform and Node version the same explicit list.
//
// Extra arguments are passed to `node --test` ahead of the file list, e.g.
//   npm test -- --test-name-pattern="queue"
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// Forward-slash relative paths: Node 22+ reads test arguments as glob
// patterns, where a backslash would be an escape character rather than a
// Windows separator.
function listTestFiles(root = ROOT) {
  return fs
    .readdirSync(path.join(root, "test"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
    .map((entry) => `test/${entry.name}`)
    .sort();
}

function buildNodeTestArgs(files, extraArgs = []) {
  return ["--test", ...extraArgs, ...files];
}

function main(extraArgs) {
  const files = listTestFiles();
  if (files.length === 0) {
    // An empty run would report success; fail loudly instead.
    console.error("run-tests: no test/*.test.js files found");
    return 1;
  }
  const result = spawnSync(process.execPath, buildNodeTestArgs(files, extraArgs), {
    cwd: ROOT,
    stdio: "inherit"
  });
  if (result.error) {
    console.error(`run-tests: failed to start node --test: ${result.error.message}`);
    return 1;
  }
  if (result.signal) {
    console.error(`run-tests: node --test was killed by ${result.signal}`);
    return 1;
  }
  return typeof result.status === "number" ? result.status : 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { buildNodeTestArgs, listTestFiles };
