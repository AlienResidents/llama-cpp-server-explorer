// Optional Bedrock-backed plain-English explainer. Returns a discriminated
// result so the route layer can translate each failure mode into a
// specific HTTP status + user-facing message instead of a generic 503.

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { getSettings } from "./settings.js";

export type ExplainOk = {
  ok: true;
  explanation: { text: string; model: string };
};

export type ExplainReason =
  | "llm_disabled"
  | "model_id_empty"
  | "aws_credentials_missing"
  | "aws_validation_error"
  | "aws_access_denied"
  | "aws_resource_not_found"
  | "aws_throttling"
  | "aws_call_failed"
  | "empty_response";

export type ExplainErr = {
  ok: false;
  reason: ExplainReason;
  message: string;
};

export type ExplainResult = ExplainOk | ExplainErr;

export async function explainOption(input: {
  flags: string[];
  description: string;
  defaultValue: string | null;
  envVar: string | null;
  sourceBlock: string | null;
}): Promise<ExplainResult> {
  const settings = getSettings();
  if (!settings.enable_llm_explanation) {
    return {
      ok: false,
      reason: "llm_disabled",
      message: "LLM explanations are disabled in Settings.",
    };
  }
  if (!settings.bedrock_model_id) {
    return {
      ok: false,
      reason: "model_id_empty",
      message: "Set bedrock_model_id in Settings (the inference-profile ARN, e.g. arn:aws:bedrock:<region>:<account>:inference-profile/<id>).",
    };
  }

  const credsLikelyPresent =
    !!process.env.AWS_PROFILE ||
    !!process.env.AWS_ACCESS_KEY_ID ||
    !!process.env.AWS_ROLE_ARN ||
    !!process.env.AWS_WEB_IDENTITY_TOKEN_FILE;
  if (!credsLikelyPresent) {
    return {
      ok: false,
      reason: "aws_credentials_missing",
      message:
        "No AWS credentials in the environment. Set AWS_PROFILE / AWS_ACCESS_KEY_ID / AWS_ROLE_ARN before starting the server.",
    };
  }

  const client = new BedrockRuntimeClient({ region: settings.bedrock_region });

  const prompt = buildPrompt(input);
  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  };

  try {
    const cmd = new InvokeModelCommand({
      modelId: settings.bedrock_model_id,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(body),
    });
    const res = await client.send(cmd);
    const decoded = new TextDecoder().decode(res.body);
    const parsed = JSON.parse(decoded) as { content?: { type: string; text?: string }[] };
    const text =
      parsed.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n")
        .trim() ?? "";
    if (!text) {
      return {
        ok: false,
        reason: "empty_response",
        message: "Bedrock returned no text content.",
      };
    }
    return {
      ok: true,
      explanation: { text, model: settings.bedrock_model_id },
    };
  } catch (err) {
    return classifyAwsError(err as { name?: string; message?: string });
  }
}

function classifyAwsError(err: { name?: string; message?: string }): ExplainErr {
  const name = err.name ?? "Error";
  const message = err.message ?? String(err);
  console.warn(`[bedrock] ${name}: ${message}`);
  switch (name) {
    case "ValidationException":
      return {
        ok: false,
        reason: "aws_validation_error",
        message: `Bedrock rejected the request: ${message}. Check that bedrock_model_id is a valid ARN or model id (no leading 'amazon-bedrock/' prefix).`,
      };
    case "AccessDeniedException":
    case "AccessDeniedError":
      return {
        ok: false,
        reason: "aws_access_denied",
        message: `Bedrock access denied: ${message}. Check IAM permissions for bedrock:InvokeModel on the model and the cross-region inference profile.`,
      };
    case "ResourceNotFoundException":
      return {
        ok: false,
        reason: "aws_resource_not_found",
        message: `Bedrock model not found: ${message}. Check the ARN's region and identifier.`,
      };
    case "ThrottlingException":
      return {
        ok: false,
        reason: "aws_throttling",
        message: `Bedrock throttled the request: ${message}. Try again shortly.`,
      };
    default:
      return {
        ok: false,
        reason: "aws_call_failed",
        message: `Bedrock call failed (${name}): ${message}`,
      };
  }
}

function buildPrompt(input: {
  flags: string[];
  description: string;
  defaultValue: string | null;
  envVar: string | null;
  sourceBlock: string | null;
}): string {
  const flagList = input.flags.join(", ");
  const sourceClause = input.sourceBlock
    ? `\nC++ definition (from common/arg.cpp):\n\`\`\`cpp\n${truncate(input.sourceBlock, 1500)}\n\`\`\`\n`
    : "";
  return [
    "You are explaining a single command-line option of the llama.cpp HTTP server",
    "to a developer who has read the README terse description but wants the *why*.",
    "",
    `Flag(s): ${flagList}`,
    `README description: ${input.description}`,
    input.defaultValue ? `Default: ${input.defaultValue}` : "",
    input.envVar ? `Environment variable: ${input.envVar}` : "",
    sourceClause,
    "Write 3 short sections in plain Markdown:",
    "1. **What it does** — one or two sentences explaining the mechanic in plain English.",
    "2. **When you'd change it** — concrete scenarios where the default isn't right.",
    "3. **Gotchas** — interactions, performance trade-offs, or footguns.",
    "",
    "Keep it tight. No hedging. Don't restate the description verbatim. If you don't",
    "know something with reasonable confidence, say so rather than inventing detail.",
  ]
    .filter(Boolean)
    .join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n... [truncated ${s.length - max} chars]`;
}
