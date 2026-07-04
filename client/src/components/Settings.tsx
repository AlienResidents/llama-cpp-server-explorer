import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { BedrockConfig, Llm, LlmConfig, LlmProviderType, OpenAiConfig, OllamaConfig, ParserType, Settings, Source } from "../types";

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
    label: "Enable plain-English explanation",
    hint: "If off, the Generate button is hidden. The active LLM is picked in the LLMs tab.",
  },
  enable_source_code_lookup: {
    label: "Enable source-code block lookup",
    hint: "Disable to skip arg.cpp fetches entirely (sources without arg_cpp_url already skip).",
  },
  enable_issue_lookup: {
    label: "Enable GitHub issue/PR lookup",
    hint: "Disable to skip the GitHub search call.",
  },
  active_llm_id: {
    label: "Active LLM",
    hint: "Which LLM generates explanations. Edit via the LLMs tab.",
  },
  llm_timeout_ms: {
    label: "LLM request timeout (ms)",
    hint:
      "How long to wait for an LLM response before aborting. Local models may need 2+ minutes on first load; hosted providers usually respond in <30s. The Test Connection button uses a separate 30s cap.",
  },
};

const SECTIONS: { title: string; keys: (keyof Settings)[] }[] = [
  { title: "Cache & UI", keys: ["cache_ttl_hours", "toast_duration_ms"] },
  { title: "Lookups", keys: ["github_issue_search_limit", "enable_source_code_lookup", "enable_issue_lookup"] },
  { title: "LLM explanation", keys: ["enable_llm_explanation", "active_llm_id", "llm_timeout_ms"] },
];

const PARSER_LABELS: Record<ParserType, string> = {
  "server-readme-table": "Server README (markdown table)",
  "llama-bench-usage-block": "llama-bench (usage block)",
};

const PROVIDER_LABELS: Record<LlmProviderType, string> = {
  bedrock: "AWS Bedrock (Anthropic via AWS SDK)",
  openai: "OpenAI-compatible (Together / OpenAI / llama.cpp / vLLM / Groq / OpenRouter)",
  ollama: "Ollama (native /api/chat)",
};

export function SettingsModal({
  initialSettings,
  defaults,
  sources: initialSources,
  llms: initialLlms,
  onClose,
  onSaved,
}: {
  initialSettings: Settings;
  defaults: Settings;
  sources: Source[];
  llms: Llm[];
  onClose: () => void;
  onSaved: (s: Settings, sources?: Source[], llms?: Llm[]) => void;
}) {
  const [draft, setDraft] = useState<Settings>(initialSettings);
  const [sources, setSources] = useState<Source[]>(initialSources);
  const [llms, setLlms] = useState<Llm[]>(initialLlms);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"general" | "sources" | "llms">("general");

  // Track the snapshot we loaded with so Save sends only fields the user
  // actually changed in this modal session. Without this, opening Settings
  // and clicking Save clobbers any concurrent changes from elsewhere.
  const initialSnapshot = useMemo(() => initialSettings, [initialSettings]);
  const changedKeys = useMemo(
    () =>
      (Object.keys(draft) as (keyof Settings)[]).filter(
        (k) => draft[k] !== initialSnapshot[k],
      ),
    [draft, initialSnapshot],
  );
  const hasChanges = changedKeys.length > 0;

  useEffect(() => {
    function handleKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function saveSettings() {
    if (!hasChanges) {
      onClose();
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      // Send only the fields the user actually edited in this session.
      const patch: Partial<Settings> = {};
      for (const k of changedKeys) {
        // @ts-expect-error — narrowed by changedKeys
        patch[k] = draft[k];
      }
      const res = await api.updateSettings(patch);
      onSaved(res.settings, sources, llms);
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
      onSaved(res.settings, sources, llms);
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

  async function refreshLlms() {
    try {
      const res = await api.listLlms();
      setLlms(res.llms);
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
            <button className={tab === "llms" ? "active" : ""} onClick={() => setTab("llms")}>LLMs ({llms.length})</button>
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
                  {sec.keys.map((k) =>
                    renderField(k, draft, defaults, update, llms),
                  )}
                </div>
              ))}
              {hasChanges && (
                <div style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: -8 }}>
                  Will save: <code>{changedKeys.join(", ")}</code>
                </div>
              )}
            </>
          )}
          {tab === "sources" && (
            <SourcesPanel
              sources={sources}
              onChange={refreshSources}
              setError={setErr}
            />
          )}
          {tab === "llms" && (
            <LlmsPanel
              llms={llms}
              activeLlmId={draft.active_llm_id}
              onChange={refreshLlms}
              onActiveChange={(id) => update("active_llm_id", id)}
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
              <button className="primary" onClick={saveSettings} disabled={saving || !hasChanges}>
                {saving ? "Saving…" : hasChanges ? `Save (${changedKeys.length})` : "No changes"}
              </button>
            </>
          )}
          {(tab === "sources" || tab === "llms") && (
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
  llms: Llm[],
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
  // active_llm_id is read-only here — user changes it via the LLMs tab.
  // Show the LLM name (looked up from the llms list) rather than the raw id.
  if (key === "active_llm_id") {
    const activeLlm = llms.find((l) => l.id === value);
    const displayValue = activeLlm ? activeLlm.name : "(none — pick in LLMs tab)";
    return (
      <div className="field" key={key}>
        <label>{meta.label}</label>
        <input type="text" value={displayValue} disabled />
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

// ─── Sources panel (unchanged from original) ────────────────────────────────

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

// ─── LLMs panel (new — mirrors SourcesPanel) ─────────────────────────────────

function LlmsPanel({
  llms,
  activeLlmId,
  onChange,
  onActiveChange,
  setError,
}: {
  llms: Llm[];
  activeLlmId: string;
  onChange: () => Promise<void>;
  onActiveChange: (id: string) => void;
  setError: (msg: string | null) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string } | undefined>>({});

  async function handleDelete(id: string) {
    if (!window.confirm(`Delete LLM "${id}"?`)) return;
    try {
      await api.deleteLlm(id);
      // If we just deleted the active LLM, the server falls back to the first
      // remaining one (handled in llms.ts deleteLlm). Refresh to pick up the
      // new active_llm_id. The parent re-reads settings on Save, but since the
      // LLMs tab doesn't Save, we need to propagate the change immediately.
      await onChange();
      // Read the updated settings so the parent's draft picks up the new
      // active_llm_id. This is a bit awkward but avoids stale state.
      const settingsRes = await api.getSettings();
      onActiveChange(settingsRes.settings.active_llm_id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleSetActive(id: string) {
    try {
      // Persist immediately so the change survives a modal close without
      // needing the General tab's Save button. The LLMs tab has no Save of
      // its own (matching the Sources tab pattern).
      const res = await api.updateSettings({ active_llm_id: id });
      onActiveChange(res.settings.active_llm_id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleTest(id: string) {
    setTestingId(id);
    // Clear any previous result for this LLM so the user sees "Testing…"
    // rather than a stale pass/fail while the request is in flight.
    setTestResults((prev) => ({ ...prev, [id]: undefined }));
    try {
      const res = await api.testLlm(id);
      if (res.ok) {
        setTestResults((prev) => ({
          ...prev,
          [id]: { ok: true, message: `Connected — model: ${res.model}` },
        }));
      } else {
        setTestResults((prev) => ({
          ...prev,
          [id]: { ok: false, message: res.message },
        }));
      }
    } catch (e) {
      // Only fires on non-200 (e.g. 404 if the LLM was deleted elsewhere).
      setTestResults((prev) => ({
        ...prev,
        [id]: { ok: false, message: (e as Error).message },
      }));
    } finally {
      setTestingId(null);
    }
  }

  return (
    <div>
      <p style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 0 }}>
        Each LLM generates plain-English explanations on demand. Pick one as active via the
        <strong> Set active</strong> button. Default LLMs can be edited but not deleted. The active
        LLM shows an <span className="badge">active</span> badge.
      </p>
      <div className="sources-list">
        {llms.map((l) => (
          <div key={l.id} className="source-row">
            {editId === l.id ? (
              <LlmForm
                initial={l}
                onCancel={() => setEditId(null)}
                onSubmit={async (patch) => {
                  try {
                    await api.updateLlm(l.id, patch);
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
                    <code>{l.id}</code>
                    {l.is_default && <span className="badge">default</span>}
                    {l.id === activeLlmId && <span className="badge" style={{ background: "var(--accent)", color: "#0d1117" }}>active</span>}
                    <span style={{ marginLeft: 8 }}>{l.name}</span>
                  </div>
                  <div className="source-meta">
                    <span>provider: <code>{PROVIDER_LABELS[l.provider]}</code></span>
                  </div>
                  <div className="source-url"><code>{summarizeLlmConfig(l)}</code></div>
                </div>
                <div className="source-actions">
                  {l.id !== activeLlmId && (
                    <button
                      className="primary"
                      onClick={() => void handleSetActive(l.id)}
                    >
                      Set active
                    </button>
                  )}
                  <button
                    onClick={() => void handleTest(l.id)}
                    disabled={testingId === l.id}
                  >
                    {testingId === l.id ? "Testing…" : "Test"}
                  </button>
                  <button onClick={() => setEditId(l.id)}>Edit</button>
                  {!l.is_default && (
                    <button className="danger" onClick={() => void handleDelete(l.id)}>Delete</button>
                  )}
                </div>
                {testResults[l.id] && (
                  <div
                    style={{
                      fontSize: 12,
                      marginTop: 6,
                      color: testResults[l.id]!.ok ? "var(--accent)" : "var(--danger)",
                    }}
                  >
                    {testResults[l.id]!.ok ? "✓ " : "✗ "}
                    {testResults[l.id]!.message}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 16 }}>
        {adding ? (
          <LlmForm
            initial={null}
            onCancel={() => setAdding(false)}
            onSubmit={async (input) => {
              if (!input.id) {
                setError("id is required");
                return;
              }
              try {
                await api.createLlm(input as Omit<Llm, "is_default">);
                setAdding(false);
                await onChange();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          />
        ) : (
          <button onClick={() => { setError(null); setAdding(true); }}>+ Add custom LLM</button>
        )}
      </div>
    </div>
  );
}

function summarizeLlmConfig(llm: Llm): string {
  const c = llm.config;
  switch (llm.provider) {
    case "bedrock":
      return `model: ${(c as BedrockConfig).model_id || "(not set)"} · region: ${(c as BedrockConfig).region}`;
    case "openai":
      return `base: ${(c as OpenAiConfig).base_url || "(not set)"} · model: ${(c as OpenAiConfig).model || "(not set)"}`;
    case "ollama":
      return `base: ${(c as OllamaConfig).base_url} · model: ${(c as OllamaConfig).model || "(not set)"} · keep_alive: ${(c as OllamaConfig).keep_alive}`;
    default:
      return JSON.stringify(c);
  }
}

type LlmDraft = {
  id: string;
  name: string;
  provider: LlmProviderType;
  config: LlmConfig;
};

// Default config per provider. Used when adding a new LLM — gives the user a
// sensible starting point they can edit.
function defaultConfigFor(provider: LlmProviderType): LlmConfig {
  switch (provider) {
    case "bedrock":
      return { model_id: "", region: "ap-southeast-4" };
    case "openai":
      // Default to a local llama.cpp server — the most common OpenAI-compat
      // target for a local dev tool. User edits to point at together.ai /
      // OpenAI / Groq / etc.
      return { base_url: "http://localhost:8080/v1", api_key: "", model: "" };
    case "ollama":
      return { base_url: "http://localhost:11434", model: "", keep_alive: "5m" };
    default:
      return { base_url: "", api_key: "", model: "" };
  }
}

function LlmForm({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: Llm | null;
  onCancel: () => void;
  onSubmit: (l: LlmDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<LlmDraft>(
    initial
      ? {
          id: initial.id,
          name: initial.name,
          provider: initial.provider,
          config: initial.config,
        }
      : {
          id: "",
          name: "",
          provider: "openai",
          config: defaultConfigFor("openai"),
        },
  );
  const isEdit = !!initial;
  const idLocked = isEdit;

  // When the provider changes on a new LLM, reset the config to the provider's
  // default. On edit, provider is locked (changing provider would invalidate
  // the config shape — user should delete + re-add instead).
  function handleProviderChange(newProvider: LlmProviderType) {
    if (isEdit) return;
    setDraft((d) => ({ ...d, provider: newProvider, config: defaultConfigFor(newProvider) }));
  }

  function updateConfig(patch: Partial<LlmConfig>) {
    setDraft((d) => ({ ...d, config: { ...d.config, ...patch } as LlmConfig }));
  }

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
        <label>provider</label>
        <select
          value={draft.provider}
          disabled={isEdit}
          onChange={(e) => handleProviderChange(e.target.value as LlmProviderType)}
        >
          {Object.entries(PROVIDER_LABELS).map(([k, label]) => (
            <option key={k} value={k}>{label}</option>
          ))}
        </select>
        {isEdit && (
          <div className="hint">Provider is immutable on edit. Delete + re-add to change.</div>
        )}
      </div>

      {draft.provider === "bedrock" && (
        <BedrockConfigFields config={draft.config as BedrockConfig} updateConfig={updateConfig} />
      )}
      {draft.provider === "openai" && (
        <OpenAiConfigFields config={draft.config as OpenAiConfig} updateConfig={updateConfig} />
      )}
      {draft.provider === "ollama" && (
        <OllamaConfigFields config={draft.config as OllamaConfig} updateConfig={updateConfig} />
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" onClick={() => void onSubmit(draft)}>
          {isEdit ? "Save" : "Add"}
        </button>
      </div>
    </div>
  );
}

function BedrockConfigFields({
  config,
  updateConfig,
}: {
  config: BedrockConfig;
  updateConfig: (patch: Partial<LlmConfig>) => void;
}) {
  return (
    <>
      <div className="field">
        <label>model id (or inference profile ARN)</label>
        <input
          type="text"
          value={config.model_id}
          onChange={(e) => updateConfig({ model_id: e.target.value } as Partial<LlmConfig>)}
        />
        <div className="hint">
          Anthropic model on Bedrock. Either a foundation-model id (e.g.
          <code> anthropic.claude-3-5-sonnet-20241022-v2:0</code>) or an inference-profile ARN
          (e.g. <code>arn:aws:bedrock:ap-southeast-4:…:inference-profile/…</code>). Empty =
          explanations disabled for this LLM.
        </div>
      </div>
      <div className="field">
        <label>region</label>
        <input
          type="text"
          value={config.region}
          onChange={(e) => updateConfig({ region: e.target.value } as Partial<LlmConfig>)}
        />
        <div className="hint">AWS region; must match the inference profile.</div>
      </div>
    </>
  );
}

function OpenAiConfigFields({
  config,
  updateConfig,
}: {
  config: OpenAiConfig;
  updateConfig: (patch: Partial<LlmConfig>) => void;
}) {
  return (
    <>
      <div className="field">
        <label>base URL</label>
        <input
          type="text"
          value={config.base_url}
          onChange={(e) => updateConfig({ base_url: e.target.value } as Partial<LlmConfig>)}
        />
        <div className="hint">
          OpenAI-compatible endpoint, no trailing slash. together.ai:
          <code> https://api.together.xyz/v1</code>. llama.cpp local server:
          <code> http://localhost:8080/v1</code>. OpenAI:
          <code> https://api.openai.com/v1</code>. Groq:
          <code> https://api.groq.com/openai/v1</code>. OpenRouter:
          <code> https://openrouter.ai/api/v1</code>. Ollama OpenAI shim:
          <code> http://localhost:11434/v1</code>.
        </div>
      </div>
      <div className="field">
        <label>api key</label>
        <input
          type="password"
          value={config.api_key}
          onChange={(e) => updateConfig({ api_key: e.target.value } as Partial<LlmConfig>)}
        />
        <div className="hint">
          Bearer token sent as <code>Authorization</code>. Empty for local servers that don't
          require auth (llama.cpp, Ollama's OpenAI shim). Stored in plaintext in SQLite —
          acceptable for a local-only dev tool.
        </div>
      </div>
      <div className="field">
        <label>model</label>
        <input
          type="text"
          value={config.model}
          onChange={(e) => updateConfig({ model: e.target.value } as Partial<LlmConfig>)}
        />
        <div className="hint">
          Model id as the provider expects it in the <code>model</code> field. together.ai:
          <code> zai-org/GLM-5.2</code>. OpenAI: <code>gpt-4o</code>. llama.cpp: whatever you
          passed to <code>--alias</code> or the model filename. Ollama shim:
          <code> llama3.1:8b</code>.
        </div>
      </div>
    </>
  );
}

function OllamaConfigFields({
  config,
  updateConfig,
}: {
  config: OllamaConfig;
  updateConfig: (patch: Partial<LlmConfig>) => void;
}) {
  return (
    <>
      <div className="field">
        <label>base URL</label>
        <input
          type="text"
          value={config.base_url}
          onChange={(e) => updateConfig({ base_url: e.target.value } as Partial<LlmConfig>)}
        />
        <div className="hint">
          Ollama server root, no trailing slash. Default:
          <code> http://localhost:11434</code>. No <code>/api</code> suffix — the provider adds it.
        </div>
      </div>
      <div className="field">
        <label>model</label>
        <input
          type="text"
          value={config.model}
          onChange={(e) => updateConfig({ model: e.target.value } as Partial<LlmConfig>)}
        />
        <div className="hint">
          As <code>ollama list</code> shows it, e.g. <code>llama3.1:8b</code>, <code>qwen2.5:14b</code>.
          Must be pulled first (<code>ollama pull &lt;model&gt;</code>).
        </div>
      </div>
      <div className="field">
        <label>keep_alive</label>
        <input
          type="text"
          value={config.keep_alive}
          onChange={(e) => updateConfig({ keep_alive: e.target.value } as Partial<LlmConfig>)}
        />
        <div className="hint">
          How long the model stays loaded after the request. Default <code>5m</code>.
          <code>0</code> = unload immediately, <code>-1</code> = keep loaded forever.
        </div>
      </div>
    </>
  );
}
