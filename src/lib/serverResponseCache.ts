type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const VALUE_CACHE = new Map<string, CacheEntry<unknown>>();
const IN_FLIGHT = new Map<string, Promise<unknown>>();
let CACHE_GENERATION = 1;

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
  }

  const inFlight = IN_FLIGHT.get(scopedKey);
  if (inFlight) return (await inFlight) as T;

  const promise = (async () => {
    const value = await producer();
    if (ttlMs > 0) {
      VALUE_CACHE.set(scopedKey, { value, expiresAt: nowMs() + ttlMs });
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
