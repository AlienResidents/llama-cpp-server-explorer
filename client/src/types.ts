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

// ─── LLM types (mirror of server/src/llm-types.ts) ──────────────────────────

export type LlmProviderType = "bedrock" | "openai" | "ollama";

export type BedrockConfig = {
  model_id: string;
  region: string;
  max_tokens: number;
};

export type OpenAiConfig = {
  base_url: string;
  api_key: string;
  model: string;
  max_tokens: number;
};

export type OllamaConfig = {
  base_url: string;
  model: string;
  keep_alive: string;
  max_tokens: number;
};

export type LlmConfig = BedrockConfig | OpenAiConfig | OllamaConfig;

export type Llm = {
  id: string;
  name: string;
  provider: LlmProviderType;
  config: LlmConfig;
  is_default: boolean;
};

// Availability snapshot the client uses to decide whether the Generate button
// is enabled and what tooltip/hint to show. Mirrors the server's
// activeLlmAvailability() union.
export type LlmAvailability =
  | { status: "ready"; llm: Llm }
  | { status: "missing-credentials"; llm: Llm; hint: string }
  | { status: "not-configured"; llm: Llm; hint: string }
  | { status: "no-active-llm" };

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
    | {
        text: string;
        model: string | null;
        llm_id: string | null;
        llm_name: string | null;
        fetched_at: number | null;
        meta: ExplainMeta | null;
      }
    | null;
};

// Structured per-flag metadata extracted from the LLM's explanation response.
// Mirrors the server's ExplainMeta type (server/src/llm-types.ts). Rendered
// as chips + callouts alongside the markdown body in OptionDetail.
export type ExplainMeta = {
  hardware_impact?: HardwareImpact[];
  synergy_notes?: SynergyNote[];
};

export type HardwareImpact = {
  // Canonical resource: VRAM | RAM | COMPUTE | CPU | DISK | NETWORK.
  type: string;
  // Canonical effect: REDUCTION | INCREASE | EXPANSION | ALTERATION.
  effect: string;
};

export type SynergyNote = {
  severity: "info" | "warning";
  title: string;
  detail: string;
};

export type Settings = {
  cache_ttl_hours: number;
  toast_duration_ms: number;
  active_source_id: string;
  github_issue_search_limit: number;
  enable_llm_explanation: boolean;
  enable_source_code_lookup: boolean;
  enable_issue_lookup: boolean;
  active_llm_id: string;
  llm_timeout_ms: number;
};

export type Meta = {
  settings: Settings;
  defaults: Settings;
  sources: Source[];
  llms: Llm[];
  llm_availability: LlmAvailability;
};

export type ApiEnvelope<T> = { data: T; cache: CacheMeta };
