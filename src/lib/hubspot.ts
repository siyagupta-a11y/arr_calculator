// lib/hubspot.ts
import { HubspotDeal, HubspotLineItem, HubspotSearchResponse } from "./types";

const HUBSPOT_BASE = "https://api.hubapi.com";
const HUBSPOT_ASSOC_CONCURRENCY = 4;
const HUBSPOT_ASSOC_BATCH_CONCURRENCY = 2;
const HUBSPOT_BATCH_READ_CONCURRENCY = 2;
const HUBSPOT_MAX_RETRIES = 6;
const HUBSPOT_BASE_BACKOFF_MS = 400;
const HUBSPOT_CACHE_TTL_MS = Number(process.env.HUBSPOT_CACHE_TTL_MS || "120000");

type CacheEntry<T> = { value: T; expiresAt: number };

const DEALS_CACHE = new Map<string, CacheEntry<HubspotDeal[]>>();
const DEAL_ASSOC_CACHE = new Map<string, CacheEntry<string[]>>();
const LINE_ITEM_CACHE = new Map<string, CacheEntry<HubspotLineItem>>();

function getToken() {
  const t = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!t) throw new Error("Missing HUBSPOT_PRIVATE_APP_TOKEN in .env.local");
  return t;
}

function nowMs() {
  return Date.now();
}

function readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= nowMs()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function writeCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T) {
  cache.set(key, { value, expiresAt: nowMs() + HUBSPOT_CACHE_TTL_MS });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(raw: string | null) {
  if (!raw) return null;
  const s = raw.trim();
  const asNum = Number(s);
  if (!Number.isNaN(asNum) && asNum >= 0) return asNum * 1000;
  const asDate = Date.parse(s);
  if (Number.isNaN(asDate)) return null;
  const delta = asDate - Date.now();
  return delta > 0 ? delta : 0;
}

async function hsFetch(url: string, init?: RequestInit) {
  for (let attempt = 0; attempt <= HUBSPOT_MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${getToken()}`,
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
      cache: "no-store",
    });

    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : {};

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === HUBSPOT_MAX_RETRIES) {
      throw new Error(`HubSpot API error ${res.status}: ${text}`);
    }

    const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
    const backoffMs = HUBSPOT_BASE_BACKOFF_MS * Math.pow(2, attempt);
    const jitterMs = Math.floor(Math.random() * 250);
    const waitMs = Math.max(retryAfterMs ?? 0, backoffMs + jitterMs);
    await sleep(waitMs);
  }

  throw new Error("HubSpot API request failed unexpectedly");
}

type DealSearchPayload = {
  filterGroups: Array<{ filters: Array<{ propertyName: string; operator: "EQ"; value: string }> }>;
  properties: string[];
  limit: number;
  after?: string;
};

type DealLineItemAssociationResponse = {
  results?: Array<{ id?: string | number }>;
};

type DealLineItemBatchAssociationResponse = {
  results?: Array<{
    from?: { id?: string | number };
    to?: Array<{ toObjectId?: string | number; id?: string | number }>;
  }>;
};

export type HubspotDealPropertyUpdate = {
  dealId: string;
  properties: Record<string, string | number | boolean>;
};

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const safeLimit = Math.max(1, Math.min(limit, items.length));
  const out: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const idx = next;
      next++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: safeLimit }, () => worker()));
  return out;
}

export async function fetchDealsInStage(properties: string[], dealstage: string) {
  const cacheKey = `${dealstage}|${[...properties].sort().join(",")}`;
  const cached = readCache(DEALS_CACHE, cacheKey);
  if (cached) return cached;

  const url = `${HUBSPOT_BASE}/crm/v3/objects/deals/search`;
  let after: string | null = null;
  const results: HubspotDeal[] = [];

  while (true) {
    const payload: DealSearchPayload = {
      filterGroups: [{ filters: [{ propertyName: "dealstage", operator: "EQ", value: dealstage }] }],
      properties,
      limit: 100,
    };
    if (after) payload.after = after;

    const json: HubspotSearchResponse<HubspotDeal> = await hsFetch(url, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    results.push(...(json.results || []));
    after = json.paging?.next?.after ?? null;
    if (!after) break;
  }

  writeCache(DEALS_CACHE, cacheKey, results);
  return results;
}

export async function fetchLineItemIdsForDeal(dealId: string) {
  const cached = readCache(DEAL_ASSOC_CACHE, dealId);
  if (cached) return cached;

  const url = `${HUBSPOT_BASE}/crm/v3/objects/deals/${dealId}/associations/line_items`;
  const json = (await hsFetch(url)) as DealLineItemAssociationResponse;
  const ids = (json.results || [])
    .map((r) => String(r.id || ""))
    .filter((id) => !!id);
  writeCache(DEAL_ASSOC_CACHE, dealId, ids);
  return ids;
}

export async function fetchLineItemIdsForDeals(dealIds: string[]) {
  const dedupedDealIds = Array.from(new Set(dealIds.filter((id) => !!id)));
  const out = new Map<string, string[]>();

  const pending: string[] = [];
  for (const dealId of dedupedDealIds) {
    const cached = readCache(DEAL_ASSOC_CACHE, dealId);
    if (cached) out.set(dealId, cached);
    else pending.push(dealId);
  }

  if (pending.length) {
    let resolvedByBatch = false;
    try {
      const batchUrl = `${HUBSPOT_BASE}/crm/v4/associations/deals/line_items/batch/read`;
      const chunkSize = 100;
      const chunks: string[][] = [];
      for (let i = 0; i < pending.length; i += chunkSize) chunks.push(pending.slice(i, i + chunkSize));

      const chunkResults = await mapWithConcurrency(
        chunks,
        HUBSPOT_ASSOC_BATCH_CONCURRENCY,
        async (chunk): Promise<DealLineItemBatchAssociationResponse> => {
          const json = (await hsFetch(batchUrl, {
            method: "POST",
            body: JSON.stringify({ inputs: chunk.map((id) => ({ id })) }),
          })) as DealLineItemBatchAssociationResponse;
          return json;
        },
      );

      const seenInBatch = new Set<string>();
      for (const chunkResult of chunkResults) {
        for (const assoc of chunkResult.results || []) {
          const dealId = String(assoc.from?.id || "");
          if (!dealId) continue;
          seenInBatch.add(dealId);
          const ids = (assoc.to || [])
            .map((t) => String(t.toObjectId || t.id || ""))
            .filter((id) => !!id);
          out.set(dealId, ids);
          writeCache(DEAL_ASSOC_CACHE, dealId, ids);
        }
      }

      for (const dealId of pending) {
        if (!seenInBatch.has(dealId)) {
          out.set(dealId, []);
          writeCache(DEAL_ASSOC_CACHE, dealId, []);
        }
      }
      resolvedByBatch = true;
    } catch {
      resolvedByBatch = false;
    }

    if (!resolvedByBatch) {
      const pairs = await mapWithConcurrency(pending, HUBSPOT_ASSOC_CONCURRENCY, async (dealId) => {
        const ids = await fetchLineItemIdsForDeal(dealId);
        return { dealId, ids };
      });
      for (const p of pairs) out.set(p.dealId, p.ids);
    }
  }

  return dealIds.map((dealId) => ({ dealId, ids: out.get(dealId) || [] }));
}

export async function batchReadLineItems(ids: string[], properties: string[]) {
  const url = `${HUBSPOT_BASE}/crm/v3/objects/line_items/batch/read`;
  const map = new Map<string, HubspotLineItem>();

  const dedupedIds = Array.from(new Set(ids.filter((id) => !!id)));
  const missingIds: string[] = [];

  for (const id of dedupedIds) {
    const cached = readCache(LINE_ITEM_CACHE, id);
    if (cached) map.set(id, cached);
    else missingIds.push(id);
  }

  if (!missingIds.length) return map;

  const chunkSize = 100;
  const chunks: string[][] = [];
  for (let i = 0; i < missingIds.length; i += chunkSize) chunks.push(missingIds.slice(i, i + chunkSize));

  const chunkResults = await mapWithConcurrency(chunks, HUBSPOT_BATCH_READ_CONCURRENCY, async (chunk) => {
    const json = await hsFetch(url, {
      method: "POST",
      body: JSON.stringify({
        properties,
        inputs: chunk.map((id) => ({ id })),
      }),
    });
    return (json.results || []) as HubspotLineItem[];
  });

  for (const lis of chunkResults) {
    lis.forEach((li) => {
      const id = String(li.id);
      map.set(id, li);
      writeCache(LINE_ITEM_CACHE, id, li);
    });
  }

  return map;
}

export async function batchUpdateDealProperties(updates: HubspotDealPropertyUpdate[]) {
  const deduped = new Map<string, Record<string, string | number | boolean>>();
  for (const u of updates) {
    if (!u.dealId || !u.properties) continue;
    deduped.set(u.dealId, u.properties);
  }

  const inputs = Array.from(deduped.entries()).map(([id, properties]) => ({
    id,
    properties,
  }));
  if (!inputs.length) return;

  const url = `${HUBSPOT_BASE}/crm/v3/objects/deals/batch/update`;
  const chunkSize = 100;
  for (let i = 0; i < inputs.length; i += chunkSize) {
    const chunk = inputs.slice(i, i + chunkSize);
    await hsFetch(url, {
      method: "POST",
      body: JSON.stringify({ inputs: chunk }),
    });
  }
}
