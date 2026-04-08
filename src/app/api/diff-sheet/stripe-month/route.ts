import { NextResponse } from "next/server";
import { generateStripeCustomerArrForMonth } from "@/lib/stripeReport";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 300;
const CACHE_TTL_MS = readTtlMs("API_DIFF_SHEET_STRIPE_MONTH_CACHE_TTL_MS", 60_000);

type DiffSheetRequest = {
  month: string;
};

async function runForMonth(month: string) {
  const normalizedMonth = String(month || "").trim();
  const key = `api:diff-sheet:stripe-month:${stableStringify({ month: normalizedMonth })}`;
  return getOrSetCache(key, CACHE_TTL_MS, () => generateStripeCustomerArrForMonth(normalizedMonth));
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Partial<DiffSheetRequest>;
    const result = await runForMonth(String(body.month || ""));
    return NextResponse.json(result);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status = message.includes("Invalid month format") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const result = await runForMonth(searchParams.get("month") || "");
    return NextResponse.json(result);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status = message.includes("Invalid month format") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
