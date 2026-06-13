import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { cache } from "./cache";
import { OptionList } from "./components/OptionList";
import { OptionDetailView } from "./components/OptionDetail";
import { SettingsModal } from "./components/Settings";
import { Toast, formatAge, type ToastSpec } from "./components/Toast";
import type {
  CacheStatus,
  Meta,
  Option,
  OptionDetail,
  Settings,
  Source,
} from "./types";

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OptionDetail | null>(null);
  const [filter, setFilter] = useState("");
  const [toast, setToast] = useState<ToastSpec | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  const toastIdRef = useRef(0);
  const toastDurationRef = useRef(2000);

  const showCacheToast = useCallback((status: CacheStatus, ageMs: number | null) => {
    let text: string;
    switch (status) {
      case "cold":    text = "Loading data…"; break;
      case "stale":   text = "Refreshing data…"; break;
      case "fresh":   text = `Cache current (${formatAge(ageMs)})`; break;
      case "updated": text = `Cache updated (${formatAge(ageMs)})`; break;
    }
    toastIdRef.current += 1;
    setToast({ id: toastIdRef.current, text, status, durationMs: toastDurationRef.current });
  }, []);

  const showErrorToast = useCallback((msg: string) => {
    toastIdRef.current += 1;
    setToast({
      id: toastIdRef.current,
      text: msg,
      status: "error",
      durationMs: Math.max(toastDurationRef.current, 4000),
    });
  }, []);

  // Load options for a given source. Warm-paints from IDB first, then refetches
  // from the server, updating the UI + cache if the server returns fresh data.
  const loadOptions = useCallback(
    async (sourceId: string) => {
      setActiveId(null);
      setDetail(null);
      const cached = await cache.getOptions(sourceId);
      if (cached) {
        setOptions(cached.data);
        showCacheToast("stale", Date.now() - cached.storedAt);
      } else {
        setOptions([]);
        showCacheToast("cold", null);
      }
      try {
        const res = await api.options(sourceId);
        setOptions(res.data);
        await cache.setOptions(sourceId, res.data);
        showCacheToast(res.cache.status, res.cache.age_ms);
      } catch (err) {
        showErrorToast(`Failed to load: ${(err as Error).message}`);
      }
    },
    [showCacheToast, showErrorToast],
  );

  // ── Initial boot ────────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      try {
        const m = await api.meta();
        setMeta(m);
        setSources(m.sources);
        toastDurationRef.current = m.settings.toast_duration_ms;
        const initialSourceId =
          m.sources.find((s) => s.id === m.settings.active_source_id)?.id ??
          m.sources[0]?.id ??
          null;
        if (!initialSourceId) {
          setBootError("No sources configured.");
          return;
        }
        setActiveSourceId(initialSourceId);
        await loadOptions(initialSourceId);
      } catch (err) {
        const msg = (err as Error).message;
        setBootError(msg);
        showErrorToast(`Failed to load: ${msg}`);
      }
    })();
  }, [loadOptions, showErrorToast]);

  const switchSource = useCallback(
    async (newId: string) => {
      if (!newId || newId === activeSourceId) return;
      setActiveSourceId(newId);
      // Persist the new active source so it survives page reload.
      try {
        const res = await api.updateSettings({ active_source_id: newId });
        setMeta((m) => (m ? { ...m, settings: res.settings } : m));
      } catch (err) {
        showErrorToast(`Failed to persist source: ${(err as Error).message}`);
      }
      await loadOptions(newId);
    },
    [activeSourceId, loadOptions, showErrorToast],
  );

  const selectOption = useCallback(
    async (id: string) => {
      if (!activeSourceId) return;
      setActiveId(id);
      setDetail(null);
      const cached = await cache.getDetail(activeSourceId, id);
      if (cached) {
        setDetail(cached.data);
        showCacheToast("stale", Date.now() - cached.storedAt);
      } else {
        showCacheToast("cold", null);
      }
      try {
        const res = await api.optionDetail(activeSourceId, id);
        setDetail(res.data);
        await cache.setDetail(activeSourceId, id, res.data);
        showCacheToast(res.cache.status, res.cache.age_ms);
      } catch (err) {
        showErrorToast(`Detail failed: ${(err as Error).message}`);
      }
    },
    [activeSourceId, showCacheToast, showErrorToast],
  );

  const refreshActive = useCallback(async () => {
    if (!activeSourceId || !activeId) return;
    showCacheToast("stale", null);
    try {
      await api.refresh(activeSourceId, activeId);
      const res = await api.optionDetail(activeSourceId, activeId);
      setDetail(res.data);
      await cache.setDetail(activeSourceId, activeId, res.data);
      showCacheToast("updated", res.cache.age_ms);
    } catch (err) {
      showErrorToast(`Refresh failed: ${(err as Error).message}`);
    }
  }, [activeSourceId, activeId, showCacheToast, showErrorToast]);

  const onSettingsSaved = useCallback(
    (s: Settings, updatedSources?: Source[]) => {
      setMeta((m) => (m ? { ...m, settings: s, sources: updatedSources ?? m.sources } : m));
      if (updatedSources) setSources(updatedSources);
      toastDurationRef.current = s.toast_duration_ms;
      // If the active source was deleted, switch to the new active source.
      if (updatedSources && activeSourceId && !updatedSources.some((src) => src.id === activeSourceId)) {
        const next = updatedSources.find((src) => src.id === s.active_source_id) ?? updatedSources[0];
        if (next) void switchSource(next.id);
      }
    },
    [activeSourceId, switchSource],
  );

  const activeSource = sources.find((s) => s.id === activeSourceId) ?? null;

  return (
    <div className="app">
      <header className="header">
        <h1>llama.cpp option explorer</h1>
        {sources.length > 0 && (
          <select
            className="source-picker"
            value={activeSourceId ?? ""}
            onChange={(e) => void switchSource(e.target.value)}
            aria-label="Source"
          >
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        )}
        {activeSource && (
          <span className="source">
            <code>{shortRepo(activeSource.readme_url)}</code> · {options.length} options
          </span>
        )}
        <div className="spacer" />
        <input
          className="search"
          placeholder="Filter by flag, description, or env var…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button onClick={() => setShowSettings(true)}>⚙ Settings</button>
      </header>

      {bootError ? (
        <div className="detail">
          <div className="empty">
            <p style={{ color: "var(--danger)" }}>Failed to boot: {bootError}</p>
            <p>Is the server running on port 8787?</p>
          </div>
        </div>
      ) : (
        <div className="body">
          <OptionList
            options={options}
            activeId={activeId}
            filter={filter}
            onSelect={selectOption}
          />
          {detail ? (
            <OptionDetailView
              detail={detail}
              sourceId={activeSourceId!}
              bedrockAvailable={meta?.bedrock_available ?? false}
              onRefresh={refreshActive}
              onExplained={(d) => {
                setDetail(d);
                if (activeSourceId && activeId) void cache.setDetail(activeSourceId, activeId, d);
              }}
            />
          ) : (
            <div className="detail">
              <div className="empty">
                <p>Pick an option from the list to dig in.</p>
                <p style={{ fontSize: 13, marginTop: 24 }}>
                  Each option pulls the README description, the matching source-code definition
                  (when available), and recent GitHub issues/PRs that mention the flag.
                  Optionally, a plain-English explanation is generated on demand via Bedrock.
                </p>
                {sources.length > 1 && (
                  <p style={{ fontSize: 13, marginTop: 16, color: "var(--fg-muted)" }}>
                    Switch source via the dropdown in the header.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {toast && <Toast toast={toast} onDismiss={() => setToast(null)} />}

      {showSettings && meta && (
        <SettingsModal
          initialSettings={meta.settings}
          defaults={meta.defaults}
          sources={sources}
          onClose={() => setShowSettings(false)}
          onSaved={onSettingsSaved}
        />
      )}
    </div>
  );
}

function shortRepo(url: string): string {
  const m = /github(?:usercontent)?\.com\/([^/]+\/[^/]+)/.exec(url);
  return m ? m[1]! : url;
}
