import { BlobNotFoundError, head, put } from "@vercel/blob";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { QuickBooksStorageKind } from "@/lib/quickbooksStore";

type QuickBooksCacDefaults = {
  selectedAccountIds: string[];
  updatedAt: number;
};

const STORE_BLOB_PATH =
  process.env.QUICKBOOKS_CAC_DEFAULTS_BLOB_PATH || "arr/quickbooks/cac-defaults-v1.json";
const STORE_PATH =
  process.env.QUICKBOOKS_CAC_DEFAULTS_STORE_PATH || "/tmp/arr-quickbooks-cac-defaults-v1.json";

function canUseBlobStorage() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function normalizeIds(values: string[]) {
  return Array.from(
    new Set(
      (values || [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

function parseDefaults(raw: string): QuickBooksCacDefaults {
  try {
    const parsed = JSON.parse(raw) as Partial<QuickBooksCacDefaults>;
    const selectedAccountIds = normalizeIds(
      Array.isArray(parsed.selectedAccountIds) ? parsed.selectedAccountIds.map((value) => String(value || "")) : [],
    );
    const updatedAt =
      typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt)
        ? parsed.updatedAt
        : Date.now();
    return { selectedAccountIds, updatedAt };
  } catch {
    return { selectedAccountIds: [], updatedAt: Date.now() };
  }
}

function encodeDefaults(payload: QuickBooksCacDefaults) {
  return JSON.stringify({
    selectedAccountIds: normalizeIds(payload.selectedAccountIds),
    updatedAt: Number(payload.updatedAt) || Date.now(),
  });
}

async function loadFromBlob() {
  try {
    const meta = await head(STORE_BLOB_PATH);
    if (!meta?.url) return { selectedAccountIds: [], updatedAt: Date.now() };
    const res = await fetch(meta.url, { cache: "no-store" });
    if (!res.ok) return { selectedAccountIds: [], updatedAt: Date.now() };
    const text = await res.text();
    return parseDefaults(text);
  } catch (error: unknown) {
    if (error instanceof BlobNotFoundError) return { selectedAccountIds: [], updatedAt: Date.now() };
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("not found") || message.includes("404")) {
      return { selectedAccountIds: [], updatedAt: Date.now() };
    }
    throw error;
  }
}

async function saveToBlob(payload: QuickBooksCacDefaults) {
  await put(STORE_BLOB_PATH, encodeDefaults(payload), {
    access: "public",
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: "application/json",
  });
}

async function loadFromFile() {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    return parseDefaults(raw);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { selectedAccountIds: [], updatedAt: Date.now() };
    }
    throw error;
  }
}

async function saveToFile(payload: QuickBooksCacDefaults) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, encodeDefaults(payload), "utf8");
}

export async function loadQuickBooksCacDefaultSelection(): Promise<{
  storage: QuickBooksStorageKind;
  selectedAccountIds: string[];
  updatedAt: number;
}> {
  if (canUseBlobStorage()) {
    const payload = await loadFromBlob();
    return {
      storage: "vercel_blob",
      selectedAccountIds: normalizeIds(payload.selectedAccountIds),
      updatedAt: payload.updatedAt,
    };
  }
  const payload = await loadFromFile();
  return {
    storage: "local_tmp",
    selectedAccountIds: normalizeIds(payload.selectedAccountIds),
    updatedAt: payload.updatedAt,
  };
}

export async function saveQuickBooksCacDefaultSelection(accountIds: string[]): Promise<{
  storage: QuickBooksStorageKind;
  selectedAccountIds: string[];
  updatedAt: number;
}> {
  const payload: QuickBooksCacDefaults = {
    selectedAccountIds: normalizeIds(accountIds),
    updatedAt: Date.now(),
  };
  if (canUseBlobStorage()) {
    await saveToBlob(payload);
    return { storage: "vercel_blob", ...payload };
  }
  await saveToFile(payload);
  return { storage: "local_tmp", ...payload };
}
