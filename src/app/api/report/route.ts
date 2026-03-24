import { NextResponse } from "next/server";
import type { ReportRequest } from "@/lib/types";
import { generateReport } from "@/lib/report";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 300;
const CACHE_TTL_MS = readTtlMs("API_REPORT_CACHE_TTL_MS", 60_000);

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ReportRequest & { startMonth?: string; endMonth?: string };
    const key = `api:report:${stableStringify(body)}`;
    const report = await getOrSetCache(key, CACHE_TTL_MS, () => generateReport(body));
    return NextResponse.json(report);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status = message.includes("Invalid startDate/endDate") || message.includes("endDate must be >= startDate")
      ? 400
      : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
