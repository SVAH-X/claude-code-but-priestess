// File blacklist enforcement — resolves gitignore-style patterns to absolute-path
// matchers. Used by chat.js CLI builders and vscode-chat.js context filters to
// deny file access at multiple layers.

const path = require("node:path");
const fs = require("node:fs");

// Converts a gitignore-style pattern to a regex that matches full file paths.
// Handles: * (any char except /), ** (any chars), ? (single char), .dotfiles.
function patternToRegex(pattern) {
  let s = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex specials except * and ?
    .replace(/\*\*/g, "\x00")              // placeholder for **
    .replace(/\*/g, "[^/\\\\]*")           // * → any non-path-separator chars
    .replace(/\?/g, "[^/\\\\]")            // ? → single non-separator char
    .replace(/\x00/g, ".*");               // ** → anything
  // If the pattern has no path separator and doesn't start with *, anchor it
  // to match anywhere in the path (typical gitignore behavior)
  if (!/[\/\\]/.test(pattern) && !pattern.startsWith("*") && !pattern.startsWith("?")) {
    s = "(^|[/\\\\])" + s + "($|[/\\\\])";
  } else if (s.startsWith(".")) {
    // Leading dot → match filename beginning with dot
    s = "(^|[/\\\\])" + s;
  }
  return new RegExp(s, "i");
}

// Scans a workspace root for files matching any blacklist pattern.
// Returns absolute paths of matched files for use in CLI exclusion args.
function findBlacklistedFiles(workspaceRoot, patterns) {
  if (!workspaceRoot || !patterns || !patterns.length) return [];
  const matched = [];
  const regexes = patterns.map(patternToRegex);

  function walk(dir, depth) {
    if (depth > 8) return; // depth limit
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.name.startsWith(".") && entry.name !== ".env") continue; // skip hidden except .env
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (regexes.some((re) => re.test(full))) {
          matched.push(full);
        }
      }
    }
  }

  walk(workspaceRoot, 0);
  // Cap to avoid blowing up CLI args (100 files max)
  return matched.slice(0, 100);
}

// Parses the advisorFileBlacklist setting (gitignore string or legacy array).
function parseBlacklist(raw) {
  if (typeof raw === "string") {
    return raw.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  }
  if (Array.isArray(raw)) return raw.filter((s) => typeof s === "string" && s.trim());
  return [];
}

// Checks whether a given absolute file path matches any blacklist pattern.
function isBlacklisted(filePath, patterns) {
  if (!filePath || !patterns || !patterns.length) return false;
  return patterns.some((re) => (typeof re === "object" ? re : patternToRegex(re)).test(filePath));
}

module.exports = { patternToRegex, findBlacklistedFiles, parseBlacklist, isBlacklisted };
