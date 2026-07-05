// OpenAI-compatible provider — speaks the OpenAI Chat Completions API
// (POST {base_url}/chat/completions). Covers together.ai, OpenAI, Groq,
// OpenRouter, vLLM, and local servers like llama.cpp's server and Ollama's
// OpenAI-compat shim. Uses the global fetch (Node 22+). No new dependencies.
//
// The AbortController on fetch enforces the timeout passed in from the
// registry (which reads llm_timeout_ms from settings). On expiry fetch throws
// an AbortError which we map to provider_timeout.

import type { ExplainInput, ExplainResult, Llm, LlmProvider, OpenAiConfig } from "./llm-types.js";
import { buildPrompt, parseExplainResponse } from "./llm-prompt.js";

export const openAiProvider: LlmProvider = {
  isConfigured(llm) {
    const cfg = llm.config as OpenAiConfig;
    return !!cfg.base_url && !!cfg.model;
  },

  hasCredentials(llm) {
    // Auth is carried in the config (api_key), not the environment. Local
    // servers (llama.cpp, Ollama's OpenAI shim) often don't require a key —
    // empty api_key is a valid state for those, so we return true and let
    // the call fail at the provider if auth is actually required.
    return openAiProvider.isConfigured(llm);
  },

  missingHint(llm) {
    const cfg = llm.config as OpenAiConfig;
    const missing: string[] = [];
    if (!cfg.base_url) missing.push("base_url");
    if (!cfg.model) missing.push("model");
    // api_key intentionally not flagged — empty is valid for no-auth local servers
    return missing.length === 0 ? "" : `Missing: ${missing.join(", ")}`;
  },

  async explain(llm, input: ExplainInput, timeoutMs: number): Promise<ExplainResult> {
    const cfg = llm.config as OpenAiConfig;
    if (!cfg.base_url || !cfg.model) {
      return {
        ok: false,
        reason: "llm_not_configured",
        message: "OpenAI-compatible LLM is missing base_url or model. Set them in Settings → LLMs.",
      };
    }
    const raw = await callOpenAi(llm, buildPrompt(input), cfg.max_tokens || 2048, timeoutMs);
    if (!raw.ok) return raw;
    return parseExplainResponse(raw);
  },

  async testConnection(llm, timeoutMs: number): Promise<ExplainResult> {
    const cfg = llm.config as OpenAiConfig;
    if (!cfg.base_url || !cfg.model) {
      return {
        ok: false,
        reason: "llm_not_configured",
        message: openAiProvider.missingHint(llm),
      };
    }
    return callOpenAi(llm, "Reply with the single word OK.", cfg.max_tokens || 2048, timeoutMs);
  },
};

// Shared call helper used by both explain() and testConnection(). Builds the
// OpenAI chat-completions body, sends it via fetch with an AbortController-
// backed timeout, and classifies failures.
async function callOpenAi(
  llm: Llm,
  prompt: string,
  maxTokens: number,
  timeoutMs: number,
): Promise<ExplainResult> {
  const cfg = llm.config as OpenAiConfig;
  const url = `${cfg.base_url.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;
  const body = {
    model: cfg.model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
    temperature: 0.3,
    stream: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      return classifyHttpError(res.status, await safeReadBody(res), "OpenAI-compatible");
    }
    const parsed = (await res.json()) as {
      choices?: { message?: { content?: string; reasoning?: string } }[];
      model?: string;
      error?: { message?: string };
    };
    if (parsed.error) {
      return {
        ok: false,
        reason: "provider_bad_request",
        message: `Provider returned an error: ${parsed.error.message ?? "unknown"}`,
      };
    }
    const msg = parsed.choices?.[0]?.message;
    const text = msg?.content?.trim() ?? "";
    if (!text) {
      // Log the raw response so the user can see what actually came back.
      // Together.ai's reasoning models (e.g. zai-org/GLM-5.2) put their
      // chain-of-thought in `message.reasoning` and the answer in
      // `message.content`. With a small max_tokens the model spends all
      // tokens on reasoning and never produces content — the 200 response
      // looks successful but there's nothing to show.
      console.warn(`[openai] empty content. reasoning=${!!msg?.reasoning} model=${cfg.model}`);
      if (msg?.reasoning) {
        return {
          ok: false,
          reason: "empty_response",
          message:
            `Provider returned reasoning but no content (model ${cfg.model}). ` +
            `Reasoning models like GLM-5.2 spend tokens on internal reasoning first; ` +
            `increase max_tokens or try a non-reasoning model.`,
        };
      }
      return { ok: false, reason: "empty_response", message: "Provider returned no text content." };
    }
    // Many providers echo the resolved model id back in the `model` field;
    // fall back to the requested model if not present.
    return { ok: true, text, model: parsed.model ?? cfg.model };
  } catch (err) {
    const e = err as Error;
    // Node's fetch throws DOMException with name 'AbortError' when the
    // signal fires. Some versions wrap it as TypeError: fetch failed with
    // cause AbortError — sniff both name and message.
    if (e.name === "AbortError" || /aborted/i.test(e.message)) {
      return {
        ok: false,
        reason: "provider_timeout",
        message: `OpenAI-compatible provider timed out after ${timeoutMs}ms`,
      };
    }
    return classifyFetchError(e, "OpenAI-compatible");
  } finally {
    clearTimeout(timer);
  }
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function classifyHttpError(status: number, body: string, label: string): ExplainResult {
  const trimmed = body.slice(0, 500);
  console.warn(`[openai] ${status}: ${trimmed}`);
  switch (status) {
    case 400:
      return {
        ok: false,
        reason: "provider_bad_request",
        message: `${label} provider rejected the request (400): ${trimmed || "no body"}`,
      };
    case 401:
    case 403:
      return {
        ok: false,
        reason: "provider_auth_error",
        message: `${label} provider auth failed (${status}): ${trimmed || "check api_key"}`,
      };
    case 404:
      return {
        ok: false,
        reason: "provider_not_found",
        message: `${label} provider returned 404: ${trimmed || "check base_url and model"}`,
      };
    case 429:
      return {
        ok: false,
        reason: "provider_rate_limited",
        message: `${label} provider rate-limited (429): ${trimmed || "try again shortly"}`,
      };
    case 500:
    case 502:
    case 503:
    case 504:
      return {
        ok: false,
        reason: "provider_server_error",
        message: `${label} provider server error (${status}): ${trimmed || "try again"}`,
      };
    default:
      return {
        ok: false,
        reason: "provider_call_failed",
        message: `${label} provider returned HTTP ${status}: ${trimmed || "no body"}`,
      };
  }
}

function classifyFetchError(err: Error, label: string): ExplainResult {
  const message = err.message ?? String(err);
  console.warn(`[openai] fetch error: ${message}`);
  // Node's fetch wraps network errors as TypeError: fetch failed with a cause.
  // ECONNREFUSED, ENOTFOUND, EAI_AGAIN come through in the cause or message.
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket hang up/i.test(message)) {
    return {
      ok: false,
      reason: "provider_unreachable",
      message: `${label} provider unreachable: ${message}`,
    };
  }
  if (/timeout|aborted/i.test(message)) {
    return {
      ok: false,
      reason: "provider_timeout",
      message: `${label} provider timed out: ${message}`,
    };
  }
  return {
    ok: false,
    reason: "provider_call_failed",
    message: `${label} provider call failed: ${message}`,
  };
}
