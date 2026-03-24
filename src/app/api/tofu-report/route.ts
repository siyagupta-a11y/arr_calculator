import { NextResponse } from "next/server";
import {
  generateTofuDetailReport,
  generateTofuReport,
  type TofuDetailMetric,
  type TofuDetailRequest,
  type TofuRequest,
} from "@/lib/tofuReport";
import type { CombinedAllSubsCombineMode } from "@/lib/combinedAllSubsReport";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 300;
const CACHE_TTL_MS = readTtlMs("API_TOFU_REPORT_CACHE_TTL_MS", 60_000);

type TofuApiRequest = Partial<TofuRequest> & {
  detailPeriodKey?: string;
  detailMetric?: string;
};

function validateAndRun(body: TofuApiRequest) {
  const basePayload: TofuRequest = {
    startDate: String(body.startDate || ""),
    endDate: String(body.endDate || ""),
    combineMode: String(body.combineMode || "grouped") as CombinedAllSubsCombineMode,
  };

  const detailPeriodKey = String(body.detailPeriodKey || "").trim();
  const detailMetric = String(body.detailMetric || "").trim();
  if (detailPeriodKey && detailMetric) {
    const detailPayload: TofuDetailRequest = {
      ...basePayload,
      detailPeriodKey,
      detailMetric: detailMetric as TofuDetailMetric,
    };
    const key = `api:tofu-report:detail:${stableStringify(detailPayload)}`;
    return getOrSetCache(key, CACHE_TTL_MS, () => generateTofuDetailReport(detailPayload));
  }

  const key = `api:tofu-report:base:${stableStringify(basePayload)}`;
  return getOrSetCache(key, CACHE_TTL_MS, () => generateTofuReport(basePayload));
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as TofuApiRequest;
    return NextResponse.json(await validateAndRun(body));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") ||
      message.includes("endDate must be >= startDate") ||
      message.includes("Invalid detail metric") ||
      message.includes("Invalid detail period")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    return NextResponse.json(
      await validateAndRun({
        startDate: searchParams.get("startDate") || "",
        endDate: searchParams.get("endDate") || "",
        combineMode: String(searchParams.get("combineMode") || "grouped") as CombinedAllSubsCombineMode,
        detailPeriodKey: searchParams.get("detailPeriodKey") || "",
        detailMetric: searchParams.get("detailMetric") || "",
      }),
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") ||
      message.includes("endDate must be >= startDate") ||
      message.includes("Invalid detail metric") ||
      message.includes("Invalid detail period")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
