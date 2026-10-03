/**
 * Sensitive-file checks for editor-driven features (inline completion).
 *
 * Port of the matcher in src/main/file-blacklist.js on the Electron side (same
 * gitignore subset, same always-on SENSITIVE_FILE_PATTERNS floor) so the
 * extension can refuse before any file content leaves VS Code. The backend
 * repeats the check; keep the two in sync (a unit test compares them).
 *
 * Patterns are matched relative to a workspace root: `name` / `*.pem` match a
 * file or directory name at any depth, a pattern with a slash is anchored to
 * the root, a trailing slash means directories only, and `*` never crosses
 * "/". A file outside the root (or checked without one) is judged by its
 * basename only. Backslashes count as separators and matching ignores case.
 */

import * as path from "path";

/**
 * Files never sent to a model, whatever prts.advisorFileBlacklist says.
 * `.env*` covers .env, .env.local, .envrc; `id_*` covers SSH private keys.
 */
export const SENSITIVE_FILE_PATTERNS: readonly string[] = Object.freeze([
  ".env*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_*",
  ".npmrc",
  ".netrc",
  ".pgpass",
  ".git-credentials",
]);

export interface CompiledPattern {
  pattern: string;
  anchored: boolean;
  dirOnly: boolean;
  re: RegExp;
}

/** Parses the advisorFileBlacklist setting (gitignore string or legacy array). */
export function parseBlacklist(raw: unknown): string[] {
  const lines = typeof raw === "string" ? raw.split(/\r?\n/) : Array.isArray(raw) ? raw : [];
  return lines
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s !== "" && !s.startsWith("#"));
}

function escapeRegex(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

// One gitignore glob (slash-normalized, no leading/trailing "/") as a regex
// source that must match a whole path.
function globToRegexSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      let j = i;
      while (glob[j] === "*") j += 1;
      if (j - i >= 2) {
        const atSegmentStart = i === 0 || glob[i - 1] === "/";
        if (atSegmentStart && glob[j] === "/") {
          out += "(?:.*/)?";
          i = j;
          continue;
        }
        if (atSegmentStart && j === glob.length) {
          out += ".*";
          i = j - 1;
          continue;
        }
      }
      out += "[^/]*";
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

/** Compiles one pattern; null for blanks, comments and (unsupported) negations. */
export function compilePattern(raw: unknown): CompiledPattern | null {
  const source = String(raw ?? "").trim();
  if (!source || source.startsWith("#") || source.startsWith("!")) return null;
  let glob = source.replace(/\\/g, "/");
  const dirOnly = glob.endsWith("/");
  glob = glob.replace(/\/+$/, "");
  const anchored = glob.includes("/");
  glob = glob.replace(/^\/+/, "");
  if (!glob) return null;
  return { pattern: source, anchored, dirOnly, re: new RegExp(`^${globToRegexSource(glob)}$`, "i") };
}

function toPosix(p: unknown): string {
  return String(p ?? "").replace(/\\/g, "/");
}

function isAbsolutePosix(p: string): boolean {
  return p.startsWith("/") || /^[a-zA-Z]:\//.test(p);
}

function normalizePosix(p: string): string {
  const normalized = path.posix.normalize(p);
  if (normalized === "/" || /^[a-zA-Z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, "");
}

function relativeSegments(filePath: unknown, root: unknown): string[] {
  const file = toPosix(filePath).trim();
  if (!file) return [];
  const basenameOnly = (): string[] => {
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

function patternMatches(compiled: CompiledPattern, segments: string[]): boolean {
  const n = segments.length;
  if (!compiled.anchored) {
    for (let i = 0; i < n; i += 1) {
      if (compiled.dirOnly && i === n - 1) continue;
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

/** The first pattern covering `filePath` (relative to `root`), or null. */
export function matchBlacklist(filePath: unknown, patterns: readonly string[], root = ""): string | null {
  if (!filePath || !patterns.length) return null;
  const segments = relativeSegments(filePath, root);
  if (!segments.length) return null;
  for (const raw of patterns) {
    const compiled = compilePattern(raw);
    if (compiled && patternMatches(compiled, segments)) return compiled.pattern;
  }
  return null;
}

/**
 * True when `filePath` matches the always-on sensitive list or any pattern of
 * the user's blacklist, relative to the workspace `root`. An empty path is
 * treated as not sensitive.
 */
export function isSensitiveFile(filePath: string | undefined, rawBlacklist?: unknown, root = ""): boolean {
  if (!filePath) return false;
  return matchBlacklist(filePath, [...SENSITIVE_FILE_PATTERNS, ...parseBlacklist(rawBlacklist)], root) !== null;
}
