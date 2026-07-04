// Settings — global app-level knobs. Source-specific fields (readme_url,
// arg_cpp_url, github_repo) live in the `sources` table; LLM-specific fields
// (model_id, region, base_url, api_key, model) live in the `llms` table.
// This file holds only settings that aren't tied to a particular source or
// LLM.

import { db } from "./db.js";

export type SettingsShape = {
  cache_ttl_hours: number;
  toast_duration_ms: number;
  active_source_id: string;
  github_issue_search_limit: number;
  enable_llm_explanation: boolean;
  enable_source_code_lookup: boolean;
  enable_issue_lookup: boolean;
  // ID of the LLM used for explanations. Empty = no active LLM (Generate
  // button disabled). Points at a row in the llms table; CRUD lives in
  // llms.ts. LLM-specific config (model id, region, base URL, api key, etc.)
  // is stored on the llms row itself, not here.
  active_llm_id: string;
  // How long to wait for an LLM response before aborting, in milliseconds.
  // Enforced via AbortController on all providers. Local models (llama.cpp,
  // Ollama) may need 2+ minutes on first load (model weights load + inference);
  // hosted providers (Together.ai, OpenAI, Bedrock) usually respond in <30s.
  // The Test Connection button uses a separate, shorter 30s cap so a dead
  // server doesn't hang the UI for the full timeout.
  llm_timeout_ms: number;
};

export const DEFAULT_SETTINGS: SettingsShape = {
  cache_ttl_hours: 24,
  toast_duration_ms: 2000,
  active_source_id: "server",
  github_issue_search_limit: 5,
  enable_llm_explanation: true,
  enable_source_code_lookup: true,
  enable_issue_lookup: true,
  // Empty by default — pick an LLM in Settings → LLMs. The llms.ts seed
  // populates this during v2→v3 migration if the user had a bedrock_model_id
  // configured, so existing setups keep working without a Settings visit.
  active_llm_id: "",
  // 2 minutes — generous for slow local models that need to load weights on
  // first call. Lower this if you only use hosted providers.
  llm_timeout_ms: 120_000,
};

const SETTING_TYPES: Record<keyof SettingsShape, "number" | "string" | "boolean"> = {
  cache_ttl_hours: "number",
  toast_duration_ms: "number",
  active_source_id: "string",
  github_issue_search_limit: "number",
  enable_llm_explanation: "boolean",
  enable_source_code_lookup: "boolean",
  enable_issue_lookup: "boolean",
  active_llm_id: "string",
  llm_timeout_ms: "number",
};

function coerce<K extends keyof SettingsShape>(key: K, raw: string): SettingsShape[K] {
  const t = SETTING_TYPES[key];
  if (t === "number") return Number(raw) as SettingsShape[K];
  if (t === "boolean") return (raw === "true") as SettingsShape[K];
  return raw as SettingsShape[K];
}

function serialize(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

const selectStmt = db.prepare("SELECT key, value FROM settings");
const upsertStmt = db.prepare(
  "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
);
const deleteStmt = db.prepare("DELETE FROM settings WHERE key = ?");

export function getSettings(): SettingsShape {
  const rows = selectStmt.all() as { key: string; value: string }[];
  const out: SettingsShape = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (row.key in SETTING_TYPES) {
      const k = row.key as keyof SettingsShape;
      // @ts-expect-error — runtime-coerced assignment, types match per SETTING_TYPES
      out[k] = coerce(k, row.value);
    }
  }
  return out;
}

export function updateSettings(patch: Partial<SettingsShape>): SettingsShape {
  const now = Date.now();
  const tx = db.transaction((entries: [string, unknown][]) => {
    for (const [k, v] of entries) {
      if (!(k in SETTING_TYPES)) continue;
      upsertStmt.run(k, serialize(v), now);
    }
  });
  tx(Object.entries(patch));
  return getSettings();
}

export function resetSettings(): SettingsShape {
  const tx = db.transaction(() => {
    for (const k of Object.keys(SETTING_TYPES)) deleteStmt.run(k);
  });
  tx();
  return getSettings();
}
