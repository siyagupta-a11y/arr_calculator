import { NextResponse } from "next/server";
import { generateCurrentDealMetrics } from "@/lib/report";
import { batchUpdateDealProperties } from "@/lib/hubspot";

export const runtime = "nodejs";

type RequestBody = {
  asOfDate?: string;
};

function isAuthorized(req: Request) {
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

  const asOfDate = body.asOfDate || new Date().toISOString().slice(0, 10);

  const arrProp = process.env.HUBSPOT_CURRENT_ARR_PROP || "current_arr";
  const carrProp = process.env.HUBSPOT_CURRENT_CARR_PROP || "current_carr";

  const metrics = await generateCurrentDealMetrics(asOfDate);

  await batchUpdateDealProperties(
    metrics.map((m) => ({
      dealId: m.dealId,
      properties: {
        [arrProp]: m.currentArr,
        [carrProp]: m.currentCarr,
      },
    })),
  );

  const arrTotal = metrics.reduce((acc, m) => acc + m.currentArr, 0);
  const carrTotal = metrics.reduce((acc, m) => acc + m.currentCarr, 0);

  return NextResponse.json({
    ok: true,
    asOfDate,
    updatedDeals: metrics.length,
    arrProperty: arrProp,
    carrProperty: carrProp,
    totals: {
      arr: arrTotal,
      carr: carrTotal,
    },
  });
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
