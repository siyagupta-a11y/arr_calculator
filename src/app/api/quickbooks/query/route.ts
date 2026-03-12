import { NextResponse } from "next/server";
import { runQuickBooksQuery } from "@/lib/quickbooks";

export const runtime = "nodejs";
export const maxDuration = 120;

type QueryBody = {
  query?: string;
};

function statusCodeFromMessage(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes("query is required") || lower.includes("query is too long")) return 400;
  if (lower.includes("not connected")) return 400;
  return 500;
}

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const body = (raw ? JSON.parse(raw) : {}) as QueryBody;
    const payload = await runQuickBooksQuery(String(body.query || ""));
    return NextResponse.json(payload);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: statusCodeFromMessage(message) });
  }
}
