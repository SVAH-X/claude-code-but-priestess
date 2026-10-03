// Test helper — short assertion names for the table-style test files, backed by
// node:test so `npm test` reports (and runs) every case on its own: a failing
// case no longer aborts the rest of its file, and the reporter names it.
const nodeTest = require("node:test");
const assert = require("node:assert");

function test(name, fn) {
  return nodeTest(name, fn);
}

function equal(actual, expected, msg) {
  assert.strictEqual(actual, expected, msg);
}

function deepEqual(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg);
}

function isTrue(val, msg) {
  assert.ok(val, msg);
}

function isFalse(val, msg) {
  assert.ok(!val, msg);
}

function matches(str, regex, msg) {
  assert.ok(regex.test(str), msg || `expected "${str}" to match ${regex}`);
}

function noMatch(str, regex, msg) {
  assert.ok(!regex.test(str), msg || `expected "${str}" NOT to match ${regex}`);
}

module.exports = { test, equal, deepEqual, isTrue, isFalse, matches, noMatch, assert };
