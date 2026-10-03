import * as path from "path";

/**
 * Lexical containment check: is `child` the same path as `root` or inside it?
 *
 * Both paths must be absolute. "." / ".." segments are resolved first, so
 * "<root>/../x" is outside. The comparison ignores case where the file system
 * usually does (Windows and macOS, matching VS Code's own file-URI rules),
 * which also covers Windows drive-letter case ("c:\\" vs "C:\\"). A path on
 * another drive or UNC share is outside because path.relative() then returns
 * an absolute path. Symlinks are NOT followed here: callers that need that
 * pass realpaths for both arguments.
 *
 * `pathImpl` / `caseInsensitive` exist so tests can exercise Windows rules
 * (path.win32) on any host.
 */
export function isPathInside(
  child: string,
  root: string,
  opts: { pathImpl?: typeof path.posix; caseInsensitive?: boolean } = {}
): boolean {
  const p = opts.pathImpl ?? path;
  if (typeof child !== "string" || typeof root !== "string" || !child || !root) return false;
  if (!p.isAbsolute(child) || !p.isAbsolute(root)) return false;
  const caseInsensitive =
    opts.caseInsensitive ?? (p.sep === "\\" || process.platform === "darwin");
  let c = p.resolve(child);
  let r = p.resolve(root);
  if (caseInsensitive) {
    c = c.toLowerCase();
    r = r.toLowerCase();
  }
  const rel = p.relative(r, c);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(".." + p.sep) && !p.isAbsolute(rel);
}
