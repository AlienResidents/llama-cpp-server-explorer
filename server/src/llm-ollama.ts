// Ollama native provider — talks to Ollama's /api/chat endpoint (not the
// OpenAI-compat shim). Exposes keep_alive, which the OpenAI shim doesn't.
// No auth; config carries the base URL + model name + keep_alive.
//
// The AbortController on fetch enforces the timeout passed in from the
// registry (which reads llm_timeout_ms from settings). On expiry fetch throws
// an AbortError which we map to provider_timeout.

import type { ExplainInput, ExplainResult, Llm, LlmProvider, OllamaConfig } from "./llm-types.js";
import { buildPrompt } from "./llm-prompt.js";

export const ollamaProvider: LlmProvider = {
  isConfigured(llm) {
    const cfg = llm.config as OllamaConfig;
    return !!cfg.base_url && !!cfg.model;
  },

  hasCredentials(llm) {
    // Ollama has no auth by default. If the user has put Ollama behind a
    // proxy that requires auth, they should use the OpenAI-compatible
    // provider instead. We treat any configured Ollama LLM as credentialed.
    return ollamaProvider.isConfigured(llm);
  },

  missingHint(llm) {
    const cfg = llm.config as OllamaConfig;
    const missing: string[] = [];
    if (!cfg.base_url) missing.push("base_url");
    if (!cfg.model) missing.push("model");
    return missing.length === 0 ? "" : `Missing: ${missing.join(", ")}`;
  },

  async explain(llm, input: ExplainInput, timeoutMs: number): Promise<ExplainResult> {
    const cfg = llm.config as OllamaConfig;
    if (!cfg.base_url || !cfg.model) {
      return {
        ok: false,
        reason: "llm_not_configured",
        message: "Ollama LLM is missing base_url or model. Set them in Settings → LLMs.",
      };
    }
    return callOllama(llm, buildPrompt(input), cfg.max_tokens || 2048, timeoutMs);
  },

  async testConnection(llm, timeoutMs: number): Promise<ExplainResult> {
    const cfg = llm.config as OllamaConfig;
    if (!cfg.base_url || !cfg.model) {
      return {
        ok: false,
        reason: "llm_not_configured",
        message: ollamaProvider.missingHint(llm),
      };
    }
    return callOllama(llm, "Reply with the single word OK.", cfg.max_tokens || 2048, timeoutMs);
  },
};

// Shared call helper used by both explain() and testConnection(). Builds the
// Ollama /api/chat body, sends it via fetch with an AbortController-backed
// timeout, and classifies failures.
async function callOllama(
  llm: Llm,
  prompt: string,
  maxTokens: number,
  timeoutMs: number,
): Promise<ExplainResult> {
  const cfg = llm.config as OllamaConfig;
  const url = `${cfg.base_url.replace(/\/+$/, "")}/api/chat`;
  const body = {
    model: cfg.model,
    messages: [{ role: "user", content: prompt }],
    stream: false,
    options: { temperature: 0.3, num_predict: maxTokens },
    keep_alive: cfg.keep_alive || "5m",
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      return classifyHttpError(res.status, await safeReadBody(res));
    }
    const parsed = (await res.json()) as {
      message?: { content?: string };
      model?: string;
      error?: string;
    };
    if (parsed.error) {
      return {
        ok: false,
        reason: "provider_bad_request",
        message: `Ollama returned an error: ${parsed.error}`,
      };
    }
    const text = parsed.message?.content?.trim() ?? "";
    if (!text) {
      return { ok: false, reason: "empty_response", message: "Ollama returned no text content." };
    }
    return { ok: true, text, model: parsed.model ?? cfg.model };
  } catch (err) {
    const e = err as Error;
    if (e.name === "AbortError" || /aborted/i.test(e.message)) {
      return {
        ok: false,
        reason: "provider_timeout",
        message: `Ollama timed out after ${timeoutMs}ms`,
      };
    }
    return classifyFetchError(e);
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

function classifyHttpError(status: number, body: string): ExplainResult {
  const trimmed = body.slice(0, 500);
  console.warn(`[ollama] ${status}: ${trimmed}`);
  switch (status) {
    case 400:
      return {
        ok: false,
        reason: "provider_bad_request",
        message: `Ollama rejected the request (400): ${trimmed || "check model name"}`,
      };
    case 404:
      return {
        ok: false,
        reason: "provider_not_found",
        message: `Ollama returned 404: ${trimmed || "check base_url (should be http://localhost:11434, no /api suffix)"}`,
      };
    case 429:
      return {
        ok: false,
        reason: "provider_rate_limited",
        message: `Ollama rate-limited (429): ${trimmed || "try again shortly"}`,
      };
    case 500:
    case 502:
    case 503:
    case 504:
      return {
        ok: false,
        reason: "provider_server_error",
        message: `Ollama server error (${status}): ${trimmed || "check ollama serve"}`,
      };
    default:
      return {
        ok: false,
        reason: "provider_call_failed",
        message: `Ollama returned HTTP ${status}: ${trimmed || "no body"}`,
      };
  }
}

function classifyFetchError(err: Error): ExplainResult {
  const message = err.message ?? String(err);
  console.warn(`[ollama] fetch error: ${message}`);
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket hang up/i.test(message)) {
    return {
      ok: false,
      reason: "provider_unreachable",
      message: `Ollama unreachable: ${message}. Is 'ollama serve' running?`,
    };
  }
  if (/timeout|aborted/i.test(message)) {
    return {
      ok: false,
      reason: "provider_timeout",
      message: `Ollama timed out: ${message}`,
    };
  }
  return {
    ok: false,
    reason: "provider_call_failed",
    message: `Ollama call failed: ${message}`,
  };
}
