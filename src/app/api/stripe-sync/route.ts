import { NextResponse } from "next/server";
import { ensureStripeSyncForRange, getStripeSyncStoreStats } from "@/lib/stripeSyncStore";

export const runtime = "nodejs";

type RequestBody = {
  startDate?: string;
  endDate?: string;
  force?: boolean;
  iterations?: number;
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
  const iterations = Math.max(1, Math.min(Number(body.iterations || 1), 20));

  const runs: unknown[] = [];
  let syncedInvoicesTotal = 0;
  for (let i = 0; i < iterations; i++) {
    const run = await ensureStripeSyncForRange({
      startDate,
      endDate,
      force: i === 0 ? !!body.force : false,
    });
    runs.push(run);

    if (run && typeof run === "object" && "syncedInvoices" in run) {
      syncedInvoicesTotal += Number((run as { syncedInvoices?: number }).syncedInvoices || 0);
    }
    if (run && typeof run === "object" && "hasMore" in run && !(run as { hasMore?: boolean }).hasMore) break;
  }

  const stats = await getStripeSyncStoreStats();

  return NextResponse.json({
    ok: true,
    startDate,
    endDate,
    iterationsRequested: iterations,
    iterationsExecuted: runs.length,
    syncedInvoicesTotal,
    lastRun: runs[runs.length - 1] || null,
    runs,
    stats,
  });
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
