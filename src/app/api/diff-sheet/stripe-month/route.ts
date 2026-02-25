import { NextResponse } from "next/server";
import { generateStripeCustomerArrForMonth } from "@/lib/stripeReport";

export const runtime = "nodejs";
export const maxDuration = 300;

type DiffSheetRequest = {
  month: string;
};

async function runForMonth(month: string) {
  return generateStripeCustomerArrForMonth(String(month || ""));
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
