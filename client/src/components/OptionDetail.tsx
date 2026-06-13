import { useState } from "react";
import type { OptionDetail } from "../types";
import { api } from "../api";
import { formatAge } from "./Toast";

export function OptionDetailView({
  detail,
  bedrockAvailable,
  onRefresh,
  onExplained,
}: {
  detail: OptionDetail;
  bedrockAvailable: boolean;
  onRefresh: () => void;
  onExplained: (newDetail: OptionDetail) => void;
}) {
  const { option, source, issues, explanation } = detail;
  const [explaining, setExplaining] = useState(false);
  const [explainErr, setExplainErr] = useState<string | null>(null);

  async function handleExplain() {
    setExplaining(true);
    setExplainErr(null);
    try {
      const res = await api.explain(option.id);
      onExplained({
        ...detail,
        explanation: {
          text: res.explanation.text,
          model: res.explanation.model,
          fetched_at: res.explanation.fetched_at,
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
        <button onClick={onRefresh}>Refresh source &amp; issues</button>
        <button onClick={handleExplain} disabled={explaining || !bedrockAvailable}>
          {explaining ? "Generating…" : explanation ? "Regenerate explanation" : "Generate plain-English explanation"}
        </button>
        {!bedrockAvailable && (
          <span style={{ color: "var(--fg-muted)", alignSelf: "center", fontSize: 12 }}>
            Bedrock unavailable — set AWS creds to enable
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
              {explanation.model} · {formatAge(explanation.fetched_at ? Date.now() - explanation.fetched_at : null)}
            </span>
          </h3>
          <div className="explanation">{explanation.text}</div>
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
