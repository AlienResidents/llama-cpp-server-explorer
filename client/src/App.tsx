import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { cache } from "./cache";
import { OptionList } from "./components/OptionList";
import { OptionDetailView } from "./components/OptionDetail";
import { SettingsModal } from "./components/Settings";
import { Toast, formatAge, type ToastSpec } from "./components/Toast";
import type { CacheStatus, Meta, Option, OptionDetail, Settings } from "./types";

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OptionDetail | null>(null);
  const [filter, setFilter] = useState("");
  const [toast, setToast] = useState<ToastSpec | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  const toastIdRef = useRef(0);
  const toastDurationRef = useRef(2000);

  // Surface a toast whose copy reflects the cache state.
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

  // ── Initial load: pull meta + options (warm IDB → server) ──────────────
  useEffect(() => {
    void (async () => {
      try {
        const m = await api.meta();
        setMeta(m);
        toastDurationRef.current = m.settings.toast_duration_ms;

        // Warm paint from IDB if present.
        const cached = await cache.getOptions();
        if (cached) {
          setOptions(cached.data);
          showCacheToast("stale", Date.now() - cached.storedAt);
        } else {
          showCacheToast("cold", null);
        }

        // Server fetch (which also serves cached SQLite + may refresh).
        const res = await api.options();
        setOptions(res.data);
        await cache.setOptions(res.data);
        showCacheToast(res.cache.status, res.cache.age_ms);
      } catch (err) {
        const msg = (err as Error).message;
        setBootError(msg);
        showErrorToast(`Failed to load: ${msg}`);
      }
    })();
  }, [showCacheToast, showErrorToast]);

  // ── Detail load on selection ────────────────────────────────────────────
  const selectOption = useCallback(async (id: string) => {
    setActiveId(id);
    setDetail(null);

    // Warm paint from IDB.
    const cached = await cache.getDetail(id);
    if (cached) {
      setDetail(cached.data);
      showCacheToast("stale", Date.now() - cached.storedAt);
    } else {
      showCacheToast("cold", null);
    }

    try {
      const res = await api.optionDetail(id);
      setDetail(res.data);
      await cache.setDetail(id, res.data);
      showCacheToast(res.cache.status, res.cache.age_ms);
    } catch (err) {
      showErrorToast(`Detail failed: ${(err as Error).message}`);
    }
  }, [showCacheToast, showErrorToast]);

  const refreshActive = useCallback(async () => {
    if (!activeId) return;
    showCacheToast("stale", null);
    try {
      await api.refresh(activeId);
      const res = await api.optionDetail(activeId);
      setDetail(res.data);
      await cache.setDetail(activeId, res.data);
      showCacheToast("updated", res.cache.age_ms);
    } catch (err) {
      showErrorToast(`Refresh failed: ${(err as Error).message}`);
    }
  }, [activeId, showCacheToast, showErrorToast]);

  const onSettingsSaved = useCallback((s: Settings) => {
    setMeta((m) => (m ? { ...m, settings: s } : m));
    toastDurationRef.current = s.toast_duration_ms;
  }, []);

  return (
    <div className="app">
      <header className="header">
        <h1>llama.cpp server option explorer</h1>
        {meta && (
          <span className="source">
            from <code>{shortRepo(meta.settings.readme_url)}</code> · {options.length} options
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
              bedrockAvailable={meta?.bedrock_available ?? false}
              onRefresh={refreshActive}
              onExplained={(d) => {
                setDetail(d);
                if (activeId) void cache.setDetail(activeId, d);
              }}
            />
          ) : (
            <div className="detail">
              <div className="empty">
                <p>Pick an option from the list to dig in.</p>
                <p style={{ fontSize: 13, marginTop: 24 }}>
                  Each option pulls the README description, the matching <code>arg.cpp</code> definition,
                  and recent GitHub issues/PRs that mention the flag. Optionally, a plain-English
                  explanation is generated on demand via Bedrock.
                </p>
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
