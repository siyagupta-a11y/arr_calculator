import { NextResponse } from "next/server";
import { fetchQuickBooksCompanyInfo } from "@/lib/quickbooks";

export const runtime = "nodejs";

function statusCodeFromMessage(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes("not connected")) return 400;
  if (lower.includes("missing quickbooks")) return 500;
  return 500;
}

export async function GET() {
  try {
    const payload = await fetchQuickBooksCompanyInfo();
    return NextResponse.json(payload);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: statusCodeFromMessage(message) });
  }
}
