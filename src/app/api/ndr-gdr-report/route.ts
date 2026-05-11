import { NextResponse } from "next/server";
import {
  generateCombinedAllSubsReport,
  type CombinedAllSubsPlan,
  type CombinedAllSubsCombineMode,
  type CombinedAllSubsRow,
  type CombinedAllSubsRequest,
} from "@/lib/combinedAllSubsReport";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";
import {
  listLatestPrecomputedPayloadRows,
  readPrecomputedPayload,
  writePrecomputedPayload,
} from "@/lib/precomputedPayloadStore";
import { isPrecomputedFactsReadEnabled, queryPrecomputedCustomerArrCurrent } from "@/lib/precomputedFactsRead";

export const runtime = "nodejs";
export const maxDuration = 300;

const CACHE_TTL_MS = readTtlMs("API_NDR_GDR_CACHE_TTL_MS", 24 * 60 * 60 * 1000);
const MONTHLY_CANONICAL_START_DATE = (() => {
  const configured = String(process.env.COMBINED_BILLING_OVERVIEW_MONTHLY_CACHE_START || "2023-01-01").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(configured) ? configured : "2023-01-01";
})();
const PRECOMPUTED_ENDPOINT_KEY = "ndr-gdr:monthly";
const CANONICAL_CACHE_KEY_PREFIX = "api:ndr-gdr:";
const RANGE_CACHE_KEY_PREFIX = "api:ndr-gdr:range:";

type RequestBody = {
  startDate?: string;
  endDate?: string;
  combineMode?: string;
  groupBy?: string;
  precomputeRangeOnly?: boolean;
};

type CohortRow = {
  cohortKey: string;
  cohortLabel: string;
  cohortCustomerCount: number;
  cohortArr: number;
  ndrByPeriod: Record<string, number | null>;
  gdrByPeriod: Record<string, number | null>;
};

type MatrixGroupBy = "overall" | "source" | "plan";

type MatrixSegment = {
  segmentKey: string;
  segmentLabel: string;
  cohorts: CohortRow[];
};

type NdrGdrResponse = {
  startDate: string;
  endDate: string;
  combineMode: CombinedAllSubsCombineMode;
  groupBy: MatrixGroupBy;
  targetCurrency: string;
  warnings: string[];
  periods: Array<{ key: string; label: string }>;
  cohorts: CohortRow[];
  segments: MatrixSegment[];
};

const PLAN_ORDER: CombinedAllSubsPlan[] = [
  "enterprise",
  "managed",
  "team",
  "plus",
  "pay_as_you_go",
  "free",
];

const PLAN_LABELS: Record<CombinedAllSubsPlan, string> = {
  enterprise: "Enterprise",
  managed: "Managed",
  team: "Team",
  plus: "Plus",
  pay_as_you_go: "Pay as you go",
  free: "Free",
};

const SOURCE_LABELS: Record<CombinedAllSubsRow["source"], string> = {
  hubspot_account: "Sales-led",
  stripe_only_customer: "Self-serve",
};

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeCombineMode(value: string | undefined): CombinedAllSubsCombineMode {
  return String(value || "").trim().toLowerCase() === "simple" ? "simple" : "grouped";
}

function normalizeGroupBy(value: string | undefined): MatrixGroupBy {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "source") return "source";
  if (normalized === "plan") return "plan";
  return "overall";
}

function round2(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizePlan(value: string | undefined): CombinedAllSubsPlan {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "enterprise") return "enterprise";
  if (normalized === "managed") return "managed";
  if (normalized === "team") return "team";
  if (normalized === "plus") return "plus";
  if (normalized === "pay_as_you_go" || normalized === "pay as you go") return "pay_as_you_go";
  return "free";
}

function monthKey(value: string) {
  return String(value || "").trim().slice(0, 7);
}

function filterByPeriodKeys(
  values: Record<string, number | null>,
  allowedKeys: Set<string>,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (allowedKeys.has(key)) out[key] = value;
  }
  return out;
}

function sliceNdrGdrResponse(report: NdrGdrResponse, startDate: string, endDate: string): NdrGdrResponse {
  const startMonth = monthKey(startDate);
  const endMonth = monthKey(endDate);
  const periods = (report.periods || []).filter((period) => period.key >= startMonth && period.key <= endMonth);
  const allowedPeriodKeys = new Set(periods.map((period) => period.key));
  const mapCohorts = (cohorts: CohortRow[]) =>
    (cohorts || [])
      .filter((cohort) => allowedPeriodKeys.has(cohort.cohortKey))
      .map((cohort) => ({
        ...cohort,
        ndrByPeriod: filterByPeriodKeys(cohort.ndrByPeriod, allowedPeriodKeys),
        gdrByPeriod: filterByPeriodKeys(cohort.gdrByPeriod, allowedPeriodKeys),
      }));
  const segments = (report.segments || []).map((segment) => ({
    ...segment,
    cohorts: mapCohorts(segment.cohorts || []),
  }));
  return {
    ...report,
    startDate,
    endDate,
    periods,
    segments,
    cohorts: segments[0]?.cohorts || [],
  };
}

function planForPeriod(row: CombinedAllSubsRow, periodKey: string): CombinedAllSubsPlan {
  return normalizePlan(row.plansByPeriod?.[periodKey] || "free");
}

function monthKeysBetween(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() < start.getTime()) return [];
  const keys: string[] = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor.getTime() <= endMonth.getTime()) {
    keys.push(cursor.toISOString().slice(0, 7));
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return keys;
}

function normalizeComparablePayload(payload: {
  combineMode: CombinedAllSubsCombineMode;
  groupBy: MatrixGroupBy;
}) {
  return {
    combineMode: payload.combineMode,
    groupBy: payload.groupBy,
  };
}

function parsePayloadFromCacheKey(cacheKey: string) {
  const raw = String(cacheKey || "");
  let encoded = "";
  if (raw.startsWith(RANGE_CACHE_KEY_PREFIX)) {
    encoded = raw.slice(RANGE_CACHE_KEY_PREFIX.length);
  } else if (raw.startsWith(CANONICAL_CACHE_KEY_PREFIX)) {
    encoded = raw.slice(CANONICAL_CACHE_KEY_PREFIX.length);
  } else {
    return null;
  }
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(encoded) as Partial<{
      startDate: string;
      endDate: string;
      combineMode: string;
      groupBy: string;
    }>;
    const startDate = String(parsed.startDate || "").trim();
    const endDate = String(parsed.endDate || "").trim();
    if (!isIsoDate(startDate) || !isIsoDate(endDate)) return null;
    return {
      startDate,
      endDate,
      combineMode: normalizeCombineMode(parsed.combineMode),
      groupBy: normalizeGroupBy(parsed.groupBy),
    };
  } catch {
    return null;
  }
}

async function buildCanonicalFromChunkRows(canonicalPayload: {
  startDate: string;
  endDate: string;
  combineMode: CombinedAllSubsCombineMode;
  groupBy: MatrixGroupBy;
}): Promise<NdrGdrResponse | null> {
  const entries = await listLatestPrecomputedPayloadRows<NdrGdrResponse>(
    PRECOMPUTED_ENDPOINT_KEY,
    {
      startDate: canonicalPayload.startDate,
      endDate: canonicalPayload.endDate,
      grain: "monthly",
      cacheKeyPrefix: RANGE_CACHE_KEY_PREFIX,
      limit: 3000,
    },
  ).catch(() => []);
  if (!entries.length) return null;

  const comparable = stableStringify(normalizeComparablePayload(canonicalPayload));
  const periodLabelByKey = new Map<string, string>();
  const segmentsByKey = new Map<string, { segmentKey: string; segmentLabel: string; cohortsByKey: Map<string, CohortRow> }>();
  const warningSet = new Set<string>();
  let targetCurrency = "";

  for (const entry of entries) {
    const keyPayload = parsePayloadFromCacheKey(entry.cacheKey);
    if (!keyPayload) continue;
    if (stableStringify(normalizeComparablePayload(keyPayload)) !== comparable) continue;
    if (!entry.payload) continue;
    const effectiveStart = keyPayload.startDate > canonicalPayload.startDate ? keyPayload.startDate : canonicalPayload.startDate;
    const effectiveEnd = keyPayload.endDate < canonicalPayload.endDate ? keyPayload.endDate : canonicalPayload.endDate;
    if (effectiveEnd < effectiveStart) continue;
    const sliced = sliceNdrGdrResponse(entry.payload, effectiveStart, effectiveEnd);
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
    const segments = (sliced.segments && sliced.segments.length)
      ? sliced.segments
      : [{ segmentKey: "overall", segmentLabel: "Overall", cohorts: sliced.cohorts || [] }];
    for (const segment of segments) {
      const segmentKey = String(segment.segmentKey || "overall");
      if (!segmentsByKey.has(segmentKey)) {
        segmentsByKey.set(segmentKey, {
          segmentKey,
          segmentLabel: String(segment.segmentLabel || segmentKey),
          cohortsByKey: new Map<string, CohortRow>(),
        });
      }
      const bucket = segmentsByKey.get(segmentKey)!;
      for (const cohort of segment.cohorts || []) {
        const cohortKey = String(cohort.cohortKey || "").trim();
        if (!cohortKey) continue;
        const existing = bucket.cohortsByKey.get(cohortKey);
        if (!existing) {
          bucket.cohortsByKey.set(cohortKey, {
            cohortKey,
            cohortLabel: String(cohort.cohortLabel || cohortKey),
            cohortCustomerCount: Number(cohort.cohortCustomerCount || 0),
            cohortArr: Number(cohort.cohortArr || 0),
            ndrByPeriod: { ...(cohort.ndrByPeriod || {}) },
            gdrByPeriod: { ...(cohort.gdrByPeriod || {}) },
          });
          continue;
        }
        existing.cohortCustomerCount = Number(cohort.cohortCustomerCount || existing.cohortCustomerCount || 0);
        existing.cohortArr = Number(cohort.cohortArr || existing.cohortArr || 0);
        existing.ndrByPeriod = { ...(existing.ndrByPeriod || {}), ...(cohort.ndrByPeriod || {}) };
        existing.gdrByPeriod = { ...(existing.gdrByPeriod || {}), ...(cohort.gdrByPeriod || {}) };
      }
    }
  }

  const expectedMonths = monthKeysBetween(canonicalPayload.startDate, canonicalPayload.endDate);
  if (!expectedMonths.length) return null;
  if (expectedMonths.some((key) => !periodLabelByKey.has(key))) return null;

  const periods = expectedMonths.map((key) => ({ key, label: periodLabelByKey.get(key) || key }));
  const segments = Array.from(segmentsByKey.values())
    .map((segment) => ({
      segmentKey: segment.segmentKey,
      segmentLabel: segment.segmentLabel,
      cohorts: expectedMonths
        .map((monthKey) => segment.cohortsByKey.get(monthKey))
        .filter((cohort): cohort is CohortRow => Boolean(cohort))
        .map((cohort) => ({
          ...cohort,
          ndrByPeriod: { ...(cohort.ndrByPeriod || {}) },
          gdrByPeriod: { ...(cohort.gdrByPeriod || {}) },
        })),
    }))
    .filter((segment) => segment.cohorts.length === expectedMonths.length)
    .sort((a, b) => a.segmentKey.localeCompare(b.segmentKey));
  if (!segments.length) return null;

  return {
    startDate: canonicalPayload.startDate,
    endDate: canonicalPayload.endDate,
    combineMode: canonicalPayload.combineMode,
    groupBy: canonicalPayload.groupBy,
    targetCurrency: targetCurrency || "USD",
    warnings: Array.from(warningSet),
    periods,
    cohorts: segments[0].cohorts,
    segments,
  };
}

async function buildNdrGdrFromPrecomputedFacts(payload: {
  startDate: string;
  endDate: string;
  groupBy: MatrixGroupBy;
}): Promise<NdrGdrResponse | null> {
  const monthKeys = monthKeysBetween(payload.startDate, payload.endDate);
  if (!monthKeys.length) return null;
  const periods = monthKeys.map((key) => ({ key, label: key }));
  const rows = await queryPrecomputedCustomerArrCurrent({
    startDate: payload.startDate,
    endDate: payload.endDate,
    grain: "monthly",
  });
  if (!rows.length) return null;

  const byCustomer = new Map<string, CombinedAllSubsRow>();
  for (const factRow of rows) {
    const periodKey = String(factRow.periodDate || "").slice(0, 7);
    if (!monthKeys.includes(periodKey)) continue;
    const rowId = `${factRow.source}:${factRow.customerKey}`;
    let row = byCustomer.get(rowId);
    if (!row) {
      row = {
        id: rowId,
        source: factRow.source,
        customerLabel: factRow.customerLabel || factRow.customerKey,
        accountId: "",
        accountName: "",
        salesAssist: "no",
        stripeKeys: [],
        matchedStripeKeys: [],
        hubspotValuesByPeriod: {},
        stripeValuesByPeriod: {},
        valuesByPeriod: {},
        plansByPeriod: {},
      };
      byCustomer.set(rowId, row);
    }
    row.valuesByPeriod[periodKey] = round2(Number(factRow.arrEnd || 0));
    if (factRow.source === "hubspot_account") {
      row.hubspotValuesByPeriod[periodKey] = round2(Number(factRow.arrEnd || 0));
      row.stripeValuesByPeriod[periodKey] = row.stripeValuesByPeriod[periodKey] || 0;
    } else {
      row.stripeValuesByPeriod[periodKey] = round2(Number(factRow.arrEnd || 0));
      row.hubspotValuesByPeriod[periodKey] = row.hubspotValuesByPeriod[periodKey] || 0;
    }
    row.plansByPeriod![periodKey] = normalizePlan(factRow.plan);
  }

  const normalizedRows = Array.from(byCustomer.values());
  for (const row of normalizedRows) {
    row.plansByPeriod = row.plansByPeriod || {};
    for (const monthKey of monthKeys) {
      row.valuesByPeriod[monthKey] = round2(Number(row.valuesByPeriod[monthKey] || 0));
      row.hubspotValuesByPeriod[monthKey] = round2(Number(row.hubspotValuesByPeriod[monthKey] || 0));
      row.stripeValuesByPeriod[monthKey] = round2(Number(row.stripeValuesByPeriod[monthKey] || 0));
      row.plansByPeriod[monthKey] = row.plansByPeriod[monthKey] || "free";
    }
  }

  const segments: MatrixSegment[] =
    payload.groupBy === "source"
      ? (["hubspot_account", "stripe_only_customer"] as const).map((source) => ({
          segmentKey: source === "hubspot_account" ? "salesled" : "selfserve",
          segmentLabel: SOURCE_LABELS[source],
          cohorts: buildCohorts(
            periods,
            normalizedRows.filter((row) => row.source === source),
          ),
        }))
      : payload.groupBy === "plan"
        ? buildPlanSegmentsFast(periods, normalizedRows)
        : [
            {
              segmentKey: "overall",
              segmentLabel: "Overall",
              cohorts: buildCohorts(periods, normalizedRows),
            },
          ];

  return {
    startDate: payload.startDate,
    endDate: payload.endDate,
    combineMode: "grouped" as const,
    groupBy: payload.groupBy,
    targetCurrency: "USD",
    warnings: [],
    periods,
    cohorts: segments[0]?.cohorts || [],
    segments,
  } satisfies NdrGdrResponse;
}

function buildCohorts(
  periods: Array<{ key: string; label: string }>,
  rows: CombinedAllSubsRow[],
  includeRowInCohort?: (row: CombinedAllSubsRow, cohortPeriodKey: string) => boolean,
): CohortRow[] {
  const periodKeys = periods.map((period) => period.key);
  const cohortAgg = periods.map((period, idx) => ({
    cohortKey: period.key,
    cohortLabel: period.label,
    cohortIndex: idx,
    cohortCustomerCount: 0,
    cohortArr: 0,
    ndrNumeratorByPeriod: new Map<string, number>(),
    gdrNumeratorByPeriod: new Map<string, number>(),
  }));

  for (const row of rows) {
    const values = row.valuesByPeriod || {};
    for (let cohortIdx = 0; cohortIdx < periodKeys.length; cohortIdx += 1) {
      const cohortKey = periodKeys[cohortIdx];
      if (includeRowInCohort && !includeRowInCohort(row, cohortKey)) continue;
      const cohortArrForCustomer = Math.max(0, Number(values[cohortKey] || 0));
      if (cohortArrForCustomer <= 0) continue;

      const agg = cohortAgg[cohortIdx];
      agg.cohortCustomerCount += 1;
      agg.cohortArr = round2(agg.cohortArr + cohortArrForCustomer);

      for (let observedIdx = cohortIdx; observedIdx < periodKeys.length; observedIdx += 1) {
        const observedKey = periodKeys[observedIdx];
        const observedArrForCustomer = Math.max(0, Number(values[observedKey] || 0));

        agg.ndrNumeratorByPeriod.set(
          observedKey,
          round2((agg.ndrNumeratorByPeriod.get(observedKey) || 0) + observedArrForCustomer),
        );
        agg.gdrNumeratorByPeriod.set(
          observedKey,
          round2((agg.gdrNumeratorByPeriod.get(observedKey) || 0) + Math.min(observedArrForCustomer, cohortArrForCustomer)),
        );
      }
    }
  }

  return cohortAgg.map((agg) => {
    const ndrByPeriod: Record<string, number | null> = {};
    const gdrByPeriod: Record<string, number | null> = {};
    for (let observedIdx = 0; observedIdx < periodKeys.length; observedIdx += 1) {
      const observedKey = periodKeys[observedIdx];
      if (observedIdx < agg.cohortIndex) {
        ndrByPeriod[observedKey] = null;
        gdrByPeriod[observedKey] = null;
        continue;
      }
      if (agg.cohortArr <= 0) {
        ndrByPeriod[observedKey] = 0;
        gdrByPeriod[observedKey] = 0;
        continue;
      }
      const ndrNumerator = Number(agg.ndrNumeratorByPeriod.get(observedKey) || 0);
      const gdrNumerator = Number(agg.gdrNumeratorByPeriod.get(observedKey) || 0);
      ndrByPeriod[observedKey] = round2((ndrNumerator / agg.cohortArr) * 100);
      gdrByPeriod[observedKey] = round2((gdrNumerator / agg.cohortArr) * 100);
    }

    return {
      cohortKey: agg.cohortKey,
      cohortLabel: agg.cohortLabel,
      cohortCustomerCount: agg.cohortCustomerCount,
      cohortArr: round2(agg.cohortArr),
      ndrByPeriod,
      gdrByPeriod,
    };
  });
}

function buildPlanSegmentsFast(
  periods: Array<{ key: string; label: string }>,
  rows: CombinedAllSubsRow[],
): MatrixSegment[] {
  const periodKeys = periods.map((period) => period.key);
  const periodCount = periodKeys.length;
  const emptyAggregates = () =>
    periods.map((period, idx) => ({
      cohortKey: period.key,
      cohortLabel: period.label,
      cohortIndex: idx,
      cohortCustomerCount: 0,
      cohortArr: 0,
      ndrNumerators: Array<number>(periodCount).fill(0),
      gdrNumerators: Array<number>(periodCount).fill(0),
    }));

  const planAggregates = new Map<CombinedAllSubsPlan, ReturnType<typeof emptyAggregates>>();
  for (const plan of PLAN_ORDER) {
    planAggregates.set(plan, emptyAggregates());
  }

  for (const row of rows) {
    const valuesByPeriod = row.valuesByPeriod || {};
    const values = periodKeys.map((periodKey) => Math.max(0, Number(valuesByPeriod[periodKey] || 0)));
    const plans = periodKeys.map((periodKey) => planForPeriod(row, periodKey));

    for (let cohortIdx = 0; cohortIdx < periodCount; cohortIdx += 1) {
      const cohortArr = values[cohortIdx];
      if (cohortArr <= 0) continue;

      const cohortPlan = plans[cohortIdx];
      const cohortAgg = planAggregates.get(cohortPlan)?.[cohortIdx];
      if (!cohortAgg) continue;
      cohortAgg.cohortCustomerCount += 1;
      cohortAgg.cohortArr += cohortArr;

      for (let observedIdx = cohortIdx; observedIdx < periodCount; observedIdx += 1) {
        const observedArr = values[observedIdx];
        cohortAgg.ndrNumerators[observedIdx] += observedArr;
        cohortAgg.gdrNumerators[observedIdx] += Math.min(observedArr, cohortArr);
      }
    }
  }

  return PLAN_ORDER.map((plan) => {
    const aggregates = planAggregates.get(plan) || [];
    const cohorts: CohortRow[] = aggregates.map((agg) => {
      const ndrByPeriod: Record<string, number | null> = {};
      const gdrByPeriod: Record<string, number | null> = {};
      for (let observedIdx = 0; observedIdx < periodCount; observedIdx += 1) {
        const observedKey = periodKeys[observedIdx];
        if (observedIdx < agg.cohortIndex) {
          ndrByPeriod[observedKey] = null;
          gdrByPeriod[observedKey] = null;
          continue;
        }
        if (agg.cohortArr <= 0) {
          ndrByPeriod[observedKey] = 0;
          gdrByPeriod[observedKey] = 0;
          continue;
        }
        ndrByPeriod[observedKey] = round2((agg.ndrNumerators[observedIdx] / agg.cohortArr) * 100);
        gdrByPeriod[observedKey] = round2((agg.gdrNumerators[observedIdx] / agg.cohortArr) * 100);
      }

      return {
        cohortKey: agg.cohortKey,
        cohortLabel: agg.cohortLabel,
        cohortCustomerCount: agg.cohortCustomerCount,
        cohortArr: round2(agg.cohortArr),
        ndrByPeriod,
        gdrByPeriod,
      };
    });

    return {
      segmentKey: plan,
      segmentLabel: PLAN_LABELS[plan],
      cohorts,
    };
  });
}

async function buildNdrGdrReport(payload: {
  startDate: string;
  endDate: string;
  combineMode: CombinedAllSubsCombineMode;
  groupBy: MatrixGroupBy;
}): Promise<NdrGdrResponse> {
  if (payload.combineMode === "grouped" && isPrecomputedFactsReadEnabled()) {
    const precomputed = await buildNdrGdrFromPrecomputedFacts(payload).catch(() => null);
    if (precomputed) return precomputed;
  }
  const combinedRequest: CombinedAllSubsRequest = {
    startDate: payload.startDate,
    endDate: payload.endDate,
    combineMode: payload.combineMode,
    displayMode: "arr",
    planGrain: "monthly",
    includePlanData: payload.groupBy === "plan",
    groupedMatchStrategy: payload.groupBy === "plan" ? "workspace_only" : "full",
    includeSalesAssist: false,
  };
  const combined = await generateCombinedAllSubsReport(combinedRequest);
  const periods = (combined.periods || []).map((period) => ({
    key: String(period.key || ""),
    label: String(period.label || period.key || ""),
  }));
  const rows = combined.rows || [];
  const segments: MatrixSegment[] =
    payload.groupBy === "source"
      ? (["hubspot_account", "stripe_only_customer"] as const).map((source) => ({
          segmentKey: source === "hubspot_account" ? "salesled" : "selfserve",
          segmentLabel: SOURCE_LABELS[source],
          cohorts: buildCohorts(
            periods,
            rows.filter((row) => row.source === source),
          ),
        }))
      : payload.groupBy === "plan"
        ? buildPlanSegmentsFast(periods, rows)
        : [
            {
              segmentKey: "overall",
              segmentLabel: "Overall",
              cohorts: buildCohorts(periods, rows),
            },
          ];

  return {
    startDate: combined.startDate,
    endDate: combined.endDate,
    combineMode: combined.combineMode,
    groupBy: payload.groupBy,
    targetCurrency: combined.targetCurrency,
    warnings: combined.warnings || [],
    periods,
    cohorts: segments[0]?.cohorts || [],
    segments,
  };
}

async function validateAndRun(body: Partial<RequestBody>) {
  const startDate = String(body.startDate || "").trim();
  const endDate = String(body.endDate || "").trim();
  const combineMode = normalizeCombineMode(body.combineMode);
  const groupBy = normalizeGroupBy(body.groupBy);
  const precomputeRangeOnly = body.precomputeRangeOnly === true;
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    throw new Error("Invalid startDate/endDate");
  }
  if (endDate < startDate) {
    throw new Error("endDate must be >= startDate");
  }

  if (precomputeRangeOnly) {
    const rangePayload = { startDate, endDate, combineMode, groupBy };
    const rangeKey = `${RANGE_CACHE_KEY_PREFIX}${stableStringify(rangePayload)}`;
    return getOrSetCache(rangeKey, CACHE_TTL_MS, async () => {
      const precomputed = await readPrecomputedPayload<NdrGdrResponse>(PRECOMPUTED_ENDPOINT_KEY, rangeKey).catch(
        () => null,
      );
      if (precomputed) return precomputed;
      const built = await buildNdrGdrReport(rangePayload);
      await writePrecomputedPayload({
        endpoint_key: PRECOMPUTED_ENDPOINT_KEY,
        cache_key: rangeKey,
        start_date: startDate,
        end_date: endDate,
        grain: "monthly",
        payload_json: JSON.stringify(built),
      }).catch(() => null);
      return built;
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  const canonicalStartDate = startDate < MONTHLY_CANONICAL_START_DATE ? startDate : MONTHLY_CANONICAL_START_DATE;
  const canonicalEndDate = endDate > today ? endDate : today;
  const canonicalPayload = { startDate: canonicalStartDate, endDate: canonicalEndDate, combineMode, groupBy };
  const key = `${CANONICAL_CACHE_KEY_PREFIX}${stableStringify(canonicalPayload)}`;
  const canonical = await getOrSetCache(key, CACHE_TTL_MS, async () => {
    const precomputed = await readPrecomputedPayload<NdrGdrResponse>(PRECOMPUTED_ENDPOINT_KEY, key).catch(() => null);
    if (precomputed) return precomputed;
    const stitched = await buildCanonicalFromChunkRows(canonicalPayload);
    if (stitched) {
      await writePrecomputedPayload({
        endpoint_key: PRECOMPUTED_ENDPOINT_KEY,
        cache_key: key,
        start_date: canonicalStartDate,
        end_date: canonicalEndDate,
        grain: "monthly",
        payload_json: JSON.stringify(stitched),
      }).catch(() => null);
      return stitched;
    }
    const built = await buildNdrGdrReport(canonicalPayload);
    await writePrecomputedPayload({
      endpoint_key: PRECOMPUTED_ENDPOINT_KEY,
      cache_key: key,
      start_date: canonicalStartDate,
      end_date: canonicalEndDate,
      grain: "monthly",
      payload_json: JSON.stringify(built),
    }).catch(() => null);
    return built;
  });
  return sliceNdrGdrResponse(canonical, startDate, endDate);
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Partial<RequestBody>;
    const report = await validateAndRun(body);
    return NextResponse.json(report);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") || message.includes("endDate must be >= startDate") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const report = await validateAndRun({
      startDate: searchParams.get("startDate") || "",
      endDate: searchParams.get("endDate") || "",
      combineMode: searchParams.get("combineMode") || "grouped",
      groupBy: searchParams.get("groupBy") || "overall",
    });
    return NextResponse.json(report);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") || message.includes("endDate must be >= startDate") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
