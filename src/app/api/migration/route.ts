import { NextResponse } from "next/server";
import { generateMigrationReport } from "@/lib/migrationReport";
import { getOrSetCache, readTtlMs } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 300;

const CACHE_TTL_MS = readTtlMs("API_MIGRATION_CACHE_TTL_MS", 5 * 60 * 1000);

export async function GET() {
  try {
    const report = await getOrSetCache("api:migration:v1", CACHE_TTL_MS, () => generateMigrationReport());
    return NextResponse.json(report);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
