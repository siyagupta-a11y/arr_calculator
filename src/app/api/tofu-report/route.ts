import { NextResponse } from "next/server";
import { generateTofuReport, type TofuRequest } from "@/lib/tofuReport";

export const runtime = "nodejs";
export const maxDuration = 300;

function validateAndRun(body: Partial<TofuRequest>) {
  const payload: TofuRequest = {
    startDate: String(body.startDate || ""),
    endDate: String(body.endDate || ""),
  };
  return generateTofuReport(payload);
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Partial<TofuRequest>;
    return NextResponse.json(await validateAndRun(body));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") || message.includes("endDate must be >= startDate")
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
      }),
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") || message.includes("endDate must be >= startDate")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
