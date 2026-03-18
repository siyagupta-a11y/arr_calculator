import { batchReadContacts, fetchContactIdsForCompanies } from "@/lib/hubspot";
import { generateReport } from "@/lib/report";
import {
  queryStripeThroughMrrCustomerArrFromBigQuery,
  type StripeBigQueryProfile,
  type StripeThroughMrrCustomerArrRow,
} from "@/lib/stripeBigquery";
import type { ReportResponse, ReportRow } from "@/lib/types";

export type CombinedAllSubsRequest = {
  startDate: string;
  endDate: string;
  combineMode?: CombinedAllSubsCombineMode;
};

export type CombinedAllSubsCombineMode = "grouped" | "simple";

export type CombinedAllSubsRow = {
  id: string;
  source: "hubspot_account" | "stripe_only_customer";
  customerLabel: string;
  accountId: string;
  accountName: string;
  stripeKeys: string[];
  matchedStripeKeys: string[];
  hubspotValuesByPeriod: Record<string, number>;
  stripeValuesByPeriod: Record<string, number>;
  valuesByPeriod: Record<string, number>;
};

export type CombinedAllSubsResponse = {
  startDate: string;
  endDate: string;
  combineMode: CombinedAllSubsCombineMode;
  targetCurrency: string;
  periods: Array<{ key: string; label: string }>;
  totalsByPeriod: Array<{ key: string; label: string; total: number }>;
  rows: CombinedAllSubsRow[];
  summary: {
    hubspotAccounts: number;
    hubspotAccountsWithStripeMatch: number;
    stripeCustomers: number;
    stripeCustomersMatched: number;
    stripeCustomersOnly: number;
  };
};

type HubspotAccountAggregate = {
  accountKey: string;
  accountId: string;
  accountName: string;
  companyIds: Set<string>;
  stripeKeys: Set<string>;
  matchedStripeKeys: Set<string>;
  hubspotValuesByPeriod: Record<string, number>;
  stripeValuesByPeriod: Record<string, number>;
  valuesByPeriod: Record<string, number>;
};

type StripeCustomerAggregate = {
  customerKey: string;
  matchingKeys: Set<string>;
  valuesByPeriod: Record<string, number>;
};

const STRIPE_QUERY_OPTIONS: { profile: StripeBigQueryProfile } = {
  profile: "stripe_arr_correct",
};

function normalizeCombineMode(mode: string | undefined): CombinedAllSubsCombineMode {
  return String(mode || "").trim().toLowerCase() === "simple" ? "simple" : "grouped";
}

function round2(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function parseIsoDateOnly(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function toIsoDateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function accountGroupingKey(rawAccountId: string) {
  const raw = String(rawAccountId || "").trim();
  if (!raw) return "";

  const numericToken =
    raw
      .split(/[,\s;|]+/)
      .map((part) => part.trim())
      .find((part) => /^\d+$/.test(part)) || "";

  return numericToken || raw.toLowerCase();
}

function accountCompanyIds(rawAccountId: string) {
  return Array.from(
    new Set(
      String(rawAccountId || "")
        .split(/[,\s;|]+/)
        .map((part) => part.trim())
        .filter((part) => /^\d+$/.test(part)),
    ),
  );
}

function normalizeStripeKey(value: string) {
  return String(value || "").trim().toLowerCase();
}

function isCloudDeploymentType(value: string) {
  return String(value || "").trim().toLowerCase() === "cloud";
}

function targetCurrency() {
  return (
    String(process.env.STRIPE_THROUGH_MRR_TARGET_CURRENCY || "").trim() ||
    String(process.env.STRIPE_ARR_CORRECT_TARGET_CURRENCY || "").trim() ||
    "USD"
  );
}

function buildHubspotAccountMap(report: ReportResponse) {
  const periods = (report.periods || []).map((period) => ({
    key: String(period.key || ""),
    label: String(period.label || period.key || ""),
  }));

  const accounts = new Map<string, HubspotAccountAggregate>();
  const companyIdToAccountKey = new Map<string, string>();

  const filteredRows: ReportRow[] = (report.rows || [])
    .filter((row) => isCloudDeploymentType(String(row.deploymentType || "")));

  for (const row of filteredRows) {
    const rawAccountId = String(row.accountId || "").trim();
    const key = accountGroupingKey(rawAccountId);
    if (!key) continue;

    if (!accounts.has(key)) {
      accounts.set(key, {
        accountKey: key,
        accountId: rawAccountId,
        accountName: String(row.accountName || "").trim(),
        companyIds: new Set<string>(),
        stripeKeys: new Set<string>(),
        matchedStripeKeys: new Set<string>(),
        hubspotValuesByPeriod: {},
        stripeValuesByPeriod: {},
        valuesByPeriod: {},
      });
    }

    const entry = accounts.get(key)!;
    if (!entry.accountId && rawAccountId) entry.accountId = rawAccountId;
    if (!entry.accountName && row.accountName) entry.accountName = String(row.accountName || "").trim();

    for (const period of periods) {
      const value = round2(Number(row.valuesByPeriod?.[period.key] || 0));
      entry.hubspotValuesByPeriod[period.key] = round2((entry.hubspotValuesByPeriod[period.key] || 0) + value);
      entry.valuesByPeriod[period.key] = round2((entry.valuesByPeriod[period.key] || 0) + value);
    }

    for (const companyId of accountCompanyIds(rawAccountId)) {
      entry.companyIds.add(companyId);
      if (!companyIdToAccountKey.has(companyId)) companyIdToAccountKey.set(companyId, key);
    }
  }

  return { periods, accounts, companyIdToAccountKey };
}

async function attachStripeKeysFromHubspotContacts(
  accounts: Map<string, HubspotAccountAggregate>,
  companyIdToAccountKey: Map<string, string>,
) {
  const companyIds = Array.from(companyIdToAccountKey.keys());
  if (!companyIds.length) return;

  const companyContactPairs = await fetchContactIdsForCompanies(companyIds);
  const allContactIds = Array.from(
    new Set(
      companyContactPairs
        .flatMap((pair) => pair.ids || [])
        .map((id) => String(id || "").trim())
        .filter(Boolean),
    ),
  );
  if (!allContactIds.length) return;

  const contactsById = await batchReadContacts(allContactIds, ["email"]);

  const contactIdsByAccountKey = new Map<string, Set<string>>();
  for (const pair of companyContactPairs) {
    const accountKey = companyIdToAccountKey.get(String(pair.companyId || ""));
    if (!accountKey) continue;
    if (!contactIdsByAccountKey.has(accountKey)) contactIdsByAccountKey.set(accountKey, new Set<string>());
    const bucket = contactIdsByAccountKey.get(accountKey)!;
    for (const contactId of pair.ids || []) {
      const normalized = String(contactId || "").trim();
      if (normalized) bucket.add(normalized);
    }
  }

  for (const [accountKey, contactIdSet] of contactIdsByAccountKey.entries()) {
    const account = accounts.get(accountKey);
    if (!account) continue;

    for (const contactId of contactIdSet) {
      const contact = contactsById.get(contactId);
      const properties = (contact?.properties || {}) as Record<string, unknown>;

      const email = normalizeStripeKey(String(properties.email || ""));
      if (email) account.stripeKeys.add(email);
    }
  }
}

function buildStripeCustomerMap(rows: StripeThroughMrrCustomerArrRow[]) {
  const customers = new Map<string, StripeCustomerAggregate>();
  const aliasesToCustomerKey = new Map<string, string>();

  for (const row of rows || []) {
    const key = normalizeStripeKey(row.customerKey);
    if (!key) continue;

    if (!customers.has(key)) {
      customers.set(key, {
        customerKey: key,
        matchingKeys: new Set<string>([key]),
        valuesByPeriod: {},
      });
    }

    const bucket = customers.get(key)!;
    aliasesToCustomerKey.set(key, key);
    const periodKey = String(row.periodKey || "").trim();
    if (!periodKey) continue;
    const arr = round2(Number(row.arr || 0));
    bucket.valuesByPeriod[periodKey] = round2((bucket.valuesByPeriod[periodKey] || 0) + arr);
  }

  return { customers, aliasesToCustomerKey };
}

function mergeStripeIntoHubspotAccounts(
  periods: Array<{ key: string; label: string }>,
  accounts: Map<string, HubspotAccountAggregate>,
  stripeCustomers: Map<string, StripeCustomerAggregate>,
  aliasesToCustomerKey: Map<string, string>,
) {
  const claimedStripeCustomerKeys = new Set<string>();
  const sortedAccounts = Array.from(accounts.values()).sort((a, b) => a.accountKey.localeCompare(b.accountKey));

  for (const account of sortedAccounts) {
    const stripeKeys = Array.from(account.stripeKeys).sort();
    for (const stripeKey of stripeKeys) {
      const canonicalStripeKey = aliasesToCustomerKey.get(stripeKey);
      if (!canonicalStripeKey) continue;
      if (claimedStripeCustomerKeys.has(canonicalStripeKey)) continue;

      const stripeCustomer = stripeCustomers.get(canonicalStripeKey);
      if (!stripeCustomer) continue;
      claimedStripeCustomerKeys.add(canonicalStripeKey);
      for (const matchingKey of stripeCustomer.matchingKeys) {
        account.matchedStripeKeys.add(matchingKey);
      }

      for (const period of periods) {
        const value = round2(Number(stripeCustomer.valuesByPeriod[period.key] || 0));
        account.stripeValuesByPeriod[period.key] = round2((account.stripeValuesByPeriod[period.key] || 0) + value);
        account.valuesByPeriod[period.key] = round2((account.valuesByPeriod[period.key] || 0) + value);
      }
    }
  }

  return claimedStripeCustomerKeys;
}

function customerLabel(accountName: string, accountId: string) {
  const cleanName = String(accountName || "").trim();
  const cleanId = String(accountId || "").trim();
  if (cleanName && cleanId) return `${cleanName} (${cleanId})`;
  if (cleanName) return cleanName;
  if (cleanId) return cleanId;
  return "(blank account)";
}

function latestPeriodValue(periods: Array<{ key: string }>, valuesByPeriod: Record<string, number>) {
  if (!periods.length) return 0;
  const key = periods[periods.length - 1].key;
  return round2(Number(valuesByPeriod[key] || 0));
}

function sortRowsByLatestPeriod(
  periods: Array<{ key: string }>,
  rows: CombinedAllSubsRow[],
) {
  return [...rows].sort((a, b) => {
    const diff = latestPeriodValue(periods, b.valuesByPeriod) - latestPeriodValue(periods, a.valuesByPeriod);
    if (Math.abs(diff) > 1e-9) return diff;
    return a.customerLabel.localeCompare(b.customerLabel);
  });
}

export async function generateCombinedAllSubsReport(
  request: CombinedAllSubsRequest,
): Promise<CombinedAllSubsResponse> {
  const start = parseIsoDateOnly(request.startDate);
  const end = parseIsoDateOnly(request.endDate);
  if (!start || !end) {
    throw new Error("Invalid startDate/endDate");
  }
  if (end.getTime() < start.getTime()) {
    throw new Error("endDate must be >= startDate");
  }

  const startDate = toIsoDateOnly(start);
  const endDate = toIsoDateOnly(end);
  const combineMode = normalizeCombineMode(request.combineMode);
  const target = targetCurrency();

  const [hubspotReport, stripeCustomerArr] = await Promise.all([
    generateReport({
      startDate,
      endDate,
      mode: "contracted",
      grain: "monthly",
    }),
    queryStripeThroughMrrCustomerArrFromBigQuery(
      {
        startDate,
        endDate,
        targetCurrency: target,
      },
      STRIPE_QUERY_OPTIONS,
    ),
  ]);

  const { periods, accounts, companyIdToAccountKey } = buildHubspotAccountMap(hubspotReport);
  const { customers: stripeCustomers, aliasesToCustomerKey } = buildStripeCustomerMap(stripeCustomerArr.rows || []);
  let matchedStripeCustomerKeys = new Set<string>();

  if (combineMode === "grouped") {
    await attachStripeKeysFromHubspotContacts(accounts, companyIdToAccountKey);
    matchedStripeCustomerKeys = mergeStripeIntoHubspotAccounts(
      periods,
      accounts,
      stripeCustomers,
      aliasesToCustomerKey,
    );
  }

  const rows: CombinedAllSubsRow[] = [];
  for (const account of accounts.values()) {
    rows.push({
      id: `hubspot:${account.accountKey}`,
      source: "hubspot_account",
      customerLabel: customerLabel(account.accountName, account.accountId),
      accountId: account.accountId,
      accountName: account.accountName,
      stripeKeys: Array.from(account.stripeKeys).sort(),
      matchedStripeKeys: Array.from(account.matchedStripeKeys).sort(),
      hubspotValuesByPeriod: account.hubspotValuesByPeriod,
      stripeValuesByPeriod: account.stripeValuesByPeriod,
      valuesByPeriod: account.valuesByPeriod,
    });
  }

  for (const [customerKey, stripeCustomer] of stripeCustomers.entries()) {
    if (combineMode === "grouped" && matchedStripeCustomerKeys.has(customerKey)) continue;

    const valuesByPeriod: Record<string, number> = {};
    for (const period of periods) {
      valuesByPeriod[period.key] = round2(Number(stripeCustomer.valuesByPeriod[period.key] || 0));
    }

    rows.push({
      id: `stripe:${customerKey}`,
      source: "stripe_only_customer",
      customerLabel: customerKey,
      accountId: "",
      accountName: "",
      stripeKeys: Array.from(stripeCustomer.matchingKeys).sort(),
      matchedStripeKeys: [],
      hubspotValuesByPeriod: {},
      stripeValuesByPeriod: valuesByPeriod,
      valuesByPeriod,
    });
  }

  const sortedRows = sortRowsByLatestPeriod(periods, rows);

  const totalsByPeriod = periods.map((period) => ({
    key: period.key,
    label: period.label,
    total: round2(
      sortedRows.reduce((sum, row) => sum + Number(row.valuesByPeriod[period.key] || 0), 0),
    ),
  }));

  return {
    startDate,
    endDate,
    combineMode,
    targetCurrency: String(target || "USD").toUpperCase(),
    periods,
    totalsByPeriod,
    rows: sortedRows,
    summary: {
      hubspotAccounts: sortedRows.filter((row) => row.source === "hubspot_account").length,
      hubspotAccountsWithStripeMatch:
        combineMode === "grouped"
          ? sortedRows.filter((row) => row.source === "hubspot_account" && row.matchedStripeKeys.length > 0).length
          : 0,
      stripeCustomers: stripeCustomers.size,
      stripeCustomersMatched: combineMode === "grouped" ? matchedStripeCustomerKeys.size : 0,
      stripeCustomersOnly:
        combineMode === "grouped"
          ? sortedRows.filter((row) => row.source === "stripe_only_customer").length
          : stripeCustomers.size,
    },
  };
}
