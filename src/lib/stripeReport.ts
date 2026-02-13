import {
  aggregatePeriodsFromMonthly,
  buildMonthlyPeriods,
  firstOfMonth,
  parseDate,
  round2,
} from "@/lib/logic";
import type { Grain, ReportResponse, ReportRow } from "@/lib/types";
import { listInvoicesWithLineItems } from "@/lib/stripe";

export type StripeReportRequest = {
  startDate: string;
  endDate: string;
  grain: Grain;
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

  const monthlyPeriods = buildMonthlyPeriods(firstOfMonth(rangeStart), firstOfMonth(rangeEnd));
  const dailyPeriods = buildDailyPeriods(rangeStart, rangeEnd);
  const aggregated = aggregatePeriodsFromMonthly(monthlyPeriods, body.grain);
  const outputPeriods =
    body.grain === "daily"
      ? dailyPeriods.map((p) => ({ key: p.key, label: p.label }))
      : aggregated.map((p) => ({ key: p.key, label: p.label }));

  const targetCurrency = (process.env.STRIPE_TARGET_CURRENCY || "USD").trim().toLowerCase();
  const invoices = await listInvoicesWithLineItems();

  const rows: ReportRow[] = [];

  for (const invoiceWithLines of invoices) {
    const invoiceCurrency = String(invoiceWithLines.invoice.currency || "").trim().toLowerCase();
    const lineCurrency = invoiceCurrency || targetCurrency;
    if (lineCurrency && lineCurrency !== targetCurrency) continue;

    const invoiceCreated = Number(invoiceWithLines.invoice.created || 0);
    const closeDate = invoiceCreated > 0 ? new Date(invoiceCreated * 1000) : null;

    for (const line of invoiceWithLines.lineItems) {
      const amountMajor = Number(line.amount || 0) / 100;
      if (!(amountMajor > 0)) continue;

      const periodStartRaw = Number(line.period?.start || 0);
      const periodEndRaw = Number(line.period?.end || 0);
      if (!(periodStartRaw > 0) || !(periodEndRaw > 0)) continue;

      const windowStart = new Date(periodStartRaw * 1000);
      const windowEndExclusive = new Date(periodEndRaw * 1000);
      if (isNaN(windowStart.getTime()) || isNaN(windowEndExclusive.getTime())) continue;
      if (windowEndExclusive <= windowStart) continue;

      // Stripe line item period end is treated as exclusive; convert for inclusion checks.
      const windowEndInclusive = new Date(windowEndExclusive.getTime() - 1);

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

      const recurring = line.price?.recurring;
      const recurringLabel = recurringFrequencyLabel(recurring?.interval, recurring?.interval_count);

      rows.push({
        dealName: invoiceWithLines.customerName,
        dealId: invoiceWithLines.customerId || "(no customer id)",
        lineItemId: line.id,

        valueUsd: annualized,
        dealCurrency: targetCurrency.toUpperCase(),
        fxRate: null,
        fxDateUsed: "",

        dealType: "stripe_invoice_line",
        closeDate: closeDate ? toIsoDate(closeDate) : "",

        windowStart: toIsoDate(windowStart),
        windowEnd: toIsoDate(windowEndInclusive),
        isOpenEnded: false,

        recurringbillingfrequency: recurringLabel,
        termMonths: null,
        amount: round2(amountMajor),
        netPrice: round2(amountMajor),
        quantity: Number(line.quantity || 1),

        valuesByPeriod,
        deploymentType: "",
        accountId: "",
        territory: "",
        country: "",
        industry: "",
        lineItemDescription: String(line.description || ""),
      });
    }
  }

  const totalsByPeriod = outputPeriods.map((p) => {
    const total = round2(rows.reduce((acc, r) => acc + (r.valuesByPeriod[p.key] || 0), 0));
    return { ...p, total };
  });

  return {
    periods: outputPeriods,
    totalsByPeriod,
    rows,
  };
}
