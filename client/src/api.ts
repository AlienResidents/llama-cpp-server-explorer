import type {
  ApiEnvelope,
  Meta,
  Option,
  OptionDetail,
  Settings,
  Source,
} from "./types";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw await asApiError(res, path);
  return (await res.json()) as T;
}

async function send<T>(
  path: string,
  method: "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await asApiError(res, path);
  return (await res.json()) as T;
}

export class ApiError extends Error {
  status: number;
  reason: string | null;
  constructor(message: string, status: number, reason: string | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.reason = reason;
  }
}

async function asApiError(res: Response, path: string): Promise<ApiError> {
  // Try to lift the server's structured `{error, reason}` into the message; if
  // the body isn't JSON, fall back to status + path.
  let message = `${path} → HTTP ${res.status}`;
  let reason: string | null = null;
  try {
    const body = (await res.json()) as { error?: string; reason?: string };
    if (body.error) message = body.error;
    if (body.reason) reason = body.reason;
  } catch {
    // non-JSON body; keep the default message
  }
  return new ApiError(message, res.status, reason);
}

const enc = encodeURIComponent;

export const api = {
  meta: () => getJson<Meta>("/api/meta"),
  options: (sourceId: string, force = false) =>
    getJson<ApiEnvelope<Option[]>>(
      `/api/sources/${enc(sourceId)}/options${force ? "?force=1" : ""}`,
    ),
  optionDetail: (sourceId: string, id: string, force = false) =>
    getJson<ApiEnvelope<OptionDetail>>(
      `/api/sources/${enc(sourceId)}/options/${enc(id)}${force ? "?force=1" : ""}`,
    ),
  refresh: (sourceId: string, id: string) =>
    send<{ ok: boolean }>(
      `/api/sources/${enc(sourceId)}/options/${enc(id)}/refresh`,
      "POST",
    ),
  explain: (sourceId: string, id: string) =>
    send<{ explanation: { text: string; model: string; fetched_at: number } }>(
      `/api/sources/${enc(sourceId)}/options/${enc(id)}/explain`,
      "POST",
    ),
  getSettings: () => getJson<{ settings: Settings; defaults: Settings }>("/api/settings"),
  updateSettings: (patch: Partial<Settings>) =>
    send<{ settings: Settings; defaults: Settings }>("/api/settings", "PUT", patch),
  resetSettings: () =>
    send<{ settings: Settings; defaults: Settings }>("/api/settings/reset", "POST"),
  listSources: () => getJson<{ sources: Source[] }>("/api/sources"),
  createSource: (s: Omit<Source, "is_default">) =>
    send<{ source: Source }>("/api/sources", "POST", s),
  updateSource: (id: string, patch: Partial<Omit<Source, "id" | "is_default">>) =>
    send<{ source: Source }>(`/api/sources/${enc(id)}`, "PUT", patch),
  deleteSource: (id: string) =>
    send<{ ok: boolean }>(`/api/sources/${enc(id)}`, "DELETE"),
};
