import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Injectable exec surface so tests can drive git success/failure without a real repo. */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number }
) => Promise<{ stdout: string }>;

const defaultExec: ExecFn = async (cmd, args, opts) => {
  const { stdout } = await execFileAsync(cmd, args, {
    cwd: opts.cwd,
    timeout: opts.timeout,
    encoding: "utf8",
  });
  return { stdout };
};

/**
 * Builds a compact, human-readable summary of recent git activity for the
 * given workspace root, suitable for injecting into a chat prompt.
 *
 * The previous implementation ran `execSync('git log ...')` directly in the
 * command handler. execSync blocks the extension host event loop, freezing
 * the VS Code UI for up to the 5s timeout while git runs. This uses async
 * execFile instead (the extension host stays responsive), and execFile avoids
 * shell interpolation entirely - no metacharacter risk from paths.
 *
 * git may be missing or the folder may not be a repository; each command
 * degrades independently. If both fail, a friendly fallback string is
 * returned so callers do not need to special-case git errors.
 */
export async function buildRecentChangesSummary(
  cwd: string,
  execFn: ExecFn = defaultExec
): Promise<string> {
  let log = "";
  let diffStat = "";
  try {
    const logRes = await execFn("git", ["log", "--oneline", "-10"], { cwd, timeout: 5000 });
    log = logRes.stdout.trim();
  } catch {
    log = "";
  }
  try {
    const diffRes = await execFn("git", ["diff", "--stat", "HEAD~5..HEAD"], { cwd, timeout: 5000 });
    diffStat = diffRes.stdout.trim();
  } catch {
    diffStat = "";
  }
  if (!log && !diffStat) {
    return "(无法获取 git 信息——当前工作区可能不是 git 仓库)";
  }
  return `最近 10 次 commit:\n${log}\n\n最近 5 次改动的文件:\n${diffStat}`;
}
