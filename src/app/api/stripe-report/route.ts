import { NextResponse } from "next/server";
import type { Grain } from "@/lib/types";
import { generateStripeReport } from "@/lib/stripeReport";

export const runtime = "nodejs";

type StripeApiRequest = {
  startDate: string;
  endDate: string;
  grain: Grain;
};

function validateAndRun(body: Partial<StripeApiRequest>) {
  const payload: StripeApiRequest = {
    startDate: String(body.startDate || ""),
    endDate: String(body.endDate || ""),
    grain: (body.grain as Grain) || "monthly",
  };
  return generateStripeReport(payload);
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Partial<StripeApiRequest>;
    const report = await validateAndRun(body);
    return NextResponse.json(report);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") ||
      message.includes("endDate must be >= startDate") ||
      message.includes("POC is limited")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const body: Partial<StripeApiRequest> = {
      startDate: searchParams.get("startDate") || "",
      endDate: searchParams.get("endDate") || "",
      grain: (searchParams.get("grain") as Grain) || "monthly",
    };
    const report = await validateAndRun(body);
    return NextResponse.json(report);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") ||
      message.includes("endDate must be >= startDate") ||
      message.includes("POC is limited")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
