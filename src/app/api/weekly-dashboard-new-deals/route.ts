import { NextResponse } from "next/server";
import {
  batchReadLineItems,
  fetchDealPipelineIdToLabelMap,
  fetchDealsCreatedBetween,
  fetchLineItemIdsForDeals,
} from "@/lib/hubspot";
import { computeCalculatedArrForLineItem, LI_PROPS } from "@/lib/logic";
import { getOrSetCache, readTtlMs } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 300;

const CACHE_TTL_MS = readTtlMs("API_WEEKLY_DASHBOARD_NEW_DEALS_CACHE_TTL_MS", 5 * 60 * 1000);

type RequestBody = {
  startDate?: string;
  endDate?: string;
};

type NewDealRow = {
  dealId: string;
  dealName: string;
  createdDate: string;
  arr: number;
  amount: number;
  pipelineLabel: string;
};

type WeeklyNewDealsResponse = {
  startDate: string;
  endDate: string;
  dealCount: number;
  totalArr: number;
  rows: NewDealRow[];
};

function round2(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function parsePayload(raw: Partial<RequestBody>) {
  const startDate = String(raw.startDate || "").trim();
  const endDate = String(raw.endDate || "").trim();
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) throw new Error("Invalid startDate/endDate");
  if (endDate < startDate) throw new Error("endDate must be >= startDate");
  return { startDate, endDate };
}

function parseIsoDateOnly(value: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
  return d;
}

function normalizePipelineLabelKey(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

async function resolveIncludedPipelineIds() {
  const configured = String(process.env.HUBSPOT_CREATED_PIPELINE_IDS || "").trim();
  if (configured) {
    return new Set(
      configured
        .split(/[,\n\r|;]+/)
        .map((value) => value.trim())
        .filter(Boolean),
    );
  }

  const pipelineIdToLabel = await fetchDealPipelineIdToLabelMap();
  const out = new Set<string>();
  for (const [pipelineId, label] of pipelineIdToLabel.entries()) {
    const normalized = normalizePipelineLabelKey(label);
    if (normalized.includes("salespipeline") || normalized.includes("transactionalpipeline")) {
      out.add(pipelineId);
    }
  }
  return out;
}

function pipelineLabelForDeal(pipelineId: string, pipelineIdToLabel: Map<string, string>) {
  return String(pipelineIdToLabel.get(pipelineId) || pipelineId || "Unknown").trim() || "Unknown";
}

async function buildWeeklyNewDeals(startDate: string, endDate: string): Promise<WeeklyNewDealsResponse> {
  const start = parseIsoDateOnly(startDate);
  const end = parseIsoDateOnly(endDate);
  if (!start || !end) throw new Error("Invalid startDate/endDate");
  if (end.getTime() < start.getTime()) throw new Error("endDate must be >= startDate");

  const includedPipelineIds = await resolveIncludedPipelineIds();
  const pipelineIdToLabel = await fetchDealPipelineIdToLabelMap();
  const deals = await fetchDealsCreatedBetween(["createdate", "dealname", "pipeline"], startDate, endDate);
  const filteredDeals = deals.filter((deal) => {
    const pipelineId = String(deal.properties?.pipeline || "").trim();
    return !includedPipelineIds.size || (pipelineId && includedPipelineIds.has(pipelineId));
  });

  const dealIds = filteredDeals.map((deal) => String(deal.id || "")).filter(Boolean);
  const lineItemIdsByDeal = new Map<string, string[]>();
  const allLineItemIds = new Set<string>();
  for (const pair of await fetchLineItemIdsForDeals(dealIds)) {
    const ids = pair.ids || [];
    lineItemIdsByDeal.set(pair.dealId, ids);
    for (const id of ids) allLineItemIds.add(id);
  }

  const lineItemsById = await batchReadLineItems(Array.from(allLineItemIds), LI_PROPS);
  const rows: NewDealRow[] = [];
  for (const deal of filteredDeals) {
    const dealId = String(deal.id || "").trim();
    if (!dealId) continue;
    const properties = deal.properties || {};
    const liIds = lineItemIdsByDeal.get(dealId) || [];
    let arr = 0;
    for (const liId of liIds) {
      const lineItem = lineItemsById.get(liId);
      if (!lineItem?.properties) continue;
      arr += computeCalculatedArrForLineItem(lineItem.properties);
    }
    rows.push({
      dealId,
      dealName: String(properties.dealname || "").trim() || "(no name)",
      createdDate: String(properties.createdate || "").slice(0, 10),
      arr: round2(arr),
      amount: round2(Number(properties.amount || 0)),
      pipelineLabel: pipelineLabelForDeal(String(properties.pipeline || "").trim(), pipelineIdToLabel),
    });
  }

  rows.sort((a, b) => b.arr - a.arr || a.createdDate.localeCompare(b.createdDate) || a.dealName.localeCompare(b.dealName));

  return {
    startDate,
    endDate,
    dealCount: rows.length,
    totalArr: round2(rows.reduce((sum, row) => sum + row.arr, 0)),
    rows,
  };
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Partial<RequestBody>;
    const { startDate, endDate } = parsePayload(body);
    const cacheKey = `api:weekly-dashboard-new-deals:${startDate}:${endDate}`;
    const payload = await getOrSetCache(cacheKey, CACHE_TTL_MS, () => buildWeeklyNewDeals(startDate, endDate));
    return NextResponse.json(payload);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") ||
      message.includes("endDate must be >= startDate")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
