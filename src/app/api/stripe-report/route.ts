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
    const body = (await req.json()) as StripeApiRequest;
    const report = await generateStripeReport(body);
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
