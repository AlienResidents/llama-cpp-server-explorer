import { useState } from "react";
import type { HardwareImpact, LlmAvailability, OptionDetail, SynergyNote } from "../types";
import { api } from "../api";
import { formatAge } from "./Toast";

export function OptionDetailView({
  detail,
  sourceId,
  llmAvailability,
  onRefresh,
  onExplained,
}: {
  detail: OptionDetail;
  sourceId: string;
  llmAvailability: LlmAvailability;
  onRefresh: () => void;
  onExplained: (newDetail: OptionDetail) => void;
}) {
  const { option, source, issues, explanation } = detail;
  const [explaining, setExplaining] = useState(false);
  const [explainErr, setExplainErr] = useState<string | null>(null);

  const canExplain = llmAvailability.status === "ready";
  const llmName =
    llmAvailability.status === "ready" ||
    llmAvailability.status === "not-configured" ||
    llmAvailability.status === "missing-credentials"
      ? llmAvailability.llm.name
      : null;
  const hint =
    llmAvailability.status === "not-configured" || llmAvailability.status === "missing-credentials"
      ? llmAvailability.hint
      : llmAvailability.status === "no-active-llm"
        ? "No active LLM — pick one in Settings → LLMs."
        : "";

  async function handleExplain() {
    setExplaining(true);
    setExplainErr(null);
    try {
      const res = await api.explain(sourceId, option.id);
      onExplained({
        ...detail,
        explanation: {
          text: res.explanation.text,
          model: res.explanation.model,
          llm_id: res.explanation.llm_id,
          llm_name: res.explanation.llm_name,
          fetched_at: res.explanation.fetched_at,
          meta: res.explanation.meta,
        },
      });
    } catch (err) {
      setExplainErr((err as Error).message);
    } finally {
      setExplaining(false);
    }
  }

  return (
    <div className="detail">
      <h2>{option.flags[0]}</h2>
      <div className="flags-row">
        {option.flags.map((f) => (
          <span key={f} className="flag-chip">{f}</span>
        ))}
        {option.argType && <span className="flag-chip" style={{ color: "var(--fg-muted)" }}>{option.argType}</span>}
      </div>

      <dl className="meta-grid">
        <dt>Category</dt><dd>{option.category}</dd>
        {option.defaultValue && (<><dt>Default</dt><dd><code>{option.defaultValue}</code></dd></>)}
        {option.envVar && (<><dt>Env var</dt><dd><code>{option.envVar}</code></dd></>)}
        {option.moreInfoUrl && (<><dt>More info</dt><dd><a href={option.moreInfoUrl} target="_blank" rel="noreferrer">{option.moreInfoUrl}</a></dd></>)}
      </dl>

      <section>
        <h3>Description (from README)</h3>
        <div
          className="description"
          dangerouslySetInnerHTML={{ __html: option.description }}
        />
      </section>

      <div className="actions">
        <button type="button" onClick={onRefresh}>Refresh source &amp; issues</button>
        <button type="button" onClick={handleExplain} disabled={explaining || !canExplain}>
          {explaining ? "Generating…" : explanation ? "Regenerate explanation" : "Generate plain-English explanation"}
        </button>
        {!canExplain && (
          <span style={{ color: "var(--fg-muted)", alignSelf: "center", fontSize: 12 }}>
            {hint}
          </span>
        )}
      </div>
      {explainErr && (
        <div style={{ color: "var(--danger)", fontSize: 13 }}>Explain failed: {explainErr}</div>
      )}

      {explanation && (
        <section>
          <h3>Plain-English explanation
            <span style={{ color: "var(--fg-muted)", fontSize: 11, marginLeft: 8, textTransform: "none" }}>
              {explanation.llm_name ?? explanation.model ?? "unknown model"}
              {explanation.fetched_at ? ` · ${formatAge(Date.now() - explanation.fetched_at)}` : ""}
            </span>
          </h3>
          {explanation.meta?.hardware_impact && explanation.meta.hardware_impact.length > 0 && (
            <div className="hw-impact-chips">
              {explanation.meta.hardware_impact.map((h, i) => (
                <HardwareImpactChip key={i} impact={h} />
              ))}
            </div>
          )}
          <div className="explanation">{explanation.text}</div>
          {explanation.meta?.synergy_notes && explanation.meta.synergy_notes.length > 0 && (
            <div className="synergy-notes">
              {explanation.meta.synergy_notes.map((n, i) => (
                <SynergyNoteCard key={i} note={n} />
              ))}
            </div>
          )}
        </section>
      )}

      {source && source.block && (
        <section>
          <h3>C++ definition
            {source.url && (
              <a href={source.url} target="_blank" rel="noreferrer"
                 style={{ marginLeft: 10, fontSize: 12, textTransform: "none" }}>
                view on GitHub ↗
              </a>
            )}
          </h3>
          <pre><code>{source.block}</code></pre>
        </section>
      )}

      {issues.length > 0 && (
        <section>
          <h3>Related issues &amp; PRs ({issues.length})</h3>
          <ul className="issues">
            {issues.map((i) => (
              <li key={i.url}>
                <span className="ref">#{i.number}</span>
                <a href={i.url} target="_blank" rel="noreferrer">{i.title}</a>
                <span className={`badge ${i.state}`}>{i.type === "pr" ? "PR" : "Issue"} · {i.state}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!source?.block && issues.length === 0 && (
        <section>
          <p style={{ color: "var(--fg-muted)" }}>
            No source block or related issues found yet. Try refreshing.
          </p>
        </section>
      )}
    </div>
  );
}

// ─── Hardware impact chip ───────────────────────────────────────────────────
// Renders a single {type, effect} pair as a colored chip. Color encodes the
// effect direction (green=reduce, red=increase, amber=expand, blue=alter);
// icon reinforces it. Gives at-a-glance scannability in the detail view.

const EFFECT_ICON: Record<string, string> = {
  REDUCTION: "📉",
  INCREASE: "📈",
  EXPANSION: "📊",
  ALTERATION: "🔄",
};

const EFFECT_COLOR: Record<string, string> = {
  REDUCTION: "var(--good)",
  INCREASE: "var(--danger)",
  EXPANSION: "var(--warn)",
  ALTERATION: "var(--accent)",
};

function HardwareImpactChip({ impact }: { impact: HardwareImpact }) {
  const icon = EFFECT_ICON[impact.effect] ?? "•";
  const color = EFFECT_COLOR[impact.effect] ?? "var(--fg-muted)";
  return (
    <span
      className="hw-impact-chip"
      style={{ color, borderColor: color }}
      title={`${impact.type} · ${impact.effect}`}
    >
      {icon} {impact.type} · {impact.effect}
    </span>
  );
}

// ─── Synergy note callout ───────────────────────────────────────────────────
// Renders a single {severity, title, detail} note as a callout box. Info notes
// get a blue 💡 tint (architectural advice); warning notes get an amber ⚠️ tint
// (footguns, common mistakes). Shown below the markdown body.

function SynergyNoteCard({ note }: { note: SynergyNote }) {
  const isWarning = note.severity === "warning";
  const icon = isWarning ? "⚠️" : "💡";
  const color = isWarning ? "var(--warn)" : "var(--accent)";
  return (
    <div
      className="synergy-note"
      style={{ borderColor: color }}
    >
      <span className="synergy-note-icon">{icon}</span>
      <div className="synergy-note-body">
        <div className="synergy-note-title" style={{ color }}>{note.title}</div>
        <div className="synergy-note-detail">{note.detail}</div>
      </div>
    </div>
  );
}
