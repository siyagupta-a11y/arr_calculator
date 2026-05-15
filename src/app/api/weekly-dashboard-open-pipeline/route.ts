import { NextResponse } from "next/server";
import { batchReadLineItems, fetchDealStageIdToLabelMap, fetchDealsInStage, fetchLineItemIdsForDeals } from "@/lib/hubspot";
import { computeCalculatedArrForLineItem, LI_PROPS } from "@/lib/logic";
import type { HubspotLineItem } from "@/lib/types";
import { getOrSetCache, readTtlMs } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 300;

const CACHE_TTL_MS = readTtlMs("API_WEEKLY_DASHBOARD_OPEN_PIPELINE_CACHE_TTL_MS", 5 * 60 * 1000);

type OpenPipelineResponse = {
  asOfDate: string;
  openPipelineArr: number;
  openDealCount: number;
  includedStageCount: number;
};

function round2(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function toIsoDateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function normalizeStageLabelKey(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

async function resolveOpenStageIds() {
  const stageIdToLabel = await fetchDealStageIdToLabelMap();
  const openStageIds = Array.from(stageIdToLabel.entries())
    .filter(([, label]) => {
      const normalized = normalizeStageLabelKey(label || "");
      return !normalized.includes("closedwon") && !normalized.includes("closedlost");
    })
    .map(([stageId]) => stageId);
  return openStageIds;
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

async function buildOpenPipelinePayload(): Promise<OpenPipelineResponse> {
  const asOfDate = toIsoDateOnly(new Date());
  const openStageIds = await resolveOpenStageIds();
  const dealsById = new Map<string, { id: string; properties?: Record<string, unknown> }>();

  for (const stageId of openStageIds) {
    const deals = await fetchDealsInStage(["amount", "createdate", "dealname", "dealstage"], stageId);
    for (const deal of deals || []) {
      const dealId = String(deal.id || "").trim();
      if (!dealId) continue;
      const previous = dealsById.get(dealId);
      if (!previous) {
        dealsById.set(dealId, { id: dealId, properties: { ...(deal.properties || {}) } });
        continue;
      }
      dealsById.set(dealId, {
        id: dealId,
        properties: {
          ...(previous.properties || {}),
          ...(deal.properties || {}),
        },
      });
    }
  }

  const dealIds = Array.from(dealsById.keys());
  if (!dealIds.length) {
    return {
      asOfDate,
      openPipelineArr: 0,
      openDealCount: 0,
      includedStageCount: openStageIds.length,
    };
  }

  const lineItemIdsByDeal = new Map<string, string[]>();
  const allLineItemIds = new Set<string>();
  for (const pair of await fetchLineItemIdsForDeals(dealIds)) {
    const ids = pair.ids || [];
    lineItemIdsByDeal.set(pair.dealId, ids);
    for (const id of ids) allLineItemIds.add(id);
  }

  const lineItemsById = await batchReadLineItems(Array.from(allLineItemIds), LI_PROPS);
  let openPipelineArr = 0;
  let openDealCount = 0;
  for (const dealId of dealIds) {
    const liIds = lineItemIdsByDeal.get(dealId) || [];
    if (!liIds.length) continue;
    const dealArr = computeDealArrFromLineItems(liIds, lineItemsById);
    if (dealArr <= 0) continue;
    openPipelineArr = round2(openPipelineArr + dealArr);
    openDealCount += 1;
  }

  return {
    asOfDate,
    openPipelineArr,
    openDealCount,
    includedStageCount: openStageIds.length,
  };
}

export async function GET() {
  try {
    const payload = await getOrSetCache("api:weekly-dashboard-open-pipeline", CACHE_TTL_MS, buildOpenPipelinePayload);
    return NextResponse.json(payload);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST() {
  return GET();
}
