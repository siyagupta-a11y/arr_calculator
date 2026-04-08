import { NextResponse } from "next/server";
import { fetchQuickBooksCompanyInfo } from "@/lib/quickbooks";
import { getOrSetCache, readTtlMs } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
const CACHE_TTL_MS = readTtlMs("API_QUICKBOOKS_COMPANY_INFO_CACHE_TTL_MS", 30_000);

function statusCodeFromMessage(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes("not connected")) return 400;
  if (lower.includes("missing quickbooks")) return 500;
  return 500;
}

export async function GET() {
  try {
    const payload = await getOrSetCache("api:quickbooks:company-info", CACHE_TTL_MS, () =>
      fetchQuickBooksCompanyInfo(),
    );
    return NextResponse.json(payload);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: statusCodeFromMessage(message) });
  }
}
