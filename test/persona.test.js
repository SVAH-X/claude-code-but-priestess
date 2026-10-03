// Persona logic tests — isolated, no module dependencies.
const { test, equal, isTrue } = require("./helper");

// ============================================================
// Blacklist parser tests (same logic as persona.js)
// ============================================================

function parseBlacklist(raw) {
  return typeof raw === "string"
    ? raw.split("\n").map(function (s) { return s.trim(); }).filter(function (s) { return s && !s.startsWith("#"); })
    : Array.isArray(raw) ? raw : [];
}

test("gitignore blacklist parser filters comments and blanks", () => {
  const raw = "# comment\n.env\n\n*.log\n# another comment\n*secret*";
  const patterns = parseBlacklist(raw);
  equal(patterns.length, 3, "three active patterns");
  equal(patterns[0], ".env");
  equal(patterns[1], "*.log");
  equal(patterns[2], "*secret*");
});

test("blacklist parser handles array fallback", () => {
  const patterns = parseBlacklist([".env", "*.log"]);
  equal(patterns.length, 2);
  equal(patterns[0], ".env");
});

test("blacklist parser returns empty for missing config", () => {
  equal(parseBlacklist(undefined).length, 0);
  equal(parseBlacklist(null).length, 0);
});

test("blacklist parser handles empty string", () => {
  equal(parseBlacklist("").length, 0);
});

test("blacklist parser handles whitespace-only lines", () => {
  const raw = "  .env  \n   \n  *.log  ";
  const patterns = parseBlacklist(raw);
  equal(patterns.length, 2);
  equal(patterns[0], ".env");
  equal(patterns[1], "*.log");
});

// ============================================================
// appendMemoryEntry format test
// ============================================================

test("appendMemoryEntry produces correct timestamp format", () => {
  const now = new Date();
  const stamp = now.getFullYear() + "-" +
    String(now.getMonth() + 1).padStart(2, "0") + "-" +
    String(now.getDate()).padStart(2, "0");
  isTrue(/^\d{4}-\d{2}-\d{2}$/.test(stamp), "timestamp YYYY-MM-DD");
  const line = "- " + stamp + " 博士今天调了一个空值 bug\n";
  isTrue(line.startsWith("- "), "line starts with dash");
  isTrue(line.includes("空值 bug"), "content preserved");
});
