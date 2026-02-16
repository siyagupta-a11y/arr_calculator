import { NextResponse } from "next/server";
import { ensureStripeSyncForRange, getStripeSyncStoreStats, resetStripeSyncStore } from "@/lib/stripeSyncStore";

export const runtime = "nodejs";

type RequestBody = {
  startDate?: string;
  endDate?: string;
  force?: boolean;
  iterations?: number;
  reset?: boolean;
};

function isAuthorized(req: Request) {
  // Allow Vercel-managed cron invocations without requiring a Bearer token.
  if (req.headers.get("x-vercel-cron")) return true;

  const secret = process.env.CRON_SECRET;
  if (!secret) return true;

  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${secret}`;
}

function defaultWindow() {
  return {
    startDate: "2025-11-01",
    endDate: "2026-01-31",
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
  const defaultIterations = Math.max(1, Math.min(Number(process.env.STRIPE_SYNC_CRON_ITERATIONS || "12"), 200));
  const iterations = Math.max(1, Math.min(Number(body.iterations ?? defaultIterations), 200));
  const runtimeBudgetMs = Math.max(5000, Number(process.env.STRIPE_SYNC_MAX_RUNTIME_MS || "40000"));
  const startedAt = Date.now();
  const hardStopAt = startedAt + runtimeBudgetMs;
  const resetApplied = !!body.reset;

  if (resetApplied) {
    await resetStripeSyncStore();
  }

  const runs: unknown[] = [];
  let syncedInvoicesTotal = 0;
  let stopReason: "exhausted" | "iteration_limit" | "runtime_budget" | "rate_limited" = "iteration_limit";
  for (let i = 0; i < iterations; i++) {
    if (Date.now() >= hardStopAt) {
      stopReason = "runtime_budget";
      break;
    }

    const run = await ensureStripeSyncForRange({
      startDate,
      endDate,
      force: i === 0 ? !!body.force : false,
    });
    runs.push(run);

    if (run && typeof run === "object" && "syncedInvoices" in run) {
      syncedInvoicesTotal += Number((run as { syncedInvoices?: number }).syncedInvoices || 0);
    }
    if (run && typeof run === "object" && "reason" in run && (run as { reason?: string }).reason === "rate_limited") {
      stopReason = "rate_limited";
      break;
    }
    if (run && typeof run === "object" && "hasMore" in run && !(run as { hasMore?: boolean }).hasMore) {
      stopReason = "exhausted";
      break;
    }
  }

  const stats = await getStripeSyncStoreStats();

  return NextResponse.json({
    ok: true,
    startDate,
    endDate,
    iterationsRequested: iterations,
    iterationsExecuted: runs.length,
    elapsedMs: Date.now() - startedAt,
    runtimeBudgetMs,
    resetApplied,
    stopReason,
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
