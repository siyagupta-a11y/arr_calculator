import { createHash } from "node:crypto";
import { BlobNotFoundError, del, head, list, put } from "@vercel/blob";
import { blobFetchHeaders, blobReadWriteToken, hasBlobToken } from "@/lib/blobConfig";

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

type PersistentCacheEnvelope<T> = {
  key: string;
  cachedAt: number;
  expiresAt: number;
  value: T;
};

export type ServerCacheSyncStatus = {
  startedAtUtc: string;
  finishedAtUtc: string;
  tookMs: number;
  warmup: boolean;
  okTaskCount: number;
  failedTaskCount: number;
  totalTaskCount: number;
};

export type ServerCacheSyncRunState = {
  startedAtUtc: string;
  warmup: boolean;
  syncMode: "fast" | "full";
  dirtyMode: boolean;
  dirtyMonthKeys: string[];
  totalTasks: number;
  nextTaskIndex: number;
  okTaskCount: number;
  failedTaskCount: number;
  failedTaskKeys: string[];
  taskKeys: string[];
  done: boolean;
  updatedAtUtc: string;
};

const VALUE_CACHE = new Map<string, CacheEntry<unknown>>();
const IN_FLIGHT = new Map<string, Promise<unknown>>();
let CACHE_GENERATION = 1;
const BLOB_PREFIX = String(process.env.SERVER_RESPONSE_CACHE_BLOB_PREFIX || "arr/runtime-cache/v1")
  .trim()
  .replace(/^\/+|\/+$/g, "");
const SYNC_STATUS_BLOB_PATH = `${BLOB_PREFIX}/_sync-status.json`;
const SYNC_RUN_STATE_BLOB_PATH = `${BLOB_PREFIX}/_sync-run-state.json`;

const persistentCacheStats = {
  hits: 0,
  misses: 0,
  writes: 0,
  readErrors: 0,
  writeErrors: 0,
};

function nowMs() {
  return Date.now();
}

export function readTtlMs(envName: string, fallbackMs: number) {
  const raw = Number(process.env[envName] || "");
  if (!Number.isFinite(raw) || raw < 0) return fallbackMs;
  return Math.floor(raw);
}

function stableStringifyValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const t = typeof value;
  if (t === "number" || t === "boolean" || t === "bigint") return String(value);
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringifyValue(item)).join(",")}]`;
  if (t === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringifyValue(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export function stableStringify(value: unknown) {
  return stableStringifyValue(value);
}

function cacheKeyWithGeneration(key: string) {
  return `${CACHE_GENERATION}:${key}`;
}

function canUsePersistentBlobCache() {
  if (!hasBlobToken()) return false;
  const raw = String(process.env.SERVER_RESPONSE_CACHE_BLOB_ENABLED || "true").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no";
}

function cacheBlobPathForScopedKey(scopedKey: string) {
  const digest = createHash("sha256").update(scopedKey).digest("hex");
  return `${BLOB_PREFIX}/${digest}.json`;
}

async function readPersistentBlobEntry<T>(scopedKey: string): Promise<PersistentCacheEnvelope<T> | null> {
  if (!canUsePersistentBlobCache()) return null;

  const token = blobReadWriteToken();
  if (!token) return null;

  const pathname = cacheBlobPathForScopedKey(scopedKey);
  try {
    const meta = await head(pathname, { token });
    const res = await fetch(meta.url, {
      headers: blobFetchHeaders(),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = (await res.json()) as Partial<PersistentCacheEnvelope<T>>;
    if (!parsed || typeof parsed !== "object") return null;
    if (String(parsed.key || "") !== scopedKey) return null;
    if (!Number.isFinite(Number(parsed.expiresAt || 0))) return null;
    return {
      key: scopedKey,
      cachedAt: Number(parsed.cachedAt || 0),
      expiresAt: Number(parsed.expiresAt || 0),
      value: parsed.value as T,
    };
  } catch (error: unknown) {
    if (error instanceof BlobNotFoundError) return null;
    persistentCacheStats.readErrors += 1;
    return null;
  }
}

async function writePersistentBlobEntry<T>(scopedKey: string, value: T, expiresAt: number) {
  if (!canUsePersistentBlobCache()) return;
  const token = blobReadWriteToken();
  if (!token) return;

  const pathname = cacheBlobPathForScopedKey(scopedKey);
  const payload: PersistentCacheEnvelope<T> = {
    key: scopedKey,
    cachedAt: nowMs(),
    expiresAt,
    value,
  };
  try {
    await put(pathname, JSON.stringify(payload), {
      access: "private",
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: "application/json; charset=utf-8",
      token,
    });
    persistentCacheStats.writes += 1;
  } catch {
    persistentCacheStats.writeErrors += 1;
  }
}

export async function clearPersistentServerResponseCache() {
  if (!canUsePersistentBlobCache()) {
    return {
      enabled: false,
      deleted: 0,
      scanned: 0,
      pages: 0,
      prefix: BLOB_PREFIX,
    };
  }

  const token = blobReadWriteToken();
  if (!token) {
    return {
      enabled: false,
      deleted: 0,
      scanned: 0,
      pages: 0,
      prefix: BLOB_PREFIX,
    };
  }

  let cursor: string | undefined;
  let hasMore = true;
  let deleted = 0;
  let scanned = 0;
  let pages = 0;

  while (hasMore) {
    const page = await list({
      token,
      prefix: `${BLOB_PREFIX}/`,
      cursor,
      limit: 1000,
    });
    pages += 1;
    const pathnames = (page.blobs || []).map((blob) => String(blob.pathname || "")).filter(Boolean);
    scanned += pathnames.length;
    if (pathnames.length) {
      await del(pathnames, { token });
      deleted += pathnames.length;
    }
    hasMore = Boolean(page.hasMore);
    cursor = page.cursor;
  }

  return { enabled: true, deleted, scanned, pages, prefix: BLOB_PREFIX };
}

export async function writeServerCacheSyncStatus(status: ServerCacheSyncStatus) {
  if (!canUsePersistentBlobCache()) return false;
  const token = blobReadWriteToken();
  if (!token) return false;
  try {
    await put(SYNC_STATUS_BLOB_PATH, JSON.stringify(status), {
      access: "private",
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: "application/json; charset=utf-8",
      token,
    });
    return true;
  } catch {
    return false;
  }
}

export async function readServerCacheSyncStatus(): Promise<ServerCacheSyncStatus | null> {
  if (!canUsePersistentBlobCache()) return null;
  const token = blobReadWriteToken();
  if (!token) return null;
  try {
    const meta = await head(SYNC_STATUS_BLOB_PATH, { token });
    const res = await fetch(meta.url, {
      headers: blobFetchHeaders(),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const parsed = (await res.json()) as Partial<ServerCacheSyncStatus>;
    if (!parsed || typeof parsed !== "object") return null;
    const startedAtUtc = String(parsed.startedAtUtc || "").trim();
    const finishedAtUtc = String(parsed.finishedAtUtc || "").trim();
    const tookMs = Number(parsed.tookMs || 0);
    const warmup = Boolean(parsed.warmup);
    const okTaskCount = Number(parsed.okTaskCount || 0);
    const failedTaskCount = Number(parsed.failedTaskCount || 0);
    const totalTaskCount = Number(parsed.totalTaskCount || 0);
    if (!startedAtUtc || !finishedAtUtc || !Number.isFinite(tookMs)) return null;
    return {
      startedAtUtc,
      finishedAtUtc,
      tookMs,
      warmup,
      okTaskCount: Number.isFinite(okTaskCount) ? okTaskCount : 0,
      failedTaskCount: Number.isFinite(failedTaskCount) ? failedTaskCount : 0,
      totalTaskCount: Number.isFinite(totalTaskCount) ? totalTaskCount : 0,
    };
  } catch (error: unknown) {
    if (error instanceof BlobNotFoundError) return null;
    return null;
  }
}

export async function writeServerCacheSyncRunState(state: ServerCacheSyncRunState) {
  if (!canUsePersistentBlobCache()) return false;
  const token = blobReadWriteToken();
  if (!token) return false;
  try {
    await put(SYNC_RUN_STATE_BLOB_PATH, JSON.stringify(state), {
      access: "private",
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: "application/json; charset=utf-8",
      token,
    });
    return true;
  } catch {
    return false;
  }
}

export async function readServerCacheSyncRunState(): Promise<ServerCacheSyncRunState | null> {
  if (!canUsePersistentBlobCache()) return null;
  const token = blobReadWriteToken();
  if (!token) return null;
  try {
    const meta = await head(SYNC_RUN_STATE_BLOB_PATH, { token });
    const res = await fetch(meta.url, {
      headers: blobFetchHeaders(),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const parsed = (await res.json()) as Partial<ServerCacheSyncRunState>;
    if (!parsed || typeof parsed !== "object") return null;
    const startedAtUtc = String(parsed.startedAtUtc || "").trim();
    const syncMode = String(parsed.syncMode || "").trim().toLowerCase() === "full" ? "full" : "fast";
    const updatedAtUtc = String(parsed.updatedAtUtc || "").trim();
    if (!startedAtUtc || !updatedAtUtc) return null;
    return {
      startedAtUtc,
      warmup: Boolean(parsed.warmup),
      syncMode,
      dirtyMode: Boolean(parsed.dirtyMode),
      dirtyMonthKeys: Array.isArray(parsed.dirtyMonthKeys) ? parsed.dirtyMonthKeys.map((v) => String(v || "")) : [],
      totalTasks: Number.isFinite(Number(parsed.totalTasks || 0)) ? Math.max(0, Number(parsed.totalTasks || 0)) : 0,
      nextTaskIndex: Number.isFinite(Number(parsed.nextTaskIndex || 0))
        ? Math.max(0, Number(parsed.nextTaskIndex || 0))
        : 0,
      okTaskCount: Number.isFinite(Number(parsed.okTaskCount || 0)) ? Math.max(0, Number(parsed.okTaskCount || 0)) : 0,
      failedTaskCount: Number.isFinite(Number(parsed.failedTaskCount || 0))
        ? Math.max(0, Number(parsed.failedTaskCount || 0))
        : 0,
      failedTaskKeys: Array.isArray(parsed.failedTaskKeys) ? parsed.failedTaskKeys.map((v) => String(v || "")) : [],
      taskKeys: Array.isArray(parsed.taskKeys) ? parsed.taskKeys.map((v) => String(v || "")) : [],
      done: Boolean(parsed.done),
      updatedAtUtc,
    };
  } catch (error: unknown) {
    if (error instanceof BlobNotFoundError) return null;
    return null;
  }
}

export function serverResponseCacheStats() {
  return {
    generation: CACHE_GENERATION,
    inMemoryEntries: VALUE_CACHE.size,
    inFlightEntries: IN_FLIGHT.size,
    persistentEnabled: canUsePersistentBlobCache(),
    persistentPrefix: BLOB_PREFIX,
    persistent: { ...persistentCacheStats },
  };
}

export function clearServerResponseCache() {
  const entriesBefore = VALUE_CACHE.size;
  const inFlightBefore = IN_FLIGHT.size;
  VALUE_CACHE.clear();
  IN_FLIGHT.clear();
  CACHE_GENERATION += 1;
  return {
    clearedEntries: entriesBefore,
    clearedInFlight: inFlightBefore,
    generation: CACHE_GENERATION,
  };
}

export async function getOrSetCache<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
  const scopedKey = cacheKeyWithGeneration(key);
  if (ttlMs > 0) {
    const hit = VALUE_CACHE.get(scopedKey);
    if (hit && hit.expiresAt > nowMs()) return hit.value as T;
    if (hit && hit.expiresAt <= nowMs()) VALUE_CACHE.delete(scopedKey);

    const persistentHit = await readPersistentBlobEntry<T>(scopedKey);
    if (persistentHit && persistentHit.expiresAt > nowMs()) {
      VALUE_CACHE.set(scopedKey, {
        value: persistentHit.value,
        expiresAt: persistentHit.expiresAt,
      });
      persistentCacheStats.hits += 1;
      return persistentHit.value;
    }
    persistentCacheStats.misses += 1;
  }

  const inFlight = IN_FLIGHT.get(scopedKey);
  if (inFlight) return (await inFlight) as T;

  const promise = (async () => {
    const value = await producer();
    if (ttlMs > 0) {
      const expiresAt = nowMs() + ttlMs;
      VALUE_CACHE.set(scopedKey, { value, expiresAt });
      await writePersistentBlobEntry(scopedKey, value, expiresAt);
    }
    return value;
  })();

  IN_FLIGHT.set(scopedKey, promise);
  try {
    return await promise;
  } finally {
    IN_FLIGHT.delete(scopedKey);
  }
}
