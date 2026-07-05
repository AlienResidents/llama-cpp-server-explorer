// Schema migration tests.
//
// These tests guard the non-destructive v2→v3 and v3→v4 migration paths —
// the ones that move bedrock_model_id / bedrock_region settings into the
// bedrock-default LLM row, seed the three default LLMs, set active_llm_id,
// preserve pre-existing explanations, and add max_tokens to each LLM's
// config_json. They also cover the fresh-install path (v0→v4) and idempotency
// (re-running on a v4 DB is a no-op).
//
// Each test creates a temp DB, sets DB_PATH to point at it, then dynamically
// imports db.ts + llms.ts fresh (via vi.resetModules) to re-trigger the
// module-load migration. The DB handle is closed in afterEach to avoid
// leaking better-sqlite3 handles across tests.

import { describe, it, expect, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Test helpers ──────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

// Creates a v2-schema DB at the given path. Optionally seeds it with old
// bedrock settings and a pre-existing explanation, so we can verify the
// v2→v3 migration moves them correctly.
//
// The v2 option_details table does NOT have explanation_llm_id — that column
// is added by the v2→v3 ALTER TABLE in db.ts. The v2 schema also has no llms
// table.
function createV2Db(
  dbPath: string,
  opts: {
    bedrockModelId?: string;
    bedrockRegion?: string;
    hasExplanation?: boolean;
  } = {},
): void {
  const db = new Database(dbPath);
  db.pragma("user_version = 2");

  // v2 schema — no llms table, no explanation_llm_id column.
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      readme_url TEXT NOT NULL,
      arg_cpp_url TEXT,
      github_repo TEXT NOT NULL,
      parser TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE cache_meta (
      source_id TEXT NOT NULL,
      key TEXT NOT NULL,
      sha TEXT,
      fetched_at INTEGER NOT NULL,
      raw TEXT,
      PRIMARY KEY (source_id, key)
    );
    CREATE TABLE options (
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
    CREATE TABLE option_details (
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

  // Seed old bedrock settings (the keys the v2→v3 migration reads + moves).
  if (opts.bedrockModelId !== undefined) {
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
    ).run("bedrock_model_id", opts.bedrockModelId, 0);
  }
  if (opts.bedrockRegion !== undefined) {
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
    ).run("bedrock_region", opts.bedrockRegion, 0);
  }

  // Seed a source + option + pre-existing explanation so we can verify
  // the migration preserves it.
  if (opts.hasExplanation) {
    db.prepare(
      "INSERT INTO sources (id, name, readme_url, github_repo, parser, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("server", "llama.cpp server", "https://example.com/readme", "ggml-org/llama.cpp", "server-readme-table", 1, 0);
    db.prepare(
      "INSERT INTO options (source_id, id, category, flags, description, raw_row, fetched_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("server", "threads", "performance", "-t", "number of threads", "raw", 0, 0);
    db.prepare(
      "INSERT INTO option_details (source_id, option_id, explanation, explanation_model, explanation_fetched_at) VALUES (?, ?, ?, ?, ?)",
    ).run("server", "threads", "This is a pre-existing explanation.", "anthropic.claude-3-opus", 1000);
  }

  db.close();
}

// Migrates from a v2 DB: creates the v2 fixture, then imports db.ts + llms.ts
// fresh so the module-load migration runs. Returns the open db handle + the
// llms module for assertions.
async function migrateFromV2(opts: {
  bedrockModelId?: string;
  bedrockRegion?: string;
  hasExplanation?: boolean;
} = {}): Promise<{
  db: Database.Database;
  llms: typeof import("../llms.js");
  settings: typeof import("../settings.js");
  dbPath: string;
}> {
  const tmpDir = mkdtempSync(join(tmpdir(), "llama-migration-test-"));
  tmpDirs.push(tmpDir);
  const dbPath = join(tmpDir, "test.db");

  createV2Db(dbPath, opts);

  // Set DB_PATH before importing so db.ts opens our temp DB, not the real one.
  process.env.DB_PATH = dbPath;
  vi.resetModules();
  const dbMod = await import("../db.js");
  const llmsMod = await import("../llms.js");
  const settingsMod = await import("../settings.js");

  return {
    db: dbMod.db,
    llms: llmsMod,
    settings: settingsMod,
    dbPath,
  };
}

// Fresh install (v0 → v3): no existing DB, migration creates everything from
// scratch. Returns the open db handle + modules.
async function freshInstall(): Promise<{
  db: Database.Database;
  llms: typeof import("../llms.js");
  settings: typeof import("../settings.js");
}> {
  const tmpDir = mkdtempSync(join(tmpdir(), "llama-fresh-test-"));
  tmpDirs.push(tmpDir);
  const dbPath = join(tmpDir, "test.db");

  process.env.DB_PATH = dbPath;
  vi.resetModules();
  const dbMod = await import("../db.js");
  const llmsMod = await import("../llms.js");
  const settingsMod = await import("../settings.js");

  return { db: dbMod.db, llms: llmsMod, settings: settingsMod };
}

afterEach(() => {
  // Clean up temp dirs. The DB handles are closed by GC / process exit;
  // better-sqlite3 handles in the module cache are replaced by the next
  // test's vi.resetModules() + fresh import.
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.resetModules();
  delete process.env.DB_PATH;
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("fresh install (v0 → v4)", () => {
  it("creates the llms table and seeds 3 default LLMs", async () => {
    const { llms } = await freshInstall();
    const all = llms.listLlms();
    expect(all).toHaveLength(3);

    const ids = all.map((l) => l.id).sort();
    expect(ids).toEqual(["bedrock-default", "ollama-default", "openai-together"]);

    // All defaults have is_default = true.
    expect(all.every((l) => l.is_default)).toBe(true);
  });

  it("leaves active_llm_id empty on fresh install", async () => {
    const { settings } = await freshInstall();
    expect(settings.getSettings().active_llm_id).toBe("");
  });

  it("seeds the together.ai LLM with the GLM-5.2 model id", async () => {
    const { llms } = await freshInstall();
    const together = llms.getLlm("openai-together");
    expect(together).toBeDefined();
    expect(together!.provider).toBe("openai");
    // The config shape is validated by the type system; here we just check
    // the model field is what the README claims.
    const cfg = together!.config as { model: string; max_tokens: number };
    expect(cfg.model).toBe("zai-org/GLM-5.2");
    // v4: all seeded LLMs get max_tokens: 2048.
    expect(cfg.max_tokens).toBe(2048);
  });

  it("seeds all 3 default LLMs with max_tokens: 2048", async () => {
    const { llms } = await freshInstall();
    for (const l of llms.listLlms()) {
      const cfg = l.config as { max_tokens: number };
      expect(cfg.max_tokens).toBe(2048);
    }
  });

  it("sets the schema version to 4", async () => {
    const { db } = await freshInstall();
    const version = db.pragma("user_version", { simple: true }) as number;
    expect(version).toBe(4);
  });
});

describe("v2 → v4 migration", () => {
  it("moves bedrock_model_id + bedrock_region into the bedrock-default LLM", async () => {
    const { llms, db } = await migrateFromV2({
      bedrockModelId: "anthropic.claude-3-opus-20240229-v1:0",
      bedrockRegion: "us-east-1",
    });

    const bedrock = llms.getLlm("bedrock-default");
    expect(bedrock).toBeDefined();
    const cfg = bedrock!.config as { model_id: string; region: string };
    expect(cfg.model_id).toBe("anthropic.claude-3-opus-20240229-v1:0");
    expect(cfg.region).toBe("us-east-1");

    // Old settings keys are deleted.
    const oldModelId = db.prepare("SELECT 1 FROM settings WHERE key = 'bedrock_model_id'").get();
    const oldRegion = db.prepare("SELECT 1 FROM settings WHERE key = 'bedrock_region'").get();
    expect(oldModelId).toBeUndefined();
    expect(oldRegion).toBeUndefined();
  });

  it("sets active_llm_id to bedrock-default when bedrock_model_id was set", async () => {
    const { settings } = await migrateFromV2({
      bedrockModelId: "anthropic.claude-3-opus-20240229-v1:0",
    });
    expect(settings.getSettings().active_llm_id).toBe("bedrock-default");
  });

  it("leaves active_llm_id empty when no bedrock_model_id was set", async () => {
    // If the user had bedrock_region but no model_id, we don't auto-activate
    // — the LLM isn't usable without a model id.
    const { settings } = await migrateFromV2({
      bedrockRegion: "ap-southeast-2",
    });
    expect(settings.getSettings().active_llm_id).toBe("");
  });

  it("still deletes bedrock_region even without bedrock_model_id", async () => {
    const { db } = await migrateFromV2({
      bedrockRegion: "ap-southeast-2",
    });
    const oldRegion = db.prepare("SELECT 1 FROM settings WHERE key = 'bedrock_region'").get();
    expect(oldRegion).toBeUndefined();
  });

  it("preserves pre-existing explanations with NULL explanation_llm_id", async () => {
    const { db } = await migrateFromV2({
      bedrockModelId: "anthropic.claude-3-opus-20240229-v1:0",
      hasExplanation: true,
    });

    // The explanation row should still exist.
    const row = db
      .prepare("SELECT explanation, explanation_model, explanation_llm_id FROM option_details WHERE source_id = ? AND option_id = ?")
      .get("server", "threads") as {
      explanation: string | null;
      explanation_model: string | null;
      explanation_llm_id: string | null;
    };

    expect(row?.explanation).toBe("This is a pre-existing explanation.");
    expect(row?.explanation_model).toBe("anthropic.claude-3-opus");
    // The new column is NULL for pre-migration rows — the UI shows the raw
    // model id instead of an LLM name for these.
    expect(row?.explanation_llm_id).toBeNull();
  });

  it("adds the explanation_llm_id column to option_details", async () => {
    const { db } = await migrateFromV2({ hasExplanation: true });
    const cols = db.prepare("PRAGMA table_info(option_details)").all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("explanation_llm_id");
  });

  it("creates the llms table with the expected columns", async () => {
    const { db } = await migrateFromV2();
    const cols = db.prepare("PRAGMA table_info(llms)").all() as { name: string; type: string }[];
    const colMap = Object.fromEntries(cols.map((c) => [c.name, c.type]));
    expect(colMap).toEqual(
      expect.objectContaining({
        id: "TEXT",
        name: "TEXT",
        provider: "TEXT",
        config_json: "TEXT",
        is_default: "INTEGER",
        created_at: "INTEGER",
      }),
    );
  });

  it("seeds all 3 default LLMs even when migrating from v2", async () => {
    const { llms } = await migrateFromV2({
      bedrockModelId: "anthropic.claude-3-opus-20240229-v1:0",
    });
    const all = llms.listLlms();
    expect(all).toHaveLength(3);
    expect(all.map((l) => l.id).sort()).toEqual([
      "bedrock-default",
      "ollama-default",
      "openai-together",
    ]);
  });

  it("sets the schema version to 4", async () => {
    const { db } = await migrateFromV2({
      bedrockModelId: "anthropic.claude-3-opus-20240229-v1:0",
    });
    const version = db.pragma("user_version", { simple: true }) as number;
    expect(version).toBe(4);
  });
});

describe("idempotency", () => {
  it("re-importing db.ts + llms.ts on an already-migrated DB is a no-op", async () => {
    // First migration: v2 → v3.
    const { db, dbPath } = await migrateFromV2({
      bedrockModelId: "anthropic.claude-3-opus-20240229-v1:0",
      hasExplanation: true,
    });
    const llmsBefore = db.prepare("SELECT COUNT(*) as n FROM llms").get() as { n: number };
    const settingsBefore = db.prepare("SELECT COUNT(*) as n FROM settings").get() as { n: number };
    db.close();

    // Second load: DB_PATH still points at the same file, modules reset.
    vi.resetModules();
    const dbMod2 = await import("../db.js");
    await import("../llms.js");

    const db2 = dbMod2.db;
    const llmsAfter = db2.prepare("SELECT COUNT(*) as n FROM llms").get() as { n: number };
    const settingsAfter = db2.prepare("SELECT COUNT(*) as n FROM settings").get() as { n: number };

    // No duplicate LLMs, no extra settings.
    expect(llmsAfter.n).toBe(llmsBefore.n);
    expect(settingsAfter.n).toBe(settingsBefore.n);

    // Schema version is 4.
    const version = db2.pragma("user_version", { simple: true }) as number;
    expect(version).toBe(4);

    // The explanation is still there.
    const row = db2
      .prepare("SELECT explanation FROM option_details WHERE source_id = ? AND option_id = ?")
      .get("server", "threads") as { explanation: string | null };
    expect(row?.explanation).toBe("This is a pre-existing explanation.");
  });
});

// ─── v3 → v4 migration ─────────────────────────────────────────────────────
//
// v3→v4 adds max_tokens to each LLM's config_json. The llms table schema is
// unchanged (config is a JSON blob); only the content gains a field. These
// tests simulate a pre-v4 DB by seeding LLMs with config_json that lacks
// max_tokens, then re-importing db.ts to run the migration.

describe("v3 → v4 migration", () => {
  // Helper: creates a v3 DB with 3 LLMs whose config_json has NO max_tokens
  // field (simulating a pre-v4 install), then re-imports db.ts + llms.ts to
  // run the v3→v4 migration. Returns the open db handle + llms module.
  async function migrateFromV3(): Promise<{
    db: Database.Database;
    llms: typeof import("../llms.js");
  }> {
    // Start from a v2→v4 migration (seeds 3 LLMs with max_tokens).
    const { db, dbPath } = await migrateFromV2({
      bedrockModelId: "anthropic.claude-3-opus-20240229-v1:0",
      bedrockRegion: "us-east-1",
    });

    // Strip max_tokens from every LLM's config_json to simulate a pre-v4 DB.
    const rows = db.prepare("SELECT id, config_json FROM llms").all() as Array<{
      id: string;
      config_json: string;
    }>;
    for (const row of rows) {
      const cfg = JSON.parse(row.config_json) as Record<string, unknown>;
      delete cfg.max_tokens;
      db.prepare("UPDATE llms SET config_json = ? WHERE id = ?").run(
        JSON.stringify(cfg),
        row.id,
      );
    }

    // Set schema version back to 3 so the v3→v4 step has work to do.
    db.pragma("user_version = 3");
    db.close();

    // Re-import to run the migration.
    process.env.DB_PATH = dbPath;
    vi.resetModules();
    const dbMod = await import("../db.js");
    const llmsMod = await import("../llms.js");
    return { db: dbMod.db, llms: llmsMod };
  }

  it("adds max_tokens: 2048 to every LLM config that lacks it", async () => {
    const { llms } = await migrateFromV3();
    for (const l of llms.listLlms()) {
      const cfg = l.config as { max_tokens: number };
      expect(cfg.max_tokens).toBe(2048);
    }
  });

  it("preserves the other config fields (model_id, region, model, etc.)", async () => {
    const { llms } = await migrateFromV3();
    const bedrock = llms.getLlm("bedrock-default");
    expect(bedrock).toBeDefined();
    const cfg = bedrock!.config as { model_id: string; region: string; max_tokens: number };
    expect(cfg.model_id).toBe("anthropic.claude-3-opus-20240229-v1:0");
    expect(cfg.region).toBe("us-east-1");
    expect(cfg.max_tokens).toBe(2048);
  });

  it("is idempotent — running twice does not double-add or overwrite", async () => {
    const { db } = await migrateFromV3();
    // Capture the config_json after the first migration.
    const before = db
      .prepare("SELECT config_json FROM llms WHERE id = ?")
      .get("openai-together") as { config_json: string };
    db.close();

    // Re-import a second time.
    vi.resetModules();
    const dbMod2 = await import("../db.js");
    const llmsMod2 = await import("../llms.js");
    const db2 = dbMod2.db;
    const after = db2
      .prepare("SELECT config_json FROM llms WHERE id = ?")
      .get("openai-together") as { config_json: string };
    expect(after.config_json).toBe(before.config_json);

    // The LLM still has max_tokens: 2048.
    const together = llmsMod2.getLlm("openai-together");
    const cfg = together!.config as { max_tokens: number };
    expect(cfg.max_tokens).toBe(2048);
  });
});
