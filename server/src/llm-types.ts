// Shared types for the LLM explanation layer. Provider-agnostic so the
// routes layer can map failure reasons to HTTP statuses without knowing
// which provider produced them.

export type LlmProviderType = "bedrock" | "openai" | "ollama";

// Per-provider config shapes. Stored as JSON in llms.config_json. Each
// provider validates its own config shape; the registry dispatches to the
// right provider based on the `provider` field.

export type BedrockConfig = {
  // Anthropic model on Bedrock. Empty = explanations disabled for this LLM.
  // Either a foundation-model id (e.g. "anthropic.claude-3-5-sonnet-20241022-v2:0")
  // or an inference-profile ARN (e.g. "arn:aws:bedrock:ap-southeast-4:...:inference-profile/...").
  model_id: string;
  region: string;
};

export type OpenAiConfig = {
  // Base URL of the OpenAI-compatible endpoint. For together.ai:
  //   https://api.together.xyz/v1
  // For a local llama.cpp server:
  //   http://localhost:8080/v1
  // For OpenAI itself: https://api.openai.com/v1
  // For Ollama's OpenAI-compat shim: http://localhost:11434/v1
  // For Groq: https://api.groq.com/openai/v1
  // For OpenRouter: https://openrouter.ai/api/v1
  base_url: string;
  // API key. Empty for local servers that don't require auth (llama.cpp,
  // Ollama's OpenAI shim). For hosted providers, set via Settings — stored
  // in plaintext in SQLite, same as bedrock_model_id was before. Acceptable
  // for a local-only dev tool; document the trade-off in the README.
  api_key: string;
  // Model id as the provider expects it in the `model` field of the chat
  // completions request body. Examples:
  //   together.ai:   "zai-org/GLM-5.2"
  //   OpenAI:        "gpt-4o"
  //   llama.cpp:     whatever you passed to --alias or the model filename
  //   Ollama shim:   "llama3.1:8b"
  model: string;
};

export type OllamaConfig = {
  // Base URL of the Ollama server. Default: http://localhost:11434
  base_url: string;
  // Model name as `ollama list` shows it, e.g. "llama3.1:8b", "qwen2.5:14b".
  model: string;
  // keep_alive passed to /api/chat. How long the model stays loaded after
  // the request. Default "5m". Set to "0" to unload immediately, or "-1"
  // to keep loaded forever.
  keep_alive: string;
};

export type LlmConfig = BedrockConfig | OpenAiConfig | OllamaConfig;

export type Llm = {
  id: string;
  name: string;
  provider: LlmProviderType;
  config: LlmConfig;
  is_default: boolean;
};

// ─── Provider interface ─────────────────────────────────────────────────────

export type ExplainInput = {
  flags: string[];
  description: string;
  defaultValue: string | null;
  envVar: string | null;
  sourceBlock: string | null;
};

export type ExplainOk = {
  ok: true;
  // The text returned by the model.
  text: string;
  // A model identifier string for provenance, stored in
  // option_details.explanation_model. For Bedrock: the ARN or model id.
  // For OpenAI-compat: the `model` field echoed back in the response (may
  // differ from the requested model on some providers). For Ollama: the
  // model name.
  model: string;
};

// Provider-agnostic failure reasons. Each provider maps its internal errors
// to these. The routes layer has one STATUS_BY_REASON map that works across
// all providers.
export type ExplainReason =
  | "llm_disabled" // global toggle off in Settings
  | "no_active_llm" // active_llm_id setting empty or points at a missing LLM
  | "llm_not_configured" // provider says config incomplete (missing base_url, model, etc.)
  | "credentials_missing" // provider needs auth that isn't present
  | "provider_unreachable" // network error, DNS, connection refused
  | "provider_timeout"
  | "provider_auth_error" // 401/403 from provider
  | "provider_not_found" // 404 — model not found, endpoint wrong
  | "provider_rate_limited" // 429
  | "provider_bad_request" // 400 — malformed request, invalid model id
  | "provider_server_error" // 5xx from provider
  | "provider_call_failed" // catch-all for anything else
  | "empty_response" // provider returned 2xx but no text content
  | "unsupported_provider"; // provider field has a value with no registered handler

export type ExplainErr = {
  ok: false;
  reason: ExplainReason;
  message: string;
};

export type ExplainResult = ExplainOk | ExplainErr;

// The interface each provider implements. The registry holds a map of
// provider type → instance.
export interface LlmProvider {
  // Returns true if the LLM has the minimum config to attempt a call
  // (e.g. base_url + model filled in for OpenAI-compat). Does NOT check
  // auth — that's discovered at call time and returned as credentials_missing.
  isConfigured(llm: Llm): boolean;

  // Returns true if the runtime environment has whatever auth the provider
  // needs (e.g. AWS env vars for Bedrock). For providers that carry auth in
  // their config (OpenAI-compat api_key, Ollama none), this returns true
  // unless the config is incomplete.
  hasCredentials(llm: Llm): boolean;

  // Human-readable explanation of what's missing, for the UI. Empty string
  // if fully ready.
  missingHint(llm: Llm): string;

  // Make the explanation call. Should never throw — return ExplainErr for all
  // failures. timeoutMs caps the request via AbortController; on expiry the
  // provider returns a provider_timeout reason.
  explain(llm: Llm, input: ExplainInput, timeoutMs: number): Promise<ExplainResult>;

  // Minimal connectivity probe. Sends a tiny prompt with low max_tokens to
  // verify server reachable + auth works + model exists + can generate. Same
  // failure-reason vocabulary as explain(). Should never throw.
  testConnection(llm: Llm, timeoutMs: number): Promise<ExplainResult>;
}
