import {
  aggregatePeriodsFromMonthly,
  buildMonthlyPeriods,
  firstOfMonth,
  parseDate,
  round2,
} from "@/lib/logic";
import type { Grain, ReportResponse, ReportRow } from "@/lib/types";
import { ensureStripeSyncForRange, getSyncedStripeLineItemsForRange } from "@/lib/stripeSyncStore";

export type StripeReportRequest = {
  startDate: string;
  endDate: string;
  grain: Grain;
};

type CacheEntry = {
  expiresAt: number;
  value: ReportResponse;
};

const REPORT_CACHE_TTL_MS = Number(process.env.STRIPE_REPORT_CACHE_TTL_MS || "300000");
const REPORT_CACHE = new Map<string, CacheEntry>();

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
  return round2((amountMajor * 365.2425) / Math.max(durationDays, 1 / 24));
}

export async function generateStripeReport(body: StripeReportRequest): Promise<ReportResponse> {
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

  const cacheKey = `${body.startDate}|${body.endDate}|${body.grain}`;
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
  let syncedItems = await getSyncedStripeLineItemsForRange(body.startDate, body.endDate);
  const autoSync = String(process.env.STRIPE_REPORT_AUTO_SYNC || "false").toLowerCase() === "true";

  if (!syncedItems.length && autoSync) {
    await ensureStripeSyncForRange({
      startDate: body.startDate,
      endDate: body.endDate,
    });
    syncedItems = await getSyncedStripeLineItemsForRange(body.startDate, body.endDate);
  }

  const rows: ReportRow[] = [];

  for (const item of syncedItems) {
    const lineCurrency = (item.currency || targetCurrency).trim().toLowerCase();
    if (lineCurrency && lineCurrency !== targetCurrency) continue;
    const closeDate = item.invoiceCreatedTs > 0 ? new Date(item.invoiceCreatedTs) : null;
    const amountMajor = Number(item.amountMinor || 0) / 100;
    if (!(amountMajor > 0)) continue;

    const windowStart = new Date(item.periodStartTs);
    const windowEndInclusive = new Date(item.periodEndTs);
    const windowEndExclusive = new Date(item.periodEndTs + 1);
    if (isNaN(windowStart.getTime()) || isNaN(windowEndExclusive.getTime())) continue;
    if (windowEndExclusive <= windowStart) continue;

    const annualized = annualizedAmountFromPeriod(amountMajor, windowStart, windowEndExclusive);
    if (!(annualized > 0)) continue;

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

    rows.push({
      dealName: item.customerName,
      dealId: item.customerId || "(no customer id)",
      lineItemId: item.lineItemId,

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
      lineItemDescription: item.lineItemDescription || "",
    });
  }

  const totalsByPeriod = outputPeriods.map((p) => {
    const total = round2(rows.reduce((acc, r) => acc + (r.valuesByPeriod[p.key] || 0), 0));
    return { ...p, total };
  });

  const response = {
    periods: outputPeriods,
    totalsByPeriod,
    rows,
  };
  REPORT_CACHE.set(cacheKey, { expiresAt: Date.now() + REPORT_CACHE_TTL_MS, value: response });
  return response;
}
