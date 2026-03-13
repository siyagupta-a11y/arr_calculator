import { NextResponse } from "next/server";
import {
  getCurrentMonthDateRangeIso,
  queryStripeAiSpendReport,
  type StripeAiSpendGrain,
  type StripeAiSpendRequest,
} from "@/lib/stripeAiSpendReport";

export const runtime = "nodejs";
export const maxDuration = 300;

const ALLOWED_GRAINS = new Set<StripeAiSpendGrain>([
  "daily",
  "weekly",
  "monthly",
  "quarterly",
]);

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
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

  const topLimitRaw = Number(raw.topLimit || 25);
  const topLimit = Number.isFinite(topLimitRaw) ? Math.max(1, Math.floor(topLimitRaw)) : 25;

  const detailLimitRaw = Number(raw.detailLimit || 300);
  const detailLimit = Number.isFinite(detailLimitRaw) ? Math.max(1, Math.floor(detailLimitRaw)) : 300;

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
  return queryStripeAiSpendReport(payload);
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
      topLimit: Number(searchParams.get("topLimit") || 25),
      detailLimit: Number(searchParams.get("detailLimit") || 300),
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
