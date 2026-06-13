import type { ApiEnvelope, Meta, Option, OptionDetail, Settings } from "./types";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function send<T>(path: string, method: "POST" | "PUT", body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  meta: () => getJson<Meta>("/api/meta"),
  options: (force = false) =>
    getJson<ApiEnvelope<Option[]>>(`/api/options${force ? "?force=1" : ""}`),
  optionDetail: (id: string, force = false) =>
    getJson<ApiEnvelope<OptionDetail>>(`/api/options/${encodeURIComponent(id)}${force ? "?force=1" : ""}`),
  refresh: (id: string) =>
    send<{ ok: boolean }>(`/api/options/${encodeURIComponent(id)}/refresh`, "POST"),
  explain: (id: string) =>
    send<{ explanation: { text: string; model: string; fetched_at: number } }>(
      `/api/options/${encodeURIComponent(id)}/explain`,
      "POST",
    ),
  getSettings: () => getJson<{ settings: Settings; defaults: Settings }>("/api/settings"),
  updateSettings: (patch: Partial<Settings>) =>
    send<{ settings: Settings; defaults: Settings }>("/api/settings", "PUT", patch),
  resetSettings: () =>
    send<{ settings: Settings; defaults: Settings }>("/api/settings/reset", "POST"),
};
