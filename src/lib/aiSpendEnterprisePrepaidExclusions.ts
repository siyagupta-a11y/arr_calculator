import { batchReadContacts, fetchContactIdsForCompanies } from "@/lib/hubspot";
import { generateReport } from "@/lib/report";
import {
  queryStripeCustomerInvoicePrepaidUsageByEmailsFromBigQuery,
  type StripeCustomerInvoicePrepaidUsageByEmailRow,
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
  rows: EnterprisePrepaidAiSpendExclusionRow[];
};

export type EnterprisePrepaidAiSpendExclusionsRequest = {
  startDate?: string;
  endDate?: string;
  asOfDate?: string;
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

function parseCompanyIds(rawAccountId: string) {
  return Array.from(
    new Set(
      String(rawAccountId || "")
        .split(/[,\s;|]+/)
        .map((part) => part.trim())
        .filter((part) => /^\d+$/.test(part)),
    ),
  );
}

function isCloudDeploymentType(value: string) {
  return String(value || "").trim().toLowerCase() === "cloud";
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

function availableCreditMinor(row: StripeCustomerInvoicePrepaidUsageByEmailRow) {
  return Math.max(0, Number(row.maxAvailableCreditMinor || 0));
}

function prepaidAppliedMinor(row: StripeCustomerInvoicePrepaidUsageByEmailRow) {
  return Math.max(0, Number(row.prepaidAppliedMinor || 0));
}

async function loadEnterpriseCompanyMapForPeriod(startDate: string, endDate: string) {
  const report = await generateReport({
    startDate,
    endDate,
    mode: "contracted",
    grain: "monthly",
  });

  const companies = new Map<string, { accountIds: Set<string>; accountNames: Set<string> }>();
  for (const row of report.rows || []) {
    if (!isCloudDeploymentType(String(row.deploymentType || ""))) continue;
    if (String(row.plan || "").trim().toLowerCase() !== "enterprise") continue;

    const accountId = String(row.accountId || "").trim();
    const accountName = String(row.accountName || "").trim();
    const companyIds = parseCompanyIds(accountId);
    if (!companyIds.length) continue;

    for (const companyId of companyIds) {
      if (!companies.has(companyId)) {
        companies.set(companyId, { accountIds: new Set<string>(), accountNames: new Set<string>() });
      }
      const entry = companies.get(companyId)!;
      if (accountId) entry.accountIds.add(accountId);
      if (accountName) entry.accountNames.add(accountName);
    }
  }
  return companies;
}

async function loadEnterpriseEmailsByCompany(companyIds: string[]) {
  const out = new Map<string, Set<string>>();
  if (!companyIds.length) return out;

  const pairs = await fetchContactIdsForCompanies(companyIds);
  const contactIds = Array.from(
    new Set(
      pairs.flatMap((pair) => pair.ids || []).map((id) => String(id || "").trim()).filter(Boolean),
    ),
  );
  if (!contactIds.length) return out;

  const contacts = await batchReadContacts(contactIds, ["email"]);
  const emailByContactId = new Map<string, string>();
  for (const [contactId, contact] of contacts.entries()) {
    const email = normalizeEmail(contact.properties?.email);
    if (email) emailByContactId.set(String(contactId || "").trim(), email);
  }

  for (const pair of pairs) {
    const companyId = String(pair.companyId || "").trim();
    if (!companyId) continue;
    for (const contactId of pair.ids || []) {
      const email = emailByContactId.get(String(contactId || "").trim());
      if (!email) continue;
      if (!out.has(companyId)) out.set(companyId, new Set<string>());
      out.get(companyId)!.add(email);
    }
  }

  return out;
}

export async function resolveEnterprisePrepaidAiSpendExclusions(
  request?: EnterprisePrepaidAiSpendExclusionsRequest,
): Promise<EnterprisePrepaidAiSpendExclusions> {
  const defaults = defaultDateRange();
  const startDate = String(request?.startDate || defaults.startDate).trim();
  const endDate = String(request?.endDate || defaults.endDate).trim();
  const asOfDate = String(request?.asOfDate || "").trim();

  const monthWindows = buildMonthWindows(startDate, endDate, asOfDate || undefined);
  if (!monthWindows.length) return { customerIds: [], customerMonthPairs: [], rows: [] };

  const enterpriseCompanies = await loadEnterpriseCompanyMapForPeriod(startDate, endDate);
  const companyIds = Array.from(enterpriseCompanies.keys());
  if (!companyIds.length) return { customerIds: [], customerMonthPairs: [], rows: [] };

  const emailsByCompany = await loadEnterpriseEmailsByCompany(companyIds);
  const allEmails = Array.from(
    new Set(Array.from(emailsByCompany.values()).flatMap((set) => Array.from(set.values()))),
  );
  if (!allEmails.length) return { customerIds: [], customerMonthPairs: [], rows: [] };

  const companyIdsByEmail = new Map<string, Set<string>>();
  for (const [companyId, emails] of emailsByCompany.entries()) {
    for (const email of emails) {
      if (!companyIdsByEmail.has(email)) companyIdsByEmail.set(email, new Set<string>());
      companyIdsByEmail.get(email)!.add(companyId);
    }
  }

  const rows: EnterprisePrepaidAiSpendExclusionRow[] = [];
  for (const monthWindow of monthWindows) {
    const customerRows = await queryStripeCustomerInvoicePrepaidUsageByEmailsFromBigQuery(
      {
        emails: allEmails,
        monthStartDate: monthWindow.invoiceMonthStartDate,
        monthEndDate: monthWindow.invoiceMonthEndDate,
        asOfDate: monthWindow.asOfDate,
      },
      { profile: "stripe_arr_correct" },
    );

    for (const customerRow of customerRows) {
      const email = normalizeEmail(customerRow.email);
      if (!email) continue;
      const appliedMinor = prepaidAppliedMinor(customerRow);
      if (appliedMinor <= 0) continue;
      const creditMinor = availableCreditMinor(customerRow);

      const linkedCompanyIds = Array.from(companyIdsByEmail.get(email) || []).sort();
      if (!linkedCompanyIds.length) continue;

      const accountIdSet = new Set<string>();
      const accountNameSet = new Set<string>();
      for (const companyId of linkedCompanyIds) {
        const ref = enterpriseCompanies.get(companyId);
        if (!ref) continue;
        for (const accountId of ref.accountIds) accountIdSet.add(accountId);
        for (const accountName of ref.accountNames) accountNameSet.add(accountName);
      }

      rows.push({
        monthKey: monthWindow.monthKey,
        monthLabel: monthWindow.monthLabel,
        asOfDate: monthWindow.asOfDate,
        customerId: String(customerRow.customerId || "").trim(),
        customerEmail: email,
        customerName: String(customerRow.name || "").trim() || "(blank)",
        currency: String(customerRow.currency || "").trim().toUpperCase() || "USD",
        prepaidAppliedMinor: appliedMinor,
        prepaidAppliedMajor: Math.round((appliedMinor / 100) * 100) / 100,
        availableCreditMinor: creditMinor,
        availableCreditMajor: Math.round((creditMinor / 100) * 100) / 100,
        accountIds: Array.from(accountIdSet).sort(),
        accountNames: Array.from(accountNameSet).sort(),
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

  return { customerIds, customerMonthPairs, rows };
}
