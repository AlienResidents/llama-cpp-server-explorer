import { useMemo } from "react";
import type { Option } from "../types";

export function OptionList({
  options,
  activeId,
  filter,
  onSelect,
}: {
  options: Option[];
  activeId: string | null;
  filter: string;
  onSelect: (id: string) => void;
}) {
  const grouped = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const filtered = f
      ? options.filter(
          (o) =>
            o.flags.some((fl) => fl.toLowerCase().includes(f)) ||
            o.description.toLowerCase().includes(f) ||
            (o.envVar?.toLowerCase().includes(f) ?? false),
        )
      : options;
    const map = new Map<string, Option[]>();
    for (const o of filtered) {
      const arr = map.get(o.category) ?? [];
      arr.push(o);
      map.set(o.category, arr);
    }
    return [...map.entries()];
  }, [options, filter]);

  return (
    <nav className="list">
      {grouped.length === 0 && (
        <div style={{ padding: 16, color: "var(--fg-muted)" }}>No matches.</div>
      )}
      {grouped.map(([cat, items]) => (
        <div key={cat}>
          <div className="category">{cat} ({items.length})</div>
          {items.map((o) => (
            <div
              key={o.id}
              className={`item ${activeId === o.id ? "active" : ""}`}
              onClick={() => onSelect(o.id)}
            >
              <div className="flags">{o.flags.join(", ")}</div>
              <div className="desc">{stripHtml(o.description)}</div>
            </div>
          ))}
        </div>
      ))}
    </nav>
  );
}

function stripHtml(s: string): string {
  // Convert <br/> separators to a visual divider, then let the browser parse
  // the rest as HTML and read it back as plain text. Using DOMParser avoids
  // the multi-character-sanitization pitfall of `replace(/<[^>]+>/g, '')` —
  // see CodeQL js/incomplete-multi-character-sanitization (alert #1).
  const withSeparators = s.replace(/<br\s*\/?>/gi, " \u00B7 ");
  if (typeof DOMParser === "undefined") {
    // SSR / non-browser fallback: iterate the regex strip until stable so
    // residue from overlapping matches can't survive.
    let prev = "";
    let next = withSeparators;
    while (prev !== next) {
      prev = next;
      next = next.replace(/<[^>]+>/g, "");
    }
    return next;
  }
  const doc = new DOMParser().parseFromString(withSeparators, "text/html");
  return doc.body.textContent ?? "";
}
