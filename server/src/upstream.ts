// Upstream fetchers — README, arg.cpp source block, GitHub issue/PR search.
// All are source-scoped: they take a Source object instead of consulting global
// settings, so different sources can be fetched in parallel without clobbering.

import { request as octokitRequest } from "@octokit/request";
import { getSettings } from "./settings.js";
import type { Source } from "./sources.js";

const DEFAULT_TIMEOUT_MS = 15000;

async function fetchText(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { "User-Agent": "llama-cpp-server-explorer" },
    });
    if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type FetchedReadme = { raw: string; sha: string; url: string };

export async function fetchReadme(source: Source): Promise<FetchedReadme> {
  const raw = await fetchText(source.readme_url);
  const sha = await sha256Hex(raw);
  return { raw, sha, url: source.readme_url };
}

export type FetchedArgCpp = { raw: string; sha: string; url: string };

export async function fetchArgCpp(source: Source): Promise<FetchedArgCpp | null> {
  if (!source.arg_cpp_url) return null;
  const raw = await fetchText(source.arg_cpp_url);
  const sha = await sha256Hex(raw);
  return { raw, sha, url: source.arg_cpp_url };
}

// Find the `add_opt(common_arg({...}))` block defining a given flag.
// Returns the source text plus a `#L<n>-L<m>` URL for GitHub.
export function findArgBlock(
  source: string,
  flags: string[],
  sourceUrl: string,
): { block: string | null; url: string | null } {
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!flags.some((f) => line.includes(`"${f}"`))) continue;

    let start = i;
    for (let j = i; j >= Math.max(0, i - 50); j--) {
      const ln = lines[j] ?? "";
      if (/\b(add_opt|common_arg)\s*\(/.test(ln)) {
        start = j;
        break;
      }
    }
    let depth = 0;
    let started = false;
    let end = start;
    for (let k = start; k < Math.min(lines.length, start + 200); k++) {
      const ln = lines[k] ?? "";
      for (const ch of ln) {
        if (ch === "(") {
          depth++;
          started = true;
        } else if (ch === ")") {
          depth--;
        }
      }
      if (started && depth <= 0) {
        end = k;
        break;
      }
    }
    const block = lines.slice(start, end + 1).join("\n");
    const blobUrl = sourceUrl
      .replace("raw.githubusercontent.com", "github.com")
      .replace(/\/(master|main)\//, "/blob/$1/");
    const url = `${blobUrl}#L${start + 1}-L${end + 1}`;
    return { block, url };
  }
  return { block: null, url: null };
}

export type IssueRef = {
  number: number;
  title: string;
  url: string;
  state: string;
  type: "issue" | "pr";
  updated_at: string;
};

export async function searchIssues(source: Source, flags: string[]): Promise<IssueRef[]> {
  const { github_issue_search_limit } = getSettings();
  const flag =
    flags.filter((f) => f.startsWith("--")).sort((a, b) => b.length - a.length)[0] ?? flags[0];
  if (!flag) return [];
  const q = `repo:${source.github_repo} "${flag}" in:body,comments,title`;

  try {
    const res = await octokitRequest("GET /search/issues", {
      q,
      per_page: Math.max(1, Math.min(20, github_issue_search_limit)),
      sort: "updated",
      order: "desc",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
      request: { fetch },
    });
    const items = (res.data as { items?: unknown[] }).items ?? [];
    return items.map((raw) => {
      const it = raw as {
        number: number;
        title: string;
        html_url: string;
        state: string;
        pull_request?: unknown;
        updated_at: string;
      };
      return {
        number: it.number,
        title: it.title,
        url: it.html_url,
        state: it.state,
        type: it.pull_request ? "pr" : "issue",
        updated_at: it.updated_at,
      };
    });
  } catch (err) {
    console.warn(`[upstream] issue search failed for ${flag}:`, (err as Error).message);
    return [];
  }
}
