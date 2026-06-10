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
  if (typeof choice.delta?.content === "string") return choice.delta.content;
  // Some servers send non-streamed shapes even with stream:true.
  if (typeof choice.message?.content === "string") return choice.message.content;
  if (typeof choice.text === "string") return choice.text;
  return "";
}

// Start a streaming turn. Calls onDelta(text) per chunk, then exactly one of
// onDone() / onError(error). The returned handle's kill() aborts the request
// (onError fires with an AbortError unless the turn already finished).
function startTurn({ baseUrl, apiKey, model, system, messages, onDelta, onDone, onError }) {
  const url = chatCompletionsUrl(baseUrl);
  const controller = new AbortController();
  let settled = false;
  const finishOk = () => {
    if (!settled) {
      settled = true;
      onDone();
    }
  };
  const finishErr = (error) => {
    if (!settled) {
      settled = true;
      onError(error);
    }
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
    const res = await net.fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify(body)
    });
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
          if (delta) onDelta(delta);
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
        if (delta) onDelta(delta);
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
      cache: "no-store"
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = await res.json().catch(() => null);
    const models = Array.isArray(json?.data)
      ? json.data.map((m) => m?.id).filter(Boolean).slice(0, 100)
      : [];
    return { ok: true, models };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

module.exports = { startTurn, chatCompletionsUrl, testConnection };
