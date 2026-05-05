import { NextResponse } from "next/server";
import {
  generateCombinedAllSubsReport,
  type CombinedAllSubsCombineMode,
  type CombinedAllSubsResponse,
  type CombinedAllSubsRequest,
} from "@/lib/combinedAllSubsReport";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";
import {
  listLatestPrecomputedPayloadRows,
  readPrecomputedPayload,
  writePrecomputedPayload,
} from "@/lib/precomputedPayloadStore";

export const runtime = "nodejs";
export const maxDuration = 300;
const CACHE_TTL_MS = readTtlMs("API_COMBINED_ALL_SUBS_CACHE_TTL_MS", 24 * 60 * 60 * 1000);
const MONTHLY_CANONICAL_START_DATE = (() => {
  const configured = String(process.env.COMBINED_BILLING_OVERVIEW_MONTHLY_CACHE_START || "2023-01-01").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(configured) ? configured : "2023-01-01";
})();
const PRECOMPUTED_ENDPOINT_KEY = "combined-all-subs:monthly";
type CombinedAllSubsApiRequest = Partial<CombinedAllSubsRequest> & {
  precomputeRangeOnly?: boolean;
  forceRefreshPrecomputed?: boolean;
};

const CACHE_KEY_PREFIX = "api:combined-all-subs:";

function monthKey(value: string) {
  return String(value || "").trim().slice(0, 7);
}

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function parseIsoDateOnly(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month ||
    parsed.getUTCDate() !== day
  ) return null;
  return parsed;
}

function toIsoDateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function monthKeysBetween(startDate: string, endDate: string) {
  const start = parseIsoDateOnly(startDate);
  const end = parseIsoDateOnly(endDate);
  if (!start || !end || end.getTime() < start.getTime()) return [];
  const keys: string[] = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor.getTime() <= endMonth.getTime()) {
    keys.push(toIsoDateOnly(cursor).slice(0, 7));
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return keys;
}

function maxIsoDate(a: string, b: string) {
  return a >= b ? a : b;
}

function minIsoDate(a: string, b: string) {
  return a <= b ? a : b;
}

function normalizeComparablePayload(payload: Partial<CombinedAllSubsRequest>) {
  return {
    combineMode: String(payload.combineMode || "grouped") as CombinedAllSubsCombineMode,
    displayMode: String(payload.displayMode || "arr") as CombinedAllSubsRequest["displayMode"],
    planGrain: String(payload.planGrain || "monthly") as CombinedAllSubsRequest["planGrain"],
    includePlanData: payload.includePlanData,
    groupedMatchStrategy: payload.groupedMatchStrategy,
    includeSalesAssist: payload.includeSalesAssist,
  };
}

function parsePayloadFromCacheKey(cacheKey: string): CombinedAllSubsRequest | null {
  const raw = String(cacheKey || "");
  if (!raw.startsWith(CACHE_KEY_PREFIX)) return null;
  const encoded = raw.slice(CACHE_KEY_PREFIX.length);
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(encoded) as Partial<CombinedAllSubsRequest>;
    const startDate = String(parsed.startDate || "").trim();
    const endDate = String(parsed.endDate || "").trim();
    if (!isIsoDate(startDate) || !isIsoDate(endDate)) return null;
    return {
      startDate,
      endDate,
      combineMode: String(parsed.combineMode || "grouped") as CombinedAllSubsCombineMode,
      displayMode: String(parsed.displayMode || "arr") as CombinedAllSubsRequest["displayMode"],
      planGrain: String(parsed.planGrain || "monthly") as CombinedAllSubsRequest["planGrain"],
      includePlanData: parsed.includePlanData,
      groupedMatchStrategy: parsed.groupedMatchStrategy,
      includeSalesAssist: parsed.includeSalesAssist,
    };
  } catch {
    return null;
  }
}

function mergeUnique(values: string[]) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function mergeMap<T>(
  current: Record<string, T> | undefined,
  incoming: Record<string, T> | undefined,
) {
  if (!current && !incoming) return undefined;
  return {
    ...(current || {}),
    ...(incoming || {}),
  };
}

function filterPeriodMap<T>(values: Record<string, T> | undefined, keys: Set<string>) {
  const out: Record<string, T> = {};
  for (const key of keys) {
    if (values && Object.prototype.hasOwnProperty.call(values, key)) out[key] = values[key];
  }
  return out;
}

function sliceMonthlyResponse(
  canonical: CombinedAllSubsResponse,
  startDate: string,
  endDate: string,
): CombinedAllSubsResponse {
  const startMonth = monthKey(startDate);
  const endMonth = monthKey(endDate);
  const periods = (canonical.periods || []).filter((period) => {
    const key = String(period.key || "");
    return key >= startMonth && key <= endMonth;
  });
  const periodKeys = new Set(periods.map((period) => String(period.key || "")));
  const totalsByPeriod = (canonical.totalsByPeriod || []).filter((period) => periodKeys.has(String(period.key || "")));
  const rows = (canonical.rows || []).map((row) => ({
    ...row,
    hubspotValuesByPeriod: filterPeriodMap(row.hubspotValuesByPeriod, periodKeys),
    stripeValuesByPeriod: filterPeriodMap(row.stripeValuesByPeriod, periodKeys),
    valuesByPeriod: filterPeriodMap(row.valuesByPeriod, periodKeys),
    hubspotPlansByPeriod: filterPeriodMap(row.hubspotPlansByPeriod, periodKeys),
    stripePlansByPeriod: filterPeriodMap(row.stripePlansByPeriod, periodKeys),
    plansByPeriod: filterPeriodMap(row.plansByPeriod, periodKeys),
    salesAssistByPeriod: filterPeriodMap(row.salesAssistByPeriod, periodKeys),
    deskEarlyAccessByPeriod: filterPeriodMap(row.deskEarlyAccessByPeriod, periodKeys),
  }));
  return {
    ...canonical,
    startDate,
    endDate,
    periods,
    totalsByPeriod,
    rows,
  };
}

async function buildCanonicalFromChunkRows(
  canonicalPayload: CombinedAllSubsRequest,
): Promise<CombinedAllSubsResponse | null> {
  const entries = await listLatestPrecomputedPayloadRows<CombinedAllSubsResponse>(
    PRECOMPUTED_ENDPOINT_KEY,
    {
      startDate: canonicalPayload.startDate,
      endDate: canonicalPayload.endDate,
      grain: "monthly",
      cacheKeyPrefix: CACHE_KEY_PREFIX,
      limit: 3000,
    },
  ).catch(() => []);
  if (!entries.length) return null;

  const canonicalComparable = stableStringify(normalizeComparablePayload(canonicalPayload));
  const periodLabelByKey = new Map<string, string>();
  const rowsById = new Map<string, CombinedAllSubsResponse["rows"][number]>();
  const warningSet = new Set<string>();
  let targetCurrency = "";

  for (const entry of entries) {
    const candidatePayload = parsePayloadFromCacheKey(entry.cacheKey);
    if (!candidatePayload) continue;
    const comparable = stableStringify(normalizeComparablePayload(candidatePayload));
    if (comparable !== canonicalComparable) continue;
    if (!entry.payload) continue;
    const effectiveStart = maxIsoDate(canonicalPayload.startDate, candidatePayload.startDate);
    const effectiveEnd = minIsoDate(canonicalPayload.endDate, candidatePayload.endDate);
    if (effectiveEnd < effectiveStart) continue;
    const sliced = sliceMonthlyResponse(entry.payload, effectiveStart, effectiveEnd);
    if (!targetCurrency) targetCurrency = String(sliced.targetCurrency || "");
    for (const warning of sliced.warnings || []) {
      const value = String(warning || "").trim();
      if (value) warningSet.add(value);
    }
    for (const period of sliced.periods || []) {
      const key = String(period.key || "").trim();
      if (!key) continue;
      periodLabelByKey.set(key, String(period.label || key));
    }
    for (const row of sliced.rows || []) {
      const rowId = String(row.id || "").trim();
      if (!rowId) continue;
      const existing = rowsById.get(rowId);
      if (!existing) {
        rowsById.set(rowId, {
          ...row,
          stripeKeys: mergeUnique(row.stripeKeys || []),
          matchedStripeKeys: mergeUnique(row.matchedStripeKeys || []),
          hubspotValuesByPeriod: { ...(row.hubspotValuesByPeriod || {}) },
          stripeValuesByPeriod: { ...(row.stripeValuesByPeriod || {}) },
          valuesByPeriod: { ...(row.valuesByPeriod || {}) },
          hubspotPlansByPeriod: row.hubspotPlansByPeriod ? { ...row.hubspotPlansByPeriod } : undefined,
          stripePlansByPeriod: row.stripePlansByPeriod ? { ...row.stripePlansByPeriod } : undefined,
          plansByPeriod: row.plansByPeriod ? { ...row.plansByPeriod } : undefined,
          salesAssistByPeriod: row.salesAssistByPeriod ? { ...row.salesAssistByPeriod } : undefined,
          deskEarlyAccessByPeriod: row.deskEarlyAccessByPeriod ? { ...row.deskEarlyAccessByPeriod } : undefined,
        });
        continue;
      }
      existing.salesAssist = existing.salesAssist === "yes" || row.salesAssist === "yes" ? "yes" : "no";
      existing.stripeKeys = mergeUnique([...(existing.stripeKeys || []), ...(row.stripeKeys || [])]);
      existing.matchedStripeKeys = mergeUnique([...(existing.matchedStripeKeys || []), ...(row.matchedStripeKeys || [])]);
      existing.hubspotValuesByPeriod = mergeMap(existing.hubspotValuesByPeriod, row.hubspotValuesByPeriod) || {};
      existing.stripeValuesByPeriod = mergeMap(existing.stripeValuesByPeriod, row.stripeValuesByPeriod) || {};
      existing.valuesByPeriod = mergeMap(existing.valuesByPeriod, row.valuesByPeriod) || {};
      existing.hubspotPlansByPeriod = mergeMap(existing.hubspotPlansByPeriod, row.hubspotPlansByPeriod);
      existing.stripePlansByPeriod = mergeMap(existing.stripePlansByPeriod, row.stripePlansByPeriod);
      existing.plansByPeriod = mergeMap(existing.plansByPeriod, row.plansByPeriod);
      existing.salesAssistByPeriod = mergeMap(existing.salesAssistByPeriod, row.salesAssistByPeriod);
      existing.deskEarlyAccessByPeriod = mergeMap(existing.deskEarlyAccessByPeriod, row.deskEarlyAccessByPeriod);
    }
  }

  const expectedMonths = monthKeysBetween(canonicalPayload.startDate, canonicalPayload.endDate);
  if (!expectedMonths.length) return null;
  if (expectedMonths.some((key) => !periodLabelByKey.has(key))) return null;

  const periods = expectedMonths.map((key) => ({ key, label: periodLabelByKey.get(key) || key }));
  const rows = Array.from(rowsById.values()).sort((a, b) => {
    const sourceCmp = String(a.source || "").localeCompare(String(b.source || ""));
    if (sourceCmp !== 0) return sourceCmp;
    const customerCmp = String(a.customerLabel || "").localeCompare(String(b.customerLabel || ""));
    if (customerCmp !== 0) return customerCmp;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });
  const totalsByPeriod = periods.map((period) => ({
    key: period.key,
    label: period.label,
    total: rows.reduce((sum, row) => sum + Number(row.valuesByPeriod?.[period.key] || 0), 0),
  }));

  const hubspotRows = rows.filter((row) => row.source === "hubspot_account");
  const stripeOnlyRows = rows.filter((row) => row.source === "stripe_only_customer");
  const matchedStripeCustomerKeys = new Set<string>();
  const allStripeCustomerKeys = new Set<string>();
  for (const row of rows) {
    for (const key of row.stripeKeys || []) allStripeCustomerKeys.add(String(key || "").trim());
    for (const key of row.matchedStripeKeys || []) matchedStripeCustomerKeys.add(String(key || "").trim());
  }

  return {
    startDate: canonicalPayload.startDate,
    endDate: canonicalPayload.endDate,
    combineMode: canonicalPayload.combineMode || "grouped",
    displayMode: canonicalPayload.displayMode || "arr",
    planGrain: canonicalPayload.planGrain || "monthly",
    targetCurrency: targetCurrency || "USD",
    warnings: Array.from(warningSet),
    periods,
    totalsByPeriod,
    rows,
    summary: {
      hubspotAccounts: hubspotRows.length,
      hubspotAccountsWithStripeMatch: hubspotRows.filter((row) => (row.matchedStripeKeys || []).length > 0).length,
      stripeCustomers: allStripeCustomerKeys.size || stripeOnlyRows.length,
      stripeCustomersMatched: matchedStripeCustomerKeys.size,
      stripeCustomersOnly: stripeOnlyRows.length,
    },
  };
}

async function validateAndRun(body: CombinedAllSubsApiRequest) {
  const payload: CombinedAllSubsRequest = {
    startDate: String(body.startDate || ""),
    endDate: String(body.endDate || ""),
    combineMode: String(body.combineMode || "grouped") as CombinedAllSubsCombineMode,
    displayMode: String(body.displayMode || "arr") as CombinedAllSubsRequest["displayMode"],
    planGrain: String(body.planGrain || "monthly") as CombinedAllSubsRequest["planGrain"],
    includePlanData: body.includePlanData,
    groupedMatchStrategy: body.groupedMatchStrategy,
    includeSalesAssist: body.includeSalesAssist,
  };
  const precomputeRangeOnly = body.precomputeRangeOnly === true;
  const forceRefreshPrecomputed = body.forceRefreshPrecomputed === true;
  const key = `api:combined-all-subs:${stableStringify(payload)}`;
  if (precomputeRangeOnly) {
    return getOrSetCache(key, CACHE_TTL_MS, async () => {
      if (!forceRefreshPrecomputed) {
        const precomputed = await readPrecomputedPayload<CombinedAllSubsResponse>(PRECOMPUTED_ENDPOINT_KEY, key).catch(
          () => null,
        );
        if (precomputed) return precomputed;
      }
      const built = await generateCombinedAllSubsReport(payload);
      await writePrecomputedPayload({
        endpoint_key: PRECOMPUTED_ENDPOINT_KEY,
        cache_key: key,
        start_date: payload.startDate,
        end_date: payload.endDate,
        grain: String(payload.planGrain || "monthly"),
        payload_json: JSON.stringify(built),
      }).catch(() => null);
      return built;
    });
  }
  if (payload.planGrain === "monthly" && !precomputeRangeOnly) {
    const today = new Date().toISOString().slice(0, 10);
    const canonicalStartDate = payload.startDate < MONTHLY_CANONICAL_START_DATE
      ? payload.startDate
      : MONTHLY_CANONICAL_START_DATE;
    const canonicalEndDate = payload.endDate > today ? payload.endDate : today;
    const canonicalPayload: CombinedAllSubsRequest = {
      ...payload,
      startDate: canonicalStartDate,
      endDate: canonicalEndDate,
    };
    const canonicalKey = `api:combined-all-subs:${stableStringify(canonicalPayload)}`;
    const canonical = await getOrSetCache(canonicalKey, CACHE_TTL_MS, async () => {
      const precomputed = await readPrecomputedPayload<CombinedAllSubsResponse>(
        PRECOMPUTED_ENDPOINT_KEY,
        canonicalKey,
      ).catch(() => null);
      if (precomputed) return precomputed;
      const stitched = await buildCanonicalFromChunkRows(canonicalPayload);
      if (stitched) {
        await writePrecomputedPayload({
          endpoint_key: PRECOMPUTED_ENDPOINT_KEY,
          cache_key: canonicalKey,
          start_date: canonicalStartDate,
          end_date: canonicalEndDate,
          grain: "monthly",
          payload_json: JSON.stringify(stitched),
        }).catch(() => null);
        return stitched;
      }
      const built = await generateCombinedAllSubsReport(canonicalPayload);
      await writePrecomputedPayload({
        endpoint_key: PRECOMPUTED_ENDPOINT_KEY,
        cache_key: canonicalKey,
        start_date: canonicalStartDate,
        end_date: canonicalEndDate,
        grain: "monthly",
        payload_json: JSON.stringify(built),
      }).catch(() => null);
      return built;
    });
    return sliceMonthlyResponse(canonical, payload.startDate, payload.endDate);
  }
  return getOrSetCache(key, CACHE_TTL_MS, async () => {
    if (!forceRefreshPrecomputed) {
      const precomputed = await readPrecomputedPayload<CombinedAllSubsResponse>(PRECOMPUTED_ENDPOINT_KEY, key).catch(
        () => null,
      );
      if (precomputed) return precomputed;
    }
    const built = await generateCombinedAllSubsReport(payload);
    await writePrecomputedPayload({
      endpoint_key: PRECOMPUTED_ENDPOINT_KEY,
      cache_key: key,
      start_date: payload.startDate,
      end_date: payload.endDate,
      grain: String(payload.planGrain || "monthly"),
      payload_json: JSON.stringify(built),
    }).catch(() => null);
    return built;
  });
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as CombinedAllSubsApiRequest;
    const report = await validateAndRun(body);
    return NextResponse.json(report);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") ||
      message.includes("endDate must be >= startDate")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const report = await validateAndRun({
      startDate: searchParams.get("startDate") || "",
      endDate: searchParams.get("endDate") || "",
      combineMode: String(searchParams.get("combineMode") || "grouped") as CombinedAllSubsCombineMode,
      displayMode: String(searchParams.get("displayMode") || "arr") as CombinedAllSubsRequest["displayMode"],
      planGrain: String(searchParams.get("planGrain") || "monthly") as CombinedAllSubsRequest["planGrain"],
    });
    return NextResponse.json(report);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") ||
      message.includes("endDate must be >= startDate")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
