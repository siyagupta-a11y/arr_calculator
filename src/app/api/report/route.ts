import { NextResponse } from "next/server";
import type { ReportRequest } from "@/lib/types";
import { generateReport } from "@/lib/report";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ReportRequest & { startMonth?: string; endMonth?: string };
    const report = await generateReport(body);
    return NextResponse.json(report);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status = message.includes("Invalid startDate/endDate") || message.includes("endDate must be >= startDate")
      ? 400
      : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
