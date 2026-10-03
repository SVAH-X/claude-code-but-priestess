import * as vscode from "vscode";
import { isSensitiveFile } from "./sensitive-files";

const DEBOUNCE_MS = 300;
const MIN_PREFIX_LENGTH = 3;

/**
 * Inline completion is opt-in (`prts.inlineCompletion.enabled`, default off):
 * every typing pause costs a CLI call and sends the lines before the cursor to
 * the model.
 */
export function isInlineCompletionEnabled(): boolean {
  return vscode.workspace.getConfiguration("prts").get<boolean>("inlineCompletion.enabled") === true;
}

/**
 * The root blacklist patterns are relative to: the document's own workspace
 * folder, else the first folder (what the tray app uses as the workspace).
 */
function workspaceRootFor(document: vscode.TextDocument): string {
  const own = document.uri ? vscode.workspace.getWorkspaceFolder(document.uri) : undefined;
  return (own ?? vscode.workspace.workspaceFolders?.[0])?.uri.fsPath ?? "";
}

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingResolve: ((items: vscode.InlineCompletionItem[]) => void) | null = null;

  /**
   * True while a `chat:inline-complete` request is in flight. The backend
   * spawns a fresh CLI subprocess for every completion request, and the editor
   * asks for completions on every pause while the user types. Without this
   * guard a short burst of typing could fork several CLI processes at once;
   * requests that arrive while one is already running are dropped, and the
   * next pause simply triggers a fresh completion.
   */
  private inFlight = false;

  constructor(private wsClient: any) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    _token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[]> {
    // Gates run before any document text is read.
    if (!isInlineCompletionEnabled()) return [];
    // Companion mode is chat-only (the backend enforces this too; skipping
    // here keeps the prefix inside VS Code). null = not heard yet: ask anyway.
    if (this.wsClient?.vibeCodingMode === "companion") return [];
    // Never send secrets (.env*, *.pem, *.key, id_*, ...) or files matching
    // the Doctor's blacklist (relative to the document's workspace folder).
    const blacklist = vscode.workspace.getConfiguration("prts").get<string>("advisorFileBlacklist");
    if (isSensitiveFile(document.fileName, blacklist, workspaceRootFor(document))) return [];

    // Get the text before the cursor (last few lines for context).
    const lineStart = Math.max(0, position.line - 5);
    const prefixRange = new vscode.Range(lineStart, 0, position.line, position.character);
    const prefix = document.getText(prefixRange);

    if (prefix.trim().length < MIN_PREFIX_LENGTH) return [];

    // Cancel any pending request.
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    // If a previous request was pending (race condition), swallow it.
    if (this.pendingResolve) {
      this.pendingResolve([]);
      this.pendingResolve = null;
    }

    return new Promise<vscode.InlineCompletionItem[]>((resolve) => {
      this.pendingResolve = resolve;
      this.debounceTimer = setTimeout(async () => {
        this.debounceTimer = null;
        this.pendingResolve = null;
        try {
          if (!this.wsClient?.isConnected()) { resolve([]); return; }
          // Skip when the server has told us there is no usable CLI provider
          // (e.g. priestess-only mode). The snapshot is maintained by WsClient
          // whenever a chat:status message arrives; null means we have not
          // heard from the server yet, in which case we ask anyway.
          const avail = this.wsClient.providerAvailability;
          if (avail && (!avail.activeProvider || avail.activeProvider === "priestess")) {
            resolve([]); return;
          }
          const lang = document.languageId;
          const file = document.fileName.split(/[\\/]/).pop();

          // requestCompletion() itself drops the request if another one is
          // still in flight, so we can never stack backend CLI spawns.
          const items = await this.requestCompletion(prefix, file, document.fileName, lang, position);

          if (_token.isCancellationRequested || !items) {
            resolve([]);
            return;
          }

          // Return the completion as ghost text.
          resolve(items);
        } catch {
          resolve([]);
        }
      }, DEBOUNCE_MS);
    });
  }

  /**
   * Sends a single completion request to the backend, guaranteeing that at
   * most one is in flight at a time. Returns null when the request was dropped
   * (another one already running) or the backend had no suggestion.
   */
  private async requestCompletion(
    prefix: string,
    file: string | undefined,
    filePath: string,
    language: string,
    position: vscode.Position
  ): Promise<vscode.InlineCompletionItem[] | null> {
    if (this.inFlight) return null;
    this.inFlight = true;
    try {
      // Send a lightweight completion request.
      // filePath lets the backend repeat the sensitive-file check on the full
      // path; only the bare file name is ever put into the prompt.
      const result = await this.wsClient.request("chat:inline-complete", {
        prefix,
        file,
        filePath,
        language,
      });
      if (!result?.text) return null;
      return [new vscode.InlineCompletionItem(result.text, new vscode.Range(position, position))];
    } finally {
      // Always release the flag so a later request is not blocked forever
      // (e.g. if the backend promise rejects).
      this.inFlight = false;
    }
  }

  dispose() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.pendingResolve = null;
  }
}
