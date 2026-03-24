import { NextResponse } from "next/server";
import { buildCombinedLiveArrPayload } from "@/lib/combinedLiveArr";
import { getOrSetCache, readTtlMs } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 300;
const CACHE_TTL_MS = readTtlMs("API_COMBINED_LIVE_ARR_CACHE_TTL_MS", 30_000);

export async function GET() {
  try {
    const payload = await getOrSetCache("api:combined-live-arr", CACHE_TTL_MS, () => buildCombinedLiveArrPayload());
    return NextResponse.json(payload);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST() {
  try {
    const payload = await getOrSetCache("api:combined-live-arr", CACHE_TTL_MS, () => buildCombinedLiveArrPayload());
    return NextResponse.json(payload);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
