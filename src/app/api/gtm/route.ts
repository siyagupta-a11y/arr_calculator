import { NextResponse } from "next/server";
import { generateGtmReport } from "@/lib/gtmReport";
import { getOrSetCache, readTtlMs } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 300;

const CACHE_TTL_MS = readTtlMs("API_GTM_CACHE_TTL_MS", 5 * 60 * 1000);

type RequestBody = {
  monthKey?: string;
  asOfDate?: string;
};

function parsePayload(raw: Partial<RequestBody>) {
  const monthKey = String(raw.monthKey || "").trim();
  const asOfDate = String(raw.asOfDate || "").trim();
  if (!/^\d{4}-\d{2}$/.test(monthKey)) throw new Error("Invalid monthKey. Expected YYYY-MM.");
  if (asOfDate && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) throw new Error("Invalid asOfDate. Expected YYYY-MM-DD.");
  return { monthKey, asOfDate };
}

async function run(raw: Partial<RequestBody>) {
  const payload = parsePayload(raw);
  const cacheKey = `api:gtm:${payload.monthKey}:${payload.asOfDate || "default"}`;
  return getOrSetCache(cacheKey, CACHE_TTL_MS, () => generateGtmReport(payload));
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";
  const status = message.startsWith("Invalid ") ? 400 : 500;
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Partial<RequestBody>;
    return NextResponse.json(await run(body));
  } catch (error: unknown) {
    return errorResponse(error);
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    return NextResponse.json(
      await run({
        monthKey: searchParams.get("monthKey") || "",
        asOfDate: searchParams.get("asOfDate") || "",
      }),
    );
  } catch (error: unknown) {
    return errorResponse(error);
  }
}
