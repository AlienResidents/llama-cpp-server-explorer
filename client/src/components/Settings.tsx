import { useEffect, useState } from "react";
import { api } from "../api";
import type { ParserType, Settings, Source } from "../types";

const SETTING_FIELDS: Record<keyof Settings, { label: string; hint: string }> = {
  cache_ttl_hours: {
    label: "Cache TTL (hours)",
    hint: "How long cached data is considered fresh before refresh.",
  },
  toast_duration_ms: {
    label: "Toast duration (ms)",
    hint: "How long the cache-status toast stays on screen.",
  },
  active_source_id: {
    label: "Active source id",
    hint: "Which source is shown by default. Edit via the source dropdown in the header.",
  },
  github_issue_search_limit: {
    label: "Issue search limit",
    hint: "Max related issues/PRs to fetch per option (1–20).",
  },
  enable_llm_explanation: {
    label: "Enable plain-English explanation (Bedrock)",
    hint: "If off, the Generate button is hidden.",
  },
  enable_source_code_lookup: {
    label: "Enable source-code block lookup",
    hint: "Disable to skip arg.cpp fetches entirely (sources without arg_cpp_url already skip).",
  },
  enable_issue_lookup: {
    label: "Enable GitHub issue/PR lookup",
    hint: "Disable to skip the GitHub search call.",
  },
  bedrock_model_id: {
    label: "Bedrock model id (or inference profile ARN)",
    hint: "Anthropic model on Bedrock used for explanations. Empty = explanations disabled.",
  },
  bedrock_region: {
    label: "Bedrock region",
    hint: "AWS region for Bedrock; must match the inference profile.",
  },
};

const SECTIONS: { title: string; keys: (keyof Settings)[] }[] = [
  { title: "Cache & UI", keys: ["cache_ttl_hours", "toast_duration_ms"] },
  { title: "Lookups", keys: ["github_issue_search_limit", "enable_source_code_lookup", "enable_issue_lookup"] },
  { title: "LLM explanation (Bedrock)", keys: ["enable_llm_explanation", "bedrock_model_id", "bedrock_region"] },
];

const PARSER_LABELS: Record<ParserType, string> = {
  "server-readme-table": "Server README (markdown table)",
  "llama-bench-usage-block": "llama-bench (usage block)",
};

export function SettingsModal({
  initialSettings,
  defaults,
  sources: initialSources,
  onClose,
  onSaved,
}: {
  initialSettings: Settings;
  defaults: Settings;
  sources: Source[];
  onClose: () => void;
  onSaved: (s: Settings, sources?: Source[]) => void;
}) {
  const [draft, setDraft] = useState<Settings>(initialSettings);
  const [sources, setSources] = useState<Source[]>(initialSources);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"general" | "sources">("general");

  useEffect(() => {
    function handleKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function saveSettings() {
    setSaving(true); setErr(null);
    try {
      const res = await api.updateSettings(draft);
      onSaved(res.settings, sources);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    if (!window.confirm("Reset all settings to defaults?")) return;
    setSaving(true); setErr(null);
    try {
      const res = await api.resetSettings();
      setDraft(res.settings);
      onSaved(res.settings, sources);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function refreshSources() {
    try {
      const res = await api.listSources();
      setSources(res.sources);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-label="Settings">
        <header>
          <h2>Settings</h2>
          <div className="tabs">
            <button className={tab === "general" ? "active" : ""} onClick={() => setTab("general")}>General</button>
            <button className={tab === "sources" ? "active" : ""} onClick={() => setTab("sources")}>Sources ({sources.length})</button>
          </div>
          <button onClick={onClose} aria-label="Close" className="close">×</button>
        </header>
        <div className="body">
          {tab === "general" && (
            <>
              {SECTIONS.map((sec) => (
                <div key={sec.title} style={{ marginBottom: 24 }}>
                  <h3 style={{ fontSize: 13, color: "var(--accent)", textTransform: "uppercase",
                               letterSpacing: 0.5, marginBottom: 12 }}>{sec.title}</h3>
                  {sec.keys.map((k) => renderField(k, draft, defaults, update))}
                </div>
              ))}
            </>
          )}
          {tab === "sources" && (
            <SourcesPanel
              sources={sources}
              onChange={refreshSources}
              setError={setErr}
            />
          )}
          {err && (
            <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 10 }}>Error: {err}</div>
          )}
        </div>
        <footer>
          {tab === "general" && (
            <>
              <button className="danger" onClick={reset} disabled={saving}>Reset to defaults</button>
              <div style={{ flex: 1 }} />
              <button onClick={onClose} disabled={saving}>Cancel</button>
              <button className="primary" onClick={saveSettings} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          )}
          {tab === "sources" && (
            <>
              <div style={{ flex: 1 }} />
              <button onClick={onClose}>Close</button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function renderField<K extends keyof Settings>(
  key: K,
  draft: Settings,
  defaults: Settings,
  update: <KK extends keyof Settings>(k: KK, v: Settings[KK]) => void,
) {
  const meta = SETTING_FIELDS[key];
  const value = draft[key];
  const isDefault = value === defaults[key];

  // active_source_id is read-only here — user changes it via the header dropdown.
  if (key === "active_source_id") {
    return (
      <div className="field" key={key}>
        <label>{meta.label}</label>
        <input type="text" value={value as string} disabled />
        <div className="hint">{meta.hint}</div>
      </div>
    );
  }
  if (typeof value === "boolean") {
    return (
      <div className="field" key={key}>
        <label>
          <input
            type="checkbox"
            checked={value}
            onChange={(e) => update(key, e.target.checked as Settings[K])}
          />
          {meta.label}
          {!isDefault && <span style={{ color: "var(--warn)", marginLeft: 8, fontSize: 11 }}>(modified)</span>}
        </label>
        <div className="hint">{meta.hint}</div>
      </div>
    );
  }
  if (typeof value === "number") {
    return (
      <div className="field" key={key}>
        <label>
          {meta.label}
          {!isDefault && <span style={{ color: "var(--warn)", marginLeft: 8, fontSize: 11 }}>(modified)</span>}
        </label>
        <input
          type="number"
          value={value}
          onChange={(e) => update(key, Number(e.target.value) as Settings[K])}
        />
        <div className="hint">{meta.hint} <em>Default: {String(defaults[key])}</em></div>
      </div>
    );
  }
  return (
    <div className="field" key={key}>
      <label>
        {meta.label}
        {!isDefault && <span style={{ color: "var(--warn)", marginLeft: 8, fontSize: 11 }}>(modified)</span>}
      </label>
      <input
        type="text"
        value={value as string}
        onChange={(e) => update(key, e.target.value as Settings[K])}
      />
      <div className="hint">{meta.hint} <em>Default: {String(defaults[key])}</em></div>
    </div>
  );
}

function SourcesPanel({
  sources,
  onChange,
  setError,
}: {
  sources: Source[];
  onChange: () => Promise<void>;
  setError: (msg: string | null) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  async function handleDelete(id: string) {
    if (!window.confirm(`Delete source "${id}"? Cached options for it will be wiped.`)) return;
    try {
      await api.deleteSource(id);
      await onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <p style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 0 }}>
        Each source supplies its own README + parser. Default sources can be edited but not deleted.
      </p>
      <div className="sources-list">
        {sources.map((s) => (
          <div key={s.id} className="source-row">
            {editId === s.id ? (
              <SourceForm
                initial={s}
                onCancel={() => setEditId(null)}
                onSubmit={async (patch) => {
                  try {
                    await api.updateSource(s.id, patch);
                    setEditId(null);
                    await onChange();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              />
            ) : (
              <>
                <div className="source-summary">
                  <div className="source-name">
                    <code>{s.id}</code>
                    {s.is_default && <span className="badge">default</span>}
                    <span style={{ marginLeft: 8 }}>{s.name}</span>
                  </div>
                  <div className="source-meta">
                    <span>parser: <code>{PARSER_LABELS[s.parser]}</code></span>
                    {" · "}
                    <span>repo: <code>{s.github_repo}</code></span>
                  </div>
                  <div className="source-url"><code>{s.readme_url}</code></div>
                </div>
                <div className="source-actions">
                  <button onClick={() => setEditId(s.id)}>Edit</button>
                  {!s.is_default && (
                    <button className="danger" onClick={() => void handleDelete(s.id)}>Delete</button>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 16 }}>
        {adding ? (
          <SourceForm
            initial={null}
            onCancel={() => setAdding(false)}
            onSubmit={async (input) => {
              if (!input.id) {
                setError("id is required");
                return;
              }
              try {
                await api.createSource(input as Omit<Source, "is_default">);
                setAdding(false);
                await onChange();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          />
        ) : (
          <button onClick={() => { setError(null); setAdding(true); }}>+ Add custom source</button>
        )}
      </div>
    </div>
  );
}

type SourceDraft = {
  id: string;
  name: string;
  readme_url: string;
  arg_cpp_url: string | null;
  github_repo: string;
  parser: ParserType;
};

function SourceForm({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: Source | null;
  onCancel: () => void;
  onSubmit: (s: SourceDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<SourceDraft>(
    initial
      ? {
          id: initial.id,
          name: initial.name,
          readme_url: initial.readme_url,
          arg_cpp_url: initial.arg_cpp_url,
          github_repo: initial.github_repo,
          parser: initial.parser,
        }
      : {
          id: "",
          name: "",
          readme_url: "",
          arg_cpp_url: "",
          github_repo: "",
          parser: "server-readme-table",
        },
  );
  const isEdit = !!initial;
  const idLocked = isEdit;

  return (
    <div className="source-form">
      <div className="field">
        <label>id (immutable)</label>
        <input
          type="text"
          value={draft.id}
          disabled={idLocked}
          onChange={(e) => setDraft({ ...draft, id: e.target.value })}
        />
      </div>
      <div className="field">
        <label>name</label>
        <input
          type="text"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </div>
      <div className="field">
        <label>parser</label>
        <select
          value={draft.parser}
          onChange={(e) => setDraft({ ...draft, parser: e.target.value as ParserType })}
        >
          {Object.entries(PARSER_LABELS).map(([k, label]) => (
            <option key={k} value={k}>{label}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>README URL (raw)</label>
        <input
          type="text"
          value={draft.readme_url}
          onChange={(e) => setDraft({ ...draft, readme_url: e.target.value })}
        />
      </div>
      <div className="field">
        <label>arg.cpp URL (optional, raw)</label>
        <input
          type="text"
          value={draft.arg_cpp_url ?? ""}
          onChange={(e) => setDraft({ ...draft, arg_cpp_url: e.target.value || null })}
        />
        <div className="hint">Empty if the source doesn't have a single arg-definition file.</div>
      </div>
      <div className="field">
        <label>github_repo (owner/repo)</label>
        <input
          type="text"
          value={draft.github_repo}
          onChange={(e) => setDraft({ ...draft, github_repo: e.target.value })}
        />
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onCancel}>Cancel</button>
        <button
          className="primary"
          onClick={() => void onSubmit(draft)}
        >
          {isEdit ? "Save" : "Add"}
        </button>
      </div>
    </div>
  );
}
