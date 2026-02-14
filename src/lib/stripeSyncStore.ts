import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { parseDate } from "@/lib/logic";
import { listInvoiceBatchWithLineItems } from "@/lib/stripe";

export type SyncedStripeLineItem = {
  key: string;
  invoiceId: string;
  invoiceCreatedTs: number;
  customerId: string;
  customerName: string;
  lineItemId: string;
  lineItemDescription: string;
  amountMinor: number;
  currency: string;
  quantity: number;
  periodStartTs: number;
  periodEndTs: number;
};

type SyncStore = {
  version: 1;
  updatedAtTs: number;
  lastSyncStartTs: number;
  lastSyncEndTs: number;
  activeRangeStartTs: number;
  activeRangeEndTs: number;
  nextInvoiceCursor: string | null;
  rangeExhausted: boolean;
  itemsByKey: Record<string, SyncedStripeLineItem>;
};

type EnsureSyncInput = {
  startDate: string;
  endDate: string;
  force?: boolean;
};

const STORE_KEY = process.env.STRIPE_SYNC_STORE_KEY || "arr:stripe_sync_store:v1";
const STORE_PATH = process.env.STRIPE_SYNC_STORE_PATH || "/tmp/arr-stripe-sync-store.json";
const MAX_HISTORY_DAYS = Number(process.env.STRIPE_SYNC_MAX_HISTORY_DAYS || "800");
const SYNC_FRESHNESS_MS = Number(process.env.STRIPE_SYNC_FRESHNESS_MS || "900000");
const SYNC_MAX_INVOICES_PER_RUN = Number(process.env.STRIPE_SYNC_MAX_INVOICES_PER_RUN || "120");

let writeLock: Promise<void> = Promise.resolve();

function nowTs() {
  return Date.now();
}

function emptyStore(): SyncStore {
  return {
    version: 1,
    updatedAtTs: 0,
    lastSyncStartTs: 0,
    lastSyncEndTs: 0,
    activeRangeStartTs: 0,
    activeRangeEndTs: 0,
    nextInvoiceCursor: null,
    rangeExhausted: false,
    itemsByKey: {},
  };
}

function parseStore(raw: string | null | undefined): SyncStore {
  if (!raw) return emptyStore();
  try {
    const parsed = JSON.parse(raw) as Partial<SyncStore> | null;
    if (!parsed || parsed.version !== 1 || !parsed.itemsByKey) return emptyStore();
    return {
      version: 1,
      updatedAtTs: Number(parsed.updatedAtTs || 0),
      lastSyncStartTs: Number(parsed.lastSyncStartTs || 0),
      lastSyncEndTs: Number(parsed.lastSyncEndTs || 0),
      activeRangeStartTs: Number(parsed.activeRangeStartTs || 0),
      activeRangeEndTs: Number(parsed.activeRangeEndTs || 0),
      nextInvoiceCursor: parsed.nextInvoiceCursor || null,
      rangeExhausted: !!parsed.rangeExhausted,
      itemsByKey: parsed.itemsByKey || {},
    };
  } catch {
    return emptyStore();
  }
}

function hasKvConfig() {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

async function kvCommand(args: string[]) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Missing KV_REST_API_URL or KV_REST_API_TOKEN");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`KV command failed HTTP ${res.status}: ${text}`);
  }

  const parsed = text ? (JSON.parse(text) as { result?: unknown; error?: string }) : {};
  if (parsed.error) {
    throw new Error(`KV command error: ${parsed.error}`);
  }
  return parsed.result;
}

async function readStoreLocal(): Promise<SyncStore> {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    return parseStore(raw);
  } catch {
    return emptyStore();
  }
}

async function writeStoreLocal(store: SyncStore) {
  await fs.mkdir(dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(store), "utf8");
}

async function readStore(): Promise<SyncStore> {
  if (hasKvConfig()) {
    const result = await kvCommand(["GET", STORE_KEY]);
    return parseStore(typeof result === "string" ? result : null);
  }
  return readStoreLocal();
}

async function writeStore(store: SyncStore) {
  if (hasKvConfig()) {
    await kvCommand(["SET", STORE_KEY, JSON.stringify(store)]);
    return;
  }
  await writeStoreLocal(store);
}

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeLock.then(fn, fn);
  writeLock = run.then(() => undefined, () => undefined);
  return run;
}

function startOfDayTs(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

function endOfDayTs(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
}

function clampHistoryStartTs(ts: number) {
  const floor = nowTs() - MAX_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  return Math.max(ts, floor);
}

function parseRange(startDate: string, endDate: string) {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new Error("Invalid startDate/endDate");
  }

  const startTs = startOfDayTs(start);
  const endTs = endOfDayTs(end);
  if (endTs < startTs) throw new Error("endDate must be >= startDate");
  return { startTs, endTs };
}

function overlaps(periodStartTs: number, periodEndTs: number, rangeStartTs: number, rangeEndTs: number) {
  return periodStartTs <= rangeEndTs && periodEndTs >= rangeStartTs;
}

export async function ensureStripeSyncForRange(input: EnsureSyncInput) {
  const { startTs, endTs } = parseRange(input.startDate, input.endDate);
  const clampedStartTs = clampHistoryStartTs(startTs);

  return withWriteLock(async () => {
    const store = await readStore();
    const sameActiveRange = store.activeRangeStartTs === clampedStartTs && store.activeRangeEndTs === endTs;

    const nextStore: SyncStore = {
      ...store,
      activeRangeStartTs: sameActiveRange ? store.activeRangeStartTs : clampedStartTs,
      activeRangeEndTs: sameActiveRange ? store.activeRangeEndTs : endTs,
      nextInvoiceCursor: sameActiveRange ? store.nextInvoiceCursor : null,
      rangeExhausted: sameActiveRange ? store.rangeExhausted : false,
    };

    const coversRequestedRange =
      nextStore.rangeExhausted &&
      nextStore.activeRangeStartTs > 0 &&
      nextStore.activeRangeEndTs > 0 &&
      nextStore.activeRangeStartTs <= clampedStartTs &&
      nextStore.activeRangeEndTs >= endTs;

    if (!input.force && coversRequestedRange) {
      return {
        synced: false,
        reason: "range-covered",
        updatedAtTs: store.updatedAtTs,
        syncedInvoices: 0,
      };
    }

    const isFresh = !input.force && nowTs() - nextStore.updatedAtTs <= SYNC_FRESHNESS_MS;
    if (isFresh && nextStore.rangeExhausted) {
      return {
        synced: false,
        reason: "fresh-cache",
        updatedAtTs: nextStore.updatedAtTs,
        syncedInvoices: 0,
      };
    }

    const batch = await listInvoiceBatchWithLineItems({
      createdGte: Math.floor(nextStore.activeRangeStartTs / 1000),
      createdLte: Math.floor(nextStore.activeRangeEndTs / 1000),
      maxInvoices: SYNC_MAX_INVOICES_PER_RUN,
      startingAfter: nextStore.nextInvoiceCursor,
    });

    nextStore.updatedAtTs = nowTs();
    nextStore.itemsByKey = { ...nextStore.itemsByKey };

    for (const inv of batch.invoicesWithLines) {
      const invoiceCreatedTs = Number(inv.invoice.created || 0) * 1000;
      const invoiceId = String(inv.invoice.id || "");
      const currency = String(inv.invoice.currency || "").trim().toLowerCase();

      for (const line of inv.lineItems) {
        const periodStartTs = Number(line.period?.start || 0) * 1000;
        const periodEndTs = Number(line.period?.end || 0) * 1000 - 1;
        if (!(periodStartTs > 0) || !(periodEndTs > 0)) continue;

        const lineItemId = String(line.id || "").trim();
        if (!lineItemId) continue;

        const key = `${invoiceId}:${lineItemId}`;

        nextStore.itemsByKey[key] = {
          key,
          invoiceId,
          invoiceCreatedTs,
          customerId: inv.customerId || "",
          customerName: inv.customerName || "",
          lineItemId,
          lineItemDescription: String(line.description || ""),
          amountMinor: Number(line.amount || 0),
          currency,
          quantity: Number(line.quantity || 1),
          periodStartTs,
          periodEndTs,
        };
      }
    }

    nextStore.nextInvoiceCursor = batch.hasMore ? batch.nextStartingAfter : null;
    nextStore.rangeExhausted = !batch.hasMore;

    if (nextStore.rangeExhausted) {
      nextStore.lastSyncStartTs =
        nextStore.lastSyncStartTs > 0
          ? Math.min(nextStore.lastSyncStartTs, nextStore.activeRangeStartTs)
          : nextStore.activeRangeStartTs;
      nextStore.lastSyncEndTs = Math.max(nextStore.lastSyncEndTs || 0, nextStore.activeRangeEndTs);
    }

    await writeStore(nextStore);

    return {
      synced: true,
      reason: "refreshed",
      updatedAtTs: nextStore.updatedAtTs,
      syncedInvoices: batch.fetchedInvoices,
      hasMore: batch.hasMore,
      nextCursor: batch.nextStartingAfter,
    };
  });
}

export async function getSyncedStripeLineItemsForRange(startDate: string, endDate: string) {
  const { startTs, endTs } = parseRange(startDate, endDate);
  const store = await readStore();
  const out: SyncedStripeLineItem[] = [];

  for (const item of Object.values(store.itemsByKey)) {
    if (overlaps(item.periodStartTs, item.periodEndTs, startTs, endTs)) {
      out.push(item);
    }
  }

  return out;
}

export async function getStripeSyncStoreStats() {
  const store = await readStore();
  return {
    storage: hasKvConfig() ? "vercel_kv" : "local_tmp",
    updatedAtTs: store.updatedAtTs,
    lastSyncStartTs: store.lastSyncStartTs,
    lastSyncEndTs: store.lastSyncEndTs,
    activeRangeStartTs: store.activeRangeStartTs,
    activeRangeEndTs: store.activeRangeEndTs,
    nextInvoiceCursor: store.nextInvoiceCursor,
    rangeExhausted: store.rangeExhausted,
    itemCount: Object.keys(store.itemsByKey).length,
  };
}
