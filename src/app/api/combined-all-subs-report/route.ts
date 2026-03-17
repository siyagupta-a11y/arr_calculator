import { NextResponse } from "next/server";
import {
  generateCombinedAllSubsReport,
  type CombinedAllSubsRequest,
} from "@/lib/combinedAllSubsReport";

export const runtime = "nodejs";
export const maxDuration = 300;

function validateAndRun(body: Partial<CombinedAllSubsRequest>) {
  const payload: CombinedAllSubsRequest = {
    startDate: String(body.startDate || ""),
    endDate: String(body.endDate || ""),
  };
  return generateCombinedAllSubsReport(payload);
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
