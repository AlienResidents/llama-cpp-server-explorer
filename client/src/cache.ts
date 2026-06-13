// IndexedDB mirror of the server cache for instant first paint on warm loads.
// Server-side SQLite remains the source of truth — the IDB blob is just a
// pre-rendered snapshot keyed by (source_id, route).

import { openDB, type IDBPDatabase } from "idb";
import type { Option, OptionDetail } from "./types";

const DB_NAME = "llama-explorer";
const DB_VERSION = 2;
const STORE = "kv";

let dbp: Promise<IDBPDatabase> | null = null;

function database(): Promise<IDBPDatabase> {
  if (!dbp) {
    dbp = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        // v1 -> v2: keys gained a source-id prefix. Wipe the v1 entries so we
        // don't accidentally show data from the wrong source.
        if (oldVersion < 2 && db.objectStoreNames.contains(STORE)) {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).clear();
        }
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

const optionsKey = (sourceId: string) => `options:${sourceId}`;
const detailKey = (sourceId: string, optId: string) => `detail:${sourceId}:${optId}`;

export const cache = {
  getOptions: (sourceId: string) => get<Option[]>(optionsKey(sourceId)),
  setOptions: (sourceId: string, v: Option[]) => set(optionsKey(sourceId), v),
  getDetail: (sourceId: string, id: string) => get<OptionDetail>(detailKey(sourceId, id)),
  setDetail: (sourceId: string, id: string, v: OptionDetail) =>
    set(detailKey(sourceId, id), v),
};
