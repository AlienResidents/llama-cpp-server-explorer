// Shared prompt builder + response parser for the LLM explanation layer.
//
// The prompt asks the LLM for a JSON object with three fields:
//   - explanation: the 3-section markdown body (What it does / When you'd
//     change it / Gotchas) — the same prose we've always rendered.
//   - hardware_impact: array of {type, effect} chips for at-a-glance
//     scannability in the list/detail view. Normalized to canonical enums.
//   - synergy_notes: array of static cross-flag notes (info/warning) shown
//     in the flag's card. Stateless — no selection-state required.
//
// The parser is tolerant: strips markdown fences, finds the outermost JSON
// object, parses, normalizes enums (dropping unknowns), and falls back to
// treating the raw response as the explanation text if anything fails. That
// graceful degradation means a model that returns plain prose instead of
// JSON still produces a usable explanation — just without chips/notes.

import type {
  ExplainInput,
  ExplainMeta,
  ExplainOk,
  ExplainResult,
  HardwareImpact,
  SynergyNote,
} from "./llm-types.js";

// ─── Prompt ─────────────────────────────────────────────────────────────────

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
    "Respond with ONLY a JSON object (no markdown fences, no prose before or",
    "after). The object must have exactly these fields:",
    "",
    '{',
    '  "explanation": string,',
    '  "hardware_impact": [{ "type": string, "effect": string }],',
    '  "synergy_notes": [{ "severity": "info" | "warning", "title": string, "detail": string }]',
    '}',
    "",
    "Field rules:",
    '- "explanation": the markdown body. Write exactly 3 short sections in',
    '  plain Markdown — "**What it does**", "**When you\'d change it**",',
    '  "**Gotchas**" — each as a paragraph or short bullet list. This is what',
    "  the user reads in detail. Don't restate the README description verbatim.",
    '- "hardware_impact": 0-3 chips. `type` is one of: VRAM, RAM, COMPUTE,',
    '  CPU, DISK, NETWORK. `effect` is one of: REDUCTION (uses less of the',
    '  resource), INCREASE (uses more), EXPANSION (allocates/grows a cache or',
    "  pool), ALTERATION (changes the access pattern without a net increase or",
    "  reduction). Omit the array entirely (or return []) if the flag has no",
    "  meaningful hardware impact. Multi-dimensional impacts are fine — e.g.",
    "  Flash Attention returns [{VRAM, REDUCTION}, {COMPUTE, ALTERATION}].",
    '- "synergy_notes": 0-3 notes. `severity` "info" for architectural advice',
    '  or "pairs with" notes; "warning" for footguns or common mistakes.',
    "  `title` is a short label (e.g. \"Pairs with --ngl\"). `detail` is one or",
    "  two sentences of substance. These notes mention OTHER flags the user",
    "  should consider alongside this one. Omit the array (or return []) if",
    "  none apply.",
    "",
    "The flag belongs to " + input.sourceName + " — state its behavior for that",
    "tool directly, don't hedge about which tool you're explaining. If the same",
    "flag means something different in another llama.cpp tool, a one-line note",
    "in Gotchas (inside `explanation`) is fine. If you don't know something with",
    "reasonable confidence, say so in the explanation rather than inventing",
    "detail. Keep it tight.",
  ]
    .filter(Boolean)
    .join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n... [truncated ${s.length - max} chars]`;
}

// ─── Response parser ────────────────────────────────────────────────────────

// Canonical enum synonyms. The LLM may return any of these; we normalize to
// the canonical value on the left. Values not in the map are dropped (so the
// UI never renders an unknown chip — graceful degradation over garbage).
const HARDWARE_TYPE_SYNONYMS: Record<string, string> = {
  VRAM: "VRAM",
  GPU_MEMORY: "VRAM",
  GPU_MEM: "VRAM",
  VIDEO_MEM: "VRAM",
  GPU_MEMORY_MB: "VRAM",
  RAM: "RAM",
  MEMORY: "RAM",
  SYSTEM_MEM: "RAM",
  HOST_MEM: "RAM",
  SYSTEM_MEMORY: "RAM",
  COMPUTE: "COMPUTE",
  GPU_COMPUTE: "COMPUTE",
  GPU: "COMPUTE",
  CPU: "CPU",
  HOST_CPU: "CPU",
  CORES: "CPU",
  CPU_CORES: "CPU",
  DISK: "DISK",
  IO: "DISK",
  STORAGE: "DISK",
  DISK_IO: "DISK",
  NETWORK: "NETWORK",
  NET: "NETWORK",
  NETWORK_IO: "NETWORK",
};

const HARDWARE_EFFECT_SYNONYMS: Record<string, string> = {
  REDUCTION: "REDUCTION",
  REDUCE: "REDUCTION",
  DECREASE: "REDUCTION",
  LOWER: "REDUCTION",
  LESS: "REDUCTION",
  INCREASE: "INCREASE",
  INCREASES: "INCREASE",
  RAISE: "INCREASE",
  HIGHER: "INCREASE",
  MORE: "INCREASE",
  EXPANSION: "EXPANSION",
  EXPAND: "EXPANSION",
  GROW: "EXPANSION",
  GROWS: "EXPANSION",
  ALLOCATE: "EXPANSION",
  ALLOCATES: "EXPANSION",
  LARGER: "EXPANSION",
  ALTERATION: "ALTERATION",
  ALTER: "ALTERATION",
  ALTERS: "ALTERATION",
  CHANGE: "ALTERATION",
  CHANGES: "ALTERATION",
  SHIFT: "ALTERATION",
  SHIFTS: "ALTERATION",
};

// Parse the LLM's raw text response into an ExplainOk with the markdown body
// as `text` and the structured metadata as `meta`. Tolerant of:
//   - clean JSON: {...}
//   - JSON in markdown fences: ```json\n{...}\n```
//   - JSON with leading/trailing prose: "Here's the JSON:\n{...}\nDone."
// On any parse failure, returns { ok: true, text: rawResponse, meta: undefined }
// so the user still sees a (raw) explanation rather than an error. Called by
// each provider's explain() after callXxx() returns successfully; NOT called
// by testConnection() (that returns plain "OK", not JSON).
export function parseExplainResponse(raw: ExplainOk): ExplainResult {
  const jsonText = extractJsonObject(raw.text);
  if (jsonText === null) {
    // Not JSON — treat the raw response as the explanation text. The user
    // sees the prose, just no chips/notes. This is the graceful-degradation
    // path for models that ignore the JSON instruction.
    return { ...raw, meta: undefined };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    // Looked like JSON but didn't parse. Fall back to raw text.
    return { ...raw, meta: undefined };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ...raw, meta: undefined };
  }
  const obj = parsed as Record<string, unknown>;

  // The markdown body. If the LLM put it in `explanation`, use that;
  // otherwise fall back to the raw response so the user sees something.
  const explanation =
    typeof obj.explanation === "string" && obj.explanation.trim().length > 0
      ? obj.explanation
      : raw.text;

  const meta = normalizeMeta(obj);
  return { ok: true, text: explanation, model: raw.model, meta };
}

// Extract the outermost JSON object from a response that may be wrapped in
// markdown fences or surrounded by prose. Returns null if no balanced {
// ... } pair is found.
function extractJsonObject(text: string): string | null {
  // Strip ```json ... ``` or ``` ... ``` fences first.
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

// Normalize the structured fields. Drops unknown enum values and malformed
// entries so the UI never renders garbage. Returns undefined if no valid
// chips or notes were produced (so the caller can omit the field entirely).
function normalizeMeta(obj: Record<string, unknown>): ExplainMeta | undefined {
  const hardware = normalizeHardwareImpact(obj.hardware_impact);
  const notes = normalizeSynergyNotes(obj.synergy_notes);
  if (!hardware && !notes) return undefined;
  return {
    ...(hardware ? { hardware_impact: hardware } : {}),
    ...(notes ? { synergy_notes: notes } : {}),
  };
}

function normalizeHardwareImpact(raw: unknown): HardwareImpact[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: HardwareImpact[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const typeRaw = typeof e.type === "string" ? e.type.toUpperCase().trim() : "";
    const effectRaw = typeof e.effect === "string" ? e.effect.toUpperCase().trim() : "";
    const type = HARDWARE_TYPE_SYNONYMS[typeRaw];
    const effect = HARDWARE_EFFECT_SYNONYMS[effectRaw];
    if (!type || !effect) continue;
    out.push({ type, effect });
  }
  return out.length > 0 ? out : undefined;
}

function normalizeSynergyNotes(raw: unknown): SynergyNote[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: SynergyNote[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const severity =
      e.severity === "info" || e.severity === "warning" ? e.severity : "info";
    const title = typeof e.title === "string" ? e.title.trim() : "";
    const detail = typeof e.detail === "string" ? e.detail.trim() : "";
    if (!title || !detail) continue;
    out.push({ severity, title, detail });
  }
  return out.length > 0 ? out : undefined;
}
