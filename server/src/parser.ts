// README parser — converts the auto-generated llama.cpp server README
// (markdown tables under `### Section` headers) into structured options.
//
// Row shape, e.g.:
//   | `-cms, --checkpoint-min-step N` | minimum spacing between context checkpoints in tokens (default: 256, 0 = no minimum)<br/>(env: LLAMA_ARG_CHECKPOINT_MIN_SPACING_NT) |

export type ParsedOption = {
  id: string;
  category: string;
  flags: string[];
  argType: string | null;
  description: string;
  defaultValue: string | null;
  envVar: string | null;
  moreInfoUrl: string | null;
  rawRow: string;
  sortOrder: number;
};

const HELP_START = "<!-- HELP_START -->";
const HELP_END = "<!-- HELP_END -->";

export function parseReadme(markdown: string): ParsedOption[] {
  // Restrict to the auto-generated help block if delimiters exist; otherwise
  // parse the whole file (forgiving fallback).
  const start = markdown.indexOf(HELP_START);
  const end = markdown.indexOf(HELP_END);
  const slice = start >= 0 && end > start ? markdown.slice(start, end) : markdown;

  const lines = slice.split(/\r?\n/);
  const out: ParsedOption[] = [];
  let category = "General";
  let inTable = false;
  let sortOrder = 0;
  const seenIds = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    const heading = /^#{2,4}\s+(.+?)\s*$/.exec(trimmed);
    if (heading) {
      category = heading[1] ?? "General";
      inTable = false;
      continue;
    }
    if (/^\|\s*-+\s*\|\s*-+\s*\|/.test(trimmed)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!trimmed.startsWith("|")) {
      inTable = false;
      continue;
    }
    // Header row: `| Argument | Explanation |` — skip
    if (/^\|\s*Argument\s*\|/i.test(trimmed)) continue;

    const cells = splitRow(trimmed);
    if (cells.length < 2) continue;
    const flagCell = cells[0]?.trim() ?? "";
    const descCell = cells[1]?.trim() ?? "";
    if (!flagCell) continue;

    const parsed = parseFlagCell(flagCell);
    if (!parsed) continue;
    const { flags, argType } = parsed;
    if (flags.length === 0) continue;

    const meta = parseDescCell(descCell);

    let id = makeId(flags);
    if (seenIds.has(id)) id = `${id}-${sortOrder}`;
    seenIds.add(id);

    out.push({
      id,
      category,
      flags,
      argType,
      description: meta.description,
      defaultValue: meta.defaultValue,
      envVar: meta.envVar,
      moreInfoUrl: meta.moreInfoUrl,
      rawRow: trimmed,
      sortOrder: sortOrder++,
    });
  }
  return out;
}

function splitRow(row: string): string[] {
  // Trim leading/trailing pipes, then split on unescaped pipes.
  const inner = row.replace(/^\|/, "").replace(/\|\s*$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|"));
}

function parseFlagCell(cell: string): { flags: string[]; argType: string | null } | null {
  // Cell is wrapped in backticks: `-x, --long ARG`
  const m = /`([^`]+)`/.exec(cell);
  const inner = (m?.[1] ?? cell).trim();
  if (!inner.startsWith("-")) return null;
  // Split flags vs trailing argument: flags are the comma-separated `-x` / `--long`
  // tokens at the start; everything else is the arg-type spec.
  const parts = inner.split(/\s+/);
  const flags: string[] = [];
  const rest: string[] = [];
  let mode: "flags" | "rest" = "flags";
  for (const part of parts) {
    if (mode === "flags" && (part.startsWith("-") || /^-?[A-Z0-9_-]+,$/.test(part))) {
      flags.push(part.replace(/,$/, ""));
      // Continue in flag mode if the part ended with comma OR the next part also starts with `-`
      continue;
    }
    mode = "rest";
    rest.push(part);
  }
  // Edge case: flags split apart — re-join any that lost their comma
  const cleanFlags = flags.filter((f) => f.startsWith("-")).map((f) => f.trim());
  return { flags: cleanFlags, argType: rest.length > 0 ? rest.join(" ") : null };
}

function parseDescCell(cell: string): {
  description: string;
  defaultValue: string | null;
  envVar: string | null;
  moreInfoUrl: string | null;
} {
  let description = cell;
  // (env: NAME)
  const envMatch = /\(env:\s*([^)]+)\)/.exec(description);
  const envVar = envMatch ? envMatch[1]!.trim() : null;
  if (envMatch) description = description.replace(envMatch[0], "").trim();

  // [(more info)](url)
  const moreMatch = /\[\(more info\)\]\(([^)]+)\)/.exec(description);
  const moreInfoUrl = moreMatch ? moreMatch[1]!.trim() : null;
  if (moreMatch) description = description.replace(moreMatch[0], "").trim();

  // (default: ...)
  const defMatch = /\(default:\s*([^)]+)\)/.exec(description);
  const defaultValue = defMatch ? defMatch[1]!.trim() : null;

  // Tidy: collapse trailing `<br/>`s and excess whitespace
  description = description.replace(/(<br\s*\/?>)+\s*$/g, "").trim();
  description = description.replace(/\s+<br\s*\/?>/g, "<br/>");

  return { description, defaultValue, envVar, moreInfoUrl };
}

function makeId(flags: string[]): string {
  // Prefer the longest `--long` flag for the id; fall back to the first.
  const longs = flags.filter((f) => f.startsWith("--")).sort((a, b) => b.length - a.length);
  const pick = longs[0] ?? flags[0]!;
  return pick.replace(/^-+/, "").toLowerCase();
}
