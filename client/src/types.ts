export type CacheStatus = "cold" | "fresh" | "stale" | "updated";

export type CacheMeta = {
  age_ms: number | null;
  status: CacheStatus;
  was_refreshed: boolean;
};

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

export type Option = {
  id: string;
  category: string;
  flags: string[];
  argType: string | null;
  description: string;
  defaultValue: string | null;
  envVar: string | null;
  moreInfoUrl: string | null;
  fetchedAt: number;
};

export type IssueRef = {
  number: number;
  title: string;
  url: string;
  state: string;
  type: "issue" | "pr";
  updated_at: string;
};

export type OptionDetail = {
  option: Option;
  source: { block: string | null; url: string | null; fetched_at: number | null } | null;
  issues: IssueRef[];
  issues_fetched_at: number | null;
  explanation:
    | { text: string; model: string | null; fetched_at: number | null }
    | null;
};

export type Settings = {
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

export type Meta = {
  settings: Settings;
  defaults: Settings;
  sources: Source[];
  bedrock_available: boolean;
};

export type ApiEnvelope<T> = { data: T; cache: CacheMeta };
