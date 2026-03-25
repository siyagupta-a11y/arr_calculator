import {
  queryStripeMeteredUsageByCustomerFromBigQuery,
  queryStripeSalesLedCustomerInvoicePrepaidUsageFromBigQuery,
  type StripeSalesLedCustomerInvoicePrepaidUsageRow,
} from "@/lib/stripeBigquery";

export type EnterprisePrepaidAiSpendExclusionRow = {
  monthKey: string;
  monthLabel: string;
  asOfDate: string;
  customerId: string;
  customerEmail: string;
  customerName: string;
  currency: string;
  prepaidAppliedMinor: number;
  prepaidAppliedMajor: number;
  availableCreditMinor: number;
  availableCreditMajor: number;
  accountIds: string[];
  accountNames: string[];
};

export type EnterprisePrepaidAiSpendExclusions = {
  customerIds: string[];
  customerMonthPairs: string[];
  customerMonthPrepaidOffsets: Array<{
    pairKey: string;
    customerId: string;
    monthKey: string;
    prepaidAppliedMinor: number;
    prepaidAppliedMajor: number;
  }>;
  rows: EnterprisePrepaidAiSpendExclusionRow[];
};

export type EnterprisePrepaidAiSpendExclusionsRequest = {
  startDate?: string;
  endDate?: string;
  asOfDate?: string;
  targetCurrency?: string;
};

type MonthWindow = {
  monthKey: string;
  monthLabel: string;
  monthStartDate: string;
  monthEndDate: string;
  invoiceMonthStartDate: string;
  invoiceMonthEndDate: string;
  asOfDate: string;
};

function normalizeEmail(value: unknown) {
  const email = String(value || "").trim().toLowerCase();
  return email.includes("@") ? email : "";
}

function toIsoDateOnlyUtc(d: Date) {
  return d.toISOString().slice(0, 10);
}

function parseIsoDateOnly(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

function defaultDateRange() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  return {
    startDate: toIsoDateOnlyUtc(start),
    endDate: toIsoDateOnlyUtc(now),
  };
}

function monthKeyFromDate(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function minIsoDate(a: string, b: string) {
  return a <= b ? a : b;
}

function addUtcMonths(date: Date, deltaMonths: number) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + deltaMonths, 1, 0, 0, 0, 0),
  );
}

function buildMonthWindows(startDate: string, endDate: string, asOfDateOverride?: string): MonthWindow[] {
  const start = parseIsoDateOnly(startDate);
  const end = parseIsoDateOnly(endDate);
  if (!start || !end || end.getTime() < start.getTime()) return [];

  const windows: MonthWindow[] = [];
  const effectiveAsOfCap = asOfDateOverride || toIsoDateOnlyUtc(new Date());

  for (
    let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1, 0, 0, 0, 0));
    cursor <= end;
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1, 0, 0, 0, 0))
  ) {
    const monthStart = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1, 0, 0, 0, 0));
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0, 0, 0, 0, 0));
    const monthKey = monthKeyFromDate(monthStart);
    const monthStartDate = toIsoDateOnlyUtc(monthStart);
    const monthEndDate = toIsoDateOnlyUtc(monthEnd);
    const invoiceMonthStart = addUtcMonths(monthStart, 1);
    const invoiceMonthEnd = new Date(
      Date.UTC(invoiceMonthStart.getUTCFullYear(), invoiceMonthStart.getUTCMonth() + 1, 0, 0, 0, 0, 0),
    );
    const invoiceMonthStartDate = toIsoDateOnlyUtc(invoiceMonthStart);
    const invoiceMonthEndDate = toIsoDateOnlyUtc(invoiceMonthEnd);
    const asOfDate = minIsoDate(invoiceMonthEndDate, effectiveAsOfCap);

    windows.push({
      monthKey,
      monthLabel: monthKey,
      monthStartDate,
      monthEndDate,
      invoiceMonthStartDate,
      invoiceMonthEndDate,
      asOfDate,
    });
  }

  return windows;
}

function availableCreditMinor(row: StripeSalesLedCustomerInvoicePrepaidUsageRow) {
  return Math.max(0, Number(row.maxAvailableCreditMinor || 0));
}

function prepaidAppliedMinor(row: StripeSalesLedCustomerInvoicePrepaidUsageRow) {
  return Math.max(0, Number(row.prepaidAppliedMinor || 0));
}

export async function resolveEnterprisePrepaidAiSpendExclusions(
  request?: EnterprisePrepaidAiSpendExclusionsRequest,
): Promise<EnterprisePrepaidAiSpendExclusions> {
  const defaults = defaultDateRange();
  const startDate = String(request?.startDate || defaults.startDate).trim();
  const endDate = String(request?.endDate || defaults.endDate).trim();
  const asOfDate = String(request?.asOfDate || "").trim();
  const targetCurrency = String(request?.targetCurrency || "USD").trim().toLowerCase() || "usd";

  const monthWindows = buildMonthWindows(startDate, endDate, asOfDate || undefined);
  if (!monthWindows.length) return { customerIds: [], customerMonthPairs: [], customerMonthPrepaidOffsets: [], rows: [] };

  const rows: EnterprisePrepaidAiSpendExclusionRow[] = [];
  for (const monthWindow of monthWindows) {
    const customerRows = await queryStripeSalesLedCustomerInvoicePrepaidUsageFromBigQuery(
      {
        monthStartDate: monthWindow.invoiceMonthStartDate,
        monthEndDate: monthWindow.invoiceMonthEndDate,
        asOfDate: monthWindow.asOfDate,
      },
      { profile: "stripe_arr_correct" },
    );
    if (!customerRows.length) continue;
    const usageByCustomer = new Map(
      (
        await queryStripeMeteredUsageByCustomerFromBigQuery(
          {
            customerIds: customerRows.map((row) => String(row.customerId || "").trim()).filter(Boolean),
            startDate: monthWindow.monthStartDate,
            endDate: monthWindow.monthEndDate,
            targetCurrency,
          },
          { profile: "stripe_arr_correct" },
        )
      ).map((row) => [String(row.customerId || "").trim(), Number(row.usageMajor || 0)]),
    );

    for (const customerRow of customerRows) {
      const email = normalizeEmail(customerRow.email);
      if (!email) continue;
      const customerId = String(customerRow.customerId || "").trim();
      if (!customerId) continue;
      const usageMajor = Number(usageByCustomer.get(customerId) || 0);
      if (!Number.isFinite(usageMajor) || usageMajor <= 0) continue;
      const appliedMinor = prepaidAppliedMinor(customerRow);
      if (appliedMinor <= 0) continue;
      const creditMinor = availableCreditMinor(customerRow);

      rows.push({
        monthKey: monthWindow.monthKey,
        monthLabel: monthWindow.monthLabel,
        asOfDate: monthWindow.asOfDate,
        customerId,
        customerEmail: email,
        customerName: String(customerRow.name || "").trim() || "(blank)",
        currency: String(customerRow.currency || "").trim().toUpperCase() || "USD",
        prepaidAppliedMinor: appliedMinor,
        prepaidAppliedMajor: Math.round((appliedMinor / 100) * 100) / 100,
        availableCreditMinor: creditMinor,
        availableCreditMajor: Math.round((creditMinor / 100) * 100) / 100,
        accountIds: Array.from(new Set((customerRow.accountIds || []).map((value) => String(value || "").trim()).filter(Boolean))).sort(),
        accountNames: Array.from(
          new Set((customerRow.accountNames || []).map((value) => String(value || "").trim()).filter(Boolean)),
        ).sort(),
      });
    }
  }

  rows.sort((a, b) => {
    if (a.monthKey !== b.monthKey) return a.monthKey.localeCompare(b.monthKey);
    const prepaidDiff = b.prepaidAppliedMinor - a.prepaidAppliedMinor;
    if (Math.abs(prepaidDiff) > 1e-9) return prepaidDiff;
    const creditDiff = b.availableCreditMinor - a.availableCreditMinor;
    if (Math.abs(creditDiff) > 1e-9) return creditDiff;
    return a.customerId.localeCompare(b.customerId);
  });

  const customerMonthPairs = Array.from(
    new Set(
      rows
        .map((row) => {
          const customerId = String(row.customerId || "").trim();
          const monthKey = String(row.monthKey || "").trim();
          if (!customerId || !monthKey) return "";
          return `${customerId}|${monthKey}`;
        })
        .filter(Boolean),
    ),
  ).sort();

  const customerIds = Array.from(
    new Set(rows.map((row) => String(row.customerId || "").trim()).filter(Boolean)),
  ).sort();

  const offsetsMap = new Map<
    string,
    { pairKey: string; customerId: string; monthKey: string; prepaidAppliedMinor: number; prepaidAppliedMajor: number }
  >();
  for (const row of rows) {
    const customerId = String(row.customerId || "").trim();
    const monthKey = String(row.monthKey || "").trim();
    if (!customerId || !monthKey) continue;
    const pairKey = `${customerId}|${monthKey}`;
    const current = offsetsMap.get(pairKey);
    if (!current) {
      offsetsMap.set(pairKey, {
        pairKey,
        customerId,
        monthKey,
        prepaidAppliedMinor: row.prepaidAppliedMinor,
        prepaidAppliedMajor: row.prepaidAppliedMajor,
      });
      continue;
    }
    const nextMinor = current.prepaidAppliedMinor + row.prepaidAppliedMinor;
    current.prepaidAppliedMinor = nextMinor;
    current.prepaidAppliedMajor = Math.round((nextMinor / 100) * 100) / 100;
  }
  const customerMonthPrepaidOffsets = Array.from(offsetsMap.values()).sort((a, b) => {
    if (a.monthKey !== b.monthKey) return a.monthKey.localeCompare(b.monthKey);
    const diff = b.prepaidAppliedMinor - a.prepaidAppliedMinor;
    if (Math.abs(diff) > 1e-9) return diff;
    return a.customerId.localeCompare(b.customerId);
  });

  return { customerIds, customerMonthPairs, customerMonthPrepaidOffsets, rows };
}
