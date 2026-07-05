import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? resolve(__dirname, "../../data/explorer.db");

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ─── Schema versioning ──────────────────────────────────────────────────────
//
// Migrations are versioned and additive from v2 onward. Each step is
// idempotent (safe to re-run) and gated on the on-disk `user_version`.
//
// v1 → v2 is the one destructive step: cache tables (option_details, options,
// cache_meta, sources) are dropped and rebuilt from upstream. That's fine
// because every cached row is regeneratable — we lose at most a refetch, never
// user input. Settings live in their own EAV table that survives.
//
// v2 → v3 is additive only and MUST NOT drop option_details: the
// `explanation` column holds user-generated LLM blurbs that are expensive to
// regenerate and expected to survive an upgrade. This step creates the new
// `llms` table and adds `explanation_llm_id` to `option_details` via ALTER
// (existing rows get NULL, which the UI treats as "pre-multi-LLM"). The
// data migration of old `bedrock_model_id` / `bedrock_region` settings into a
// seeded default Bedrock LLM row is handled by `llms.ts` on first load.
//
// v3 → v4 adds `max_tokens` to each LLM's config_json. The `llms` table
// schema itself is unchanged (config is a JSON blob), but existing configs
// don't have the field. The migration iterates all llms rows, parses
// config_json, adds max_tokens: 2048 if missing, writes back. Idempotent —
// rows that already have max_tokens are skipped.

const CURRENT_SCHEMA_VERSION = 4;

const onDiskVersion = (db.pragma("user_version", { simple: true }) as number) ?? 0;

// v1 → v2: rebuild cache tables from upstream. Settings table is preserved
// (EAV, no schema change between v1 and v2). Only fires for someone upgrading
// from v1; anyone already on v2+ skips this. This is the only destructive step.
if (onDiskVersion > 0 && onDiskVersion < 2) {
  console.log(`[db] migrating v1 → v2: rebuilding cache tables`);
  db.exec(`
    DROP TABLE IF EXISTS option_details;
    DROP TABLE IF EXISTS options;
    DROP TABLE IF EXISTS cache_meta;
    DROP TABLE IF EXISTS sources;
  `);
}

// All versions: ensure base tables exist. CREATE TABLE IF NOT EXISTS makes
// this safe on both fresh installs (v0) and upgrades.
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    readme_url TEXT NOT NULL,
    arg_cpp_url TEXT,
    github_repo TEXT NOT NULL,
    parser TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cache_meta (
    source_id TEXT NOT NULL,
    key TEXT NOT NULL,
    sha TEXT,
    fetched_at INTEGER NOT NULL,
    raw TEXT,
    PRIMARY KEY (source_id, key)
  );

  CREATE TABLE IF NOT EXISTS options (
    source_id TEXT NOT NULL,
    id TEXT NOT NULL,
    category TEXT NOT NULL,
    flags TEXT NOT NULL,
    arg_type TEXT,
    description TEXT NOT NULL,
    default_value TEXT,
    env_var TEXT,
    more_info_url TEXT,
    raw_row TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (source_id, id)
  );

  CREATE INDEX IF NOT EXISTS options_category_idx
    ON options(source_id, category, sort_order);

  CREATE TABLE IF NOT EXISTS option_details (
    source_id TEXT NOT NULL,
    option_id TEXT NOT NULL,
    source_block TEXT,
    source_url TEXT,
    source_fetched_at INTEGER,
    issues_json TEXT,
    issues_fetched_at INTEGER,
    explanation TEXT,
    explanation_model TEXT,
    explanation_fetched_at INTEGER,
    explanation_llm_id TEXT,
    PRIMARY KEY (source_id, option_id),
    FOREIGN KEY (source_id, option_id)
      REFERENCES options(source_id, id) ON DELETE CASCADE
  );

  -- v3: LLM registry. Each row is a configured LLM (Bedrock, OpenAI-compat,
  -- Ollama, ...). Mirrors the sources table shape. Seeded by llms.ts on first
  -- load; users CRUD via Settings → LLMs tab.
  CREATE TABLE IF NOT EXISTS llms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    config_json TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`);

// v2 → v3: add explanation_llm_id to option_details so the UI can show
// "Generated via <llm name>" by joining back to the llms table. Additive —
// existing rows get NULL, which the UI treats as "pre-multi-LLM (model id
// only)". Gated on the column not existing yet so it's idempotent. On a
// fresh install the CREATE TABLE above already includes the column so this
// ALTER is a no-op; on a v2→v3 upgrade it adds the column in place without
// touching the existing explanation data.
const optionDetailsCols = db.pragma("table_info(option_details)") as Array<{ name: string }>;
const hasLlmIdCol = optionDetailsCols.some((c) => c.name === "explanation_llm_id");
if (!hasLlmIdCol) {
  console.log(`[db] migrating v2 → v3: adding option_details.explanation_llm_id`);
  db.exec(`ALTER TABLE option_details ADD COLUMN explanation_llm_id TEXT`);
}

// v3 → v4: add max_tokens to each LLM's config_json. The llms table schema
// doesn't change (config is a JSON blob); only the content of config_json
// gains a field. Iterates all rows, parses config_json, adds max_tokens: 2048
// if missing, writes back. Idempotent — rows that already have max_tokens are
// skipped, so re-importing or running twice is a no-op. On a fresh install
// the llms table is empty (seeded by llms.ts with max_tokens already set) so
// this loop does nothing.
const llmsRows = db.prepare("SELECT id, config_json FROM llms").all() as Array<{
  id: string;
  config_json: string;
}>;
let migratedCount = 0;
for (const row of llmsRows) {
  const cfg = JSON.parse(row.config_json) as Record<string, unknown>;
  if (cfg.max_tokens === undefined) {
    cfg.max_tokens = 2048;
    db.prepare("UPDATE llms SET config_json = ? WHERE id = ?").run(
      JSON.stringify(cfg),
      row.id,
    );
    migratedCount++;
  }
}
if (migratedCount > 0) {
  console.log(
    `[db] migrating v3 → v4: added max_tokens to ${migratedCount} LLM config(s)`,
  );
}

db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
