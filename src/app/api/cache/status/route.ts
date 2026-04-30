import { NextResponse } from "next/server";
import {
  readServerCacheSyncStatus,
  serverResponseCacheStats,
} from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  try {
    const [lastSync, stats] = await Promise.all([
      readServerCacheSyncStatus(),
      Promise.resolve(serverResponseCacheStats()),
    ]);
    return NextResponse.json({
      ok: true,
      lastSync,
      stats,
      checkedAtUtc: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

