import * as vscode from "vscode";

const DEBOUNCE_MS = 300;
const MIN_PREFIX_LENGTH = 3;

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
          const items = await this.requestCompletion(prefix, file, lang, position);

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
    language: string,
    position: vscode.Position
  ): Promise<vscode.InlineCompletionItem[] | null> {
    if (this.inFlight) return null;
    this.inFlight = true;
    try {
      // Send a lightweight completion request.
      const result = await this.wsClient.request("chat:inline-complete", {
        prefix,
        file,
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
