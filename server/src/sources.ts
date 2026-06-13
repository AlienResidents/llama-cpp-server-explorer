// Source registry — first-class entity for "thing whose CLI options we explore".
// Each source has a parser type that selects how its README is read. Defaults
// (server, llama-bench) are seeded on first run; users can edit, add, or remove
// via Settings.

import { db } from "./db.js";

export type ParserType = "server-readme-table" | "llama-bench-usage-block";

export type Source = {
  id: string;
  name: string;
  readme_url: string;
  arg_cpp_url: string | null;
  github_repo: string;
  parser: ParserType;
  is_default: boolean;
};

export const DEFAULT_SOURCES: Omit<Source, "is_default">[] = [
  {
    id: "server",
    name: "llama.cpp server",
    readme_url:
      "https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md",
    arg_cpp_url:
      "https://raw.githubusercontent.com/ggml-org/llama.cpp/master/common/arg.cpp",
    github_repo: "ggml-org/llama.cpp",
    parser: "server-readme-table",
  },
  {
    id: "llama-bench",
    name: "llama-bench",
    readme_url:
      "https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/llama-bench/README.md",
    // llama-bench parses argv inline in its own .cpp; no add_opt anchor.
    arg_cpp_url: null,
    github_repo: "ggml-org/llama.cpp",
    parser: "llama-bench-usage-block",
  },
];

const selectAll = db.prepare(
  "SELECT id, name, readme_url, arg_cpp_url, github_repo, parser, is_default FROM sources ORDER BY created_at ASC",
);
const selectById = db.prepare(
  "SELECT id, name, readme_url, arg_cpp_url, github_repo, parser, is_default FROM sources WHERE id = ?",
);
const insertStmt = db.prepare(
  "INSERT INTO sources (id, name, readme_url, arg_cpp_url, github_repo, parser, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
);
const updateStmt = db.prepare(
  "UPDATE sources SET name = ?, readme_url = ?, arg_cpp_url = ?, github_repo = ?, parser = ? WHERE id = ?",
);
const deleteStmt = db.prepare("DELETE FROM sources WHERE id = ? AND is_default = 0");

type Row = Omit<Source, "is_default"> & { is_default: number };

function rowToSource(row: Row): Source {
  return { ...row, is_default: row.is_default === 1 };
}

// Seed defaults on first run.
const existing = selectAll.all() as Row[];
if (existing.length === 0) {
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const s of DEFAULT_SOURCES) {
      insertStmt.run(
        s.id,
        s.name,
        s.readme_url,
        s.arg_cpp_url,
        s.github_repo,
        s.parser,
        1,
        now,
      );
    }
  });
  tx();
}

export function listSources(): Source[] {
  return (selectAll.all() as Row[]).map(rowToSource);
}

export function getSource(id: string): Source | null {
  const row = selectById.get(id) as Row | undefined;
  return row ? rowToSource(row) : null;
}

export function createSource(input: Omit<Source, "is_default">): Source {
  insertStmt.run(
    input.id,
    input.name,
    input.readme_url,
    input.arg_cpp_url,
    input.github_repo,
    input.parser,
    0,
    Date.now(),
  );
  return getSource(input.id)!;
}

export function updateSource(id: string, patch: Partial<Omit<Source, "id" | "is_default">>): Source {
  const current = getSource(id);
  if (!current) throw new Error(`source not found: ${id}`);
  const next: Source = {
    ...current,
    ...patch,
    id: current.id,
    is_default: current.is_default,
  };
  updateStmt.run(
    next.name,
    next.readme_url,
    next.arg_cpp_url,
    next.github_repo,
    next.parser,
    id,
  );
  return getSource(id)!;
}

export function deleteSource(id: string): boolean {
  const result = deleteStmt.run(id);
  return result.changes > 0;
}
