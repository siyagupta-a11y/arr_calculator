import {
  aggregatePeriodsFromMonthly,
  buildMonthlyPeriods,
  firstOfMonth,
  parseDate,
  round2,
} from "@/lib/logic";
import type { Grain, ReportResponse, ReportRow } from "@/lib/types";
import { getPriceDisplayNamesById } from "@/lib/stripe";
import { loadStripeLineItemsFromBigQuery } from "@/lib/stripeBigquery";
import { ensureStripeSyncForRange, getSyncedStripeLineItemsForRange } from "@/lib/stripeSyncStore";

export type StripeGroupField = "customerId" | "lineItemDescription" | "lineItemDescriptionPrefix";

export type StripeReportRequest = {
  startDate: string;
  endDate: string;
  grain: Grain;
  filterCustomerName?: string;
  filterCustomerId?: string;
  filterLineItemDescription?: string;
  filterLineItemDescriptionPrefix?: string;
  groupByFields?: StripeGroupField[];
  sortByPeriodKey?: string;
};

type CacheEntry = {
  expiresAt: number;
  value: ReportResponse;
};

const REPORT_CACHE_TTL_MS = Number(process.env.STRIPE_REPORT_CACHE_TTL_MS || "300000");
const REPORT_CACHE = new Map<string, CacheEntry>();
const NON_ZERO_EPSILON = 1e-9;

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

function recurringFrequencyLabel(interval?: string | null, intervalCount?: number | null) {
  const i = String(interval || "").trim().toLowerCase();
  const count = Number(intervalCount || 1);
  if (!i) return "";
  if (count <= 1) return i;
  return `every_${count}_${i}`;
}

function annualizedAmountFromPeriod(amountMajor: number, start: Date, endExclusive: Date) {
  const durationMs = endExclusive.getTime() - start.getTime();
  if (durationMs <= 0) return 0;
  const durationDays = durationMs / (24 * 60 * 60 * 1000);
  return (amountMajor * 365.2425) / Math.max(durationDays, 1 / 24);
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

export async function generateStripeReport(body: StripeReportRequest): Promise<ReportResponse> {
  const startVal = parseDate(body.startDate);
  const endVal = parseDate(body.endDate);
  if (!startVal || !endVal || isNaN(startVal.getTime()) || isNaN(endVal.getTime())) {
    throw new Error("Invalid startDate/endDate");
  }

  const rawRangeStart = new Date(startVal.getFullYear(), startVal.getMonth(), startVal.getDate(), 0, 0, 0, 0);
  const rawRangeEnd = new Date(endVal.getFullYear(), endVal.getMonth(), endVal.getDate(), 23, 59, 59, 999);
  const rangeStart = rawRangeStart;
  const rangeEnd = rawRangeEnd;
  if (rangeEnd < rangeStart) {
    throw new Error("endDate must be >= startDate");
  }

  const source = (process.env.STRIPE_DATA_SOURCE || "blob").toLowerCase();
  const cacheKey = `${body.startDate}|${body.endDate}|${body.grain}|${source}|${body.filterCustomerName || ""}|${body.filterCustomerId || ""}|${body.filterLineItemDescription || ""}|${body.filterLineItemDescriptionPrefix || ""}|${(body.groupByFields || []).join(",")}|${body.sortByPeriodKey || ""}`;
  const cached = REPORT_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const monthlyPeriods = buildMonthlyPeriods(firstOfMonth(rangeStart), firstOfMonth(rangeEnd));
  const dailyPeriods = buildDailyPeriods(rangeStart, rangeEnd);
  const aggregated = aggregatePeriodsFromMonthly(monthlyPeriods, body.grain);
  const outputPeriods =
    body.grain === "daily"
      ? dailyPeriods.map((p) => ({ key: p.key, label: p.label }))
      : aggregated.map((p) => ({ key: p.key, label: p.label }));

  const targetCurrency = (process.env.STRIPE_TARGET_CURRENCY || "USD").trim().toLowerCase();
  const clampedStartDate = toIsoDate(rangeStart);
  const clampedEndDate = toIsoDate(rangeEnd);
  let syncedItems =
    source === "bigquery"
      ? await loadStripeLineItemsFromBigQuery(rangeStart.getTime(), rangeEnd.getTime(), {
          customerId: body.filterCustomerId,
          customerName: body.filterCustomerName,
          lineItemDescription: body.filterLineItemDescription,
        })
      : await getSyncedStripeLineItemsForRange(clampedStartDate, clampedEndDate);

  if (source !== "bigquery") {
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
  }

  const allowBigQueryPriceLookup = String(process.env.STRIPE_BIGQUERY_PRICE_LOOKUP || "false").toLowerCase() === "true";
  const shouldLookupPriceNames = source !== "bigquery" || allowBigQueryPriceLookup;
  const priceIds = shouldLookupPriceNames
    ? Array.from(
        new Set(
          syncedItems
            .map((item) => getPriceIdFromDescription(item.lineItemDescription || ""))
            .filter((id) => !!id),
        ),
      )
    : [];
  const priceDisplayNamesById = priceIds.length ? await getPriceDisplayNamesById(priceIds) : {};

  const rows: ReportRow[] = [];

  for (const item of syncedItems) {
    const lineCurrency = (item.currency || targetCurrency).trim().toLowerCase();
    if (lineCurrency && lineCurrency !== targetCurrency) continue;
    const closeDate = item.invoiceCreatedTs > 0 ? new Date(item.invoiceCreatedTs) : null;
    const amountMajor = Number(item.amountMinor || 0) / 100;
    if (Math.abs(amountMajor) <= NON_ZERO_EPSILON) continue;

    const windowStart = new Date(item.periodStartTs);
    const windowEndInclusive = new Date(item.periodEndTs);
    const windowEndExclusive = new Date(item.periodEndTs + 1);
    if (isNaN(windowStart.getTime()) || isNaN(windowEndExclusive.getTime())) continue;
    if (windowEndExclusive <= windowStart) continue;

    const annualized = annualizedAmountFromPeriod(amountMajor, windowStart, windowEndExclusive);
    if (Math.abs(annualized) <= NON_ZERO_EPSILON) continue;

    const valuesMonthly: Record<string, number> = {};
    for (const mp of monthlyPeriods) {
      const monthEnd = mp.end;
      const coversMonthEnd = windowStart <= monthEnd && windowEndInclusive >= monthEnd;
      valuesMonthly[mp.key] = coversMonthEnd ? annualized : 0;
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
        const coversDay = windowStart <= dp.dayEnd && windowEndInclusive >= dp.dayEnd;
        valuesByPeriod[dp.key] = coversDay ? annualized : 0;
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
      windowEnd: toIsoDate(windowEndInclusive),
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
    const customerNameOk = matchesTextFilter(r.dealName || "", body.filterCustomerName || "");
    const customerIdOk = matchesTextFilter(r.dealId || "", body.filterCustomerId || "");
    const lineItemDescriptionOk = matchesTextFilter(r.lineItemDescription || "", body.filterLineItemDescription || "");
    const lineItemDescriptionPrefixOk = matchesTextFilter(
      lineItemDescriptionPrefix(r.lineItemDescription || ""),
      body.filterLineItemDescriptionPrefix || "",
    );
    return customerNameOk && customerIdOk && lineItemDescriptionOk && lineItemDescriptionPrefixOk;
  });

  let outputRows = filteredRows;
  const groupByFields = (body.groupByFields || []).filter(Boolean);
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

  if (body.sortByPeriodKey && body.sortByPeriodKey !== "none") {
    const sortKey = body.sortByPeriodKey;
    outputRows = [...outputRows].sort((a, b) => (b.valuesByPeriod[sortKey] || 0) - (a.valuesByPeriod[sortKey] || 0));
  }

  const totalsByPeriod = outputPeriods.map((p) => {
    const total = round2(outputRows.reduce((acc, r) => acc + (r.valuesByPeriod[p.key] || 0), 0));
    return { ...p, total };
  });

  const response = {
    periods: outputPeriods,
    totalsByPeriod,
    rows: outputRows,
  };
  REPORT_CACHE.set(cacheKey, { expiresAt: Date.now() + REPORT_CACHE_TTL_MS, value: response });
  return response;
}
