import { NextResponse } from "next/server";
import {
  queryStripeBillingOverviewFromBigQuery,
  type StripeBigQueryProfile,
  type StripeBillingOverviewGrain,
  type StripeBillingOverviewRequest,
} from "@/lib/stripeBigquery";

export const runtime = "nodejs";
export const maxDuration = 300;

const STRIPE_BILLING_OVERVIEW_OPTIONS: { profile: StripeBigQueryProfile } = {
  profile: "stripe_arr_correct",
};

const ALLOWED_GRAINS = new Set<StripeBillingOverviewGrain>([
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
};

function parsePayload(raw: Partial<ApiBody>): StripeBillingOverviewRequest {
  const startDate = String(raw.startDate || "").trim();
  const endDate = String(raw.endDate || "").trim();
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    throw new Error("Invalid startDate/endDate");
  }

  const grainRaw = String(raw.grain || "monthly").trim().toLowerCase() as StripeBillingOverviewGrain;
  const grain = ALLOWED_GRAINS.has(grainRaw) ? grainRaw : "monthly";

  const targetCurrency =
    String(process.env.STRIPE_BILLING_OVERVIEW_TARGET_CURRENCY || "").trim() ||
    String(process.env.STRIPE_THROUGH_MRR_TARGET_CURRENCY || "").trim() ||
    String(process.env.STRIPE_ARR_CORRECT_TARGET_CURRENCY || "").trim() ||
    "USD";

  return {
    startDate,
    endDate,
    grain,
    targetCurrency,
  };
}

async function validateAndRun(body: Partial<ApiBody>) {
  const payload = parsePayload(body);
  return queryStripeBillingOverviewFromBigQuery(payload, STRIPE_BILLING_OVERVIEW_OPTIONS);
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
