// Optional Bedrock-backed plain-English explainer. Gracefully no-ops if
// AWS credentials aren't available — the rest of the app keeps working.

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { getSettings } from "./settings.js";

export type Explanation = { text: string; model: string };

export async function explainOption(input: {
  flags: string[];
  description: string;
  defaultValue: string | null;
  envVar: string | null;
  sourceBlock: string | null;
}): Promise<Explanation | null> {
  const settings = getSettings();
  if (!settings.enable_llm_explanation) return null;
  if (!settings.bedrock_model_id) {
    console.warn("[bedrock] explain skipped: bedrock_model_id is empty (set it in Settings)");
    return null;
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
    if (!text) return null;
    return { text, model: settings.bedrock_model_id };
  } catch (err) {
    console.warn("[bedrock] explain failed:", (err as Error).message);
    return null;
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
