type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const VALUE_CACHE = new Map<string, CacheEntry<unknown>>();
const IN_FLIGHT = new Map<string, Promise<unknown>>();

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

export async function getOrSetCache<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
  if (ttlMs > 0) {
    const hit = VALUE_CACHE.get(key);
    if (hit && hit.expiresAt > nowMs()) return hit.value as T;
    if (hit && hit.expiresAt <= nowMs()) VALUE_CACHE.delete(key);
  }

  const inFlight = IN_FLIGHT.get(key);
  if (inFlight) return (await inFlight) as T;

  const promise = (async () => {
    const value = await producer();
    if (ttlMs > 0) {
      VALUE_CACHE.set(key, { value, expiresAt: nowMs() + ttlMs });
    }
    return value;
  })();

  IN_FLIGHT.set(key, promise);
  try {
    return await promise;
  } finally {
    IN_FLIGHT.delete(key);
  }
}
