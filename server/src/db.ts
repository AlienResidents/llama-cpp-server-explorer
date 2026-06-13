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

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cache_meta (
    key TEXT PRIMARY KEY,
    sha TEXT,
    fetched_at INTEGER NOT NULL,
    raw TEXT
  );

  CREATE TABLE IF NOT EXISTS options (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    flags TEXT NOT NULL,
    arg_type TEXT,
    description TEXT NOT NULL,
    default_value TEXT,
    env_var TEXT,
    more_info_url TEXT,
    raw_row TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    sort_order INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS options_category_idx ON options(category, sort_order);

  CREATE TABLE IF NOT EXISTS option_details (
    option_id TEXT PRIMARY KEY,
    source_block TEXT,
    source_url TEXT,
    source_fetched_at INTEGER,
    issues_json TEXT,
    issues_fetched_at INTEGER,
    explanation TEXT,
    explanation_model TEXT,
    explanation_fetched_at INTEGER,
    FOREIGN KEY (option_id) REFERENCES options(id) ON DELETE CASCADE
  );
`);
