import { NextResponse } from "next/server";
import {
  batchReadCompanies,
  batchReadLineItems,
  fetchDealStageIdToLabelMap,
  fetchDealsInStageClosedBetween,
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

type ClosedWonAccountRow = {
  accountId: string;
  accountName: string;
  closedWonDealCount: number;
  arr: number;
  latestClosedDate: string;
};

type WeeklyClosedWonAccountsResponse = {
  startDate: string;
  endDate: string;
  accountCount: number;
  dealCount: number;
  totalArr: number;
  rows: ClosedWonAccountRow[];
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

async function resolveClosedWonStageIds() {
  const configured = String(process.env.HUBSPOT_CLOSED_WON_STAGE_IDS || process.env.HUBSPOT_CLOSED_WON_STAGE_ID || "").trim();
  if (configured) {
    return Array.from(
      new Set(
        configured
          .split(/[,\n\r|;]+/)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    );
  }

  const stageIdToLabel = await fetchDealStageIdToLabelMap();
  return Array.from(stageIdToLabel.entries())
    .filter(([, label]) => normalizePipelineLabelKey(label || "").includes("closedwon"))
    .map(([stageId]) => stageId);
}

function firstNonEmptyString(values: Array<string | undefined>) {
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (trimmed) return trimmed;
  }
  return "";
}

async function buildWeeklyClosedWonAccounts(startDate: string, endDate: string): Promise<WeeklyClosedWonAccountsResponse> {
  const start = parseIsoDateOnly(startDate);
  const end = parseIsoDateOnly(endDate);
  if (!start || !end) throw new Error("Invalid startDate/endDate");
  if (end.getTime() < start.getTime()) throw new Error("endDate must be >= startDate");

  const closedWonStageIds = await resolveClosedWonStageIds();
  if (!closedWonStageIds.length) {
    return {
      startDate,
      endDate,
      accountCount: 0,
      dealCount: 0,
      totalArr: 0,
      rows: [],
    };
  }

  const dealsById = new Map<string, {
    dealId: string;
    accountId: string;
    dealName: string;
    closedDate: string;
    arr: number;
    closedWonStageId: string;
  }>();

  for (const stageId of closedWonStageIds) {
    const deals = await fetchDealsInStageClosedBetween(["createdate", "closedate", "dealname", "hs_primary_associated_company", "dealstage"], stageId, startDate, endDate);
    for (const deal of deals || []) {
      const dealId = String(deal.id || "").trim();
      if (!dealId) continue;
      const properties = deal.properties || {};
      const accountId = firstNonEmptyString([
        String(properties.hs_primary_associated_company || ""),
        String(properties.account_id || ""),
        String(properties.companyid || ""),
      ]);
      const closedDate = String(properties.closedate || "").trim().slice(0, 10);
      const previous = dealsById.get(dealId);
      if (!previous) {
        dealsById.set(dealId, {
          dealId,
          accountId,
          dealName: String(properties.dealname || "").trim() || "(no name)",
          closedDate,
          arr: 0,
          closedWonStageId: stageId,
        });
      }
    }
  }

  const dealIds = Array.from(dealsById.keys());
  const lineItemIdsByDeal = new Map<string, string[]>();
  const allLineItemIds = new Set<string>();
  for (const pair of await fetchLineItemIdsForDeals(dealIds)) {
    const ids = pair.ids || [];
    lineItemIdsByDeal.set(pair.dealId, ids);
    for (const id of ids) allLineItemIds.add(id);
  }
  const lineItemsById = await batchReadLineItems(Array.from(allLineItemIds), LI_PROPS);

  const accountIds = Array.from(
    new Set(
      Array.from(dealsById.values())
        .map((row) => String(row.accountId || "").trim())
        .filter(Boolean),
    ),
  );
  const companiesById = accountIds.length ? await batchReadCompanies(accountIds, ["name", "hs_name"]) : new Map();
  const rowsByAccount = new Map<string, ClosedWonAccountRow>();

  for (const deal of dealsById.values()) {
    const liIds = lineItemIdsByDeal.get(deal.dealId) || [];
    let dealArr = 0;
    for (const liId of liIds) {
      const lineItem = lineItemsById.get(liId);
      if (!lineItem?.properties) continue;
      dealArr += computeCalculatedArrForLineItem(lineItem.properties);
    }
    if (dealArr <= 0) continue;

    const companyId = String(deal.accountId || "").trim() || deal.dealId;
    const company = companyId !== deal.dealId ? companiesById.get(companyId) : null;
    const companyProps = (company?.properties || {}) as Record<string, unknown>;
    const accountName =
      firstNonEmptyString([
        String(companyProps.name || ""),
        String(companyProps.hs_name || ""),
      ]) || deal.dealName || companyId;
    const existing = rowsByAccount.get(companyId) || {
      accountId: companyId,
      accountName,
      closedWonDealCount: 0,
      arr: 0,
      latestClosedDate: deal.closedDate,
    };
    existing.closedWonDealCount += 1;
    existing.arr = round2(existing.arr + dealArr);
    if (deal.closedDate && (!existing.latestClosedDate || deal.closedDate > existing.latestClosedDate)) {
      existing.latestClosedDate = deal.closedDate;
    }
    if (!existing.accountName && accountName) existing.accountName = accountName;
    rowsByAccount.set(companyId, existing);
  }

  const rows = Array.from(rowsByAccount.values()).sort((a, b) => b.arr - a.arr || a.accountName.localeCompare(b.accountName));

  return {
    startDate,
    endDate,
    accountCount: rows.length,
    dealCount: dealIds.length,
    totalArr: round2(rows.reduce((sum, row) => sum + row.arr, 0)),
    rows,
  };
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Partial<RequestBody>;
    const { startDate, endDate } = parsePayload(body);
    const cacheKey = `api:weekly-dashboard-closed-won-accounts:${startDate}:${endDate}`;
    const payload = await getOrSetCache(cacheKey, CACHE_TTL_MS, () => buildWeeklyClosedWonAccounts(startDate, endDate));
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
