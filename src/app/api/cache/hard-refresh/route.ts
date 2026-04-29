import { NextResponse } from "next/server";
import { clearHubspotMemoryCache } from "@/lib/hubspot";
import { clearServerResponseCache } from "@/lib/serverResponseCache";
import { clearStripeReportMemoryCache } from "@/lib/stripeReport";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST() {
  try {
    const serverCache = clearServerResponseCache();
    clearHubspotMemoryCache();
    clearStripeReportMemoryCache();
    return NextResponse.json({
      ok: true,
      refreshedAtUtc: new Date().toISOString(),
      serverCache,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
