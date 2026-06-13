import { useEffect } from "react";
import type { CacheStatus } from "../types";

export type ToastSpec = {
  id: number;
  text: string;
  status: CacheStatus | "error";
  durationMs: number;
};

export function Toast({ toast, onDismiss }: { toast: ToastSpec; onDismiss: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onDismiss, toast.durationMs);
    return () => window.clearTimeout(t);
  }, [toast.id, toast.durationMs, onDismiss]);

  return (
    <div className={`toast ${toast.status}`} role="status" aria-live="polite">
      <span className="dot" />
      <span>{toast.text}</span>
    </div>
  );
}

export function formatAge(ms: number | null): string {
  if (ms == null || ms < 0) return "unknown";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
