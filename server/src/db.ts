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
// Bump CURRENT_SCHEMA_VERSION whenever the schema below changes in a way that's
// incompatible with on-disk data. The migration here is intentionally crude:
// if the on-disk version doesn't match, we drop + recreate. This is fine
// because every cached row is regeneratable from upstream — we lose at most a
// few seconds of refetch time, never user input. (Settings live in their own
// table that survives the wipe.)

const CURRENT_SCHEMA_VERSION = 2;

const onDiskVersion = (db.pragma("user_version", { simple: true }) as number) ?? 0;

if (onDiskVersion !== 0 && onDiskVersion !== CURRENT_SCHEMA_VERSION) {
  console.log(
    `[db] schema version ${onDiskVersion} -> ${CURRENT_SCHEMA_VERSION}; rebuilding cache tables`,
  );
  db.exec(`
    DROP TABLE IF EXISTS option_details;
    DROP TABLE IF EXISTS options;
    DROP TABLE IF EXISTS cache_meta;
    DROP TABLE IF EXISTS sources;
  `);
}

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
    PRIMARY KEY (source_id, option_id),
    FOREIGN KEY (source_id, option_id)
      REFERENCES options(source_id, id) ON DELETE CASCADE
  );
`);

db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
