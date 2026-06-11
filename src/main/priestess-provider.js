// ============================================================
//  Built-in "Priestess" backend — she carries herself.
//
//  Streams chat completions from any OpenAI-compatible server (LiteLLM by
//  default; also Ollama, LM Studio, vLLM, OpenRouter, …). No local CLI is
//  involved: this is a direct HTTP connection from the app to the server the
//  Doctor configured. The base URL / API key / model live only in the local
//  settings.json and are sent only to that server.
//
//  Uses Electron net.fetch (system proxy aware) with SSE parsing. Returns a
//  handle with kill() so chat.js can treat a turn like a CLI subprocess.
// ============================================================

const { net } = require("electron");

// Accept base URLs with or without /v1 (or a full /chat/completions path).
function chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) return null;
  if (base.endsWith("/chat/completions")) return base;
  if (base.endsWith("/v1")) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function extractDelta(payload) {
  const choice = payload?.choices?.[0];
  if (!choice) return "";
  // delta.reasoning_content (DeepSeek-R1 style) is deliberately ignored —
  // chain of thought is not part of her reply.
  if (typeof choice.delta?.content === "string") return choice.delta.content;
  // Some servers send non-streamed shapes even with stream:true.
  if (typeof choice.message?.content === "string") return choice.message.content;
  if (typeof choice.text === "string") return choice.text;
  return "";
}

// Longest suffix of `s` that is a proper prefix of `tag` — i.e. a tag that
// might still be completing in the next chunk.
function partialTagSuffix(s, tag) {
  const max = Math.min(s.length, tag.length - 1);
  for (let len = max; len > 0; len -= 1) {
    if (s.endsWith(tag.slice(0, len))) return s.slice(s.length - len);
  }
  return "";
}

// Local reasoning models (DeepSeek-R1, Qwen3, …) often stream their chain of
// thought inline as <think>…</think> before the real answer. That is not
// meant for the Doctor — drop it, holding back a partial tag that might still
// be forming across chunk boundaries.
function createThinkFilter() {
  const OPEN = "<think>";
  const CLOSE = "</think>";
  let inThink = false;
  let tail = "";
  return {
    push(text) {
      let s = tail + text;
      tail = "";
      let out = "";
      for (;;) {
        if (inThink) {
          const end = s.indexOf(CLOSE);
          if (end === -1) {
            // Thought content is discarded; keep only a possible partial close.
            tail = partialTagSuffix(s, CLOSE);
            return out;
          }
          s = s.slice(end + CLOSE.length);
          inThink = false;
        } else {
          const start = s.indexOf(OPEN);
          if (start === -1) {
            tail = partialTagSuffix(s, OPEN);
            out += s.slice(0, s.length - tail.length);
            return out;
          }
          out += s.slice(0, start);
          s = s.slice(start + OPEN.length);
          inThink = true;
        }
      }
    },
    // A held partial open tag that never completed is real text; a pending
    // thought is not.
    flush() {
      const rest = inThink ? "" : tail;
      tail = "";
      return rest;
    }
  };
}

// Abort the turn if the server goes completely quiet (no headers, no chunk)
// for this long. Generous because the typical deployment is a local model on
// modest hardware, where one token can take a while — but a wedged server
// should not hang the turn forever.
const IDLE_TIMEOUT_MS = 120 * 1000;
const TEST_TIMEOUT_MS = 8 * 1000;

// Start a streaming turn. Calls onDelta(text) per chunk, then exactly one of
// onDone() / onError(error). The returned handle's kill() aborts the request
// (onError fires with an AbortError unless the turn already finished).
function startTurn({ baseUrl, apiKey, model, system, messages, onDelta, onDone, onError }) {
  const url = chatCompletionsUrl(baseUrl);
  const controller = new AbortController();
  const thinkFilter = createThinkFilter();
  let settled = false;
  let idleTimer = null;
  const emit = (text) => {
    const visible = thinkFilter.push(text);
    if (visible) onDelta(visible);
  };
  const finishOk = () => {
    if (settled) return;
    const rest = thinkFilter.flush();
    if (rest) onDelta(rest);
    settled = true;
    clearTimeout(idleTimer);
    onDone();
  };
  const finishErr = (error) => {
    if (!settled) {
      settled = true;
      clearTimeout(idleTimer);
      onError(error);
    }
  };
  // Settle with a plain Error (not the AbortError the kill below produces) so
  // chat.js reports a timeout instead of treating it as a user cancel.
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      finishErr(new Error(`服务器超过 ${IDLE_TIMEOUT_MS / 1000} 秒没有任何响应，已断开`));
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }, IDLE_TIMEOUT_MS);
  };

  (async () => {
    if (!url) throw new Error("no server URL configured");
    const body = {
      model: String(model || "").trim() || undefined,
      stream: true,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        ...messages
      ]
    };
    armIdleTimer();
    const res = await net.fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify(body)
    });
    armIdleTimer();
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 400);
      throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("no response body");
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let sawSse = false;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdleTimer();
      buffer += decoder.decode(value, { stream: true });
      let newlineAt;
      while ((newlineAt = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineAt).trim();
        buffer = buffer.slice(newlineAt + 1);
        if (!line.startsWith("data:")) continue;
        sawSse = true;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          finishOk();
          return;
        }
        try {
          const delta = extractDelta(JSON.parse(data));
          if (delta) emit(delta);
        } catch {
          /* ignore malformed keep-alive / partial lines */
        }
      }
    }

    // Stream ended without [DONE]. If it never looked like SSE, the server
    // answered non-streamed JSON — salvage the full message from the buffer.
    if (!sawSse && buffer.trim()) {
      try {
        const delta = extractDelta(JSON.parse(buffer.trim()));
        if (delta) emit(delta);
      } catch {
        /* not JSON either — nothing to salvage */
      }
    }
    finishOk();
  })().catch(finishErr);

  return {
    kill: () => {
      try {
        controller.abort();
      } catch {
        /* already settled */
      }
    }
  };
}

// Probe the server's /v1/models — verifies URL + key and returns the model ids
// so the settings page can offer them as suggestions.
async function testConnection({ baseUrl, apiKey }) {
  const base = String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/, "")
    .replace(/\/v1$/, "");
  if (!base) return { ok: false, error: "no server URL" };
  try {
    const res = await net.fetch(`${base}/v1/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      cache: "no-store",
      // Don't let a dead host hang the settings window on its TCP timeout.
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS)
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = await res.json().catch(() => null);
    const models = Array.isArray(json?.data)
      ? json.data.map((m) => m?.id).filter(Boolean).slice(0, 100)
      : [];
    return { ok: true, models };
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      return { ok: false, error: `连接超时（${TEST_TIMEOUT_MS / 1000} 秒）——请确认服务器地址与端口` };
    }
    return { ok: false, error: error?.message || String(error) };
  }
}

module.exports = { startTurn, chatCompletionsUrl, testConnection };
