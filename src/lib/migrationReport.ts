import { getMonthlyAverageFxRateForCloseMonth } from "@/lib/fx";
import {
  batchReadCompanies,
  batchReadLineItems,
  fetchCompanyIdsForDeals,
  fetchDealsInStage,
  fetchLineItemIdsForDeals,
} from "@/lib/hubspot";
import { computeCalculatedArrForLineItem, FX_TARGET_CURRENCY, LI_PROPS, parseDate, round2 } from "@/lib/logic";
import {
  calculateMigrationMetrics,
  isExplicitV3ToV4Migration,
  migrationPlanVersion,
  migrationReportWindow,
} from "@/lib/migrationRules";
import {
  queryStripeV3ToV4MigrationsFromBigQuery,
  type StripeV3ToV4MigrationRow,
} from "@/lib/stripeBigquery";
import type { HubspotLineItem } from "@/lib/types";

export type MigrationSource = "stripe" | "hubspot";

export type MigrationDetailRow = {
  migrationKey: string;
  source: MigrationSource;
  customerId: string;
  customerName: string;
  workspaceId: string;
  migratedAt: string;
  migratedArr: number;
  priorV3Arr: number;
  migratedV4Arr: number;
  recordUrl: string;
};

export type MigrationSummary = {
  arrMigrated: number;
  logosMigrated: number;
};

export type MigrationReportResponse = {
  asOfDate: string;
  fiscalYearStart: string;
  currentMonthStart: string;
  targetCurrency: string;
  generatedAt: string;
  fiscalYear: MigrationSummary;
  currentMonth: MigrationSummary;
  sourceBreakdown: Array<{
    source: MigrationSource;
    sourceLabel: string;
    fiscalYear: MigrationSummary;
    currentMonth: MigrationSummary;
  }>;
  months: Array<{
    monthKey: string;
    monthLabel: string;
    arrMigrated: number;
    logosMigrated: number;
  }>;
  migrations: MigrationDetailRow[];
  warnings: string[];
  methodology: string[];
};

const DEFAULT_SALES_PIPELINE_ID = "0cbbc8c6-dccf-4601-8d59-b6a15ed5129b";
const DEFAULT_SALES_CLOSED_WON_STAGE_ID = "f12c408f-f92b-4a95-8b59-9f801b19b105";

type HubspotDealPlanRecord = {
  dealId: string;
  dealName: string;
  closeDate: string;
  currency: string;
  workspaceId: string;
  customerKey: string;
  companyId: string;
  companyName: string;
  companyWorkspaceId: string;
  explicitMigration: boolean;
  v3Arr: number;
  v4Arr: number;
};

function envValue(name: string, fallback: string) {
  return String(process.env[name] || fallback).trim() || fallback;
}

function todayInToronto() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function normalizedWorkspaceId(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function lineItemDescriptions(lineItem: HubspotLineItem | undefined) {
  const properties = lineItem?.properties || {};
  return [properties.name, properties.hs_product_name, properties.description, properties.hs_sku]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function hubspotRecordUrl(portalId: string, dealId: string) {
  return `https://app.hubspot.com/contacts/${portalId}/record/0-3/${dealId}?utm_source=arr_dashboard&utm_medium=internal&utm_campaign=migration`;
}

function stripeRecordUrl(customerId: string) {
  return `https://dashboard.stripe.com/customers/${encodeURIComponent(customerId)}`;
}

function monthLabel(monthKey: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${monthKey}-01T12:00:00.000Z`));
}

function monthKeys(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  const keys: string[] = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor <= last) {
    keys.push(cursor.toISOString().slice(0, 7));
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return keys;
}

function unknownPropertyError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("property") && (message.includes("does not exist") || message.includes("not a valid property"));
}

async function fetchHubspotSalesDeals(properties: string[], closedWonStageId: string) {
  try {
    return await fetchDealsInStage(properties, closedWonStageId);
  } catch (error) {
    if (!unknownPropertyError(error)) throw error;
    return fetchDealsInStage(properties.filter((property) => property !== "workspace_id"), closedWonStageId);
  }
}

async function generateHubspotMigrations(options: {
  startDate: string;
  endDate: string;
  targetCurrency: string;
  portalId: string;
  warnings: Set<string>;
}): Promise<MigrationDetailRow[]> {
  const salesPipelineId = envValue("HUBSPOT_COMMISSION_SALES_PIPELINE_ID", DEFAULT_SALES_PIPELINE_ID);
  const closedWonStageId = envValue(
    "HUBSPOT_COMMISSION_SALES_CLOSED_WON_STAGE_ID",
    DEFAULT_SALES_CLOSED_WON_STAGE_ID,
  );
  const deals = (
    await fetchHubspotSalesDeals(
      ["dealname", "dealtype", "pipeline", "closedate", "deal_currency_code", "workspace_id"],
      closedWonStageId,
    )
  ).filter((deal) => String(deal.properties?.pipeline || "").trim() === salesPipelineId);
  if (!deals.length) return [];

  const dealIds = deals.map((deal) => String(deal.id || "").trim()).filter(Boolean);
  const [lineItemPairs, companyPairs] = await Promise.all([
    fetchLineItemIdsForDeals(dealIds),
    fetchCompanyIdsForDeals(dealIds),
  ]);
  const lineItemIdsByDeal = new Map(lineItemPairs.map((pair) => [pair.dealId, pair.ids]));
  const companyIdsByDeal = new Map(companyPairs.map((pair) => [pair.dealId, pair.ids]));
  const allLineItemIds = Array.from(new Set(lineItemPairs.flatMap((pair) => pair.ids)));
  const allCompanyIds = Array.from(new Set(companyPairs.flatMap((pair) => pair.ids.slice(0, 1))));
  const lineItemsById = await batchReadLineItems(allLineItemIds, LI_PROPS);

  let companiesById = new Map<string, { id: string; properties?: Record<string, unknown> }>();
  try {
    companiesById = await batchReadCompanies(allCompanyIds, ["name", "workspaceid"]);
  } catch (error) {
    if (!unknownPropertyError(error)) throw error;
    companiesById = await batchReadCompanies(allCompanyIds, ["name"]);
  }

  const dealPlanRecords: HubspotDealPlanRecord[] = [];
  const fxCache = new Map<string, Promise<number>>();
  async function fxRate(currency: string, closeDate: string) {
    if (currency === options.targetCurrency) return 1;
    const key = `${currency}|${options.targetCurrency}|${closeDate.slice(0, 7)}`;
    if (!fxCache.has(key)) {
      fxCache.set(
        key,
        getMonthlyAverageFxRateForCloseMonth(
          currency,
          options.targetCurrency,
          new Date(`${closeDate}T12:00:00.000Z`),
        ).then((result) => Number(result.rate || 0)),
      );
    }
    return fxCache.get(key)!;
  }

  for (const deal of deals) {
    const dealId = String(deal.id || "").trim();
    const closeDateValue = parseDate(deal.properties?.closedate);
    const closeDate = closeDateValue && !Number.isNaN(closeDateValue.getTime())
      ? closeDateValue.toISOString().slice(0, 10)
      : "";
    if (!dealId || !closeDate || closeDate > options.endDate) continue;
    const companyId = companyIdsByDeal.get(dealId)?.[0] || "";
    const company = companiesById.get(companyId);
    const companyName = String(company?.properties?.name || "").trim();
    const dealWorkspaceId = normalizedWorkspaceId(deal.properties?.workspace_id);
    const companyWorkspaceId = normalizedWorkspaceId(company?.properties?.workspaceid);
    const workspaceId = dealWorkspaceId || companyWorkspaceId;
    const customerKey = companyId ? `company:${companyId}` : workspaceId ? `workspace:${workspaceId}` : `deal:${dealId}`;
    const currency = String(deal.properties?.deal_currency_code || options.targetCurrency).trim().toUpperCase();
    const rate = await fxRate(currency, closeDate);
    if (rate <= 0) {
      options.warnings.add(`Some ${currency} HubSpot migrations could not be converted to ${options.targetCurrency}.`);
      continue;
    }

    const dealName = String(deal.properties?.dealname || "").trim() || `Deal ${dealId}`;
    const explicitMigration = isExplicitV3ToV4Migration([dealName]);
    let v3Arr = 0;
    let v4Arr = 0;
    for (const lineItemId of lineItemIdsByDeal.get(dealId) || []) {
      const lineItem = lineItemsById.get(lineItemId);
      const version = migrationPlanVersion(
        lineItemDescriptions(lineItem),
        explicitMigration ? "v4" : "v3",
      );
      if (!version) continue;
      const arr = computeCalculatedArrForLineItem(lineItem?.properties || {});
      if (version === "v4") v4Arr += arr * rate;
      else v3Arr += arr * rate;
    }
    if (v3Arr <= 0 && v4Arr <= 0) continue;
    dealPlanRecords.push({
      dealId,
      dealName,
      closeDate,
      currency,
      workspaceId,
      customerKey,
      companyId,
      companyName,
      companyWorkspaceId,
      explicitMigration,
      v3Arr: round2(v3Arr),
      v4Arr: round2(v4Arr),
    });
  }

  const recordsByCustomer = new Map<string, HubspotDealPlanRecord[]>();
  for (const record of dealPlanRecords) {
    if (!recordsByCustomer.has(record.customerKey)) recordsByCustomer.set(record.customerKey, []);
    recordsByCustomer.get(record.customerKey)!.push(record);
  }

  const migrations: MigrationDetailRow[] = [];
  for (const records of recordsByCustomer.values()) {
    const sorted = records.slice().sort((a, b) => a.closeDate.localeCompare(b.closeDate) || a.dealId.localeCompare(b.dealId));
    let historicalV3Arr = 0;
    let v4Seen = false;
    for (const record of sorted) {
      const hasV3Before = historicalV3Arr > 0 || record.v3Arr > 0 || record.explicitMigration;
      if (!v4Seen && record.v4Arr > 0) {
        v4Seen = true;
        if (hasV3Before && record.closeDate >= options.startDate && record.closeDate <= options.endDate) {
          const workspaceId = record.workspaceId || record.companyWorkspaceId;
          migrations.push({
            migrationKey: `hubspot:${record.customerKey}`,
            source: "hubspot",
            customerId: record.companyId || record.dealId,
            customerName: record.companyName || record.dealName,
            workspaceId,
            migratedAt: record.closeDate,
            migratedArr: record.v4Arr,
            priorV3Arr: round2(historicalV3Arr || record.v3Arr),
            migratedV4Arr: record.v4Arr,
            recordUrl: hubspotRecordUrl(options.portalId, record.dealId),
          });
        }
      }
      if (record.v3Arr > 0) historicalV3Arr = record.v3Arr;
    }
  }

  return migrations;
}

function stripeMigrationRow(row: StripeV3ToV4MigrationRow): MigrationDetailRow {
  return {
    migrationKey: `stripe:${row.customerId}`,
    source: "stripe",
    customerId: row.customerId,
    customerName: row.customerName || row.customerId,
    workspaceId: normalizedWorkspaceId(row.workspaceId),
    migratedAt: row.migratedAt,
    migratedArr: round2(row.migratedArr),
    priorV3Arr: round2(row.v3ArrBefore),
    migratedV4Arr: round2(row.v4ArrAfter),
    recordUrl: stripeRecordUrl(row.customerId),
  };
}

export async function generateMigrationReport(options?: { asOfDate?: string }): Promise<MigrationReportResponse> {
  const window = migrationReportWindow(String(options?.asOfDate || todayInToronto()).trim());
  const targetCurrency = String(FX_TARGET_CURRENCY || "USD").trim().toUpperCase();
  const portalId = String(process.env.HUBSPOT_PORTAL_ID || "20692578").trim() || "20692578";
  const warnings = new Set<string>();

  const [stripeResult, hubspotResult] = await Promise.allSettled([
    queryStripeV3ToV4MigrationsFromBigQuery(
      {
        startDate: window.fiscalYearStart,
        endDate: window.asOfDate,
        targetCurrency,
      },
      { profile: "stripe_arr_correct" },
    ),
    generateHubspotMigrations({
      startDate: window.fiscalYearStart,
      endDate: window.asOfDate,
      targetCurrency,
      portalId,
      warnings,
    }),
  ]);

  if (stripeResult.status === "rejected" && hubspotResult.status === "rejected") {
    const stripeMessage = stripeResult.reason instanceof Error ? stripeResult.reason.message : String(stripeResult.reason);
    const hubspotMessage = hubspotResult.reason instanceof Error ? hubspotResult.reason.message : String(hubspotResult.reason);
    throw new Error(`Migration sources failed. Stripe: ${stripeMessage}. HubSpot: ${hubspotMessage}.`);
  }
  if (stripeResult.status === "rejected") {
    warnings.add(
      `Stripe / BigQuery migrations are temporarily unavailable: ${
        stripeResult.reason instanceof Error ? stripeResult.reason.message : String(stripeResult.reason)
      }`,
    );
  }
  if (hubspotResult.status === "rejected") {
    warnings.add(
      `HubSpot migrations are temporarily unavailable: ${
        hubspotResult.reason instanceof Error ? hubspotResult.reason.message : String(hubspotResult.reason)
      }`,
    );
  }

  const stripeRows = stripeResult.status === "fulfilled" ? stripeResult.value.rows : [];
  const hubspotMigrations = hubspotResult.status === "fulfilled" ? hubspotResult.value : [];

  const stripeMigrations = stripeRows.map(stripeMigrationRow);

  const migrations = [...hubspotMigrations, ...stripeMigrations].sort(
    (a, b) => b.migratedAt.localeCompare(a.migratedAt) || a.customerName.localeCompare(b.customerName),
  );
  const fiscalYear = calculateMigrationMetrics(migrations, window.fiscalYearStart, window.asOfDate);
  const currentMonth = calculateMigrationMetrics(migrations, window.currentMonthStart, window.asOfDate);
  const sourceBreakdown = (["stripe", "hubspot"] as MigrationSource[]).map((source) => {
    const sourceRows = migrations.filter((row) => row.source === source);
    return {
      source,
      sourceLabel: source === "stripe" ? "Stripe / BigQuery" : "HubSpot Sales Default Pipeline",
      fiscalYear: calculateMigrationMetrics(sourceRows, window.fiscalYearStart, window.asOfDate),
      currentMonth: calculateMigrationMetrics(sourceRows, window.currentMonthStart, window.asOfDate),
    };
  });
  const months = monthKeys(window.fiscalYearStart, window.asOfDate).map((monthKey) => {
    const nextMonth = new Date(`${monthKey}-01T00:00:00.000Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    nextMonth.setUTCDate(0);
    const endDate = nextMonth.toISOString().slice(0, 10) > window.asOfDate
      ? window.asOfDate
      : nextMonth.toISOString().slice(0, 10);
    return {
      monthKey,
      monthLabel: monthLabel(monthKey),
      ...calculateMigrationMetrics(migrations, `${monthKey}-01`, endDate),
    };
  });

  return {
    asOfDate: window.asOfDate,
    fiscalYearStart: window.fiscalYearStart,
    currentMonthStart: window.currentMonthStart,
    targetCurrency,
    generatedAt: new Date().toISOString(),
    fiscalYear,
    currentMonth,
    sourceBreakdown,
    months,
    migrations,
    warnings: Array.from(warnings),
    methodology: [
      "A customer is counted once, on the first day a v4 plan has positive ARR while that customer had positive v3 plan ARR immediately beforehand.",
      "Stripe results come from the Stripe data-pipeline subscription-item change events in BigQuery. Add-ons, AI tokens, conversation sessions, and web-search/crawl charges are excluded.",
      "HubSpot results independently use closed-won migration deals in the Sales Default Pipeline. Explicit migration deals do not require a matching Stripe customer; v4 ARR is annualized and converted using the HubSpot CARR report conventions.",
      "Stripe / BigQuery and HubSpot Sales Default Pipeline customers are counted as independent migration populations; neither source requires a matching record in the other.",
    ],
  };
}
