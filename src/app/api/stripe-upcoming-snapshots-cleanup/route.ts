import { NextResponse } from "next/server";
import {
  cleanupStripeUpcomingSnapshotsForDay,
  type StripeBigQueryProfile,
} from "@/lib/stripeBigquery";

export const runtime = "nodejs";
export const maxDuration = 300;

type RequestBody = {
  dryRun?: boolean;
  targetDate?: string;
  profile?: string;
};

function asBool(value: unknown, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "y";
}

function normalizeProfile(value: string | undefined): StripeBigQueryProfile {
  return String(value || "").trim().toLowerCase() === "default"
    ? "default"
    : "stripe_arr_correct";
}

function isAuthorized(req: Request) {
  if (req.headers.get("x-vercel-cron")) return true;

  const secret = process.env.CRON_SECRET;
  if (!secret) return true;

  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${secret}`;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    body = {};
  }

  const targetDate =
    String(body.targetDate || "").trim() ||
    String(url.searchParams.get("targetDate") || "").trim();
  const profile = normalizeProfile(
    String(body.profile || "").trim() || String(url.searchParams.get("profile") || "").trim(),
  );
  const dryRunBody = body.dryRun;
  const dryRunQuery = url.searchParams.get("dryRun");
  const dryRun = dryRunBody != null ? !!dryRunBody : asBool(dryRunQuery, false);

  const startedAt = Date.now();
  const result = await cleanupStripeUpcomingSnapshotsForDay(
    {
      targetDate: targetDate || undefined,
      dryRun,
    },
    { profile },
  );

  return NextResponse.json({
    ok: true,
    elapsedMs: Date.now() - startedAt,
    ...result,
  });
}

export async function GET(req: Request) {
  try {
    return await handle(req);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    return await handle(req);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
