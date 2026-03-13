import { NextResponse } from "next/server";
import { fetchQuickBooksSalesMarketingCostsByMonth } from "@/lib/quickbooks";

export const runtime = "nodejs";
export const maxDuration = 300;

type RequestBody = {
  startDate?: string;
  endDate?: string;
  accountIds?: string[];
};

function normalizeIds(values: unknown) {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

function statusCodeFromMessage(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes("invalid startdate") || lower.includes("invalid enddate")) return 400;
  if (lower.includes("enddate must be >=")) return 400;
  if (lower.includes("not connected")) return 400;
  return 500;
}

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const body = (raw ? JSON.parse(raw) : {}) as RequestBody;
    const startDate = String(body.startDate || "");
    const endDate = String(body.endDate || "");
    const accountIds = normalizeIds(body.accountIds);
    const payload = await fetchQuickBooksSalesMarketingCostsByMonth(startDate, endDate, {
      selectedAccountIds: accountIds,
    });
    return NextResponse.json(payload);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: statusCodeFromMessage(message) });
  }
}
