// Simple test runner using Node.js native assert.
// Usage: node test/run.js
const fs = require("node:fs");
const path = require("node:path");

const TEST_DIR = __dirname;
const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.js"));

let passed = 0;
let failed = 0;
const failures = [];

for (const file of files.sort()) {
  const filePath = path.join(TEST_DIR, file);
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  ${file}`);
  console.log("=".repeat(50));
  try {
    require(filePath);
    passed++;
    console.log(`  PASS`);
  } catch (err) {
    failed++;
    failures.push({ file, error: err.message, stack: err.stack });
    console.log(`  FAIL: ${err.message}`);
  }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: ${passed + failed} files, ${passed} pass, ${failed} fail`);
console.log("=".repeat(50));

if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`\n  ${f.file}:`);
    console.log(`    ${f.error}`);
  }
}

// Don't use process.exit — let the runtime finish normally so node --test
// wrappers and CI reporters get accurate results.
if (failed > 0 && process.env.NODE_TEST_CONTEXT === undefined) {
  process.exitCode = 1;
}
