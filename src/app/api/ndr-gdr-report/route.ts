import { NextResponse } from "next/server";
import {
  generateCombinedAllSubsReport,
  type CombinedAllSubsPlan,
  type CombinedAllSubsCombineMode,
  type CombinedAllSubsRow,
  type CombinedAllSubsRequest,
} from "@/lib/combinedAllSubsReport";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";
import { readPrecomputedPayload, writePrecomputedPayload } from "@/lib/precomputedPayloadStore";

export const runtime = "nodejs";
export const maxDuration = 300;

const CACHE_TTL_MS = readTtlMs("API_NDR_GDR_CACHE_TTL_MS", 60_000);
const MONTHLY_CANONICAL_START_DATE = (() => {
  const configured = String(process.env.COMBINED_BILLING_OVERVIEW_MONTHLY_CACHE_START || "2023-01-01").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(configured) ? configured : "2023-01-01";
})();
const PRECOMPUTED_ENDPOINT_KEY = "ndr-gdr:monthly";

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

type NdrGdrResponse = Awaited<ReturnType<typeof buildNdrGdrReport>>;

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
}) {
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
    const rangeKey = `api:ndr-gdr:range:${stableStringify(rangePayload)}`;
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
  const key = `api:ndr-gdr:${stableStringify(canonicalPayload)}`;
  const canonical = await getOrSetCache(key, CACHE_TTL_MS, async () => {
    const precomputed = await readPrecomputedPayload<NdrGdrResponse>(PRECOMPUTED_ENDPOINT_KEY, key).catch(() => null);
    if (precomputed) return precomputed;
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
