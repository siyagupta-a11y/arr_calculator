import { NextResponse } from "next/server";
import { ensureStripeSyncForRange, getStripeSyncStoreStats } from "@/lib/stripeSyncStore";

export const runtime = "nodejs";

type RequestBody = {
  startDate?: string;
  endDate?: string;
  force?: boolean;
};

function isAuthorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;

  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${secret}`;
}

function defaultWindow() {
  const end = new Date();
  const lookbackDays = Number(process.env.STRIPE_SYNC_DEFAULT_LOOKBACK_DAYS || "730");
  const start = new Date(end.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    body = {};
  }

  const fallback = defaultWindow();
  const startDate = body.startDate || fallback.startDate;
  const endDate = body.endDate || fallback.endDate;

  const sync = await ensureStripeSyncForRange({
    startDate,
    endDate,
    force: !!body.force,
  });

  const stats = await getStripeSyncStoreStats();

  return NextResponse.json({
    ok: true,
    startDate,
    endDate,
    sync,
    stats,
  });
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
