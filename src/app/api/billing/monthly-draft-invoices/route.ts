import { NextResponse } from "next/server";
import { monthlyDraftInvoicesEnabled, runMonthlyDraftInvoiceJob } from "@/lib/monthlyDraftInvoices";

export const runtime = "nodejs";
export const maxDuration = 300;

type RequestBody = {
  month?: string;
  dryRun?: boolean;
  maxDeals?: number;
};

function authorized(req: Request) {
  const secret = String(process.env.CRON_SECRET || "").trim();
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function boolValue(value: unknown, fallback: boolean) {
  if (value == null || String(value).trim() === "") return fallback;
  return ["1", "true", "yes", "y"].includes(String(value).trim().toLowerCase());
}

async function handle(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: RequestBody = {};
  if (req.method !== "GET") {
    try {
      body = await req.json() as RequestBody;
    } catch {
      body = {};
    }
  }
  const url = new URL(req.url);
  const enabled = monthlyDraftInvoicesEnabled();
  const requestedDryRun = boolValue(body.dryRun ?? url.searchParams.get("dryRun"), !enabled);
  const dryRun = requestedDryRun || !enabled;
  const month = String(body.month || url.searchParams.get("month") || "").trim() || undefined;
  const maxDealsRaw = body.maxDeals ?? url.searchParams.get("maxDeals") ?? undefined;
  const maxDeals = maxDealsRaw == null ? undefined : Number(maxDealsRaw);
  const result = await runMonthlyDraftInvoiceJob({ billingMonth: month, dryRun, maxDeals });

  return NextResponse.json({
    ...result,
    enabled,
    guardMessage: enabled ? null : "BILLING_DRAFTS_ENABLED is not true; this run was forced to dry-run mode.",
  });
}

export async function GET(req: Request) {
  try {
    return await handle(req);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    return await handle(req);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
