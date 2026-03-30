import { BlobNotFoundError, head, put } from "@vercel/blob";
import { promises as fs } from "node:fs";
import path from "node:path";
import { blobAccessMode, blobFetchHeaders, blobReadWriteToken, hasBlobToken } from "@/lib/blobConfig";

export type CurrencyLayerFxStoreStorageKind = "vercel_blob" | "local_tmp";

export type CurrencyLayerMonthlyFxEntry = {
  rate: number;
  dateUsed: string;
  status?: "ok" | "rate_limited" | "error";
  errorCode?: string;
  errorInfo?: string;
  nextRetryAt?: number;
  updatedAt: number;
};

type CurrencyLayerMonthlyFxStoreV1 = {
  version: 1;
  entries: Record<string, CurrencyLayerMonthlyFxEntry>;
};

const STORE_BLOB_PATH =
  process.env.CURRENCYLAYER_MONTHLY_FX_BLOB_PATH || "arr/fx/currencylayer-monthly-v1.json";
const STORE_PATH =
  process.env.CURRENCYLAYER_MONTHLY_FX_STORE_PATH || "/tmp/arr-currencylayer-monthly-v1.json";

function canUseBlobStorage() {
  return hasBlobToken();
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeEntry(value: unknown): CurrencyLayerMonthlyFxEntry | null {
  if (!value || typeof value !== "object") return null;
  const parsed = value as Partial<CurrencyLayerMonthlyFxEntry>;
  const rate = Number(parsed.rate);
  const dateUsed = clean(parsed.dateUsed);
  const status = clean(parsed.status).toLowerCase();
  const errorCode = clean(parsed.errorCode);
  const errorInfo = clean(parsed.errorInfo);
  const nextRetryAt = Number(parsed.nextRetryAt || 0);
  const updatedAt = Number(parsed.updatedAt || Date.now());
  if (!dateUsed) return null;
  return {
    rate: Number.isFinite(rate) ? rate : 0,
    dateUsed,
    status:
      status === "ok" || status === "rate_limited" || status === "error"
        ? (status as CurrencyLayerMonthlyFxEntry["status"])
        : undefined,
    errorCode: errorCode || undefined,
    errorInfo: errorInfo || undefined,
    nextRetryAt: Number.isFinite(nextRetryAt) && nextRetryAt > 0 ? nextRetryAt : undefined,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
}

function normalizeEntries(value: unknown): Record<string, CurrencyLayerMonthlyFxEntry> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, CurrencyLayerMonthlyFxEntry> = {};
  for (const [rawKey, rawEntry] of Object.entries(value as Record<string, unknown>)) {
    const key = clean(rawKey).toUpperCase();
    if (!key) continue;
    const normalized = normalizeEntry(rawEntry);
    if (!normalized) continue;
    out[key] = normalized;
  }
  return out;
}

function parseStore(raw: string): Record<string, CurrencyLayerMonthlyFxEntry> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const candidate = parsed as Partial<CurrencyLayerMonthlyFxStoreV1> & {
      entries?: unknown;
    };
    if (candidate.version === 1) return normalizeEntries(candidate.entries || {});
    if ("entries" in candidate) return normalizeEntries(candidate.entries || {});
    return normalizeEntries(candidate);
  } catch {
    return {};
  }
}

function encodeStore(entries: Record<string, CurrencyLayerMonthlyFxEntry>) {
  const payload: CurrencyLayerMonthlyFxStoreV1 = {
    version: 1,
    entries: normalizeEntries(entries),
  };
  return JSON.stringify(payload);
}

async function loadFromBlob() {
  try {
    const token = blobReadWriteToken();
    if (!token) return {};
    const meta = await head(STORE_BLOB_PATH, { token });
    if (!meta?.url) return {};
    const res = await fetch(meta.url, {
      cache: "no-store",
      headers: blobFetchHeaders(),
    });
    if (!res.ok) return {};
    const text = await res.text();
    return parseStore(text);
  } catch (error: unknown) {
    if (error instanceof BlobNotFoundError) return {};
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("not found") || message.includes("404")) return {};
    throw error;
  }
}

async function saveToBlob(entries: Record<string, CurrencyLayerMonthlyFxEntry>) {
  const token = blobReadWriteToken();
  if (!token) throw new Error("Missing blob read/write token");
  await put(STORE_BLOB_PATH, encodeStore(entries), {
    token,
    access: blobAccessMode(),
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: "application/json",
  });
}

async function loadFromFile() {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    return parseStore(raw);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw error;
  }
}

async function saveToFile(entries: Record<string, CurrencyLayerMonthlyFxEntry>) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, encodeStore(entries), "utf8");
}

export async function loadCurrencyLayerMonthlyFxEntries(): Promise<{
  storage: CurrencyLayerFxStoreStorageKind;
  entries: Record<string, CurrencyLayerMonthlyFxEntry>;
}> {
  if (canUseBlobStorage()) {
    const entries = await loadFromBlob();
    return { storage: "vercel_blob", entries };
  }
  const entries = await loadFromFile();
  return { storage: "local_tmp", entries };
}

export async function saveCurrencyLayerMonthlyFxEntries(
  entries: Record<string, CurrencyLayerMonthlyFxEntry>,
): Promise<{
  storage: CurrencyLayerFxStoreStorageKind;
}> {
  const normalized = normalizeEntries(entries);
  if (canUseBlobStorage()) {
    await saveToBlob(normalized);
    return { storage: "vercel_blob" };
  }
  await saveToFile(normalized);
  return { storage: "local_tmp" };
}
