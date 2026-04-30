import { NextResponse } from "next/server";
import {
  generateCombinedAllSubsReport,
  type CombinedAllSubsCombineMode,
  type CombinedAllSubsResponse,
  type CombinedAllSubsRequest,
} from "@/lib/combinedAllSubsReport";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";
import { readPrecomputedPayload, writePrecomputedPayload } from "@/lib/precomputedPayloadStore";

export const runtime = "nodejs";
export const maxDuration = 300;
const CACHE_TTL_MS = readTtlMs("API_COMBINED_ALL_SUBS_CACHE_TTL_MS", 24 * 60 * 60 * 1000);
const MONTHLY_CANONICAL_START_DATE = (() => {
  const configured = String(process.env.COMBINED_BILLING_OVERVIEW_MONTHLY_CACHE_START || "2023-01-01").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(configured) ? configured : "2023-01-01";
})();
const PRECOMPUTED_ENDPOINT_KEY = "combined-all-subs:monthly";

function monthKey(value: string) {
  return String(value || "").trim().slice(0, 7);
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

async function validateAndRun(body: Partial<CombinedAllSubsRequest>) {
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
  if (payload.planGrain === "monthly") {
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
  const key = `api:combined-all-subs:${stableStringify(payload)}`;
  return getOrSetCache(key, CACHE_TTL_MS, () => generateCombinedAllSubsReport(payload));
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Partial<CombinedAllSubsRequest>;
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
