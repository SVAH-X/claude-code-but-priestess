/**
 * Decides whether a window may offer "restore previous conversation / start
 * fresh" after connecting. The VS Code conversation is one shared session on
 * the tray side: every window sees the same history, and both answers to the
 * prompt rewrite it (restore reloads the on-disk copy, start fresh wipes it).
 * A second window answering the prompt would therefore cancel or discard a
 * turn the first window is in the middle of, so the prompt is only offered
 * when the tray reports no running turn and no other connected window.
 *
 * The tray answers a read-only `chat:state` request (ws-server.js). Any
 * failure (old tray without the request, timeout, disconnect) counts as
 * "unsafe": a missing prompt is harmless, a wiped live conversation is not.
 */
export interface ChatStateSnapshot {
  busy?: boolean;
  clients?: number;
}

export function isRestoreSafe(state: ChatStateSnapshot | null | undefined): boolean {
  if (!state || typeof state !== "object") return false;
  if (state.busy) return false;
  const clients = typeof state.clients === "number" ? state.clients : NaN;
  // The asking socket is counted too, so exactly one client means "only me".
  return clients === 1;
}

export async function shouldOfferRestore(
  wsClient: { request(type: string, data?: Record<string, any>): Promise<any> }
): Promise<boolean> {
  try {
    const res = await wsClient.request("chat:state");
    return isRestoreSafe(res);
  } catch (_) {
    return false;
  }
}
