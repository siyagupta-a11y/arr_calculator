import { NextResponse } from "next/server";
import {
  batchReadLineItems,
  fetchDealPipelineIdToLabelMap,
  fetchDealsCreatedBetween,
  fetchLineItemIdsForDeals,
} from "@/lib/hubspot";
import { computeCalculatedArrForLineItem, LI_PROPS } from "@/lib/logic";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";
import type { HubspotLineItem } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const CACHE_TTL_MS = readTtlMs("API_HUBSPOT_CREATED_PIPELINE_CACHE_TTL_MS", 60_000);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

type RequestBody = {
  startDate?: string;
  endDate?: string;
};

type OtherDealRow = {
  dealId: string;
  dealName: string;
  createdDate: string;
  pipelineValue: number;
};

type BucketRow = {
  weekStart: string;
  weekEnd: string;
  dealCount: number;
  pipelineValue: number;
  pipelineValueArr: number;
  enterpriseDealCount: number;
  managedDealCount: number;
  teamDealCount: number;
  plusDealCount: number;
  deskDealCount: number;
  otherDealCount: number;
  otherDeals: OtherDealRow[];
};

type DealCategory = "enterprise" | "managed" | "team" | "plus" | "desk" | "other";

function round2(n: number) {
  return Math.round((Number(n) || 0) * 100) / 100;
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

function toIsoDateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function parseHubspotTimestampMs(rawValue: unknown) {
  const value = String(rawValue || "").trim();
  if (!value) return NaN;
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return NaN;
    if (numeric > 1_000_000_000_000) return numeric;
    return numeric * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function parseAmount(rawValue: unknown) {
  const value = Number.parseFloat(String(rawValue ?? "").trim());
  return Number.isFinite(value) ? value : 0;
}

function parseCsvSet(raw: string) {
  return Array.from(
    new Set(
      String(raw || "")
        .split(/[,\n\r|;]+/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function normalizePipelineLabelKey(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

async function resolveIncludedPipelineIds() {
  const configuredIds = parseCsvSet(String(process.env.HUBSPOT_CREATED_PIPELINE_IDS || ""));
  if (configuredIds.length) return new Set(configuredIds);

  const pipelineIdToLabel = await fetchDealPipelineIdToLabelMap();
  const out = new Set<string>();
  for (const [pipelineId, label] of pipelineIdToLabel.entries()) {
    const normalized = normalizePipelineLabelKey(label);
    if (
      normalized.includes("salespipeline") ||
      normalized.includes("transactionalpipeline")
    ) {
      out.add(pipelineId);
    }
  }
  return out;
}

function computeDealArrFromLineItems(liIds: string[], lineItemsById: Map<string, HubspotLineItem>) {
  let sum = 0;
  for (const liId of liIds) {
    const properties = lineItemsById.get(liId)?.properties;
    if (!properties) continue;
    sum += computeCalculatedArrForLineItem(properties);
  }
  return round2(sum);
}

function classifyDealFromLineItems(liIds: string[], lineItemsById: Map<string, HubspotLineItem>): DealCategory {
  if (!liIds.length) return "other";
  const searchable = liIds
    .map((liId) => {
      const properties = (lineItemsById.get(liId)?.properties || {}) as Record<string, unknown>;
      return [properties.name, properties.hs_product_name, properties.description, properties.hs_sku]
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean)
        .join(" ");
    })
    .filter(Boolean)
    .join(" ");

  if (!searchable) return "other";
  if (/\bdesk\b/.test(searchable)) return "desk";
  if (/\b(midmarket|smb|enterprise)\b/.test(searchable)) return "enterprise";
  if (/\bmanaged\b/.test(searchable)) return "managed";
  if (/\bteam\b/.test(searchable)) return "team";
  if (/\bplus\b/.test(searchable)) return "plus";
  return "other";
}

async function buildWeeklyCreatedPipeline(startDate: string, endDate: string) {
  const start = parseIsoDateOnly(startDate);
  const end = parseIsoDateOnly(endDate);
  if (!start || !end) throw new Error("Invalid startDate/endDate");
  if (end.getTime() < start.getTime()) throw new Error("endDate must be >= startDate");

  const includedPipelineIds = await resolveIncludedPipelineIds();
  const deals = await fetchDealsCreatedBetween(["amount", "createdate", "dealname", "pipeline"], startDate, endDate);
  const dealsInIncludedPipelines = deals.filter((deal) => {
    const pipelineId = String(deal.properties?.pipeline || "").trim();
    return !!pipelineId && includedPipelineIds.has(pipelineId);
  });
  const dealIdToLineItemIds = new Map<string, string[]>();
  const allLineItemIds = new Set<string>();
  for (const pair of await fetchLineItemIdsForDeals(dealsInIncludedPipelines.map((deal) => String(deal.id || "")))) {
    const ids = pair.ids || [];
    dealIdToLineItemIds.set(pair.dealId, ids);
    for (const id of ids) allLineItemIds.add(id);
  }
  const lineItemsById = await batchReadLineItems(Array.from(allLineItemIds), LI_PROPS);

  const startMs = start.getTime();
  const endMs = end.getTime() + (DAY_MS - 1);

  const bucketMap = new Map<
    string,
    {
      dealCount: number;
      pipelineValue: number;
      pipelineValueArr: number;
      enterpriseDealCount: number;
      managedDealCount: number;
      teamDealCount: number;
      plusDealCount: number;
      deskDealCount: number;
      otherDealCount: number;
      otherDeals: OtherDealRow[];
    }
  >();

  for (const deal of dealsInIncludedPipelines) {
    const properties = deal.properties || {};
    const createdMs = parseHubspotTimestampMs(properties.createdate);
    if (!Number.isFinite(createdMs)) continue;
    if (createdMs < startMs || createdMs > endMs) continue;

    const bucketIndex = Math.floor((createdMs - startMs) / WEEK_MS);
    const bucketStartMs = startMs + bucketIndex * WEEK_MS;
    const bucketStartKey = toIsoDateOnly(new Date(bucketStartMs));
    const amount = parseAmount(properties.amount);
    const dealId = String(deal.id || "").trim();
    const dealName = String(properties.dealname || "").trim();
    const createdDate = toIsoDateOnly(new Date(createdMs));
    const liIds = dealIdToLineItemIds.get(String(deal.id || "")) || [];
    const category = classifyDealFromLineItems(liIds, lineItemsById);
    const dealArr = computeDealArrFromLineItems(liIds, lineItemsById);

    const current = bucketMap.get(bucketStartKey) || {
      dealCount: 0,
      pipelineValue: 0,
      pipelineValueArr: 0,
      enterpriseDealCount: 0,
      managedDealCount: 0,
      teamDealCount: 0,
      plusDealCount: 0,
      deskDealCount: 0,
      otherDealCount: 0,
      otherDeals: [],
    };
    current.dealCount += 1;
    current.pipelineValue += amount;
    current.pipelineValueArr += dealArr;
    if (category === "enterprise") current.enterpriseDealCount += 1;
    else if (category === "managed") current.managedDealCount += 1;
    else if (category === "team") current.teamDealCount += 1;
    else if (category === "plus") current.plusDealCount += 1;
    else if (category === "desk") current.deskDealCount += 1;
    else {
      current.otherDealCount += 1;
      current.otherDeals.push({
        dealId,
        dealName: dealName || "(no name)",
        createdDate,
        pipelineValue: round2(amount),
      });
    }
    bucketMap.set(bucketStartKey, current);
  }

  const rows: BucketRow[] = [];
  for (let bucketStartMs = startMs; bucketStartMs <= endMs; bucketStartMs += WEEK_MS) {
    const weekStart = toIsoDateOnly(new Date(bucketStartMs));
    const weekEndMs = Math.min(bucketStartMs + 6 * DAY_MS, end.getTime());
    const weekEnd = toIsoDateOnly(new Date(weekEndMs));
    const bucket = bucketMap.get(weekStart) || {
      dealCount: 0,
      pipelineValue: 0,
      pipelineValueArr: 0,
      enterpriseDealCount: 0,
      managedDealCount: 0,
      teamDealCount: 0,
      plusDealCount: 0,
      deskDealCount: 0,
      otherDealCount: 0,
      otherDeals: [],
    };
    rows.push({
      weekStart,
      weekEnd,
      dealCount: bucket.dealCount,
      pipelineValue: round2(bucket.pipelineValue),
      pipelineValueArr: round2(bucket.pipelineValueArr),
      enterpriseDealCount: bucket.enterpriseDealCount,
      managedDealCount: bucket.managedDealCount,
      teamDealCount: bucket.teamDealCount,
      plusDealCount: bucket.plusDealCount,
      deskDealCount: bucket.deskDealCount,
      otherDealCount: bucket.otherDealCount,
      otherDeals: bucket.otherDeals
        .slice()
        .sort((a, b) => a.createdDate.localeCompare(b.createdDate) || a.dealName.localeCompare(b.dealName)),
    });
  }

  const totalPipelineValue = round2(rows.reduce((acc, row) => acc + row.pipelineValue, 0));
  const totalPipelineValueArr = round2(rows.reduce((acc, row) => acc + row.pipelineValueArr, 0));
  const totalDeals = rows.reduce((acc, row) => acc + row.dealCount, 0);

  return {
    startDate,
    endDate,
    chunkDays: 7,
    totalPipelineValue,
    totalPipelineValueArr,
    totalDeals,
    rows,
  };
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as RequestBody;
    const startDate = String(body.startDate || "").trim();
    const endDate = String(body.endDate || "").trim();
    if (!startDate || !endDate) throw new Error("Invalid startDate/endDate");

    const key = `api:hubspot-created-pipeline:${stableStringify({ startDate, endDate })}`;
    const payload = await getOrSetCache(key, CACHE_TTL_MS, () => buildWeeklyCreatedPipeline(startDate, endDate));
    return NextResponse.json(payload);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") || message.includes("endDate must be >= startDate") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
