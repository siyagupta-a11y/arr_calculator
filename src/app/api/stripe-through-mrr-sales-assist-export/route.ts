import { NextResponse } from "next/server";
import { fetchWorkspaceIdsForDealStageLabel } from "@/lib/hubspot";
import {
  queryStripeThroughMrrSalesAssistExportFromBigQuery,
  type StripeBigQueryProfile,
} from "@/lib/stripeBigquery";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 300;

const CACHE_TTL_MS = readTtlMs("API_STRIPE_THROUGH_MRR_SALES_ASSIST_EXPORT_CACHE_TTL_MS", 120_000);
const EPSILON = 1e-9;

const STRIPE_THROUGH_MRR_OPTIONS: { profile: StripeBigQueryProfile } = {
  profile: "stripe_arr_correct",
};

type ApiBody = {
  detailMonth?: string;
  targetCurrency?: string;
};

function isIsoMonth(value: string) {
  return /^\d{4}-\d{2}$/.test(value);
}

function normalizeWorkspaceIdToken(value: string) {
  return String(value || "").trim().toLowerCase();
}

function toMoneyText(value: number) {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function previousIsoMonth(isoMonth: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(isoMonth || "").trim());
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return "";
  const d = new Date(Date.UTC(year, month - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

async function buildResponse(detailMonth: string, targetCurrency: string) {
  let transactionalWorkspaceIds = new Set<string>();
  try {
    const fetched = await fetchWorkspaceIdsForDealStageLabel();
    transactionalWorkspaceIds = new Set(
      Array.from(fetched)
        .map((workspaceId) => normalizeWorkspaceIdToken(workspaceId))
        .filter(Boolean),
    );
  } catch (error) {
    console.warn(
      `Stripe through MRR sales-assist export: failed to fetch transactional workspace ids: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const workspaceIds = Array.from(transactionalWorkspaceIds);
  if (!workspaceIds.length) {
    return {
      detailMonth,
      previousMonth: previousIsoMonth(detailMonth),
      targetCurrency: targetCurrency.toUpperCase(),
      rows: [],
    };
  }

  const payload = await queryStripeThroughMrrSalesAssistExportFromBigQuery(
    { detailMonth, targetCurrency, workspaceIds },
    STRIPE_THROUGH_MRR_OPTIONS,
  );

  const rows: string[][] = [];
  for (const group of payload.rows) {
    const previous = Number(group.previousMonthEndMrr || 0);
    const current = Number(group.currentMonthEndMrr || 0);
    if (!(Math.abs(previous) <= EPSILON && current > EPSILON)) continue;

    const customerIds = (group.associatedCustomerIds || []).filter(Boolean);
    if (!customerIds.length) continue;
    const workspaceCell = (group.associatedWorkspaceIds || []).filter(Boolean).join(" | ");

    for (const customerId of customerIds) {
      rows.push([
        payload.detailMonth,
        payload.previousMonth,
        customerId,
        group.emailGroup || "(blank)",
        group.customerCountry || "N/A",
        group.customerTerritory || "N/A",
        workspaceCell,
        "yes",
        toMoneyText(previous),
        toMoneyText(current),
      ]);
    }
  }

  rows.sort((a, b) => {
    const bCurrent = Number(b[9] || 0);
    const aCurrent = Number(a[9] || 0);
    if (Math.abs(bCurrent - aCurrent) > EPSILON) return bCurrent - aCurrent;
    return String(a[2] || "").localeCompare(String(b[2] || ""));
  });

  return {
    detailMonth: payload.detailMonth,
    previousMonth: payload.previousMonth,
    targetCurrency: payload.targetCurrency,
    rows,
  };
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as ApiBody;
    const detailMonth = String(body.detailMonth || "").trim();
    if (!isIsoMonth(detailMonth)) {
      return NextResponse.json({ error: "Invalid detailMonth" }, { status: 400 });
    }
    const targetCurrency =
      String(body.targetCurrency || process.env.STRIPE_THROUGH_MRR_TARGET_CURRENCY || "USD")
        .trim()
        .toLowerCase() || "usd";

    const key = `api:stripe-through-mrr-sales-assist-export:${stableStringify({ detailMonth, targetCurrency })}`;
    const response = await getOrSetCache(key, CACHE_TTL_MS, () => buildResponse(detailMonth, targetCurrency));
    return NextResponse.json(response);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
