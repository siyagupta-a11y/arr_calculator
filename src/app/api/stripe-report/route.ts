import { NextResponse } from "next/server";
import type { Grain } from "@/lib/types";
import { generateStripeReport } from "@/lib/stripeReport";

export const runtime = "nodejs";

type StripeApiRequest = {
  startDate: string;
  endDate: string;
  grain: Grain;
};

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as StripeApiRequest;
    const report = await generateStripeReport(body);
    if (!report.rows.length) {
      return NextResponse.json(
        {
          error:
            "No synced Stripe data for this range yet. Run /api/stripe-sync for the same date window, then retry.",
        },
        { status: 409 },
      );
    }
    return NextResponse.json(report);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") || message.includes("endDate must be >= startDate")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function GET() {
  return NextResponse.json(
    { error: "Method not allowed. Use POST /api/stripe-report with JSON body." },
    { status: 405 },
  );
}
