import { NextResponse } from "next/server";
import {
  generateTofuDetailReport,
  generateTofuReport,
  type TofuDetailMetric,
  type TofuDetailRequest,
  type TofuRequest,
  type TofuResponse,
} from "@/lib/tofuReport";
import type { CombinedAllSubsCombineMode } from "@/lib/combinedAllSubsReport";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";
import { readPrecomputedPayload, writePrecomputedPayload } from "@/lib/precomputedPayloadStore";

export const runtime = "nodejs";
export const maxDuration = 300;
const CACHE_TTL_MS = readTtlMs("API_TOFU_REPORT_CACHE_TTL_MS", 24 * 60 * 60 * 1000);
const MONTHLY_CANONICAL_START_DATE = (() => {
  const configured = String(process.env.COMBINED_BILLING_OVERVIEW_MONTHLY_CACHE_START || "2023-01-01").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(configured) ? configured : "2023-01-01";
})();
const PRECOMPUTED_ENDPOINT_KEY = "tofu:monthly";

type TofuApiRequest = Partial<TofuRequest> & {
  detailPeriodKey?: string;
  detailMetric?: string;
  detailSegment?: string;
  precomputeRangeOnly?: boolean;
};

function monthKey(value: string) {
  return String(value || "").trim().slice(0, 7);
}

function sliceMonthlyTofuResponse(response: TofuResponse, startDate: string, endDate: string): TofuResponse {
  const startMonth = monthKey(startDate);
  const endMonth = monthKey(endDate);
  return {
    ...response,
    startDate,
    endDate,
    rows: (response.rows || []).filter((row) => row.periodKey >= startMonth && row.periodKey <= endMonth),
    planRows: (response.planRows || []).filter((row) => row.periodKey >= startMonth && row.periodKey <= endMonth),
    segmentRows: (response.segmentRows || []).filter((row) => row.periodKey >= startMonth && row.periodKey <= endMonth),
  };
}

async function validateAndRun(body: TofuApiRequest) {
  const basePayload: TofuRequest = {
    startDate: String(body.startDate || ""),
    endDate: String(body.endDate || ""),
    combineMode: String(body.combineMode || "grouped") as CombinedAllSubsCombineMode,
    groupBy: String(body.groupBy || "month") as TofuRequest["groupBy"],
  };

  const detailPeriodKey = String(body.detailPeriodKey || "").trim();
  const detailMetric = String(body.detailMetric || "").trim();
  const detailSegment = String(body.detailSegment || "").trim();
  if (detailPeriodKey && detailMetric) {
    const detailPayload: TofuDetailRequest = {
      ...basePayload,
      detailPeriodKey,
      detailMetric: detailMetric as TofuDetailMetric,
      detailSegment: detailSegment
        ? (detailSegment as TofuDetailRequest["detailSegment"])
        : undefined,
    };
    const key = `api:tofu-report:detail:${stableStringify(detailPayload)}`;
    return getOrSetCache(key, CACHE_TTL_MS, () => generateTofuDetailReport(detailPayload));
  }

  const precomputeRangeOnly = body.precomputeRangeOnly === true;
  if (precomputeRangeOnly) {
    const rangeKey = `api:tofu-report:range:${stableStringify(basePayload)}`;
    return getOrSetCache(rangeKey, CACHE_TTL_MS, () => generateTofuReport(basePayload));
  }

  const today = new Date().toISOString().slice(0, 10);
  const canonicalStartDate = basePayload.startDate < MONTHLY_CANONICAL_START_DATE
    ? basePayload.startDate
    : MONTHLY_CANONICAL_START_DATE;
  const canonicalEndDate = basePayload.endDate > today ? basePayload.endDate : today;
  const canonicalPayload: TofuRequest = {
    ...basePayload,
    startDate: canonicalStartDate,
    endDate: canonicalEndDate,
  };
  const key = `api:tofu-report:base:${stableStringify(canonicalPayload)}`;
  const canonical = await getOrSetCache(key, CACHE_TTL_MS, async () => {
    const precomputed = await readPrecomputedPayload<TofuResponse>(PRECOMPUTED_ENDPOINT_KEY, key).catch(() => null);
    if (precomputed) return precomputed;
    const built = await generateTofuReport(canonicalPayload);
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
  return sliceMonthlyTofuResponse(canonical, basePayload.startDate, basePayload.endDate);
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as TofuApiRequest;
    return NextResponse.json(await validateAndRun(body));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") ||
      message.includes("endDate must be >= startDate") ||
      message.includes("Invalid detail metric") ||
      message.includes("Invalid detail period") ||
      message.includes("Invalid detail segment")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    return NextResponse.json(
      await validateAndRun({
        startDate: searchParams.get("startDate") || "",
        endDate: searchParams.get("endDate") || "",
        combineMode: String(searchParams.get("combineMode") || "grouped") as CombinedAllSubsCombineMode,
        groupBy: String(searchParams.get("groupBy") || "month") as TofuRequest["groupBy"],
        detailPeriodKey: searchParams.get("detailPeriodKey") || "",
        detailMetric: searchParams.get("detailMetric") || "",
        detailSegment: searchParams.get("detailSegment") || "",
      }),
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") ||
      message.includes("endDate must be >= startDate") ||
      message.includes("Invalid detail metric") ||
      message.includes("Invalid detail period") ||
      message.includes("Invalid detail segment")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
