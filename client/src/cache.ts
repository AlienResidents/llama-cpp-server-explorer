// IndexedDB mirror of the server cache for instant first paint on warm loads.
// Server-side SQLite remains the source of truth — the IDB blob is just a
// pre-rendered snapshot keyed by route.

import { openDB, type IDBPDatabase } from "idb";
import type { Option, OptionDetail } from "./types";

const DB_NAME = "llama-explorer";
const DB_VERSION = 1;
const STORE = "kv";

let dbp: Promise<IDBPDatabase> | null = null;

function database(): Promise<IDBPDatabase> {
  if (!dbp) {
    dbp = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      },
    });
  }
  return dbp;
}

type Stored<T> = { data: T; storedAt: number };

async function get<T>(key: string): Promise<Stored<T> | null> {
  try {
    const db = await database();
    const v = (await db.get(STORE, key)) as Stored<T> | undefined;
    return v ?? null;
  } catch {
    return null;
  }
}

async function set<T>(key: string, value: T): Promise<void> {
  try {
    const db = await database();
    await db.put(STORE, { data: value, storedAt: Date.now() }, key);
  } catch {
    // IndexedDB unavailable (e.g., private mode) — silent fail
  }
}

export const cache = {
  getOptions: () => get<Option[]>("options"),
  setOptions: (v: Option[]) => set("options", v),
  getDetail: (id: string) => get<OptionDetail>(`detail:${id}`),
  setDetail: (id: string, v: OptionDetail) => set(`detail:${id}`, v),
};
