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
  return s.replace(/<br\s*\/?>/gi, " · ").replace(/<[^>]+>/g, "");
}
