import { useEffect, useState } from "react";
import { api } from "../api";
import type { Settings } from "../types";

const FIELD_LABELS: Record<keyof Settings, { label: string; hint: string }> = {
  cache_ttl_hours: {
    label: "Cache TTL (hours)",
    hint: "How long cached data is considered fresh before refresh.",
  },
  toast_duration_ms: {
    label: "Toast duration (ms)",
    hint: "How long the cache-status toast stays on screen.",
  },
  readme_url: {
    label: "README URL",
    hint: "Source of the option list. Point at a fork or branch to test.",
  },
  arg_cpp_url: {
    label: "arg.cpp URL",
    hint: "Source for C++ flag definitions used in source-block lookup.",
  },
  github_repo: {
    label: "GitHub repo",
    hint: "owner/repo for issue & PR search (e.g., ggml-org/llama.cpp).",
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
    label: "Enable C++ source-block lookup",
    hint: "Disable to skip arg.cpp fetches entirely.",
  },
  enable_issue_lookup: {
    label: "Enable GitHub issue/PR lookup",
    hint: "Disable to skip the GitHub search call.",
  },
  bedrock_model_id: {
    label: "Bedrock model id (or inference profile ARN)",
    hint: "Anthropic model on Bedrock used for explanations.",
  },
  bedrock_region: {
    label: "Bedrock region",
    hint: "AWS region for Bedrock; must match the inference profile.",
  },
};

const SECTIONS: { title: string; keys: (keyof Settings)[] }[] = [
  {
    title: "Cache & UI",
    keys: ["cache_ttl_hours", "toast_duration_ms"],
  },
  {
    title: "Sources",
    keys: ["readme_url", "arg_cpp_url", "github_repo", "github_issue_search_limit"],
  },
  {
    title: "Lookups",
    keys: ["enable_source_code_lookup", "enable_issue_lookup"],
  },
  {
    title: "LLM explanation (Bedrock)",
    keys: ["enable_llm_explanation", "bedrock_model_id", "bedrock_region"],
  },
];

export function SettingsModal({
  initialSettings,
  defaults,
  onClose,
  onSaved,
}: {
  initialSettings: Settings;
  defaults: Settings;
  onClose: () => void;
  onSaved: (s: Settings) => void;
}) {
  const [draft, setDraft] = useState<Settings>(initialSettings);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function save() {
    setSaving(true); setErr(null);
    try {
      const res = await api.updateSettings(draft);
      onSaved(res.settings);
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
      onSaved(res.settings);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-label="Settings">
        <header>
          <h2>Settings</h2>
          <button onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="body">
          {SECTIONS.map((sec) => (
            <div key={sec.title} style={{ marginBottom: 24 }}>
              <h3 style={{ fontSize: 13, color: "var(--accent)", textTransform: "uppercase",
                           letterSpacing: 0.5, marginBottom: 12 }}>{sec.title}</h3>
              {sec.keys.map((k) => renderField(k, draft, defaults, update))}
            </div>
          ))}
          {err && (
            <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 10 }}>Error: {err}</div>
          )}
        </div>
        <footer>
          <button className="danger" onClick={reset} disabled={saving}>Reset to defaults</button>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} disabled={saving}>Cancel</button>
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
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
  const meta = FIELD_LABELS[key];
  const value = draft[key];
  const isDefault = value === defaults[key];

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
