// File blacklist — gitignore-style patterns guarding what the model may read on
// its own: Claude companion/advisor turns (Read deny rules) and the editor
// context the VS Code extension captures without being asked.
//
// Matching is relative to a workspace root, never against the whole absolute
// path: the folders above the project (".../design-tokens/", "~/Desktop") must
// not decide whether a file inside it is sensitive. Supported subset:
//   - `name`, `*.pem`, `id_rsa*`   no slash: matches a file OR directory name at
//                                  any depth (a matching directory covers
//                                  everything below it)
//   - `config/*.yml`, `/x.json`    leading or inner slash: anchored to the root
//   - `secrets/`                   trailing slash: directories only
//   - `**`, `*`, `?`, `[a-z]`      gitignore wildcards; `*` never crosses "/"
//   - `#` comments; `!` negation is not supported and is ignored
// Backslashes in patterns and paths are treated as separators (Windows users
// type them), so gitignore escapes are not supported either.
//
// Files outside the root (or checked without one) are matched on their basename
// only. Matching ignores case on every platform: the macOS and Windows file
// systems do, and for a deny list a stray match only blocks a read.
//
// Inside the root these are the semantics Claude Code applies to relative
// Read(...) deny rules (gitignore, relative to the CLI's cwd, case-insensitive
// on macOS), so claudeReadDenyRules() can hand the list to the CLI for real
// enforcement; matchClaudeReadDeny() predicts what those rules deny.

const path = require("node:path");

// Parses the advisorFileBlacklist setting (gitignore string or legacy array).
function parseBlacklist(raw) {
  const lines = typeof raw === "string" ? raw.split(/\r?\n/) : Array.isArray(raw) ? raw : [];
  return lines
    .filter((s) => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
}

function escapeRegex(ch) {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

// Translates one gitignore glob (already slash-normalized, no leading or
// trailing "/") into a regex source that must match a whole path.
function globToRegexSource(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      let j = i;
      while (glob[j] === "*") j += 1;
      if (j - i >= 2) {
        const atSegmentStart = i === 0 || glob[i - 1] === "/";
        if (atSegmentStart && glob[j] === "/") {
          out += "(?:.*/)?"; // "**/" = zero or more directories
          i = j; // also consume the "/"
          continue;
        }
        if (atSegmentStart && j === glob.length) {
          out += ".*"; // trailing "/**" (or a bare "**") = everything inside
          i = j - 1;
          continue;
        }
      }
      out += "[^/]*"; // "*" (and any other run of stars) stays within one name
      i = j - 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    if (ch === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close > i + 1) {
        let body = glob.slice(i + 1, close);
        const negate = body[0] === "!" || body[0] === "^";
        if (negate) body = body.slice(1);
        if (body) {
          const safe = body.replace(/[\\\]^]/g, "\\$&");
          out += negate ? `[^/${safe}]` : `[${safe}]`;
          i = close;
          continue;
        }
      }
      out += "\\[";
      continue;
    }
    out += escapeRegex(ch);
  }
  return out;
}

// Compiles one pattern; returns null for blanks, comments and negations.
function compilePattern(raw) {
  const source = String(raw ?? "").trim();
  if (!source || source.startsWith("#") || source.startsWith("!")) return null;
  let glob = source.replace(/\\/g, "/");
  const dirOnly = glob.endsWith("/");
  glob = glob.replace(/\/+$/, "");
  const anchored = glob.includes("/");
  glob = glob.replace(/^\/+/, "");
  if (!glob) return null;
  return {
    pattern: source,
    anchored,
    dirOnly,
    re: new RegExp(`^${globToRegexSource(glob)}$`, "i")
  };
}

function toPosix(p) {
  return String(p ?? "").replace(/\\/g, "/");
}

function isAbsolutePosix(p) {
  return p.startsWith("/") || /^[a-zA-Z]:\//.test(p);
}

function normalizePosix(p) {
  const normalized = path.posix.normalize(p);
  if (normalized === "/" || /^[a-zA-Z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, "");
}

// Splits `filePath` into path segments relative to `root`. Outside the root (or
// with no root) only the basename is returned: the folders above a project are
// not the Doctor's to judge by this list. With `outsideRoot: "ignore"` a file
// outside the root yields nothing (it cannot match at all).
function relativeSegments(filePath, root, outsideRoot = "basename") {
  const file = toPosix(filePath).trim();
  if (!file) return [];
  const basenameOnly = () => {
    if (outsideRoot === "ignore") return [];
    const name = normalizePosix(file).split("/").filter(Boolean).pop();
    return name && name !== "." && name !== ".." ? [name] : [];
  };
  if (!isAbsolutePosix(file)) {
    const rel = path.posix.normalize(file);
    if (rel === ".." || rel.startsWith("../")) return basenameOnly();
    return rel.split("/").filter((s) => s && s !== ".");
  }
  const rootPath = toPosix(root).trim();
  if (!rootPath || !isAbsolutePosix(rootPath)) return basenameOnly();
  const f = normalizePosix(file);
  const r = normalizePosix(rootPath);
  const fKey = f.toLowerCase();
  const rKey = r.toLowerCase();
  if (fKey === rKey) return [];
  const prefix = rKey.endsWith("/") ? rKey : `${rKey}/`;
  if (!fKey.startsWith(prefix)) return basenameOnly();
  return f.slice(prefix.length).split("/").filter(Boolean);
}

function patternMatches(compiled, segments) {
  const n = segments.length;
  if (!compiled.anchored) {
    for (let i = 0; i < n; i += 1) {
      if (compiled.dirOnly && i === n - 1) continue; // the last segment is the file
      if (compiled.re.test(segments[i])) return true;
    }
    return false;
  }
  for (let i = 1; i <= n; i += 1) {
    if (compiled.dirOnly && i === n) continue;
    if (compiled.re.test(segments.slice(0, i).join("/"))) return true;
  }
  return false;
}

// Returns the first pattern that covers `filePath`, or null.
//   root:        workspace root the patterns are relative to
//   outsideRoot: "basename" (default) judges an outside file by its name,
//                "ignore" never matches it
function matchBlacklist(filePath, patterns, { root = "", outsideRoot = "basename" } = {}) {
  if (!filePath || !Array.isArray(patterns) || !patterns.length) return null;
  const segments = relativeSegments(filePath, root, outsideRoot);
  if (!segments.length) return null;
  for (const raw of patterns) {
    const compiled = compilePattern(raw);
    if (compiled && patternMatches(compiled, segments)) return compiled.pattern;
  }
  return null;
}

function isBlacklisted(filePath, patterns, options = {}) {
  return matchBlacklist(filePath, patterns, options) !== null;
}

// The blacklist as Claude Code sees it: one slash-normalized glob per usable
// pattern. Parentheses would close a Read(...) rule early, so such patterns are
// skipped rather than guessed at. A leading "/" would mean "relative to the
// settings file" to Claude, and ours lives in a temp dir, so it is dropped; a
// single-name pattern then matches at any depth (Claude applies gitignore
// rules: "Read(x.json)" also denies sub/x.json), which only errs toward
// denying more.
function claudeDenyGlobs(patterns) {
  const globs = [];
  for (const raw of Array.isArray(patterns) ? patterns : []) {
    const source = String(raw ?? "").trim();
    if (!source || source.startsWith("#") || source.startsWith("!")) continue;
    if (/[()]/.test(source)) continue;
    let glob = source.replace(/\\/g, "/");
    const dirOnly = glob.endsWith("/");
    glob = glob.replace(/\/+$/, "").replace(/^\/+/, "");
    if (!glob) continue;
    globs.push({ glob, dirOnly, anchored: glob.includes("/") });
  }
  return globs;
}

// Converts the blacklist into Claude Code permission deny rules. The rules are
// relative (Claude resolves them against the CLI's cwd with gitignore rules,
// case-insensitively on macOS), so they guard the workspace without touching
// attachments granted via --add-dir from elsewhere.
function claudeReadDenyRules(patterns) {
  const rules = claudeDenyGlobs(patterns).map(({ glob, dirOnly, anchored }) =>
    `Read(${anchored ? glob : `**/${glob}`}${dirOnly ? "/**" : ""})`
  );
  return [...new Set(rules)];
}

// Whether the rules from claudeReadDenyRules() would stop Claude's Read tool
// from opening `filePath` when the CLI runs in `root`. Returns the covering
// (normalized) pattern or null. Differs from matchBlacklist() in two ways that
// follow Claude: leading-slash names match at any depth (see above), and files
// outside the root are not covered by these relative rules (observed on macOS;
// pass outsideRoot: "basename" to hedge where that is unverified).
function matchClaudeReadDeny(filePath, patterns, options = {}) {
  const equivalent = claudeDenyGlobs(patterns).map(({ glob, dirOnly }) => (dirOnly ? `${glob}/` : glob));
  if (!options.root) return null;
  return matchBlacklist(filePath, equivalent, { outsideRoot: "ignore", ...options });
}

// Files whose contents must never be sent to a model by editor-driven features
// such as inline completion, regardless of advisorFileBlacklist. That setting is
// user-editable (and writable over the VS Code bridge), so it can be emptied;
// this floor cannot. `.env*` covers .env, .env.local, .envrc; `id_*` covers
// SSH private keys (id_rsa, id_ed25519, ...). The VS Code extension keeps an
// identical copy in vscode-extension/src/sensitive-files.ts.
const SENSITIVE_FILE_PATTERNS = Object.freeze([
  ".env*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_*",
  ".npmrc",
  ".netrc",
  ".pgpass",
  ".git-credentials"
]);

module.exports = {
  claudeReadDenyRules,
  compilePattern,
  isBlacklisted,
  matchBlacklist,
  matchClaudeReadDeny,
  parseBlacklist,
  SENSITIVE_FILE_PATTERNS
};
