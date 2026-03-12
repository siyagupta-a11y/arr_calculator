import { NextResponse } from "next/server";
import { getQuickBooksStatus } from "@/lib/quickbooks";

export const runtime = "nodejs";

export async function GET() {
  try {
    const status = await getQuickBooksStatus();
    return NextResponse.json(status);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
