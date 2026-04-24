import { NextResponse } from "next/server";
import {
  fetchDealStageIdToLabelMap,
  fetchDealsInStageClosedBetween,
} from "@/lib/hubspot";
import {
  queryStripeCustomerIdsByWorkspaceIdsFromBigQuery,
  type StripeBigQueryProfile,
} from "@/lib/stripeBigquery";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 120;

const CACHE_TTL_MS = readTtlMs("API_MODEL_UPDATE_UNMATCHED_DEALS_CACHE_TTL_MS", 300_000);
const STRIPE_OPTIONS: { profile: StripeBigQueryProfile } = {
  profile: "stripe_arr_correct",
};

type ApiBody = {
  startDate?: unknown;
  endDate?: unknown;
};

type UnmatchedReason = "missing_workspace_id" | "no_stripe_customer_mapping";

type UnmatchedDealRow = {
  dealId: string;
  dealName: string;
  closeDateUtc: string;
  workspaceId: string;
  primaryCompanyId: string;
  unmatchedReason: UnmatchedReason;
};

type ReportPayload = {
  startDate: string;
  endDate: string;
  stageIds: string[];
  workspacePropertyCandidates: string[];
  summary: {
    totalTransactionalDeals: number;
    matchedDeals: number;
    unmatchedDeals: number;
    missingWorkspaceIdDeals: number;
    noStripeMappingDeals: number;
  };
  rows: UnmatchedDealRow[];
};

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function parsePayload(raw: ApiBody) {
  const startDate = String(raw.startDate || "").trim();
  const endDate = String(raw.endDate || "").trim();
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    throw new Error("Invalid startDate/endDate");
  }
  if (endDate < startDate) {
    throw new Error("endDate must be >= startDate");
  }
  return { startDate, endDate };
}

function normalizeStageLabelKey(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizeWorkspaceId(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function firstNonEmptyProperty(properties: Record<string, unknown>, candidates: string[]) {
  for (const key of candidates) {
    const value = String(properties[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function parseHubspotTimestampToIso(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      const ms = numeric > 1_000_000_000_000 ? numeric : numeric > 1_000_000_000 ? numeric * 1000 : numeric;
      const d = new Date(ms);
      if (Number.isFinite(d.getTime())) return d.toISOString();
    }
  }
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return raw;
}

async function resolveTransactionalStageIds() {
  const configured = uniqueStrings(
    String(process.env.HUBSPOT_TRANSACTIONAL_STAGE_ID || "")
      .split(",")
      .map((value) => value.trim()),
  );
  if (configured.length) return configured;

  const requestedLabel = normalizeStageLabelKey(
    String(process.env.HUBSPOT_TRANSACTIONAL_STAGE_LABEL || "Closed Won (Transactional Pipeline)"),
  );
  if (!requestedLabel) return [];
  const stageMap = await fetchDealStageIdToLabelMap();
  return Array.from(stageMap.entries())
    .filter(([, label]) => normalizeStageLabelKey(label || "") === requestedLabel)
    .map(([stageId]) => stageId);
}

async function buildReport(startDate: string, endDate: string): Promise<ReportPayload> {
  const stageIds = await resolveTransactionalStageIds();
  const workspaceProp = String(process.env.DEAL_WORKSPACE_ID_PROP || "workspace_id").trim() || "workspace_id";
  const workspacePropertyCandidates = uniqueStrings(
    [
      workspaceProp,
      workspaceProp.endsWith("__c") ? workspaceProp.slice(0, -3) : `${workspaceProp}__c`,
      "workspace_id",
      "workspace_id__c",
    ].map((value) => String(value || "").trim()),
  );
  const dealProperties = uniqueStrings([
    ...workspacePropertyCandidates,
    "closedate",
    "dealname",
    "hs_primary_associated_company",
  ]);

  const dealsByStage = await Promise.all(
    stageIds.map((stageId) =>
      fetchDealsInStageClosedBetween(
        dealProperties,
        stageId,
        startDate,
        endDate,
      ),
    ),
  );

  const uniqueDealsById = new Map<string, { id: string; properties?: Record<string, unknown> }>();
  for (const deals of dealsByStage) {
    for (const deal of deals || []) {
      const id = String(deal.id || "").trim();
      if (!id || uniqueDealsById.has(id)) continue;
      uniqueDealsById.set(id, {
        id,
        properties: (deal.properties || {}) as Record<string, unknown>,
      });
    }
  }
  const uniqueDeals = Array.from(uniqueDealsById.values());

  const preparedDeals = uniqueDeals.map((deal) => {
    const properties = deal.properties || {};
    const workspaceId = normalizeWorkspaceId(firstNonEmptyProperty(properties, workspacePropertyCandidates));
    return {
      dealId: deal.id,
      dealName: String(properties.dealname || "").trim(),
      closeDateUtc: parseHubspotTimestampToIso(properties.closedate),
      workspaceId,
      primaryCompanyId: String(properties.hs_primary_associated_company || "").trim(),
    };
  });

  const uniqueWorkspaceIds = uniqueStrings(preparedDeals.map((deal) => deal.workspaceId));
  const mappingPayload = await queryStripeCustomerIdsByWorkspaceIdsFromBigQuery(uniqueWorkspaceIds, STRIPE_OPTIONS);
  const customerIdsByWorkspace = new Map<string, Set<string>>();
  for (const mapping of mappingPayload.mappings || []) {
    const workspaceId = normalizeWorkspaceId(mapping.workspaceId);
    const customerId = String(mapping.customerId || "").trim();
    if (!workspaceId || !customerId) continue;
    if (!customerIdsByWorkspace.has(workspaceId)) customerIdsByWorkspace.set(workspaceId, new Set<string>());
    customerIdsByWorkspace.get(workspaceId)?.add(customerId);
  }

  const rows: UnmatchedDealRow[] = [];
  let missingWorkspaceIdDeals = 0;
  let noStripeMappingDeals = 0;
  let matchedDeals = 0;

  for (const deal of preparedDeals) {
    if (!deal.workspaceId) {
      missingWorkspaceIdDeals += 1;
      rows.push({
        dealId: deal.dealId,
        dealName: deal.dealName,
        closeDateUtc: deal.closeDateUtc,
        workspaceId: "",
        primaryCompanyId: deal.primaryCompanyId,
        unmatchedReason: "missing_workspace_id",
      });
      continue;
    }

    const mappedCustomerIds = customerIdsByWorkspace.get(deal.workspaceId);
    if (!mappedCustomerIds || mappedCustomerIds.size === 0) {
      noStripeMappingDeals += 1;
      rows.push({
        dealId: deal.dealId,
        dealName: deal.dealName,
        closeDateUtc: deal.closeDateUtc,
        workspaceId: deal.workspaceId,
        primaryCompanyId: deal.primaryCompanyId,
        unmatchedReason: "no_stripe_customer_mapping",
      });
      continue;
    }

    matchedDeals += 1;
  }

  rows.sort((a, b) => {
    const left = Date.parse(a.closeDateUtc);
    const right = Date.parse(b.closeDateUtc);
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return right - left;
    if (a.closeDateUtc !== b.closeDateUtc) return String(b.closeDateUtc).localeCompare(String(a.closeDateUtc));
    return a.dealId.localeCompare(b.dealId);
  });

  return {
    startDate,
    endDate,
    stageIds,
    workspacePropertyCandidates,
    summary: {
      totalTransactionalDeals: preparedDeals.length,
      matchedDeals,
      unmatchedDeals: rows.length,
      missingWorkspaceIdDeals,
      noStripeMappingDeals,
    },
    rows,
  };
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as ApiBody;
    const { startDate, endDate } = parsePayload(body);

    const key = `api:model-update-unmatched-transactional-deals:${stableStringify({
      startDate,
      endDate,
      transactionalStageId: String(process.env.HUBSPOT_TRANSACTIONAL_STAGE_ID || ""),
      transactionalStageLabel: String(process.env.HUBSPOT_TRANSACTIONAL_STAGE_LABEL || ""),
      dealWorkspaceProp: String(process.env.DEAL_WORKSPACE_ID_PROP || ""),
    })}`;
    const payload = await getOrSetCache(key, CACHE_TTL_MS, () => buildReport(startDate, endDate));
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

