import { NextResponse } from "next/server";
import {
  queryStripeBillingOverviewFromBigQuery,
  type StripeBigQueryProfile,
  type StripeBillingOverviewGrain,
  type StripeBillingOverviewGroupBy,
  type StripeBillingOverviewRequest,
} from "@/lib/stripeBigquery";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";
import { readPrecomputedPayload, writePrecomputedPayload } from "@/lib/precomputedPayloadStore";

export const runtime = "nodejs";
export const maxDuration = 300;
const CACHE_TTL_MS = readTtlMs("API_STRIPE_BILLING_OVERVIEW_CACHE_TTL_MS", 60_000);
const PRECOMPUTED_ENDPOINT_KEY = "stripe-billing-overview";

const STRIPE_BILLING_OVERVIEW_OPTIONS: { profile: StripeBigQueryProfile } = {
  profile: "stripe_arr_correct",
};

const ALLOWED_GRAINS = new Set<StripeBillingOverviewGrain>([
  "daily",
  "weekly",
  "monthly",
  "quarterly",
]);

const ALLOWED_GROUP_BY = new Set<StripeBillingOverviewGroupBy>([
  "none",
  "product_id",
  "price_id",
  "subscription_item_id",
  "subscription_id",
  "customer_id",
]);

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

type ApiBody = {
  startDate?: string;
  endDate?: string;
  grain?: string;
  groupBy?: string;
  includeCustomerArrRows?: boolean | string;
  includeCurrentMonthProjection?: boolean | string;
};

function parseOptionalBoolean(value: unknown, defaultValue: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return defaultValue;
}

function parsePayload(raw: Partial<ApiBody>): StripeBillingOverviewRequest {
  const startDate = String(raw.startDate || "").trim();
  const endDate = String(raw.endDate || "").trim();
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    throw new Error("Invalid startDate/endDate");
  }

  const grainRaw = String(raw.grain || "monthly").trim().toLowerCase() as StripeBillingOverviewGrain;
  const grain = ALLOWED_GRAINS.has(grainRaw) ? grainRaw : "monthly";
  const groupByRaw = String(raw.groupBy || "none").trim().toLowerCase() as StripeBillingOverviewGroupBy;
  const groupBy = ALLOWED_GROUP_BY.has(groupByRaw) ? groupByRaw : "none";

  const targetCurrency =
    String(process.env.STRIPE_BILLING_OVERVIEW_TARGET_CURRENCY || "").trim() ||
    String(process.env.STRIPE_THROUGH_MRR_TARGET_CURRENCY || "").trim() ||
    String(process.env.STRIPE_ARR_CORRECT_TARGET_CURRENCY || "").trim() ||
    "USD";

  return {
    startDate,
    endDate,
    grain,
    groupBy,
    targetCurrency,
    includeCustomerArrRows: parseOptionalBoolean(raw.includeCustomerArrRows, true),
    includeCurrentMonthProjection: parseOptionalBoolean(raw.includeCurrentMonthProjection, true),
  };
}

async function validateAndRun(body: Partial<ApiBody>) {
  const payload = parsePayload(body);
  const key = `api:stripe-billing-overview:${stableStringify(payload)}`;
  return getOrSetCache(key, CACHE_TTL_MS, async () => {
    const precomputed = await readPrecomputedPayload<Awaited<ReturnType<typeof queryStripeBillingOverviewFromBigQuery>>>(
      PRECOMPUTED_ENDPOINT_KEY,
      key,
    ).catch(() => null);
    if (precomputed) return precomputed;
    const built = await queryStripeBillingOverviewFromBigQuery(payload, STRIPE_BILLING_OVERVIEW_OPTIONS);
    await writePrecomputedPayload({
      endpoint_key: PRECOMPUTED_ENDPOINT_KEY,
      cache_key: key,
      start_date: payload.startDate,
      end_date: payload.endDate,
      grain: payload.grain,
      payload_json: JSON.stringify(built),
    }).catch(() => null);
    return built;
  });
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
      grain: searchParams.get("grain") || "monthly",
      groupBy: searchParams.get("groupBy") || "none",
      includeCustomerArrRows: searchParams.get("includeCustomerArrRows") || undefined,
      includeCurrentMonthProjection: searchParams.get("includeCurrentMonthProjection") || undefined,
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
