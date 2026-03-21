import { NextResponse } from "next/server";
import { batchUpdateDealProperties } from "@/lib/hubspot";
import { generateCurrentDealMetrics } from "@/lib/report";

export const runtime = "nodejs";
export const maxDuration = 300;

type RequestBody = {
  asOfDate?: string;
  dryRun?: boolean;
  contractedArrField?: string;
  currentArrField?: string;
  syncedAtField?: string;
};

function isAuthorized(req: Request) {
  if (req.headers.get("x-vercel-cron")) return true;

  const secret = process.env.CRON_SECRET;
  if (!secret) return true;

  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${secret}`;
}

function toBool(value: unknown, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "y";
}

function normalizeFieldName(value: unknown, fallback = "") {
  const raw = value == null ? fallback : String(value);
  const name = raw.trim();
  if (!name) return "";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid HubSpot field name: ${name}`);
  }
  return name;
}

function validateAsOfDate(value: string | undefined) {
  if (!value) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Invalid asOfDate. Expected YYYY-MM-DD.");
  }
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

  const url = new URL(req.url);
  const asOfDate = String(body.asOfDate || url.searchParams.get("asOfDate") || "").trim() || undefined;
  validateAsOfDate(asOfDate);

  const dryRun = toBool(body.dryRun ?? url.searchParams.get("dryRun"), false);
  const contractedArrField = normalizeFieldName(
    body.contractedArrField ?? url.searchParams.get("contractedArrField"),
    process.env.HUBSPOT_CONTRACTED_ARR_FIELD || "contracted_arr",
  );
  const currentArrField = normalizeFieldName(
    body.currentArrField ?? url.searchParams.get("currentArrField"),
    process.env.HUBSPOT_CURRENT_ARR_FIELD || "",
  );
  const syncedAtField = normalizeFieldName(
    body.syncedAtField ?? url.searchParams.get("syncedAtField"),
    process.env.HUBSPOT_ARR_SYNC_DATE_FIELD || "",
  );

  if (!contractedArrField && !currentArrField && !syncedAtField) {
    return NextResponse.json(
      { error: "No HubSpot target fields configured. Set at least one field name." },
      { status: 400 },
    );
  }

  const startedAt = Date.now();
  const metrics = await generateCurrentDealMetrics(asOfDate);

  const updates = metrics
    .map((metric) => {
      const properties: Record<string, string | number | boolean> = {};
      if (contractedArrField) properties[contractedArrField] = metric.currentCarr;
      if (currentArrField) properties[currentArrField] = metric.currentArr;
      if (syncedAtField) properties[syncedAtField] = metric.asOfDate;
      return {
        dealId: metric.dealId,
        properties,
      };
    })
    .filter((update) => Object.keys(update.properties).length > 0);

  if (!dryRun && updates.length) {
    await batchUpdateDealProperties(updates);
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    asOfDate: metrics[0]?.asOfDate || asOfDate || new Date().toISOString().slice(0, 10),
    elapsedMs: Date.now() - startedAt,
    fields: {
      contractedArrField: contractedArrField || null,
      currentArrField: currentArrField || null,
      syncedAtField: syncedAtField || null,
    },
    dealCount: metrics.length,
    updatedDealCount: updates.length,
  });
}

export async function GET(req: Request) {
  try {
    return await handle(req);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.includes("Invalid asOfDate") || message.includes("Invalid HubSpot field name") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(req: Request) {
  try {
    return await handle(req);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.includes("Invalid asOfDate") || message.includes("Invalid HubSpot field name") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
