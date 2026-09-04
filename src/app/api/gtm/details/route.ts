import { NextResponse } from "next/server";
import { queryGtmDetails, validateGtmDetailRequest, type GtmDetailRequest } from "@/lib/gtmDetails";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 300;

const CACHE_TTL_MS = readTtlMs("API_GTM_DETAILS_CACHE_TTL_MS", 5 * 60 * 1000);

async function run(raw: Partial<GtmDetailRequest>) {
  const request = validateGtmDetailRequest(raw);
  const cacheKey = `api:gtm:details:${stableStringify(request)}`;
  return getOrSetCache(cacheKey, CACHE_TTL_MS, () => queryGtmDetails(request));
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";
  const status = message.startsWith("Invalid ") ? 400 : 500;
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Partial<GtmDetailRequest>;
    return NextResponse.json(await run(body));
  } catch (error: unknown) {
    return errorResponse(error);
  }
}
