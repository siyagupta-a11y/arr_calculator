import { NextResponse } from "next/server";
import {
  queryStripeAiSpendDailyAnnualizedCustomerBreakdownFromUpcomingSnapshotsFromBigQuery,
} from "@/lib/stripeBigquery";
import { resolveEnterprisePrepaidAiSpendExclusions } from "@/lib/aiSpendEnterprisePrepaidExclusions";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 300;

const CACHE_TTL_MS = readTtlMs("API_COMBINED_BILLING_OVERVIEW_CACHE_TTL_MS", 60_000);
const AI_SPEND_EXCLUSIONS_CACHE_TTL_MS = readTtlMs("API_STRIPE_AI_SPEND_EXCLUSIONS_CACHE_TTL_MS", 300_000);
const AI_SPEND_UPCOMING_PRODUCT_TERMS = ["ai tokens", "web search and crawl"];

type ApiBody = {
  startDate?: string;
  endDate?: string;
  selectedDate?: string;
  targetCurrency?: string;
};

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function pickTargetCurrency(explicit?: string) {
  return (
    String(explicit || "").trim() ||
    String(process.env.STRIPE_BILLING_OVERVIEW_TARGET_CURRENCY || "").trim() ||
    String(process.env.STRIPE_THROUGH_MRR_TARGET_CURRENCY || "").trim() ||
    String(process.env.STRIPE_ARR_CORRECT_TARGET_CURRENCY || "").trim() ||
    "USD"
  );
}

function parsePayload(raw: Partial<ApiBody>) {
  const startDate = String(raw.startDate || "").trim();
  const endDate = String(raw.endDate || "").trim();
  const selectedDate = String(raw.selectedDate || "").trim();
  if (!isIsoDate(startDate) || !isIsoDate(endDate) || !isIsoDate(selectedDate)) {
    throw new Error("Invalid startDate/endDate/selectedDate");
  }
  if (endDate < startDate) {
    throw new Error("endDate must be >= startDate");
  }

  return {
    startDate,
    endDate,
    selectedDate,
    targetCurrency: pickTargetCurrency(raw.targetCurrency),
  };
}

async function validateAndRun(body: Partial<ApiBody>) {
  const payload = parsePayload(body);
  const exclusions = await getOrSetCache(
    `api:stripe-ai-spend:enterprise-prepaid-exclusions:${stableStringify({
      startDate: payload.startDate,
      endDate: payload.endDate,
      invoiceMonthOffset: 1,
      targetCurrency: payload.targetCurrency,
    })}`,
    AI_SPEND_EXCLUSIONS_CACHE_TTL_MS,
    () =>
      resolveEnterprisePrepaidAiSpendExclusions({
        startDate: payload.startDate,
        endDate: payload.endDate,
        targetCurrency: payload.targetCurrency,
      }),
  ).catch(() => ({ customerMonthPrepaidOffsets: [] }));

  const key = `api:combined-billing-overview:ai-spend-daily-breakdown:${stableStringify({
    selectedDate: payload.selectedDate,
    targetCurrency: payload.targetCurrency,
    prepaidOffsetByCustomerMonthPairs: (exclusions.customerMonthPrepaidOffsets || []).map((entry) => ({
      pairKey: entry.pairKey,
      prepaidAppliedMajor: entry.prepaidAppliedMajor,
    })),
  })}`;

  return getOrSetCache(key, CACHE_TTL_MS, () =>
    queryStripeAiSpendDailyAnnualizedCustomerBreakdownFromUpcomingSnapshotsFromBigQuery(
      {
        startDate: payload.selectedDate,
        endDate: payload.selectedDate,
        targetCurrency: payload.targetCurrency,
        productDescriptionIncludes: AI_SPEND_UPCOMING_PRODUCT_TERMS,
        excludeCustomerMonthPairs: [],
        prepaidOffsetByCustomerMonthPairs: (exclusions.customerMonthPrepaidOffsets || []).map((entry) => ({
          pairKey: entry.pairKey,
          prepaidAppliedMajor: entry.prepaidAppliedMajor,
        })),
      },
      { profile: "stripe_arr_correct" },
    ),
  );
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Partial<ApiBody>;
    const result = await validateAndRun(body);
    return NextResponse.json(result);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate/selectedDate") || message.includes("endDate must be >= startDate")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
