import { NextResponse } from "next/server";
import { getQuickBooksStatus } from "@/lib/quickbooks";

export const runtime = "nodejs";
export const maxDuration = 300;

function isAuthorized(req: Request) {
  if (req.headers.get("x-vercel-cron")) return true;

  const secret = process.env.CRON_SECRET;
  if (!secret) return true;

  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  try {
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const startedAt = Date.now();
    const status = await getQuickBooksStatus();
    return NextResponse.json({
      ok: true,
      elapsedMs: Date.now() - startedAt,
      ...status,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
