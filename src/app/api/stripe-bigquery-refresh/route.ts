import { NextResponse } from "next/server";
import { refreshStripeBigQueryExternalTablesFromBucket } from "@/lib/stripeBigqueryBucketRefresh";

export const runtime = "nodejs";
export const maxDuration = 300;

type RequestBody = {
  dryRun?: boolean;
  snapshot?: string;
  mode?: string;
};

function isAuthorized(req: Request) {
  // Allow Vercel-managed cron invocations without requiring a Bearer token.
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

  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    body = {};
  }

  const startedAt = Date.now();
  const result = await refreshStripeBigQueryExternalTablesFromBucket({
    dryRun: body.dryRun,
    snapshot: body.snapshot,
    mode: body.mode,
  });

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
