import { Hono } from "hono";
import { db } from "./db.js";
import { parseReadme } from "./parser.js";
import {
  fetchArgCpp,
  fetchReadme,
  findArgBlock,
  searchIssues,
  type IssueRef,
} from "./upstream.js";
import {
  DEFAULT_SETTINGS,
  getSettings,
  resetSettings,
  updateSettings,
  type SettingsShape,
} from "./settings.js";
import {
  createSource,
  deleteSource,
  getSource,
  listSources,
  updateSource,
  type ParserType,
  type Source,
} from "./sources.js";
import { explainOption } from "./bedrock.js";

export const api = new Hono();

// ─── Cache helpers ──────────────────────────────────────────────────────────

type CacheStatus = "cold" | "fresh" | "stale" | "updated";
type CacheMeta = { age_ms: number | null; status: CacheStatus; was_refreshed: boolean };

function ttlMs(): number {
  return getSettings().cache_ttl_hours * 3600_000;
}

function isStale(fetchedAt: number | null | undefined): boolean {
  if (!fetchedAt) return true;
  return Date.now() - fetchedAt > ttlMs();
}

function ageMs(fetchedAt: number | null | undefined): number | null {
  if (!fetchedAt) return null;
  return Date.now() - fetchedAt;
}

function requireSource(sourceId: string): Source | null {
  return getSource(sourceId);
}

// ─── Settings routes ────────────────────────────────────────────────────────

api.get("/settings", (c) => {
  return c.json({ settings: getSettings(), defaults: DEFAULT_SETTINGS });
});

api.put("/settings", async (c) => {
  const body = (await c.req.json()) as Partial<SettingsShape>;
  const settings = updateSettings(body);
  return c.json({ settings, defaults: DEFAULT_SETTINGS });
});

api.post("/settings/reset", (c) => {
  return c.json({ settings: resetSettings(), defaults: DEFAULT_SETTINGS });
});

// ─── Sources CRUD ──────────────────────────────────────────────────────────

api.get("/sources", (c) => {
  return c.json({ sources: listSources() });
});

api.post("/sources", async (c) => {
  const body = (await c.req.json()) as {
    id: string;
    name: string;
    readme_url: string;
    arg_cpp_url: string | null;
    github_repo: string;
    parser: ParserType;
  };
  if (getSource(body.id)) return c.json({ error: "id already exists" }, 409);
  const created = createSource(body);
  return c.json({ source: created }, 201);
});

api.put("/sources/:id", async (c) => {
  const id = c.req.param("id");
  const existing = getSource(id);
  if (!existing) return c.json({ error: "source not found" }, 404);
  const patch = (await c.req.json()) as Partial<Omit<Source, "id" | "is_default">>;
  const updated = updateSource(id, patch);
  return c.json({ source: updated });
});

api.delete("/sources/:id", (c) => {
  const id = c.req.param("id");
  const existing = getSource(id);
  if (!existing) return c.json({ error: "source not found" }, 404);
  if (existing.is_default) return c.json({ error: "cannot delete default source" }, 400);
  // If the source we're deleting is the active one, fall back to the first
  // remaining source so we don't leave the app pointing at nothing.
  const settings = getSettings();
  if (settings.active_source_id === id) {
    const remaining = listSources().filter((s) => s.id !== id);
    if (remaining.length > 0) {
      updateSettings({ active_source_id: remaining[0]!.id });
    }
  }
  // Cascade-delete cached options + details for that source.
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM option_details WHERE source_id = ?").run(id);
    db.prepare("DELETE FROM options WHERE source_id = ?").run(id);
    db.prepare("DELETE FROM cache_meta WHERE source_id = ?").run(id);
    deleteSource(id);
  });
  tx();
  return c.json({ ok: true });
});

// ─── Meta route — used by the client on boot ────────────────────────────────

api.get("/meta", (c) => {
  const settings = getSettings();
  const sources = listSources();
  const bedrockAvailable =
    !!process.env.AWS_PROFILE ||
    !!process.env.AWS_ACCESS_KEY_ID ||
    !!process.env.AWS_ROLE_ARN ||
    !!process.env.AWS_WEB_IDENTITY_TOKEN_FILE;
  return c.json({
    settings,
    defaults: DEFAULT_SETTINGS,
    sources,
    bedrock_available: bedrockAvailable,
  });
});

// ─── Per-source options ─────────────────────────────────────────────────────

const insertOption = db.prepare(`
  INSERT INTO options (source_id, id, category, flags, arg_type, description,
                       default_value, env_var, more_info_url, raw_row,
                       fetched_at, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, id) DO UPDATE SET
    category = excluded.category,
    flags = excluded.flags,
    arg_type = excluded.arg_type,
    description = excluded.description,
    default_value = excluded.default_value,
    env_var = excluded.env_var,
    more_info_url = excluded.more_info_url,
    raw_row = excluded.raw_row,
    fetched_at = excluded.fetched_at,
    sort_order = excluded.sort_order
`);

const upsertCacheMeta = db.prepare(`
  INSERT INTO cache_meta (source_id, key, sha, fetched_at, raw)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET
    sha = excluded.sha, fetched_at = excluded.fetched_at, raw = excluded.raw
`);

const getCacheMeta = db.prepare(
  "SELECT sha, fetched_at, raw FROM cache_meta WHERE source_id = ? AND key = ?",
) as unknown as {
  get: (sourceId: string, k: string) => { sha: string; fetched_at: number; raw: string } | undefined;
};

async function refreshOptions(source: Source): Promise<{ count: number; changed: boolean }> {
  const fetched = await fetchReadme(source);
  const prev = getCacheMeta.get(source.id, "readme");
  const changed = !prev || prev.sha !== fetched.sha;
  const parsed = parseReadme(fetched.raw, source.parser);
  const now = Date.now();

  const tx = db.transaction(() => {
    if (changed) {
      db.prepare("DELETE FROM options WHERE source_id = ?").run(source.id);
    }
    for (const opt of parsed) {
      insertOption.run(
        source.id,
        opt.id,
        opt.category,
        JSON.stringify(opt.flags),
        opt.argType,
        opt.description,
        opt.defaultValue,
        opt.envVar,
        opt.moreInfoUrl,
        opt.rawRow,
        now,
        opt.sortOrder,
      );
    }
    upsertCacheMeta.run(source.id, "readme", fetched.sha, now, fetched.raw);
  });
  tx();
  return { count: parsed.length, changed };
}

const listOptionsStmt = db.prepare(`
  SELECT id, category, flags, arg_type as argType, description,
         default_value as defaultValue, env_var as envVar,
         more_info_url as moreInfoUrl, fetched_at as fetchedAt
  FROM options WHERE source_id = ?
  ORDER BY sort_order ASC
`);

type OptionRow = {
  id: string;
  category: string;
  flags: string;
  argType: string | null;
  description: string;
  defaultValue: string | null;
  envVar: string | null;
  moreInfoUrl: string | null;
  fetchedAt: number;
};

function rowToOption(row: OptionRow) {
  return { ...row, flags: JSON.parse(row.flags) as string[] };
}

api.get("/sources/:sourceId/options", async (c) => {
  const source = requireSource(c.req.param("sourceId"));
  if (!source) return c.json({ error: "source not found" }, 404);
  const force = c.req.query("force") === "1";
  const meta = getCacheMeta.get(source.id, "readme");
  const status: CacheStatus = !meta ? "cold" : isStale(meta.fetched_at) ? "stale" : "fresh";
  let was_refreshed = false;

  if (force || !meta || isStale(meta.fetched_at)) {
    try {
      await refreshOptions(source);
      was_refreshed = true;
    } catch (err) {
      console.warn("[options] refresh failed:", (err as Error).message);
      if (!meta) throw err;
    }
  }

  const rows = listOptionsStmt.all(source.id) as OptionRow[];
  const data = rows.map(rowToOption);
  const fetchedAt = getCacheMeta.get(source.id, "readme")?.fetched_at ?? null;
  const cache: CacheMeta = {
    age_ms: ageMs(fetchedAt),
    status: was_refreshed && status !== "fresh" ? "updated" : status,
    was_refreshed,
  };
  return c.json({ data, cache });
});

// ─── Per-source option detail ──────────────────────────────────────────────

const getOption = db.prepare(`
  SELECT id, category, flags, arg_type as argType, description,
         default_value as defaultValue, env_var as envVar,
         more_info_url as moreInfoUrl, fetched_at as fetchedAt
  FROM options WHERE source_id = ? AND id = ?
`);

const getDetail = db.prepare(`
  SELECT source_block as sourceBlock, source_url as sourceUrl,
         source_fetched_at as sourceFetchedAt,
         issues_json as issuesJson, issues_fetched_at as issuesFetchedAt,
         explanation, explanation_model as explanationModel,
         explanation_fetched_at as explanationFetchedAt
  FROM option_details WHERE source_id = ? AND option_id = ?
`);

const upsertDetailSource = db.prepare(`
  INSERT INTO option_details (source_id, option_id, source_block, source_url, source_fetched_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(source_id, option_id) DO UPDATE SET
    source_block = excluded.source_block,
    source_url = excluded.source_url,
    source_fetched_at = excluded.source_fetched_at
`);

const upsertDetailIssues = db.prepare(`
  INSERT INTO option_details (source_id, option_id, issues_json, issues_fetched_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(source_id, option_id) DO UPDATE SET
    issues_json = excluded.issues_json,
    issues_fetched_at = excluded.issues_fetched_at
`);

const upsertDetailExplanation = db.prepare(`
  INSERT INTO option_details (source_id, option_id, explanation, explanation_model, explanation_fetched_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(source_id, option_id) DO UPDATE SET
    explanation = excluded.explanation,
    explanation_model = excluded.explanation_model,
    explanation_fetched_at = excluded.explanation_fetched_at
`);

type DetailRow = {
  sourceBlock: string | null;
  sourceUrl: string | null;
  sourceFetchedAt: number | null;
  issuesJson: string | null;
  issuesFetchedAt: number | null;
  explanation: string | null;
  explanationModel: string | null;
  explanationFetchedAt: number | null;
};

async function refreshSourceFor(source: Source, opt: { id: string; flags: string[] }): Promise<void> {
  const settings = getSettings();
  if (!settings.enable_source_code_lookup) return;
  if (!source.arg_cpp_url) return; // Source declares no C++ definition file.
  const src = await fetchArgCpp(source);
  if (!src) return;
  const found = findArgBlock(src.raw, opt.flags, src.url);
  upsertDetailSource.run(source.id, opt.id, found.block, found.url, Date.now());
}

async function refreshIssuesFor(source: Source, opt: { id: string; flags: string[] }): Promise<void> {
  const settings = getSettings();
  if (!settings.enable_issue_lookup) return;
  const issues = await searchIssues(source, opt.flags);
  upsertDetailIssues.run(source.id, opt.id, JSON.stringify(issues), Date.now());
}

api.get("/sources/:sourceId/options/:id", async (c) => {
  const source = requireSource(c.req.param("sourceId"));
  if (!source) return c.json({ error: "source not found" }, 404);
  const id = c.req.param("id");
  const force = c.req.query("force") === "1";
  const optRow = getOption.get(source.id, id) as OptionRow | undefined;
  if (!optRow) return c.json({ error: "option not found" }, 404);
  const opt = rowToOption(optRow);

  let detail = (getDetail.get(source.id, id) as DetailRow | undefined) ?? null;
  let was_refreshed = false;
  const initialStatus: CacheStatus = !detail
    ? "cold"
    : isStale(detail.sourceFetchedAt) || isStale(detail.issuesFetchedAt)
      ? "stale"
      : "fresh";

  const tasks: Promise<unknown>[] = [];
  if (force || !detail || isStale(detail.sourceFetchedAt)) {
    tasks.push(refreshSourceFor(source, opt).catch((e) => console.warn("[detail] source:", e.message)));
  }
  if (force || !detail || isStale(detail.issuesFetchedAt)) {
    tasks.push(refreshIssuesFor(source, opt).catch((e) => console.warn("[detail] issues:", e.message)));
  }
  if (tasks.length > 0) {
    await Promise.all(tasks);
    was_refreshed = true;
    detail = (getDetail.get(source.id, id) as DetailRow | undefined) ?? null;
  }

  const issues: IssueRef[] = detail?.issuesJson
    ? (JSON.parse(detail.issuesJson) as IssueRef[])
    : [];

  const oldestFetch = Math.min(
    detail?.sourceFetchedAt ?? Date.now(),
    detail?.issuesFetchedAt ?? Date.now(),
  );

  return c.json({
    data: {
      option: opt,
      source: detail
        ? {
            block: detail.sourceBlock,
            url: detail.sourceUrl,
            fetched_at: detail.sourceFetchedAt,
          }
        : null,
      issues,
      issues_fetched_at: detail?.issuesFetchedAt ?? null,
      explanation: detail?.explanation
        ? {
            text: detail.explanation,
            model: detail.explanationModel,
            fetched_at: detail.explanationFetchedAt,
          }
        : null,
    },
    cache: {
      age_ms: ageMs(oldestFetch),
      status:
        was_refreshed && initialStatus !== "fresh" ? ("updated" as CacheStatus) : initialStatus,
      was_refreshed,
    } satisfies CacheMeta,
  });
});

api.post("/sources/:sourceId/options/:id/refresh", async (c) => {
  const source = requireSource(c.req.param("sourceId"));
  if (!source) return c.json({ error: "source not found" }, 404);
  const id = c.req.param("id");
  const optRow = getOption.get(source.id, id) as OptionRow | undefined;
  if (!optRow) return c.json({ error: "option not found" }, 404);
  const opt = rowToOption(optRow);
  await Promise.all([
    refreshSourceFor(source, opt).catch((e) => console.warn("[refresh] source:", e.message)),
    refreshIssuesFor(source, opt).catch((e) => console.warn("[refresh] issues:", e.message)),
  ]);
  return c.json({ ok: true });
});

api.post("/sources/:sourceId/options/:id/explain", async (c) => {
  const source = requireSource(c.req.param("sourceId"));
  if (!source) return c.json({ error: "source not found" }, 404);
  const id = c.req.param("id");
  const optRow = getOption.get(source.id, id) as OptionRow | undefined;
  if (!optRow) return c.json({ error: "option not found" }, 404);
  const opt = rowToOption(optRow);
  const detail = getDetail.get(source.id, id) as DetailRow | undefined;

  const result = await explainOption({
    flags: opt.flags,
    description: opt.description,
    defaultValue: opt.defaultValue,
    envVar: opt.envVar,
    sourceBlock: detail?.sourceBlock ?? null,
  });

  if (!result) {
    return c.json(
      { error: "explanation unavailable (LLM disabled, AWS creds missing, or model id empty)" },
      503,
    );
  }

  upsertDetailExplanation.run(source.id, id, result.text, result.model, Date.now());
  return c.json({
    explanation: { text: result.text, model: result.model, fetched_at: Date.now() },
  });
});
