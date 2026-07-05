// Shared prompt builder for the LLM explanation layer. All providers use
// the same prompt so the output shape is consistent regardless of which
// LLM generated it. Extracted from the original bedrock.ts.

import type { ExplainInput } from "./llm-types.js";

export function buildPrompt(input: ExplainInput): string {
  const flagList = input.flags.join(", ");
  const sourceClause = input.sourceBlock
    ? `\nC++ definition (from common/arg.cpp):\n\`\`\`cpp\n${truncate(input.sourceBlock, 1500)}\n\`\`\`\n`
    : "";
  return [
    `You are explaining a single command-line option of ${input.sourceName} (from ${input.sourceRepo})`,
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
    "Keep it tight. Don't restate the description verbatim. The flag belongs to",
    `${input.sourceName} — state its behavior for that tool directly, don't hedge`,
    "about which tool you're explaining. If the same flag means something different",
    "in another llama.cpp tool, a one-line note in Gotchas is fine. If you don't",
    "know something with reasonable confidence, say so rather than inventing detail.",
  ]
    .filter(Boolean)
    .join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n... [truncated ${s.length - max} chars]`;
}
