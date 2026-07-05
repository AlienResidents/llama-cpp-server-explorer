// LLM registry — first-class entity for "thing that generates explanations".
// Mirrors the sources.ts pattern: module-level seed on first run, CRUD
// functions, is_default flag. Each LLM has a provider type that selects how
// its config is interpreted and which provider implementation handles the
// call. The dispatcher (explainWith) routes to the registered provider.
//
// v2 → v3 data migration: when the llms table is empty AND the old
// bedrock_model_id / bedrock_region settings keys exist, the seed reads them,
// writes them into a default Bedrock LLM row, sets active_llm_id to point at
// it, and deletes the old settings keys. This preserves any configured
// Bedrock model across the upgrade. On a fresh install (no old keys), the
// seed creates defaults with empty auth/model — same UX as today.

import { db } from "./db.js";
import { getSettings, updateSettings } from "./settings.js";
import { bedrockProvider } from "./llm-bedrock.js";
import { openAiProvider } from "./llm-openai.js";
import { ollamaProvider } from "./llm-ollama.js";
import type {
  ExplainInput,
  ExplainResult,
  Llm,
  LlmConfig,
  LlmProvider,
  LlmProviderType,
} from "./llm-types.js";

export type { Llm, LlmConfig, LlmProviderType, LlmProvider, ExplainInput, ExplainResult } from "./llm-types.js";

// ─── Provider registry ──────────────────────────────────────────────────────

const PROVIDERS: Record<LlmProviderType, LlmProvider> = {
  bedrock: bedrockProvider,
  openai: openAiProvider,
  ollama: ollamaProvider,
};

export function providerFor(type: LlmProviderType): LlmProvider | undefined {
  return PROVIDERS[type];
}

// ─── Default LLMs ───────────────────────────────────────────────────────────
//
// Three defaults, one per shipped provider. Each ships with sensible base
// URLs but empty auth/model — the user fills those in via Settings → LLMs.
// Users can add custom LLMs (e.g. a second OpenAI-compatible pointing at a
// local llama.cpp server) via the same UI.

const DEFAULT_LLMS: Omit<Llm, "is_default">[] = [
  {
    id: "bedrock-default",
    name: "AWS Bedrock (Claude)",
    provider: "bedrock",
    config: { model_id: "", region: "ap-southeast-4", max_tokens: 2048 },
  },
  {
    id: "openai-together",
    name: "Together.ai (OpenAI-compatible)",
    provider: "openai",
    config: { base_url: "https://api.together.xyz/v1", api_key: "", model: "zai-org/GLM-5.2", max_tokens: 2048 },
  },
  {
    id: "ollama-default",
    name: "Ollama (native /api/chat)",
    provider: "ollama",
    config: { base_url: "http://localhost:11434", model: "", keep_alive: "5m", max_tokens: 2048 },
  },
];

// ─── CRUD ───────────────────────────────────────────────────────────────────

const selectAll = db.prepare(
  "SELECT id, name, provider, config_json, is_default, created_at FROM llms ORDER BY created_at ASC",
);
const selectById = db.prepare(
  "SELECT id, name, provider, config_json, is_default, created_at FROM llms WHERE id = ?",
);
const insertStmt = db.prepare(
  "INSERT INTO llms (id, name, provider, config_json, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?)",
);
const updateStmt = db.prepare(
  "UPDATE llms SET name = ?, provider = ?, config_json = ? WHERE id = ?",
);
const deleteStmt = db.prepare("DELETE FROM llms WHERE id = ? AND is_default = 0");

type Row = Omit<Llm, "is_default" | "config"> & { is_default: number; config_json: string };

function rowToLlm(row: Row): Llm {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider as LlmProviderType,
    config: JSON.parse(row.config_json) as LlmConfig,
    is_default: row.is_default === 1,
  };
}

// ─── Seeding + v2→v3 migration ──────────────────────────────────────────────
//
// Runs at module load, mirroring sources.ts. On a fresh DB (llms table
// empty, no old bedrock settings), seeds the three defaults with empty
// auth/model. On a v2→v3 upgrade (llms table empty, old bedrock settings
// present), seeds the defaults but writes the old bedrock_model_id /
// bedrock_region into the Bedrock default and sets active_llm_id to it,
// then deletes the old settings keys so they don't linger as orphans.

const existing = selectAll.all() as Row[];
if (existing.length === 0) {
  // Read old bedrock settings if present (v2→v3 upgrade path).
  const oldModelId = readSettingRaw("bedrock_model_id");
  const oldRegion = readSettingRaw("bedrock_region") || "ap-southeast-4";

  const defaultsToSeed = DEFAULT_LLMS.map((l) => {
    if (l.provider === "bedrock" && oldModelId) {
      return { ...l, config: { ...l.config, model_id: oldModelId, region: oldRegion } };
    }
    return l;
  });

  const now = Date.now();
  const tx = db.transaction(() => {
    for (const l of defaultsToSeed) {
      insertStmt.run(l.id, l.name, l.provider, JSON.stringify(l.config), 1, now);
    }
    // If we migrated a real bedrock_model_id, point active_llm_id at it so the
    // user's existing setup keeps working without a Settings visit. Otherwise
    // leave active_llm_id empty (user picks on first Settings visit).
    if (oldModelId) {
      upsertSettingRaw("active_llm_id", "bedrock-default");
    }
    // Clean up the old keys either way — they no longer belong in SettingsShape.
    if (oldModelId || db.prepare("SELECT 1 FROM settings WHERE key = 'bedrock_region'").get()) {
      db.prepare("DELETE FROM settings WHERE key IN ('bedrock_model_id', 'bedrock_region')").run();
    }
  });
  tx();

  if (oldModelId) {
    console.log(
      `[llms] v2→v3 migration: moved bedrock_model_id into the bedrock-default LLM and set it active`,
    );
  }
}

function readSettingRaw(key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function upsertSettingRaw(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value, Date.now());
}

// ─── CRUD public API ────────────────────────────────────────────────────────

export function listLlms(): Llm[] {
  return (selectAll.all() as Row[]).map(rowToLlm);
}

export function getLlm(id: string): Llm | null {
  const row = selectById.get(id) as Row | undefined;
  return row ? rowToLlm(row) : null;
}

export function createLlm(input: Omit<Llm, "is_default">): Llm {
  insertStmt.run(
    input.id,
    input.name,
    input.provider,
    JSON.stringify(input.config),
    0,
    Date.now(),
  );
  return getLlm(input.id)!;
}

export function updateLlm(id: string, patch: Partial<Omit<Llm, "id" | "is_default">>): Llm {
  const current = getLlm(id);
  if (!current) throw new Error(`llm not found: ${id}`);
  const next: Llm = {
    ...current,
    ...patch,
    id: current.id,
    is_default: current.is_default,
  };
  updateStmt.run(next.name, next.provider, JSON.stringify(next.config), id);
  return getLlm(id)!;
}

export function deleteLlm(id: string): boolean {
  // If we're deleting the active LLM, fall back to the first remaining one so
  // we don't leave active_llm_id pointing at nothing. Mirrors the source
  // deletion logic in routes.ts.
  const settings = getSettings();
  if (settings.active_llm_id === id) {
    const remaining = listLlms().filter((l) => l.id !== id);
    updateSettings({ active_llm_id: remaining[0]?.id ?? "" });
  }
  const result = deleteStmt.run(id);
  return result.changes > 0;
}

// ─── Active LLM resolution ──────────────────────────────────────────────────

export function getActiveLlm(): Llm | null {
  const id = getSettings().active_llm_id;
  if (!id) return null;
  return getLlm(id);
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

export async function explainWith(
  llm: Llm | null,
  input: ExplainInput,
): Promise<ExplainResult> {
  if (!llm) {
    return {
      ok: false,
      reason: "no_active_llm",
      message: "No active LLM. Pick one in Settings → LLMs.",
    };
  }
  const provider = PROVIDERS[llm.provider];
  if (!provider) {
    return {
      ok: false,
      reason: "unsupported_provider",
      message: `Unknown provider type: ${llm.provider}`,
    };
  }
  const timeoutMs = getSettings().llm_timeout_ms;
  return provider.explain(llm, input, timeoutMs);
}

// ─── Test connection dispatcher ─────────────────────────────────────────────
//
// Used by the POST /api/llms/:id/test route. Sends a minimal prompt to verify
// the LLM is reachable + authed + can generate. Uses a shorter timeout than
// explain() so a dead server doesn't hang the UI — capped at 30s regardless
// of the llm_timeout_ms setting (a test that takes >30s on a tiny prompt is
// a failure worth knowing about quickly).

export async function testLlm(llm: Llm | null, timeoutMs = 30_000): Promise<ExplainResult> {
  if (!llm) {
    return {
      ok: false,
      reason: "no_active_llm",
      message: "LLM not found.",
    };
  }
  const provider = PROVIDERS[llm.provider];
  if (!provider) {
    return {
      ok: false,
      reason: "unsupported_provider",
      message: `Unknown provider type: ${llm.provider}`,
    };
  }
  return provider.testConnection(llm, timeoutMs);
}

// ─── Availability for the UI ──────────────────────────────────────────────
//
// The client uses this to decide whether to enable the Generate button.
// Returns 'ready' | 'missing-credentials' | 'not-configured' | 'no-active-llm'.

export type LlmAvailability =
  | { status: "ready"; llm: Llm }
  | { status: "missing-credentials"; llm: Llm; hint: string }
  | { status: "not-configured"; llm: Llm; hint: string }
  | { status: "no-active-llm" };

export function activeLlmAvailability(): LlmAvailability {
  const llm = getActiveLlm();
  if (!llm) return { status: "no-active-llm" };
  const provider = PROVIDERS[llm.provider];
  if (!provider) return { status: "not-configured", llm, hint: `Unknown provider: ${llm.provider}` };
  if (!provider.isConfigured(llm)) {
    return { status: "not-configured", llm, hint: provider.missingHint(llm) };
  }
  if (!provider.hasCredentials(llm)) {
    return { status: "missing-credentials", llm, hint: provider.missingHint(llm) };
  }
  return { status: "ready", llm };
}
