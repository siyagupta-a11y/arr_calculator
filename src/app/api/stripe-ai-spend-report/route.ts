import { NextResponse } from "next/server";
import {
  resolveEnterprisePrepaidAiSpendExclusions,
  resolveEnterprisePrepaidAiSpendCurrentMonthCarryForwardOffsets,
} from "@/lib/aiSpendEnterprisePrepaidExclusions";
import {
  queryStripeAiSpendFromBigQuery,
  queryStripeAiSpendCurrentMonthFromUpcomingFromBigQuery,
  queryStripeLatestUpcomingSnapshotDateFromBigQuery,
  type StripeAiSpendGrain,
  type StripeAiSpendRequest,
} from "@/lib/stripeBigquery";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 300;
const CACHE_TTL_MS = readTtlMs("API_STRIPE_AI_SPEND_CACHE_TTL_MS", 60_000);
const EXCLUSIONS_CACHE_TTL_MS = readTtlMs("API_STRIPE_AI_SPEND_EXCLUSIONS_CACHE_TTL_MS", 300_000);
const CARRY_FORWARD_CACHE_TTL_MS = readTtlMs(
  "API_STRIPE_AI_SPEND_CARRY_FORWARD_CACHE_TTL_MS",
  EXCLUSIONS_CACHE_TTL_MS,
);
const AI_SPEND_UPCOMING_PRODUCT_TERMS = ["ai tokens", "web search and crawl"];

const ALLOWED_GRAINS = new Set<StripeAiSpendGrain>([
  "daily",
  "weekly",
  "monthly",
  "quarterly",
]);

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseIsoDateUtc(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return date;
}

function toIsoDateOnlyUtc(value: Date) {
  return value.toISOString().slice(0, 10);
}

function getCurrentMonthDateRangeIso() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    startDate: toIsoDateOnlyUtc(start),
    endDate: toIsoDateOnlyUtc(now),
  };
}

function isCurrentMonthRange(startDate: string, endDate: string) {
  const start = parseIsoDateUtc(startDate);
  const end = parseIsoDateUtc(endDate);
  if (!start || !end || end.getTime() < start.getTime()) return false;

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return (
    start.getTime() >= monthStart.getTime() &&
    start.getTime() < nextMonthStart.getTime() &&
    end.getTime() >= monthStart.getTime() &&
    end.getTime() < nextMonthStart.getTime()
  );
}

type ApiBody = {
  startDate?: string;
  endDate?: string;
  grain?: string;
  topLimit?: number;
  detailLimit?: number;
};

function parsePayload(raw: Partial<ApiBody>): StripeAiSpendRequest {
  const defaults = getCurrentMonthDateRangeIso();
  const startDate = String(raw.startDate || defaults.startDate).trim();
  const endDate = String(raw.endDate || defaults.endDate).trim();
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    throw new Error("Invalid startDate/endDate");
  }

  const grainRaw = String(raw.grain || "monthly").trim().toLowerCase() as StripeAiSpendGrain;
  const grain = ALLOWED_GRAINS.has(grainRaw) ? grainRaw : "monthly";

  const topLimitRaw = Number(raw.topLimit || 300);
  const topLimit = Number.isFinite(topLimitRaw) ? Math.max(1, Math.floor(topLimitRaw)) : 300;

  const detailLimitRaw = Number(raw.detailLimit || 100);
  const detailLimit = Number.isFinite(detailLimitRaw) ? Math.max(1, Math.floor(detailLimitRaw)) : 100;

  const targetCurrency =
    String(process.env.STRIPE_AI_SPEND_TARGET_CURRENCY || "").trim() ||
    String(process.env.STRIPE_BILLING_OVERVIEW_TARGET_CURRENCY || "").trim() ||
    String(process.env.STRIPE_THROUGH_MRR_TARGET_CURRENCY || "").trim() ||
    String(process.env.STRIPE_ARR_CORRECT_TARGET_CURRENCY || "").trim() ||
    "USD";

  return {
    startDate,
    endDate,
    grain,
    targetCurrency,
    topLimit,
    detailLimit,
  };
}

async function validateAndRun(body: Partial<ApiBody>) {
  const payload = parsePayload(body);
  const useUpcomingCurrentMonthSource = isCurrentMonthRange(payload.startDate, payload.endDate);

  if (useUpcomingCurrentMonthSource) {
    const now = new Date();
    const monthStartDate = toIsoDateOnlyUtc(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)));
    const latestSnapshotDate = await getOrSetCache(
      "api:stripe-ai-spend:latest-upcoming-snapshot-date",
      CACHE_TTL_MS,
      () => queryStripeLatestUpcomingSnapshotDateFromBigQuery({ profile: "stripe_arr_correct" }),
    ).catch(() => "");
    const carryForwardAsOfDate = isIsoDate(latestSnapshotDate) ? latestSnapshotDate : toIsoDateOnlyUtc(now);
    const carryForwardKey = `api:stripe-ai-spend:carry-forward:${stableStringify({
      monthStartDate,
      asOfDate: carryForwardAsOfDate,
      targetCurrency: payload.targetCurrency,
    })}`;
    const carryForward = await getOrSetCache(
      carryForwardKey,
      CARRY_FORWARD_CACHE_TTL_MS,
      () =>
        resolveEnterprisePrepaidAiSpendCurrentMonthCarryForwardOffsets({
          currentMonthStartDate: monthStartDate,
          asOfDate: carryForwardAsOfDate,
          targetCurrency: payload.targetCurrency,
        }),
    ).catch(() => ({
      currentMonthStartDate: monthStartDate,
      currentMonthEndDate: monthStartDate,
      lastMonthStartDate: "",
      lastMonthEndDate: "",
      carriedCustomerIds: [],
      prepaidOffsetByCustomerIds: [],
      excludedCustomers: [],
    }));

    const upcomingRequestPayload = {
      ...payload,
      productDescriptionIncludes: AI_SPEND_UPCOMING_PRODUCT_TERMS,
      excludeCustomerIds: [],
      prepaidOffsetByCustomerIds: carryForward.prepaidOffsetByCustomerIds || [],
    };
    const key = `api:stripe-ai-spend:upcoming-current-month:${stableStringify(upcomingRequestPayload)}`;
    return getOrSetCache(key, CACHE_TTL_MS, async () => {
      const report = await queryStripeAiSpendCurrentMonthFromUpcomingFromBigQuery(upcomingRequestPayload, {
        profile: "stripe_arr_correct",
      });
      return {
        ...report,
        reportSource: "latest_upcoming_invoice_snapshot",
        excludedEnterprisePrepaidCustomerCount: carryForward.carriedCustomerIds.length,
        excludedEnterprisePrepaidCustomers: carryForward.excludedCustomers,
      };
    });
  }

  const exclusionsKey = `api:stripe-ai-spend:enterprise-prepaid-exclusions:${stableStringify({
    startDate: payload.startDate,
    endDate: payload.endDate,
    invoiceMonthOffset: 1,
  })}`;
  const exclusions = await getOrSetCache(
    exclusionsKey,
    EXCLUSIONS_CACHE_TTL_MS,
    () =>
      resolveEnterprisePrepaidAiSpendExclusions({
        startDate: payload.startDate,
        endDate: payload.endDate,
        targetCurrency: payload.targetCurrency,
      }),
  ).catch(() => ({ customerIds: [], customerMonthPairs: [], customerMonthPrepaidOffsets: [], rows: [] }));
  const requestPayload: StripeAiSpendRequest = {
    ...payload,
    excludeCustomerIds: [],
    excludeCustomerMonthPairs: [],
    prepaidOffsetByCustomerMonthPairs: (exclusions.customerMonthPrepaidOffsets || []).map((entry) => ({
      pairKey: entry.pairKey,
      prepaidAppliedMajor: entry.prepaidAppliedMajor,
    })),
  };
  const key = `api:stripe-ai-spend:${stableStringify(requestPayload)}`;
  return getOrSetCache(key, CACHE_TTL_MS, async () => {
    const report = await queryStripeAiSpendFromBigQuery(requestPayload, { profile: "stripe_arr_correct" });
    return {
      ...report,
      excludedEnterprisePrepaidCustomerCount: exclusions.customerIds.length,
      excludedEnterprisePrepaidCustomers: exclusions.rows,
    };
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
      message.includes("Invalid startDate/endDate") || message.includes("endDate must be >= startDate") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const body: Partial<ApiBody> = {
      startDate: searchParams.get("startDate") || undefined,
      endDate: searchParams.get("endDate") || undefined,
      grain: searchParams.get("grain") || "monthly",
      topLimit: Number(searchParams.get("topLimit") || 300),
      detailLimit: Number(searchParams.get("detailLimit") || 100),
    };
    const report = await validateAndRun(body);
    return NextResponse.json(report);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") || message.includes("endDate must be >= startDate") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
