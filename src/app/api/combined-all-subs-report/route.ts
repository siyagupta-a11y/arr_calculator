import { NextResponse } from "next/server";
import {
  generateCombinedAllSubsReport,
  type CombinedAllSubsCombineMode,
  type CombinedAllSubsRequest,
} from "@/lib/combinedAllSubsReport";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 300;
const CACHE_TTL_MS = readTtlMs("API_COMBINED_ALL_SUBS_CACHE_TTL_MS", 60_000);

function validateAndRun(body: Partial<CombinedAllSubsRequest>) {
  const payload: CombinedAllSubsRequest = {
    startDate: String(body.startDate || ""),
    endDate: String(body.endDate || ""),
    combineMode: String(body.combineMode || "grouped") as CombinedAllSubsCombineMode,
    displayMode: String(body.displayMode || "arr") as CombinedAllSubsRequest["displayMode"],
    planGrain: String(body.planGrain || "monthly") as CombinedAllSubsRequest["planGrain"],
  };
  const key = `api:combined-all-subs:${stableStringify(payload)}`;
  return getOrSetCache(key, CACHE_TTL_MS, () => generateCombinedAllSubsReport(payload));
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Partial<CombinedAllSubsRequest>;
    const report = await validateAndRun(body);
    return NextResponse.json(report);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") ||
      message.includes("endDate must be >= startDate")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const report = await validateAndRun({
      startDate: searchParams.get("startDate") || "",
      endDate: searchParams.get("endDate") || "",
      combineMode: String(searchParams.get("combineMode") || "grouped") as CombinedAllSubsCombineMode,
      displayMode: String(searchParams.get("displayMode") || "arr") as CombinedAllSubsRequest["displayMode"],
      planGrain: String(searchParams.get("planGrain") || "monthly") as CombinedAllSubsRequest["planGrain"],
    });
    return NextResponse.json(report);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") ||
      message.includes("endDate must be >= startDate")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
