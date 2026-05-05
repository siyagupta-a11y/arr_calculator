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
import {
  listLatestPrecomputedPayloadRows,
  readPrecomputedPayload,
  writePrecomputedPayload,
} from "@/lib/precomputedPayloadStore";

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
  forceRefreshPrecomputed?: boolean;
};

const CACHE_KEY_PREFIX = "api:tofu-report:base:";

function monthKey(value: string) {
  return String(value || "").trim().slice(0, 7);
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
  const out: string[] = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor.getTime() <= endMonth.getTime()) {
    out.push(toIsoDateOnly(cursor).slice(0, 7));
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return out;
}

function maxIsoDate(a: string, b: string) {
  return a >= b ? a : b;
}

function minIsoDate(a: string, b: string) {
  return a <= b ? a : b;
}

function parsePayloadFromCacheKey(cacheKey: string): TofuRequest | null {
  const raw = String(cacheKey || "");
  if (!raw.startsWith(CACHE_KEY_PREFIX)) return null;
  const encoded = raw.slice(CACHE_KEY_PREFIX.length);
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(encoded) as Partial<TofuRequest>;
    const startDate = String(parsed.startDate || "").trim();
    const endDate = String(parsed.endDate || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return null;
    return {
      startDate,
      endDate,
      combineMode: String(parsed.combineMode || "grouped") as CombinedAllSubsCombineMode,
      groupBy: String(parsed.groupBy || "month") as TofuRequest["groupBy"],
    };
  } catch {
    return null;
  }
}

function normalizeComparablePayload(payload: Partial<TofuRequest>) {
  return {
    combineMode: String(payload.combineMode || "grouped") as CombinedAllSubsCombineMode,
    groupBy: String(payload.groupBy || "month") as TofuRequest["groupBy"],
  };
}

async function buildCanonicalFromChunkRows(canonicalPayload: TofuRequest) {
  const entries = await listLatestPrecomputedPayloadRows<TofuResponse>(
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

  const comparable = stableStringify(normalizeComparablePayload(canonicalPayload));
  const rowsByPeriod = new Map<string, TofuResponse["rows"][number]>();
  const planRowsByKey = new Map<string, NonNullable<TofuResponse["planRows"]>[number]>();
  const segmentRowsByKey = new Map<string, NonNullable<TofuResponse["segmentRows"]>[number]>();
  let targetCurrency = "";

  for (const entry of entries) {
    const payloadFromKey = parsePayloadFromCacheKey(entry.cacheKey);
    if (!payloadFromKey) continue;
    if (stableStringify(normalizeComparablePayload(payloadFromKey)) !== comparable) continue;
    if (!entry.payload) continue;
    const effectiveStart = maxIsoDate(canonicalPayload.startDate, payloadFromKey.startDate);
    const effectiveEnd = minIsoDate(canonicalPayload.endDate, payloadFromKey.endDate);
    if (effectiveEnd < effectiveStart) continue;
    const sliced = sliceMonthlyTofuResponse(entry.payload, effectiveStart, effectiveEnd);
    if (!targetCurrency) targetCurrency = String(sliced.targetCurrency || "");
    for (const row of sliced.rows || []) {
      rowsByPeriod.set(String(row.periodKey || ""), row);
    }
    for (const row of sliced.planRows || []) {
      planRowsByKey.set(`${row.periodKey}::${row.plan}`, row);
    }
    for (const row of sliced.segmentRows || []) {
      segmentRowsByKey.set(`${row.periodKey}::${row.segment}`, row);
    }
  }

  const expectedMonths = monthKeysBetween(canonicalPayload.startDate, canonicalPayload.endDate);
  if (!expectedMonths.length) return null;
  if (expectedMonths.some((key) => !rowsByPeriod.has(key))) return null;

  return {
    startDate: canonicalPayload.startDate,
    endDate: canonicalPayload.endDate,
    combineMode: canonicalPayload.combineMode || "grouped",
    groupBy: canonicalPayload.groupBy || "month",
    targetCurrency: targetCurrency || "USD",
    rows: expectedMonths
      .map((key) => rowsByPeriod.get(key))
      .filter((row): row is TofuResponse["rows"][number] => Boolean(row)),
    planRows: Array.from(planRowsByKey.values()).sort((a, b) =>
      `${a.periodKey}:${a.plan}`.localeCompare(`${b.periodKey}:${b.plan}`),
    ),
    segmentRows: Array.from(segmentRowsByKey.values()).sort((a, b) =>
      `${a.periodKey}:${a.segment}`.localeCompare(`${b.periodKey}:${b.segment}`),
    ),
  } satisfies TofuResponse;
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
  const forceRefreshPrecomputed = body.forceRefreshPrecomputed === true;
  const key = `api:tofu-report:base:${stableStringify(basePayload)}`;
  if (precomputeRangeOnly) {
    return getOrSetCache(key, CACHE_TTL_MS, async () => {
      if (!forceRefreshPrecomputed) {
        const precomputed = await readPrecomputedPayload<TofuResponse>(PRECOMPUTED_ENDPOINT_KEY, key).catch(() => null);
        if (precomputed) return precomputed;
      }
      const built = await generateTofuReport(basePayload);
      await writePrecomputedPayload({
        endpoint_key: PRECOMPUTED_ENDPOINT_KEY,
        cache_key: key,
        start_date: basePayload.startDate,
        end_date: basePayload.endDate,
        grain: "monthly",
        payload_json: JSON.stringify(built),
      }).catch(() => null);
      return built;
    });
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
  const canonicalKey = `api:tofu-report:base:${stableStringify(canonicalPayload)}`;
  const canonical = await getOrSetCache(canonicalKey, CACHE_TTL_MS, async () => {
    const precomputed = await readPrecomputedPayload<TofuResponse>(PRECOMPUTED_ENDPOINT_KEY, canonicalKey).catch(() => null);
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
    const built = await generateTofuReport(canonicalPayload);
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
