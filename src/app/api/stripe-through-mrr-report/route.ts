import { NextResponse } from "next/server";
import {
  queryStripeThroughMrrReportFromBigQuery,
  type StripeBigQueryProfile,
  type StripeThroughMrrGrain,
  type StripeThroughMrrGroupBy,
  type StripeThroughMrrReportRequest,
} from "@/lib/stripeBigquery";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 300;
const CACHE_TTL_MS = readTtlMs("API_STRIPE_THROUGH_MRR_CACHE_TTL_MS", 60_000);

const STRIPE_THROUGH_MRR_OPTIONS: { profile: StripeBigQueryProfile } = {
  profile: "stripe_arr_correct",
};

const GROUP_BY_VALUES = new Set<StripeThroughMrrGroupBy>([
  "none",
  "customer_id",
  "country",
  "territory",
  "product_id",
  "price_id",
  "subscription_id",
  "subscription_item_id",
  "event_type",
  "email",
]);
const GRAIN_VALUES = new Set<StripeThroughMrrGrain>(["monthly", "daily"]);

const DEFAULT_PAGE_SIZE = 1000;

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isIsoMonth(value: string) {
  return /^\d{4}-\d{2}$/.test(value);
}

function monthFromDate(dateText: string) {
  return String(dateText || "").slice(0, 7);
}

type ApiBody = {
  startDate?: string;
  endDate?: string;
  detailStartMonth?: string;
  detailEndMonth?: string;
  detailMonth?: string;
  grain?: string;
  groupBy?: string;
  countryFilters?: string[] | string;
  page?: number;
  pageSize?: number;
  skipSummary?: boolean | string;
  skipCount?: boolean | string;
};

function normalizeCountryFilters(raw: string[] | string | undefined) {
  if (Array.isArray(raw)) {
    return Array.from(
      new Set(
        raw
          .map((value) => String(value || "").trim())
          .filter(Boolean),
      ),
    ).slice(0, 50);
  }
  const single = String(raw || "").trim();
  if (!single) return [] as string[];
  return Array.from(
    new Set(
      single
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ).slice(0, 50);
}

function parsePayload(raw: Partial<ApiBody>): StripeThroughMrrReportRequest {
  const startDate = String(raw.startDate || "").trim();
  const endDate = String(raw.endDate || "").trim();
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    throw new Error("Invalid startDate/endDate");
  }

  const detailMonthFallbackRaw = String(raw.detailMonth || "").trim();
  const detailStartMonthRaw = String(raw.detailStartMonth || detailMonthFallbackRaw || "").trim();
  const detailEndMonthRaw = String(raw.detailEndMonth || detailMonthFallbackRaw || "").trim();
  const detailStartMonth = isIsoMonth(detailStartMonthRaw) ? detailStartMonthRaw : monthFromDate(startDate);
  const detailEndMonth = isIsoMonth(detailEndMonthRaw) ? detailEndMonthRaw : monthFromDate(endDate);
  const grainRaw = String(raw.grain || "monthly").trim().toLowerCase() as StripeThroughMrrGrain;
  const grain = GRAIN_VALUES.has(grainRaw) ? grainRaw : "monthly";

  const groupByRaw = String(raw.groupBy || "none").trim() as StripeThroughMrrGroupBy;
  const groupBy = GROUP_BY_VALUES.has(groupByRaw) ? groupByRaw : "none";

  const pageRaw = Number(raw.page || 1);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;

  const pageSizeRaw = Number(raw.pageSize || DEFAULT_PAGE_SIZE);
  const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.floor(pageSizeRaw) : DEFAULT_PAGE_SIZE;
  const skipSummaryRaw = raw.skipSummary;
  const skipSummary =
    skipSummaryRaw === true ||
    String(skipSummaryRaw || "").trim().toLowerCase() === "true" ||
    String(skipSummaryRaw || "").trim() === "1";
  const skipCountRaw = raw.skipCount;
  const skipCount =
    skipCountRaw === true ||
    String(skipCountRaw || "").trim().toLowerCase() === "true" ||
    String(skipCountRaw || "").trim() === "1";

  const targetCurrency =
    String(process.env.STRIPE_THROUGH_MRR_TARGET_CURRENCY || "").trim() ||
    String(process.env.STRIPE_ARR_CORRECT_TARGET_CURRENCY || "").trim() ||
    "USD";

  return {
    startDate,
    endDate,
    detailStartMonth,
    detailEndMonth,
    grain,
    groupBy,
    countryFilters: normalizeCountryFilters(raw.countryFilters),
    page,
    pageSize,
    targetCurrency,
    skipSummary,
    skipCount,
  };
}

async function validateAndRun(body: Partial<ApiBody>) {
  const payload = parsePayload(body);
  const key = `api:stripe-through-mrr:${stableStringify(payload)}`;
  return getOrSetCache(key, CACHE_TTL_MS, () =>
    queryStripeThroughMrrReportFromBigQuery(payload, STRIPE_THROUGH_MRR_OPTIONS),
  );
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Partial<ApiBody>;
    const report = await validateAndRun(body);
    return NextResponse.json(report);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
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
    const body: Partial<ApiBody> = {
      startDate: searchParams.get("startDate") || "",
      endDate: searchParams.get("endDate") || "",
      detailStartMonth: searchParams.get("detailStartMonth") || "",
      detailEndMonth: searchParams.get("detailEndMonth") || "",
      detailMonth: searchParams.get("detailMonth") || "",
      grain: searchParams.get("grain") || "monthly",
      groupBy: searchParams.get("groupBy") || "none",
      countryFilters: searchParams.get("countryFilters") || "",
      page: Number(searchParams.get("page") || 1),
      pageSize: Number(searchParams.get("pageSize") || DEFAULT_PAGE_SIZE),
      skipSummary: searchParams.get("skipSummary") || "",
      skipCount: searchParams.get("skipCount") || "",
    };
    const report = await validateAndRun(body);
    return NextResponse.json(report);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") ||
      message.includes("endDate must be >= startDate")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
