// Settings — global app-level knobs. Source-specific fields (readme_url,
// arg_cpp_url, github_repo) moved to the `sources` table; this file now only
// holds settings that aren't tied to a particular source.

import { db } from "./db.js";

export type SettingsShape = {
  cache_ttl_hours: number;
  toast_duration_ms: number;
  active_source_id: string;
  github_issue_search_limit: number;
  enable_llm_explanation: boolean;
  enable_source_code_lookup: boolean;
  enable_issue_lookup: boolean;
  bedrock_model_id: string;
  bedrock_region: string;
};

export const DEFAULT_SETTINGS: SettingsShape = {
  cache_ttl_hours: 24,
  toast_duration_ms: 2000,
  active_source_id: "server",
  github_issue_search_limit: 5,
  enable_llm_explanation: true,
  enable_source_code_lookup: true,
  enable_issue_lookup: true,
  // Empty by default — set this in the Settings UI to your Bedrock
  // inference-profile ARN (or a foundation-model id) before generating
  // explanations. Leaving it empty disables the LLM path gracefully.
  bedrock_model_id: "",
  bedrock_region: "ap-southeast-4",
};

const SETTING_TYPES: Record<keyof SettingsShape, "number" | "string" | "boolean"> = {
  cache_ttl_hours: "number",
  toast_duration_ms: "number",
  active_source_id: "string",
  github_issue_search_limit: "number",
  enable_llm_explanation: "boolean",
  enable_source_code_lookup: "boolean",
  enable_issue_lookup: "boolean",
  bedrock_model_id: "string",
  bedrock_region: "string",
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
