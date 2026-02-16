import { NextResponse } from "next/server";
import { getStripeSyncStoreStats } from "@/lib/stripeSyncStore";

export const runtime = "nodejs";

function isAuthorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;

  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const stats = await getStripeSyncStoreStats();
  const now = Date.now();
  const secondsSinceUpdate = stats.updatedAtTs > 0 ? Math.floor((now - stats.updatedAtTs) / 1000) : null;

  return NextResponse.json({
    ok: true,
    nowTs: now,
    secondsSinceUpdate,
    healthy: stats.storage === "vercel_blob" && stats.itemCount > 0,
    stats,
  });
}
