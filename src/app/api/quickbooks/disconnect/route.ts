import { NextResponse } from "next/server";
import { disconnectQuickBooks } from "@/lib/quickbooks";

export const runtime = "nodejs";

export async function POST() {
  try {
    await disconnectQuickBooks();
    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
