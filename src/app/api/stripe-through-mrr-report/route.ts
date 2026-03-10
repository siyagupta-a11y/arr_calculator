import { NextResponse } from "next/server";
import {
  queryStripeThroughMrrReportFromBigQuery,
  type StripeBigQueryProfile,
  type StripeThroughMrrGroupBy,
  type StripeThroughMrrReportRequest,
} from "@/lib/stripeBigquery";

export const runtime = "nodejs";
export const maxDuration = 300;

const STRIPE_THROUGH_MRR_OPTIONS: { profile: StripeBigQueryProfile } = {
  profile: "stripe_arr_correct",
};

const GROUP_BY_VALUES = new Set<StripeThroughMrrGroupBy>([
  "none",
  "customer_id",
  "product_id",
  "price_id",
  "subscription_id",
  "subscription_item_id",
  "event_type",
]);

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
  detailMonth?: string;
  groupBy?: string;
  page?: number;
  pageSize?: number;
};

function parsePayload(raw: Partial<ApiBody>): StripeThroughMrrReportRequest {
  const startDate = String(raw.startDate || "").trim();
  const endDate = String(raw.endDate || "").trim();
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    throw new Error("Invalid startDate/endDate");
  }

  const detailMonthRaw = String(raw.detailMonth || "").trim();
  const detailMonth = isIsoMonth(detailMonthRaw) ? detailMonthRaw : monthFromDate(endDate);

  const groupByRaw = String(raw.groupBy || "none").trim() as StripeThroughMrrGroupBy;
  const groupBy = GROUP_BY_VALUES.has(groupByRaw) ? groupByRaw : "none";

  const pageRaw = Number(raw.page || 1);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;

  const pageSizeRaw = Number(raw.pageSize || DEFAULT_PAGE_SIZE);
  const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.floor(pageSizeRaw) : DEFAULT_PAGE_SIZE;

  const targetCurrency =
    String(process.env.STRIPE_THROUGH_MRR_TARGET_CURRENCY || "").trim() ||
    String(process.env.STRIPE_ARR_CORRECT_TARGET_CURRENCY || "").trim() ||
    "USD";

  return {
    startDate,
    endDate,
    detailMonth,
    groupBy,
    page,
    pageSize,
    targetCurrency,
  };
}

async function validateAndRun(body: Partial<ApiBody>) {
  const payload = parsePayload(body);
  return queryStripeThroughMrrReportFromBigQuery(payload, STRIPE_THROUGH_MRR_OPTIONS);
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
      detailMonth: searchParams.get("detailMonth") || "",
      groupBy: searchParams.get("groupBy") || "none",
      page: Number(searchParams.get("page") || 1),
      pageSize: Number(searchParams.get("pageSize") || DEFAULT_PAGE_SIZE),
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
