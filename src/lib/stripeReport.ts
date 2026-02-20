import {
  aggregatePeriodsFromMonthly,
  buildMonthlyPeriods,
  firstOfMonth,
  parseDate,
  round2,
} from "@/lib/logic";
import type { Grain, ReportResponse, ReportRow } from "@/lib/types";
import { getPriceDisplayNamesById } from "@/lib/stripe";
import {
  queryStripeReportAllRowsFromBigQuery,
  queryStripeReportPageFromBigQuery,
  type StripeBigQueryPeriodSpec,
} from "@/lib/stripeBigquery";
import { ensureStripeSyncForRange, getSyncedStripeLineItemsForRange } from "@/lib/stripeSyncStore";

export type StripeGroupField = "customerId" | "lineItemDescription" | "lineItemDescriptionPrefix";

export type StripeReportRequest = {
  startDate: string;
  endDate: string;
  grain: Grain;
  filterCustomerId?: string;
  filterLineItemDescription?: string;
  filterLineItemDescriptionPrefix?: string;
  groupByFields?: StripeGroupField[];
  sortByPeriodKey?: string;
  page?: number;
};

type StripeReportBaseResponse = {
  periods: { key: string; label: string }[];
  totalsByPeriod: { key: string; label: string; total: number }[];
  rows: ReportRow[];
  sourceRowsFetched: number;
};

type CacheEntry = {
  expiresAt: number;
  value: StripeReportBaseResponse;
};

export const STRIPE_REPORT_PAGE_SIZE = 1000;

const REPORT_CACHE_TTL_MS = Number(process.env.STRIPE_REPORT_CACHE_TTL_MS || "300000");
const REPORT_CACHE = new Map<string, CacheEntry>();
const NON_ZERO_EPSILON = 1e-9;
const ALWAYS_MULTIPLY_BY_TWELVE_DESCRIPTIONS = new Set(["web search and crawl", "ai tokens"]);
const GROUP_FIELD_LABELS: Record<StripeGroupField, string> = {
  customerId: "Customer ID",
  lineItemDescription: "Line Item Description",
  lineItemDescriptionPrefix: "Line Description (before ' - ')",
};

function formatDayKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function buildDailyPeriods(start: Date, end: Date) {
  const periods: Array<{ key: string; label: string; dayStart: Date; dayEnd: Date }> = [];
  for (
    let day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    day <= end;
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  ) {
    const dayStart = new Date(day);
    const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59, 999);
    const key = formatDayKey(dayStart);
    periods.push({ key, label: key, dayStart, dayEnd });
  }
  return periods;
}

function toIsoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function monthBucketStartUtcTs(d: Date) {
  return Date.UTC(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

function monthBucketEndExclusiveUtcTs(d: Date) {
  return Date.UTC(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0);
}

function monthBucketEndInclusiveTs(monthStart: Date) {
  return monthBucketEndExclusiveUtcTs(monthStart) - 1;
}

function recurringFrequencyLabel(interval?: string | null, intervalCount?: number | null) {
  const i = String(interval || "").trim().toLowerCase();
  const count = Number(intervalCount || 1);
  if (!i) return "";
  if (count <= 1) return i;
  return `every_${count}_${i}`;
}

function shouldAlwaysMultiplyByTwelve(description: string) {
  return ALWAYS_MULTIPLY_BY_TWELVE_DESCRIPTIONS.has(String(description || "").trim().toLowerCase());
}

function isInvoiceAnchorDescription(description: string) {
  const normalized = String(description || "").trim().toLowerCase();
  return normalized === "refund" || normalized === "discount";
}

function annualizationMultiplierFromPeriod(start: Date, endExclusive: Date, description: string) {
  const startMs = start.getTime();
  const endMs = endExclusive.getTime();
  const durationMs = endMs - startMs;
  if (durationMs <= 0) return 0;

  const oneYearAfterStartUtc = new Date(startMs);
  oneYearAfterStartUtc.setUTCFullYear(oneYearAfterStartUtc.getUTCFullYear() + 1);
  if (oneYearAfterStartUtc.getTime() === endMs) {
    return 1;
  }

  if (shouldAlwaysMultiplyByTwelve(description)) {
    return 12;
  }

  const oneMonthAfterStartUtc = new Date(startMs);
  oneMonthAfterStartUtc.setUTCMonth(oneMonthAfterStartUtc.getUTCMonth() + 1);
  if (oneMonthAfterStartUtc.getTime() === endMs) {
    return 12;
  }

  const monthStartMs = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1, 0, 0, 0, 0);
  const nextMonthStartMs = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  const monthMs = Math.max(nextMonthStartMs - monthStartMs, 1);
  const ratio = monthMs / Math.max(durationMs, 1);
  return ratio * 12;
}

function getPriceIdFromDescription(description: string) {
  const text = String(description || "").trim();
  const match = /^price:([A-Za-z0-9_]+)/i.exec(text);
  return match ? match[1] : "";
}

function getDisplayDescription(rawDescription: string, priceDisplayNamesById: Record<string, string>) {
  const priceId = getPriceIdFromDescription(rawDescription);
  if (!priceId) return rawDescription;
  return priceDisplayNamesById[priceId] || rawDescription;
}

function lineItemDescriptionPrefix(description: string) {
  const text = String(description || "").trim();
  if (!text) return "(blank)";
  const cut = text.indexOf(" - ");
  return (cut === -1 ? text : text.slice(0, cut)).trim() || "(blank)";
}

function normalizeDescriptionGroupBucket(description: string) {
  const text = String(description || "").trim();
  if (!text) return "(blank)";
  const normalized = text
    .toLowerCase()
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/remaining time on .+ add on/.test(normalized)) return "Remaining Time on Add-On";
  if (/time on .+ add on/.test(normalized)) return "Time on Add-On";
  return text;
}

function matchesTextFilter(value: string, rawFilter: string) {
  const text = String(value || "").toLowerCase();
  const tokens = String(rawFilter || "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) return true;

  const includeTerms: string[] = [];
  const excludeTerms: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.startsWith("not ")) {
      const term = token.slice(4).trim().toLowerCase();
      if (term) excludeTerms.push(term);
      continue;
    }
    includeTerms.push(lower);
  }

  if (excludeTerms.some((term) => text.includes(term))) return false;
  if (includeTerms.length === 0) return true;
  return includeTerms.some((term) => text.includes(term));
}

function groupValueForRow(row: ReportRow, field: StripeGroupField) {
  if (field === "customerId") return row.dealId || "(blank)";
  if (field === "lineItemDescription") return normalizeDescriptionGroupBucket(row.lineItemDescription || "");
  return normalizeDescriptionGroupBucket(lineItemDescriptionPrefix(row.lineItemDescription || ""));
}

function normalizeGroupByFields(fields?: StripeGroupField[]) {
  return Array.from(new Set((fields || []).filter(Boolean)));
}

function fallbackRowSortKey(row: ReportRow) {
  return [
    row.dealName || "",
    row.dealId || "",
    row.lineItemId || "",
    row.lineItemDescription || "",
    row.closeDate || "",
    JSON.stringify(row.groupValues || {}),
  ].join("|");
}

function stableSortRows(rows: ReportRow[], sortByPeriodKey?: string) {
  const sortKey = sortByPeriodKey && sortByPeriodKey !== "none" ? sortByPeriodKey : "";
  return [...rows].sort((a, b) => {
    if (sortKey) {
      const diff = (b.valuesByPeriod[sortKey] || 0) - (a.valuesByPeriod[sortKey] || 0);
      if (Math.abs(diff) > NON_ZERO_EPSILON) return diff;
    }
    return fallbackRowSortKey(a).localeCompare(fallbackRowSortKey(b));
  });
}

function buildBaseCacheKey(body: StripeReportRequest, source: string) {
  return [
    body.startDate,
    body.endDate,
    body.grain,
    source,
    body.filterCustomerId || "",
    body.filterLineItemDescription || "",
    body.filterLineItemDescriptionPrefix || "",
    normalizeGroupByFields(body.groupByFields).join(","),
    body.sortByPeriodKey || "",
  ].join("|");
}

type StripeReportContext = {
  rangeStart: Date;
  rangeEnd: Date;
  outputPeriods: { key: string; label: string }[];
  monthlyPeriods: Array<{ key: string; label: string; start: Date; end: Date }>;
  dailyPeriods: Array<{ key: string; label: string; dayStart: Date; dayEnd: Date }>;
  aggregated: Array<{ key: string; label: string; members?: string[] }>;
  targetCurrency: string;
  groupByFields: StripeGroupField[];
};

function buildStripeReportContext(body: StripeReportRequest): StripeReportContext {
  const startVal = parseDate(body.startDate);
  const endVal = parseDate(body.endDate);
  if (!startVal || !endVal || isNaN(startVal.getTime()) || isNaN(endVal.getTime())) {
    throw new Error("Invalid startDate/endDate");
  }

  const rangeStart = new Date(startVal.getFullYear(), startVal.getMonth(), startVal.getDate(), 0, 0, 0, 0);
  const rangeEnd = new Date(endVal.getFullYear(), endVal.getMonth(), endVal.getDate(), 23, 59, 59, 999);
  if (rangeEnd < rangeStart) {
    throw new Error("endDate must be >= startDate");
  }

  const monthlyPeriods = buildMonthlyPeriods(firstOfMonth(rangeStart), firstOfMonth(rangeEnd));
  const dailyPeriods = buildDailyPeriods(rangeStart, rangeEnd);
  const aggregated = aggregatePeriodsFromMonthly(monthlyPeriods, body.grain) as Array<{
    key: string;
    label: string;
    members?: string[];
  }>;
  const outputPeriods =
    body.grain === "daily"
      ? dailyPeriods.map((p) => ({ key: p.key, label: p.label }))
      : aggregated.map((p) => ({ key: p.key, label: p.label }));

  return {
    rangeStart,
    rangeEnd,
    outputPeriods,
    monthlyPeriods,
    dailyPeriods,
    aggregated,
    targetCurrency: (process.env.STRIPE_TARGET_CURRENCY || "USD").trim().toLowerCase(),
    groupByFields: normalizeGroupByFields(body.groupByFields),
  };
}

function buildBigQueryPeriodSpecs(body: StripeReportRequest, context: StripeReportContext): StripeBigQueryPeriodSpec[] {
  if (body.grain === "daily") {
    return context.dailyPeriods.map((period) => ({
      key: period.key,
      label: period.label,
      startTsMs: period.dayStart.getTime(),
      endTsMs: period.dayEnd.getTime(),
    }));
  }

  const monthByKey = new Map(context.monthlyPeriods.map((month) => [month.key, month]));
  return context.aggregated.map((period) => {
    const members = period.members && period.members.length ? period.members : [period.key];
    const memberMonths = members
      .map((member) => monthByKey.get(member))
      .filter((value): value is NonNullable<typeof value> => !!value);
    const startTsMs = memberMonths.length
      ? Math.min(...memberMonths.map((month) => monthBucketStartUtcTs(month.start)))
      : context.rangeStart.getTime();
    const endTsMs = memberMonths.length
      ? Math.max(...memberMonths.map((month) => monthBucketEndInclusiveTs(month.start)))
      : context.rangeEnd.getTime();
    return {
      key: period.key,
      label: period.label,
      startTsMs,
      endTsMs,
    };
  });
}

async function buildStripeReportBase(body: StripeReportRequest): Promise<StripeReportBaseResponse> {
  const source = "blob";
  const context = buildStripeReportContext(body);
  const cacheKey = buildBaseCacheKey(body, source);
  const cached = REPORT_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const { rangeStart, rangeEnd, monthlyPeriods, dailyPeriods, aggregated, outputPeriods, targetCurrency, groupByFields } =
    context;
  const clampedStartDate = toIsoDate(rangeStart);
  const clampedEndDate = toIsoDate(rangeEnd);
  let syncedItems = await getSyncedStripeLineItemsForRange(clampedStartDate, clampedEndDate);

  const autoSync = String(process.env.STRIPE_REPORT_AUTO_SYNC || "false").toLowerCase() === "true";
  if (!syncedItems.length && autoSync) {
    try {
      await ensureStripeSyncForRange({
        startDate: clampedStartDate,
        endDate: clampedEndDate,
      });
      syncedItems = await getSyncedStripeLineItemsForRange(clampedStartDate, clampedEndDate);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e || "");
      const isRateLimited = msg.includes("rate_limit") || msg.includes("429");
      if (!isRateLimited) throw e;
    }
  }
  const rangeStartMs = rangeStart.getTime();
  const rangeEndMs = rangeEnd.getTime();
  syncedItems = syncedItems.filter((item) => item.periodStartTs <= rangeEndMs && item.periodEndTs > rangeStartMs);
  const sourceRowsFetched = syncedItems.length;

  const priceIds = Array.from(
    new Set(
      syncedItems
        .map((item) => getPriceIdFromDescription(item.lineItemDescription || ""))
        .filter((id) => !!id),
    ),
  );
  const priceDisplayNamesById = priceIds.length ? await getPriceDisplayNamesById(priceIds) : {};
  const invoiceAnchorAmountById = new Map<string, number>();
  const invoiceAnchorItemById = new Map<string, (typeof syncedItems)[number]>();

  for (const item of syncedItems) {
    const invoiceId = String(item.invoiceId || "").trim();
    if (!invoiceId) continue;

    const lineCurrency = (item.currency || targetCurrency).trim().toLowerCase();
    if (lineCurrency && lineCurrency !== targetCurrency) continue;

    const windowStart = new Date(item.periodStartTs);
    const windowEndExclusive = new Date(item.periodEndTs);
    if (isNaN(windowStart.getTime()) || isNaN(windowEndExclusive.getTime())) continue;
    if (windowEndExclusive < windowStart) continue;
    if (
      windowEndExclusive.getTime() === windowStart.getTime() &&
      !isInvoiceAnchorDescription(item.lineItemDescription || "")
    ) {
      continue;
    }

    const amountMajor = Number(item.amountMinor || 0) / 100;
    const currentMaxAmount = invoiceAnchorAmountById.get(invoiceId);
    if (currentMaxAmount != null && amountMajor <= currentMaxAmount) continue;

    invoiceAnchorAmountById.set(invoiceId, amountMajor);
    invoiceAnchorItemById.set(invoiceId, item);
  }

  const rows: ReportRow[] = [];

  for (const item of syncedItems) {
    const lineCurrency = (item.currency || targetCurrency).trim().toLowerCase();
    if (lineCurrency && lineCurrency !== targetCurrency) continue;
    const closeDate = item.invoiceCreatedTs > 0 ? new Date(item.invoiceCreatedTs) : null;
    const amountMajor = Number(item.amountMinor || 0) / 100;
    const usesInvoiceAnchor = isInvoiceAnchorDescription(item.lineItemDescription || "");

    const windowStart = new Date(item.periodStartTs);
    const windowEndExclusive = new Date(item.periodEndTs);
    if (isNaN(windowStart.getTime()) || isNaN(windowEndExclusive.getTime())) continue;
    if (windowEndExclusive < windowStart) continue;
    if (windowEndExclusive.getTime() === windowStart.getTime() && !usesInvoiceAnchor) continue;

    const ownMultiplier = annualizationMultiplierFromPeriod(windowStart, windowEndExclusive, item.lineItemDescription || "");
    let appliedMultiplier = ownMultiplier;
    if (usesInvoiceAnchor) {
      const anchor = invoiceAnchorItemById.get(String(item.invoiceId || "").trim());
      if (anchor) {
        const anchorStart = new Date(anchor.periodStartTs);
        const anchorEndExclusive = new Date(anchor.periodEndTs);
        if (isNaN(anchorStart.getTime()) || isNaN(anchorEndExclusive.getTime()) || anchorEndExclusive < anchorStart) {
          appliedMultiplier = 0;
        } else {
          appliedMultiplier = annualizationMultiplierFromPeriod(
            anchorStart,
            anchorEndExclusive,
            anchor.lineItemDescription || "",
          );
        }
      } else {
        appliedMultiplier = 0;
      }
    }
    const annualized = amountMajor * appliedMultiplier;

    const valuesMonthly: Record<string, number> = {};
    for (const mp of monthlyPeriods) {
      const monthStartUtc = new Date(monthBucketStartUtcTs(mp.start));
      const monthEndExclusiveUtc = new Date(monthBucketEndExclusiveUtcTs(mp.start));
      const overlapsMonth = windowStart < monthEndExclusiveUtc && windowEndExclusive > monthStartUtc;
      valuesMonthly[mp.key] = overlapsMonth ? annualized : 0;
    }

    const valuesByPeriod: Record<string, number> = {};
    if (body.grain === "monthly") {
      for (const mp of monthlyPeriods) valuesByPeriod[mp.key] = valuesMonthly[mp.key] || 0;
    } else if (body.grain === "quarterly" || body.grain === "annually") {
      for (const ap of aggregated as Array<{ key: string; members?: string[] }>) {
        const members = ap.members || [];
        const sum = members.reduce((acc, key) => acc + (valuesMonthly[key] || 0), 0);
        valuesByPeriod[ap.key] = round2(sum);
      }
    } else {
      for (const dp of dailyPeriods) {
        const overlapsDay = windowStart <= dp.dayEnd && windowEndExclusive > dp.dayStart;
        valuesByPeriod[dp.key] = overlapsDay ? annualized : 0;
      }
    }

    const rawDescription = item.lineItemDescription || item.lineItemId || "(no description)";

    rows.push({
      dealName: item.customerName,
      dealId: item.customerId || "(no customer id)",
      lineItemId: item.lineItemId || item.key,

      valueUsd: annualized,
      dealCurrency: targetCurrency.toUpperCase(),
      fxRate: null,
      fxDateUsed: "",

      dealType: "stripe_invoice_line",
      closeDate: closeDate ? toIsoDate(closeDate) : "",

      windowStart: toIsoDate(windowStart),
      windowEnd: toIsoDate(new Date(item.periodEndTs)),
      isOpenEnded: false,

      recurringbillingfrequency: recurringFrequencyLabel(),
      termMonths: null,
      amount: round2(amountMajor),
      netPrice: round2(amountMajor),
      quantity: Number(item.quantity || 1),

      valuesByPeriod,
      deploymentType: "",
      accountId: "",
      territory: "",
      country: "",
      industry: "",
      lineItemDescription: getDisplayDescription(rawDescription, priceDisplayNamesById),
    });
  }

  const filteredRows = rows.filter((r) => {
    const customerIdOk = matchesTextFilter(r.dealId || "", body.filterCustomerId || "");
    const lineItemDescriptionOk = matchesTextFilter(r.lineItemDescription || "", body.filterLineItemDescription || "");
    const lineItemDescriptionPrefixOk = matchesTextFilter(
      lineItemDescriptionPrefix(r.lineItemDescription || ""),
      body.filterLineItemDescriptionPrefix || "",
    );
    return customerIdOk && lineItemDescriptionOk && lineItemDescriptionPrefixOk;
  });

  let outputRows = filteredRows;
  if (groupByFields.length > 0) {
    const grouped = new Map<string, ReportRow>();
    for (const row of filteredRows) {
      const key = groupByFields.map((field) => `${field}:${groupValueForRow(row, field)}`).join("|");
      const groupValues = Object.fromEntries(groupByFields.map((field) => [field, groupValueForRow(row, field)]));
      if (!grouped.has(key)) {
        grouped.set(key, {
          ...row,
          groupValues,
          valuesByPeriod: { ...row.valuesByPeriod },
        });
        continue;
      }
      const agg = grouped.get(key)!;
      for (const periodKey of Object.keys(row.valuesByPeriod || {})) {
        agg.valuesByPeriod[periodKey] = round2((agg.valuesByPeriod[periodKey] || 0) + (row.valuesByPeriod[periodKey] || 0));
      }
      agg.valueUsd = round2((agg.valueUsd || 0) + (row.valueUsd || 0));
      agg.amount = round2((agg.amount || 0) + (row.amount || 0));
      agg.netPrice = round2((agg.netPrice || 0) + (row.netPrice || 0));
      agg.quantity = Number(agg.quantity || 0) + Number(row.quantity || 0);
      agg.dealName = groupByFields.map((field) => groupValueForRow(row, field)).join(" | ");
      agg.dealId = groupByFields.includes("customerId") ? groupValueForRow(row, "customerId") : "(group)";
      agg.lineItemId = key;
      agg.lineItemDescription = groupByFields
        .filter((field) => field !== "customerId")
        .map((field) => groupValueForRow(row, field))
        .join(" | ");
      agg.groupValues = groupValues;
    }
    outputRows = Array.from(grouped.values());
  }

  const outputRowsSorted = stableSortRows(outputRows, body.sortByPeriodKey);

  const totalsByPeriod = outputPeriods.map((p) => {
    const total = round2(outputRowsSorted.reduce((acc, r) => acc + (r.valuesByPeriod[p.key] || 0), 0));
    return { ...p, total };
  });

  const response: StripeReportBaseResponse = {
    periods: outputPeriods,
    totalsByPeriod,
    rows: outputRowsSorted,
    sourceRowsFetched,
  };
  REPORT_CACHE.set(cacheKey, { expiresAt: Date.now() + REPORT_CACHE_TTL_MS, value: response });
  return response;
}

function buildBigQueryRequest(
  body: StripeReportRequest,
  context: StripeReportContext,
  page: number,
  pageSize: number,
) {
  return {
    startTsMs: context.rangeStart.getTime(),
    endTsMs: context.rangeEnd.getTime(),
    targetCurrency: context.targetCurrency,
    page,
    pageSize,
    periods: buildBigQueryPeriodSpecs(body, context),
    sortByPeriodKey: body.sortByPeriodKey || "none",
    groupByFields: context.groupByFields,
    filters: {
      customerId: body.filterCustomerId || "",
      lineItemDescription: body.filterLineItemDescription || "",
      lineItemDescriptionPrefix: body.filterLineItemDescriptionPrefix || "",
    },
  };
}

async function generateStripeReportFromBigQuery(body: StripeReportRequest): Promise<ReportResponse> {
  const context = buildStripeReportContext(body);
  const page = Math.max(1, Math.floor(Number(body.page || 1)));
  const bigQueryResult = await queryStripeReportPageFromBigQuery(
    buildBigQueryRequest(body, context, page, STRIPE_REPORT_PAGE_SIZE),
  );
  return {
    periods: context.outputPeriods,
    totalsByPeriod: bigQueryResult.totalsByPeriod,
    rows: bigQueryResult.rows,
    pagination: {
      page: bigQueryResult.page,
      pageSize: STRIPE_REPORT_PAGE_SIZE,
      returnedRows: bigQueryResult.rows.length,
      sourceReturnedRows: bigQueryResult.sourceRowsFetched,
      totalRows: bigQueryResult.totalRows,
      totalPages: bigQueryResult.totalPages,
      hasMore: bigQueryResult.page < bigQueryResult.totalPages,
      sourcePaged: false,
    },
  };
}

async function buildStripeReportBaseFromBigQuery(body: StripeReportRequest): Promise<StripeReportBaseResponse> {
  const context = buildStripeReportContext(body);
  const bigQueryResult = await queryStripeReportAllRowsFromBigQuery(
    buildBigQueryRequest(body, context, 1, STRIPE_REPORT_PAGE_SIZE),
  );
  return {
    periods: context.outputPeriods,
    totalsByPeriod: bigQueryResult.totalsByPeriod,
    rows: bigQueryResult.rows,
    sourceRowsFetched: bigQueryResult.sourceRowsFetched,
  };
}

export async function generateStripeReport(body: StripeReportRequest): Promise<ReportResponse> {
  const source = (process.env.STRIPE_DATA_SOURCE || "blob").toLowerCase();
  if (source === "bigquery") {
    return generateStripeReportFromBigQuery(body);
  }

  const page = Math.max(1, Math.floor(Number(body.page || 1)));
  const base = await buildStripeReportBase(body);
  const totalRows = base.rows.length;
  const totalPages = totalRows > 0 ? Math.ceil(totalRows / STRIPE_REPORT_PAGE_SIZE) : 1;
  const clampedPage = Math.min(page, totalPages);
  const pageStartIdx = (clampedPage - 1) * STRIPE_REPORT_PAGE_SIZE;
  const pagedRows = base.rows.slice(pageStartIdx, pageStartIdx + STRIPE_REPORT_PAGE_SIZE);
  const hasMore = clampedPage < totalPages;

  return {
    periods: base.periods,
    totalsByPeriod: base.totalsByPeriod,
    rows: pagedRows,
    pagination: {
      page: clampedPage,
      pageSize: STRIPE_REPORT_PAGE_SIZE,
      returnedRows: pagedRows.length,
      sourceReturnedRows: base.sourceRowsFetched,
      totalRows,
      totalPages,
      hasMore,
      sourcePaged: false,
    },
  };
}

function escapeCsvCell(value: string | number) {
  const text = String(value ?? "");
  if (text.includes(",") || text.includes('"') || text.includes("\n")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export async function generateStripeReportCsv(body: StripeReportRequest) {
  const source = (process.env.STRIPE_DATA_SOURCE || "blob").toLowerCase();
  const base = source === "bigquery" ? await buildStripeReportBaseFromBigQuery(body) : await buildStripeReportBase(body);
  const groupByFields = normalizeGroupByFields(body.groupByFields);
  const showDefaultColumns = groupByFields.length === 0;

  const headers = [
    ...(showDefaultColumns
      ? ["Customer ID", "Line Item ID", "Line Item Description"]
      : groupByFields.map((field) => GROUP_FIELD_LABELS[field] || field)),
    ...base.periods.map((p) => p.label),
  ];

  const lines: string[] = [headers.map(escapeCsvCell).join(",")];
  for (const row of base.rows) {
    const leadingColumns = showDefaultColumns
      ? [row.dealId || "", row.lineItemId || "", row.lineItemDescription || ""]
      : groupByFields.map((field) => row.groupValues?.[field] || "(blank)");
    const valueColumns = base.periods.map((p) => round2(row.valuesByPeriod[p.key] || 0));
    lines.push([...leadingColumns, ...valueColumns].map(escapeCsvCell).join(","));
  }

  return lines.join("\n");
}
