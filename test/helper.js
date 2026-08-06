// Test helper — thin wrappers around Node.js native assert with descriptive output.
const assert = require("node:assert");
const { strictEqual, deepStrictEqual, ok, throws, doesNotThrow } = assert;

let currentTest = "";
let count = 0;
let failed = 0;

function test(name, fn) {
  currentTest = name;
  try {
    fn();
    count++;
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    throw err; // re-throw so the runner catches it
  }
}

function equal(actual, expected, msg) {
  try {
    strictEqual(actual, expected, msg);
  } catch (err) {
    console.log(`    in: ${currentTest}`);
    throw err;
  }
}

function deepEqual(actual, expected, msg) {
  try {
    deepStrictEqual(actual, expected, msg);
  } catch (err) {
    console.log(`    in: ${currentTest}`);
    throw err;
  }
}

function isTrue(val, msg) {
  try {
    ok(val, msg);
  } catch (err) {
    console.log(`    in: ${currentTest}`);
    throw err;
  }
}

function isFalse(val, msg) {
  try {
    ok(!val, msg);
  } catch (err) {
    console.log(`    in: ${currentTest}`);
    throw err;
  }
}

function matches(str, regex, msg) {
  try {
    ok(regex.test(str), msg || `expected "${str}" to match ${regex}`);
  } catch (err) {
    console.log(`    in: ${currentTest}`);
    throw err;
  }
}

function noMatch(str, regex, msg) {
  try {
    ok(!regex.test(str), msg || `expected "${str}" NOT to match ${regex}`);
  } catch (err) {
    console.log(`    in: ${currentTest}`);
    throw err;
  }
}

module.exports = { test, equal, deepEqual, isTrue, isFalse, matches, noMatch, assert };
