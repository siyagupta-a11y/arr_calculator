import { NextResponse } from "next/server";
import {
  generateTeamScorecardReport,
  type TeamScorecardReportRequest,
} from "@/lib/teamScorecardReport";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 300;

const CACHE_TTL_MS = readTtlMs("API_TEAM_SCORECARDS_CACHE_TTL_MS", 5 * 60 * 1000);

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const input: TeamScorecardReportRequest = {
      team: url.searchParams.get("team") || "",
      startDate: url.searchParams.get("startDate") || "",
      endDate: url.searchParams.get("endDate") || "",
    };
    const cacheKey = `api:team-scorecards:v2:${stableStringify(input)}`;
    const report = await getOrSetCache(cacheKey, CACHE_TTL_MS, () => generateTeamScorecardReport(input));
    return NextResponse.json(report, {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.startsWith("Invalid") || message.includes("startDate") || message.includes("endDate") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
