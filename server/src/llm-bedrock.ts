// Bedrock provider — Anthropic Claude via the AWS SDK. Keeps the existing
// auth model (AWS SDK credential chain via env vars) and the Anthropic
// request/response body shape. Config carries the model id + region.
//
// The AbortController on the SDK call enforces the timeout passed in from the
// registry (which reads llm_timeout_ms from settings). AWS SDK v3 accepts an
// abortSignal in the per-request options bag passed to client.send().

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { BedrockConfig, ExplainInput, ExplainResult, Llm, LlmProvider } from "./llm-types.js";
import { buildPrompt } from "./llm-prompt.js";

export const bedrockProvider: LlmProvider = {
  isConfigured(llm) {
    const cfg = llm.config as BedrockConfig;
    return !!cfg.model_id && !!cfg.region;
  },

  hasCredentials(llm) {
    // Bedrock auth comes from the environment (AWS_PROFILE / AWS_ACCESS_KEY_ID
    // / AWS_ROLE_ARN / AWS_WEB_IDENTITY_TOKEN_FILE), not from the LLM config.
    // This mirrors the original bedrock.ts credential sniff.
    return (
      !!process.env.AWS_PROFILE ||
      !!process.env.AWS_ACCESS_KEY_ID ||
      !!process.env.AWS_ROLE_ARN ||
      !!process.env.AWS_WEB_IDENTITY_TOKEN_FILE
    );
  },

  missingHint(llm) {
    const cfg = llm.config as BedrockConfig;
    const missing: string[] = [];
    if (!cfg.model_id) missing.push("model_id");
    if (!cfg.region) missing.push("region");
    if (!bedrockProvider.hasCredentials(llm)) {
      missing.push("AWS credentials (AWS_PROFILE / AWS_ACCESS_KEY_ID / AWS_ROLE_ARN)");
    }
    return missing.length === 0 ? "" : `Missing: ${missing.join(", ")}`;
  },

  async explain(llm, input: ExplainInput, timeoutMs: number): Promise<ExplainResult> {
    const cfg = llm.config as BedrockConfig;
    if (!cfg.model_id || !cfg.region) {
      return {
        ok: false,
        reason: "llm_not_configured",
        message: "Bedrock LLM is missing model_id or region. Set them in Settings → LLMs.",
      };
    }
    if (!bedrockProvider.hasCredentials(llm)) {
      return {
        ok: false,
        reason: "credentials_missing",
        message:
          "No AWS credentials in the environment. Set AWS_PROFILE / AWS_ACCESS_KEY_ID / AWS_ROLE_ARN before starting the server.",
      };
    }
    return callBedrock(llm, buildPrompt(input), cfg.max_tokens || 2048, timeoutMs);
  },

  async testConnection(llm, timeoutMs: number): Promise<ExplainResult> {
    const cfg = llm.config as BedrockConfig;
    if (!cfg.model_id || !cfg.region) {
      return {
        ok: false,
        reason: "llm_not_configured",
        message: bedrockProvider.missingHint(llm),
      };
    }
    if (!bedrockProvider.hasCredentials(llm)) {
      return {
        ok: false,
        reason: "credentials_missing",
        message: bedrockProvider.missingHint(llm),
      };
    }
    return callBedrock(llm, "Reply with the single word OK.", cfg.max_tokens || 2048, timeoutMs);
  },
};

// Shared call helper used by both explain() and testConnection(). Builds the
// Anthropic-shaped body, sends it via the AWS SDK with an AbortController-
// backed timeout, and classifies failures into the provider-agnostic reason
// vocabulary.
async function callBedrock(
  llm: Llm,
  prompt: string,
  maxTokens: number,
  timeoutMs: number,
): Promise<ExplainResult> {
  const cfg = llm.config as BedrockConfig;
  const client = new BedrockRuntimeClient({ region: cfg.region });
  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const cmd = new InvokeModelCommand({
      modelId: cfg.model_id,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(body),
    });
    const res = await client.send(cmd, { abortSignal: controller.signal });
    const decoded = new TextDecoder().decode(res.body);
    const parsed = JSON.parse(decoded) as { content?: { type: string; text?: string }[] };
    const text =
      parsed.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n")
        .trim() ?? "";
    if (!text) {
      return { ok: false, reason: "empty_response", message: "Bedrock returned no text content." };
    }
    return { ok: true, text, model: cfg.model_id };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    // AbortController fires — AWS SDK v3 throws with name 'AbortError' or a
    // message containing 'abort'. Check before the general classifier so we
    // return provider_timeout instead of provider_call_failed.
    if (e.name === "AbortError" || /abort/i.test(e.message ?? "")) {
      return {
        ok: false,
        reason: "provider_timeout",
        message: `Bedrock request timed out after ${timeoutMs}ms`,
      };
    }
    return classifyBedrockError(e);
  } finally {
    clearTimeout(timer);
  }
}

function classifyBedrockError(err: { name?: string; message?: string }): ExplainResult {
  const name = err.name ?? "Error";
  const message = err.message ?? String(err);
  console.warn(`[bedrock] ${name}: ${message}`);
  switch (name) {
    case "ValidationException":
      return {
        ok: false,
        reason: "provider_bad_request",
        message: `Bedrock rejected the request: ${message}. Check that model_id is a valid ARN or model id (no leading 'amazon-bedrock/' prefix).`,
      };
    case "AccessDeniedException":
    case "AccessDeniedError":
      return {
        ok: false,
        reason: "provider_auth_error",
        message: `Bedrock access denied: ${message}. Check IAM permissions for bedrock:InvokeModel on the model and the cross-region inference profile.`,
      };
    case "ResourceNotFoundException":
      return {
        ok: false,
        reason: "provider_not_found",
        message: `Bedrock model not found: ${message}. Check the ARN's region and identifier.`,
      };
    case "ThrottlingException":
      return {
        ok: false,
        reason: "provider_rate_limited",
        message: `Bedrock throttled the request: ${message}. Try again shortly.`,
      };
    case "TimeoutException":
    case "RequestTimeoutException":
      return {
        ok: false,
        reason: "provider_timeout",
        message: `Bedrock request timed out: ${message}`,
      };
    default:
      // Network-level failures (ECONNREFUSED, ENOTFOUND, etc.) bubble up as
      // generic errors with a `name` like `NetworkingError` or `Error`. AWS
      // SDK v3 doesn't consistently tag these, so we sniff the message.
      if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(message)) {
        return {
          ok: false,
          reason: "provider_unreachable",
          message: `Bedrock unreachable: ${message}`,
        };
      }
      return {
        ok: false,
        reason: "provider_call_failed",
        message: `Bedrock call failed (${name}): ${message}`,
      };
  }
}
