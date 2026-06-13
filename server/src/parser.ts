// README parsers. Two variants:
//
//   server-readme-table       — markdown tables under `### Section` headers.
//                               Used for tools/server/README.md.
//   llama-bench-usage-block   — fenced-code-block usage listing under
//                               `## Syntax`, with `options:` and
//                               `test parameters:` sub-sections inside the
//                               block. Used for tools/llama-bench/README.md.
//
// Both produce ParsedOption[] in the same shape so the rest of the app stays
// parser-agnostic.

import type { ParserType } from "./sources.js";

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

export function parseReadme(markdown: string, parser: ParserType): ParsedOption[] {
  switch (parser) {
    case "server-readme-table":
      return parseServerReadmeTable(markdown);
    case "llama-bench-usage-block":
      return parseLlamaBenchUsageBlock(markdown);
    default:
      throw new Error(`unknown parser: ${parser as string}`);
  }
}

// ─── Parser: server README table format ────────────────────────────────────

const HELP_START = "<!-- HELP_START -->";
const HELP_END = "<!-- HELP_END -->";

function parseServerReadmeTable(markdown: string): ParsedOption[] {
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
    if (/^\|\s*Argument\s*\|/i.test(trimmed)) continue;

    const cells = splitTableRow(trimmed);
    if (cells.length < 2) continue;
    const flagCell = cells[0]?.trim() ?? "";
    const descCell = cells[1]?.trim() ?? "";
    if (!flagCell) continue;

    const parsed = parseFlagCell(flagCell);
    if (!parsed) continue;
    const { flags, argType } = parsed;
    if (flags.length === 0) continue;

    const meta = parseDescCell(descCell);

    const id = uniqueId(makeId(flags), seenIds, sortOrder);
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

function splitTableRow(row: string): string[] {
  const inner = row.replace(/^\|/, "").replace(/\|\s*$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|"));
}

function parseFlagCell(cell: string): { flags: string[]; argType: string | null } | null {
  const m = /`([^`]+)`/.exec(cell);
  const inner = (m?.[1] ?? cell).trim();
  if (!inner.startsWith("-")) return null;
  const parts = inner.split(/\s+/);
  const flags: string[] = [];
  const rest: string[] = [];
  let mode: "flags" | "rest" = "flags";
  for (const part of parts) {
    if (mode === "flags" && (part.startsWith("-") || /^-?[A-Z0-9_-]+,$/.test(part))) {
      flags.push(part.replace(/,$/, ""));
      continue;
    }
    mode = "rest";
    rest.push(part);
  }
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
  const envMatch = /\(env:\s*([^)]+)\)/.exec(description);
  const envVar = envMatch ? envMatch[1]!.trim() : null;
  if (envMatch) description = description.replace(envMatch[0], "").trim();

  const moreMatch = /\[\(more info\)\]\(([^)]+)\)/.exec(description);
  const moreInfoUrl = moreMatch ? moreMatch[1]!.trim() : null;
  if (moreMatch) description = description.replace(moreMatch[0], "").trim();

  const defMatch = /\(default:\s*([^)]+)\)/.exec(description);
  const defaultValue = defMatch ? defMatch[1]!.trim() : null;

  description = description.replace(/(<br\s*\/?>)+\s*$/g, "").trim();
  description = description.replace(/\s+<br\s*\/?>/g, "<br/>");
  return { description, defaultValue, envVar, moreInfoUrl };
}

// ─── Parser: llama-bench usage-block format ────────────────────────────────
//
// Source structure inside the README:
//
//   ## Syntax
//
//   ```
//   usage: llama-bench [options]
//
//   options:
//     -h, --help
//     --numa <distribute|isolate|numactl>       numa mode (default: disabled)
//     ...
//
//   test parameters:
//     -m, --model <filename>                    (default: models/...)
//     -hf, -hfr, --hf-repo <user>/<model>[:quant] Hugging Face model repository
//                                               (continuation line, indented)
//     ...
//   ```
//
// Parser approach:
//   1. Find the first fenced code block under `## Syntax`.
//   2. Walk lines. Lines ending in ":" (with no leading whitespace beyond the
//      block indent) become categories ("options", "test parameters", ...).
//   3. Lines starting with ` ` then `-` are option starts.
//   4. Lines that are deeper-indented continuations append to the previous
//      option's description.

function parseLlamaBenchUsageBlock(markdown: string): ParsedOption[] {
  const block = extractFirstFencedBlock(markdown, /^## Syntax\b/m);
  if (!block) return [];

  const lines = block.split(/\r?\n/);
  const out: ParsedOption[] = [];
  let category = "options";
  let sortOrder = 0;
  const seenIds = new Set<string>();
  let current: ParsedOption | null = null;
  // Track the column where descriptions start within an option line so we can
  // tell continuation lines apart from new options.
  // - Allow comma OR whitespace between flag tokens (mostly comma, but the
  //   `-ot --override-tensor` outlier in llama-bench uses a single space).
  // - The trailing description block is optional — some lines (like `-h,
  //   --help`) have no description after the flags.
  const OPTION_LINE = /^(\s*)(-[^\s,]+(?:[,\s]+-[^\s,]+)*)(?:(?:\s{2,}|\s)(.*?))?\s*$/;

  const flush = () => {
    if (current) {
      const meta = extractTrailingMeta(current.description);
      current.description = meta.description;
      current.defaultValue = meta.defaultValue;
      out.push(current);
      current = null;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      // Blank line — soft separator; flush any in-progress option.
      flush();
      continue;
    }

    // Section heading: e.g. "options:" or "test parameters:" — these are at
    // shallow indent and end with ":".
    const sec = /^(?:\s{0,4})([a-z][a-z _-]+):\s*$/.exec(line);
    if (sec) {
      flush();
      category = sec[1]!.trim();
      continue;
    }

    // "usage:" header — skip.
    if (/^usage:/i.test(line.trim())) continue;

    // Option start line.
    const m = OPTION_LINE.exec(line);
    if (m) {
      flush();
      const flagToken = m[2]!;
      const tail = m[3] ?? "";
      const flags = splitFlags(flagToken);
      const { argType, rest } = extractArgType(tail);

      const id = uniqueId(makeId(flags), seenIds, sortOrder);
      current = {
        id,
        category,
        flags,
        argType,
        description: rest,
        defaultValue: null,
        envVar: null,
        moreInfoUrl: null,
        rawRow: line,
        sortOrder: sortOrder++,
      };
      continue;
    }

    // Continuation line — indented further than an option start, no flag.
    if (current) {
      const cont = line.trim();
      if (cont) {
        current.description = current.description
          ? `${current.description} ${cont}`
          : cont;
      }
      continue;
    }
  }
  flush();
  return out;
}

// Pull `(default: ...)` off the end of the description.
function extractTrailingMeta(desc: string): { description: string; defaultValue: string | null } {
  const m = /\(default:\s*([^)]+)\)\s*$/.exec(desc);
  if (!m) return { description: desc.trim(), defaultValue: null };
  return {
    description: desc.slice(0, m.index).trim(),
    defaultValue: m[1]!.trim(),
  };
}

// Given the leading flag token like `-r, --repetitions` or `-h, --help`, plus
// the tail after the whitespace separator, decide how much of the tail is the
// argument-type spec (e.g. `<n>`, `<csv|json|...>`) vs description.
function splitFlags(flagToken: string): string[] {
  // Flags are separated by either commas (typical) or whitespace (the `-ot
  // --override-tensor` outlier).
  return flagToken
    .split(/[,\s]+/)
    .map((f) => f.trim())
    .filter((f) => f.startsWith("-"));
}

// Walk the tail (everything after the flag token) to extract the arg type
// without relying on a 2+-space gap, since some lines (`-hf-repo`) only have
// a single space between arg and description, and some args contain internal
// spaces (`<tensor name pattern>=<buffer type>;...`).
function extractArgType(tail: string): { argType: string | null; rest: string } {
  const trimmed = tail.replace(/^\s+/, "");
  if (!trimmed) return { argType: null, rest: "" };

  if (!trimmed.startsWith("<")) {
    // Positional spec like `FILE`, `N`, `<value>` (already handled above), or
    // just description. Use the 2+-space heuristic for these.
    const gap = /\s{2,}/.exec(trimmed);
    if (!gap) {
      // No clear separator; if the head looks like a single uppercase token
      // it's probably an arg type (e.g. `FILE`, `N`).
      const m = /^([A-Z][A-Za-z0-9_]*)\s+(.*)$/.exec(trimmed);
      if (m) return { argType: m[1]!, rest: m[2]!.trim() };
      return { argType: null, rest: trimmed };
    }
    return {
      argType: trimmed.slice(0, gap.index).trim() || null,
      rest: trimmed.slice(gap.index).trim(),
    };
  }

  // Walk angle-bracket / square-bracket / connector chars greedily.
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i]!;
    if (ch === "<") {
      const close = trimmed.indexOf(">", i + 1);
      if (close < 0) break;
      i = close + 1;
    } else if (ch === "[") {
      const close = trimmed.indexOf("]", i + 1);
      if (close < 0) break;
      i = close + 1;
    } else if (ch === "=" || ch === "/" || ch === ";" || ch === ".") {
      i++;
    } else if (/\s/.test(ch)) {
      break;
    } else {
      // Word character not part of a bracket — stop, treat as description.
      break;
    }
  }
  const argType = trimmed.slice(0, i).trim();
  const rest = trimmed.slice(i).trim();
  return { argType: argType || null, rest };
}

// Find a fenced ``` ``` block immediately after the first heading matching
// `headingRe`. Returns the block content (without fences), or null if missing.
function extractFirstFencedBlock(markdown: string, headingRe: RegExp): string | null {
  const lines = markdown.split(/\r?\n/);
  let i = 0;
  // find the heading
  while (i < lines.length && !headingRe.test(lines[i] ?? "")) i++;
  if (i >= lines.length) return null;
  // find the opening fence
  while (i < lines.length && !/^```/.test(lines[i] ?? "")) i++;
  if (i >= lines.length) return null;
  i++; // skip fence
  const start = i;
  while (i < lines.length && !/^```/.test(lines[i] ?? "")) i++;
  return lines.slice(start, i).join("\n");
}

// ─── Shared helpers ────────────────────────────────────────────────────────

function makeId(flags: string[]): string {
  const longs = flags.filter((f) => f.startsWith("--")).sort((a, b) => b.length - a.length);
  const pick = longs[0] ?? flags[0]!;
  return pick.replace(/^-+/, "").toLowerCase();
}

function uniqueId(base: string, seen: Set<string>, fallback: number): string {
  let id = base;
  if (seen.has(id)) id = `${base}-${fallback}`;
  seen.add(id);
  return id;
}
