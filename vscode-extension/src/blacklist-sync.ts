import * as vscode from "vscode";

/**
 * The file blacklist lives in the tray's settings.json; VS Code is only an
 * optional second place to edit it. The sync is one-directional and only
 * carries a value the Doctor explicitly set in his VS Code *user* settings:
 * `get()` would return the contributed default for an unset key and silently
 * overwrite a list edited on the tray side on every connect. Workspace and
 * folder values are ignored too - opening a repository must not be able to
 * rewrite the global blacklist.
 */
export function userSetBlacklist(): string | undefined {
  const info = vscode.workspace
    .getConfiguration("prts")
    .inspect<string>("advisorFileBlacklist");
  const value = info?.globalValue;
  return typeof value === "string" ? value : undefined;
}

/** Pushes the user-set blacklist to the tray. Returns true when a push was sent. */
export function pushUserBlacklist(wsClient: any): boolean {
  if (!wsClient || !wsClient.isConnected()) return false;
  const value = userSetBlacklist();
  if (value === undefined) return false;
  // Fire-and-forget: a failing settings write is not worth an error dialog.
  Promise.resolve(
    wsClient.request("settings:set", { patch: { advisorFileBlacklist: value } })
  ).catch(() => {});
  return true;
}
