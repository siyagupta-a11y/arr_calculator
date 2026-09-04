import { NextResponse } from "next/server";
import {
  generateTeamScorecardReport,
  type TeamScorecardReportRequest,
} from "@/lib/teamScorecardReport";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 300;

const CACHE_TTL_MS = readTtlMs("API_TEAM_SCORECARDS_CACHE_TTL_MS", 5 * 60 * 1000);

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as TeamScorecardReportRequest;
    const cacheKey = `api:team-scorecards:v2:${stableStringify(body)}`;
    const report = await getOrSetCache(cacheKey, CACHE_TTL_MS, () => generateTeamScorecardReport(body));
    return NextResponse.json(report);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.startsWith("Invalid") || message.includes("startDate") || message.includes("endDate") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
