import { NextResponse } from "next/server";
import { fetchQuickBooksExpenseAccounts } from "@/lib/quickbooks";

export const runtime = "nodejs";
export const maxDuration = 120;

function statusCodeFromMessage(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes("not connected")) return 400;
  return 500;
}

export async function GET() {
  try {
    const payload = await fetchQuickBooksExpenseAccounts();
    return NextResponse.json(payload);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: statusCodeFromMessage(message) });
  }
}
