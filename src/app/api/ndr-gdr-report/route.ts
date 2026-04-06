import { NextResponse } from "next/server";
import {
  generateCombinedAllSubsReport,
  type CombinedAllSubsPlan,
  type CombinedAllSubsCombineMode,
  type CombinedAllSubsRow,
  type CombinedAllSubsRequest,
} from "@/lib/combinedAllSubsReport";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 300;

const CACHE_TTL_MS = readTtlMs("API_NDR_GDR_CACHE_TTL_MS", 60_000);

type RequestBody = {
  startDate?: string;
  endDate?: string;
  combineMode?: string;
  groupBy?: string;
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
        ? PLAN_ORDER.map((plan) => ({
            segmentKey: plan,
            segmentLabel: PLAN_LABELS[plan],
            cohorts: buildCohorts(periods, rows, (row, cohortPeriodKey) => planForPeriod(row, cohortPeriodKey) === plan),
          }))
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
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    throw new Error("Invalid startDate/endDate");
  }
  if (endDate < startDate) {
    throw new Error("endDate must be >= startDate");
  }

  const key = `api:ndr-gdr:${stableStringify({ startDate, endDate, combineMode, groupBy })}`;
  return getOrSetCache(key, CACHE_TTL_MS, () => buildNdrGdrReport({ startDate, endDate, combineMode, groupBy }));
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
