import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { parseDate } from "@/lib/logic";
import { listInvoicesWithLineItems } from "@/lib/stripe";

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
  itemsByKey: Record<string, SyncedStripeLineItem>;
};

type EnsureSyncInput = {
  startDate: string;
  endDate: string;
  force?: boolean;
};

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
    itemsByKey: {},
  };
}

async function readStore(): Promise<SyncStore> {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as SyncStore;
    if (!parsed || parsed.version !== 1 || !parsed.itemsByKey) return emptyStore();
    return parsed;
  } catch {
    return emptyStore();
  }
}

async function writeStore(store: SyncStore) {
  await fs.mkdir(dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(store), "utf8");
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
    const coversRequestedRange =
      store.lastSyncStartTs > 0 &&
      store.lastSyncEndTs > 0 &&
      store.lastSyncStartTs <= clampedStartTs &&
      store.lastSyncEndTs >= endTs;

    // Fast path: if we already cover the requested range, do not re-sync on report calls.
    // Historical Stripe invoice data is effectively immutable for this use-case.
    if (!input.force && coversRequestedRange) {
      return {
        synced: false,
        reason: "range-covered",
        updatedAtTs: store.updatedAtTs,
        syncedInvoices: 0,
      };
    }

    const isFresh = !input.force && nowTs() - store.updatedAtTs <= SYNC_FRESHNESS_MS;
    if (isFresh && store.lastSyncStartTs > 0 && store.lastSyncEndTs > 0) {
      return {
        synced: false,
        reason: "fresh-cache",
        updatedAtTs: store.updatedAtTs,
        syncedInvoices: 0,
      };
    }

    const invoices = await listInvoicesWithLineItems({
      createdGte: Math.floor(clampedStartTs / 1000),
      createdLte: Math.floor(endTs / 1000),
      maxInvoices: SYNC_MAX_INVOICES_PER_RUN,
    });

    const nextStore: SyncStore = {
      ...store,
      updatedAtTs: nowTs(),
      lastSyncStartTs:
        store.lastSyncStartTs > 0 ? Math.min(store.lastSyncStartTs, clampedStartTs) : clampedStartTs,
      lastSyncEndTs: Math.max(store.lastSyncEndTs || 0, endTs),
      itemsByKey: { ...store.itemsByKey },
    };

    for (const inv of invoices) {
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

    await writeStore(nextStore);

    return {
      synced: true,
      reason: "refreshed",
      updatedAtTs: nextStore.updatedAtTs,
      syncedInvoices: invoices.length,
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
    updatedAtTs: store.updatedAtTs,
    lastSyncStartTs: store.lastSyncStartTs,
    lastSyncEndTs: store.lastSyncEndTs,
    itemCount: Object.keys(store.itemsByKey).length,
  };
}
