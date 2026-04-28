import {
  fetchCompanyIdsForContactEmails,
  fetchSalesAssistDealMatches,
  fetchDealsInStage,
} from "@/lib/hubspot";
import { generateReport } from "@/lib/report";
import {
  queryStripeThroughMrrCustomerArrFromBigQuery,
  queryStripeThroughMrrCustomerPlanFromBigQuery,
  type StripeBigQueryProfile,
  type StripeThroughMrrCustomerArrRow,
  type StripeThroughMrrCustomerPlanRow,
  type StripeThroughMrrCustomerArrResult,
  type StripeThroughMrrCustomerPlanResult,
} from "@/lib/stripeBigquery";
import type { ReportResponse, ReportRow } from "@/lib/types";

export type CombinedAllSubsRequest = {
  startDate: string;
  endDate: string;
  combineMode?: CombinedAllSubsCombineMode;
  displayMode?: CombinedAllSubsDisplayMode;
  planGrain?: CombinedAllSubsPlanGrain;
  includePlanData?: boolean;
  groupedMatchStrategy?: "full" | "workspace_only";
  includeSalesAssist?: boolean;
};

export type CombinedAllSubsCombineMode = "grouped" | "simple";
export type CombinedAllSubsDisplayMode = "arr" | "plan";
export type CombinedAllSubsPlanGrain = "daily" | "monthly";
export type CombinedAllSubsPlan = "enterprise" | "managed" | "team" | "plus" | "pay_as_you_go" | "free";

export type CombinedAllSubsRow = {
  id: string;
  source: "hubspot_account" | "stripe_only_customer";
  customerLabel: string;
  accountId: string;
  accountName: string;
  salesAssist: "yes" | "no";
  salesAssistByPeriod?: Record<string, "yes" | "no">;
  deskEarlyAccessByPeriod?: Record<string, "yes" | "no">;
  stripeKeys: string[];
  matchedStripeKeys: string[];
  hubspotValuesByPeriod: Record<string, number>;
  stripeValuesByPeriod: Record<string, number>;
  valuesByPeriod: Record<string, number>;
  hubspotPlansByPeriod?: Record<string, CombinedAllSubsPlan>;
  stripePlansByPeriod?: Record<string, CombinedAllSubsPlan>;
  plansByPeriod?: Record<string, CombinedAllSubsPlan>;
};

export type CombinedAllSubsResponse = {
  startDate: string;
  endDate: string;
  combineMode: CombinedAllSubsCombineMode;
  displayMode: CombinedAllSubsDisplayMode;
  planGrain: CombinedAllSubsPlanGrain;
  targetCurrency: string;
  warnings?: string[];
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
  matchedStripeWorkspaceIds: Set<string>;
  deskEarlyAccessByPeriod: Record<string, "yes" | "no">;
  hubspotValuesByPeriod: Record<string, number>;
  stripeValuesByPeriod: Record<string, number>;
  valuesByPeriod: Record<string, number>;
  hubspotPlansByPeriod: Record<string, CombinedAllSubsPlan>;
  stripePlansByPeriod: Record<string, CombinedAllSubsPlan>;
  plansByPeriod: Record<string, CombinedAllSubsPlan>;
};

type StripeCustomerAggregate = {
  customerKey: string;
  matchingKeys: Set<string>;
  workspaceIds: Set<string>;
  valuesByPeriod: Record<string, number>;
  plansByPeriod: Record<string, CombinedAllSubsPlan>;
};

const STRIPE_QUERY_OPTIONS: { profile: StripeBigQueryProfile } = {
  profile: "stripe_arr_correct",
};

function normalizeCombineMode(mode: string | undefined): CombinedAllSubsCombineMode {
  return String(mode || "").trim().toLowerCase() === "simple" ? "simple" : "grouped";
}

function normalizeDisplayMode(mode: string | undefined): CombinedAllSubsDisplayMode {
  return String(mode || "").trim().toLowerCase() === "plan" ? "plan" : "arr";
}

function normalizePlanGrain(grain: string | undefined): CombinedAllSubsPlanGrain {
  return String(grain || "").trim().toLowerCase() === "daily" ? "daily" : "monthly";
}

function normalizeGroupedMatchStrategy(value: string | undefined): "full" | "workspace_only" {
  return String(value || "").trim().toLowerCase() === "workspace_only" ? "workspace_only" : "full";
}

function round2(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function isDeskEarlyAccessRow(row: ReportRow) {
  const tokens = [
    String(row.lineItemDescription || ""),
    String(row.deliveryStage || ""),
    String(row.dealName || ""),
  ]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return tokens.some((value) => value.includes("desk - early access") || value.includes("desk early access"));
}

const PLAN_RANK: Record<CombinedAllSubsPlan, number> = {
  enterprise: 6,
  managed: 5,
  team: 4,
  plus: 3,
  pay_as_you_go: 2,
  free: 1,
};

function betterPlan(current: CombinedAllSubsPlan | undefined, incoming: CombinedAllSubsPlan | undefined): CombinedAllSubsPlan {
  const a = current || "free";
  const b = incoming || "free";
  return PLAN_RANK[b] > PLAN_RANK[a] ? b : a;
}

function normalizeHubspotPlan(plan: string | undefined): CombinedAllSubsPlan {
  const value = String(plan || "").trim().toLowerCase();
  if (value === "enterprise") return "enterprise";
  if (value === "managed") return "managed";
  if (value === "team") return "team";
  return "free";
}

function normalizeCombinedPlan(plan: string | undefined): CombinedAllSubsPlan {
  const value = String(plan || "").trim().toLowerCase();
  if (value === "enterprise") return "enterprise";
  if (value === "managed") return "managed";
  if (value === "team") return "team";
  if (value === "plus") return "plus";
  if (value === "pay_as_you_go" || value === "pay as you go") return "pay_as_you_go";
  return "free";
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

function normalizeWorkspaceId(value: string) {
  return String(value || "").trim().toLowerCase();
}

function isUnknownPropertyError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = String(error.message || "").toLowerCase();
  return (
    message.includes("property") &&
    (message.includes("does not exist") ||
      message.includes("no property found") ||
      message.includes("not a valid property"))
  );
}

function parseHubspotTimestampMs(rawValue: unknown) {
  const text = String(rawValue ?? "").trim();
  if (!text) return NaN;
  const asNum = Number(text);
  if (Number.isFinite(asNum)) {
    if (asNum > 1e12) return asNum;
    if (asNum > 1e9) return asNum * 1000;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function monthKeyFromTimestampMs(ms: number) {
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString().slice(0, 7);
}

function monthKeyFromPeriodKey(periodKey: string) {
  const key = String(periodKey || "").trim();
  if (/^\d{4}-\d{2}$/.test(key)) return key;
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return key.slice(0, 7);
  return "";
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

type SalesAssistEventKind = "on" | "off";
type SalesAssistWorkspaceEvent = {
  atMs: number;
  kind: SalesAssistEventKind;
};

async function loadSalesAssistWorkspaceEventsByWorkspaceId(): Promise<Map<string, SalesAssistWorkspaceEvent[]>> {
  const salesPipelineStageIds = Array.from(
    new Set(
      String(process.env.INCLUDED_DEALSTAGE || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );

  const workspaceProp = String(process.env.DEAL_WORKSPACE_ID_PROP || "workspace_id").trim() || "workspace_id";
  const workspacePropCandidates = Array.from(
    new Set(
      [
        workspaceProp,
        workspaceProp.endsWith("__c") ? workspaceProp.slice(0, -3) : `${workspaceProp}__c`,
        "workspace_id",
        "workspace_id__c",
      ]
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );

  const out = new Map<string, SalesAssistWorkspaceEvent[]>();
  const onMatches = await fetchSalesAssistDealMatches();
  for (const match of onMatches) {
    const workspaceId = normalizeWorkspaceId(match.workspaceId);
    const atMs = Number(match.closedAtMs);
    if (!workspaceId || !Number.isFinite(atMs)) continue;
    if (!out.has(workspaceId)) out.set(workspaceId, []);
    out.get(workspaceId)?.push({ atMs, kind: "on" });
  }

  for (const stageId of salesPipelineStageIds) {
    let deals: Awaited<ReturnType<typeof fetchDealsInStage>> = [];
    let fetched = false;
    for (const workspaceField of workspacePropCandidates) {
      try {
        deals = await fetchDealsInStage([workspaceField, "closedate"], stageId);
        fetched = true;
        break;
      } catch (error) {
        if (isUnknownPropertyError(error)) continue;
        throw error;
      }
    }
    if (!fetched) continue;

    for (const deal of deals || []) {
      const properties = (deal.properties || {}) as Record<string, unknown>;
      const workspaceId = normalizeWorkspaceId(
        workspacePropCandidates
          .map((key) => String(properties[key] ?? "").trim())
          .find((value) => !!value) || "",
      );
      if (!workspaceId) continue;
      const atMs = parseHubspotTimestampMs(properties.closedate);
      if (!Number.isFinite(atMs)) continue;
      if (!out.has(workspaceId)) out.set(workspaceId, []);
      out.get(workspaceId)?.push({ atMs, kind: "off" });
    }
  }

  for (const events of out.values()) {
    events.sort((a, b) => {
      if (a.atMs !== b.atMs) return a.atMs - b.atMs;
      if (a.kind === b.kind) return 0;
      return a.kind === "on" ? -1 : 1;
    });
  }

  return out;
}

function buildSalesAssistMonthMap(
  eventsByWorkspaceId: Map<string, SalesAssistWorkspaceEvent[]>,
  periodKeys: string[],
) {
  const monthKeys = Array.from(
    new Set(
      periodKeys
        .map((periodKey) => monthKeyFromPeriodKey(periodKey))
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b));
  const out = new Map<string, Map<string, boolean>>();
  if (!monthKeys.length) return out;

  for (const [workspaceId, events] of eventsByWorkspaceId.entries()) {
    let active = false;
    let idx = 0;
    const activeByMonth = new Map<string, boolean>();
    for (const monthKey of monthKeys) {
      while (idx < events.length) {
        const eventMonth = monthKeyFromTimestampMs(events[idx].atMs);
        if (!eventMonth || eventMonth > monthKey) break;
        active = events[idx].kind === "on";
        idx += 1;
      }
      activeByMonth.set(monthKey, active);
    }
    out.set(workspaceId, activeByMonth);
  }
  return out;
}

function buildSalesAssistByPeriodForWorkspaceSet(
  workspaceIds: Iterable<string>,
  periods: Array<{ key: string }>,
  salesAssistByWorkspaceMonth: Map<string, Map<string, boolean>>,
): Record<string, "yes" | "no"> {
  const out: Record<string, "yes" | "no"> = {};
  for (const period of periods) {
    const monthKey = monthKeyFromPeriodKey(period.key);
    let isYes = false;
    if (monthKey) {
      for (const workspaceId of workspaceIds) {
        const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
        if (!normalizedWorkspaceId) continue;
        if (salesAssistByWorkspaceMonth.get(normalizedWorkspaceId)?.get(monthKey)) {
          isYes = true;
          break;
        }
      }
    }
    out[period.key] = isYes ? "yes" : "no";
  }
  return out;
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
        matchedStripeWorkspaceIds: new Set<string>(),
        deskEarlyAccessByPeriod: {},
        hubspotValuesByPeriod: {},
        stripeValuesByPeriod: {},
        valuesByPeriod: {},
        hubspotPlansByPeriod: {},
        stripePlansByPeriod: {},
        plansByPeriod: {},
      });
    }

    const entry = accounts.get(key)!;
    if (!entry.accountId && rawAccountId) entry.accountId = rawAccountId;
    if (!entry.accountName && row.accountName) entry.accountName = String(row.accountName || "").trim();

    for (const period of periods) {
      const value = round2(Number(row.valuesByPeriod?.[period.key] || 0));
      entry.hubspotValuesByPeriod[period.key] = round2((entry.hubspotValuesByPeriod[period.key] || 0) + value);
      entry.valuesByPeriod[period.key] = round2((entry.valuesByPeriod[period.key] || 0) + value);
      entry.deskEarlyAccessByPeriod[period.key] = entry.deskEarlyAccessByPeriod[period.key] || "no";
      if (value > 0 && isDeskEarlyAccessRow(row)) {
        entry.deskEarlyAccessByPeriod[period.key] = "yes";
      }
      if (value > 0) {
        const plan = normalizeHubspotPlan(row.plan);
        entry.hubspotPlansByPeriod[period.key] = betterPlan(entry.hubspotPlansByPeriod[period.key], plan);
        entry.plansByPeriod[period.key] = betterPlan(entry.plansByPeriod[period.key], plan);
      } else {
        entry.hubspotPlansByPeriod[period.key] = entry.hubspotPlansByPeriod[period.key] || "free";
        entry.plansByPeriod[period.key] = entry.plansByPeriod[period.key] || "free";
      }
    }

    for (const companyId of accountCompanyIds(rawAccountId)) {
      entry.companyIds.add(companyId);
      if (!companyIdToAccountKey.has(companyId)) companyIdToAccountKey.set(companyId, key);
    }
  }

  return { periods, accounts, companyIdToAccountKey };
}

function summarizeErrorMessage(error: unknown) {
  if (error instanceof Error) return String(error.message || "Unknown error");
  return "Unknown error";
}

async function attachStripeKeysFromHubspotContacts(
  accounts: Map<string, HubspotAccountAggregate>,
  companyIdToAccountKey: Map<string, string>,
  stripeCustomers: Map<string, StripeCustomerAggregate>,
  excludeCustomerKeys?: Set<string>,
) {
  const candidateEmails = Array.from(stripeCustomers.keys()).filter(
    (key) => key.includes("@") && !excludeCustomerKeys?.has(key),
  );
  if (!candidateEmails.length) return;

  const companyEmails = await fetchCompanyIdsForContactEmails(candidateEmails);
  for (const [companyId, emails] of companyEmails.entries()) {
    const accountKey = companyIdToAccountKey.get(String(companyId || "").trim());
    if (!accountKey) continue;
    const account = accounts.get(accountKey);
    if (!account) continue;
    for (const email of emails) {
      const normalized = normalizeStripeKey(email);
      if (normalized) account.stripeKeys.add(normalized);
    }
  }
}

function buildStripeCustomerMap(
  arrRows: StripeThroughMrrCustomerArrRow[],
  planRows: StripeThroughMrrCustomerPlanRow[] = [],
) {
  const customers = new Map<string, StripeCustomerAggregate>();
  const aliasesToCustomerKey = new Map<string, string>();

  for (const row of arrRows || []) {
    const key = normalizeStripeKey(row.customerKey);
    if (!key) continue;

    if (!customers.has(key)) {
      customers.set(key, {
        customerKey: key,
        matchingKeys: new Set<string>([key]),
        workspaceIds: new Set<string>(),
        valuesByPeriod: {},
        plansByPeriod: {},
      });
    }

    const bucket = customers.get(key)!;
    aliasesToCustomerKey.set(key, key);
    for (const workspaceId of row.workspaceIds || []) {
      const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
      if (normalizedWorkspaceId) bucket.workspaceIds.add(normalizedWorkspaceId);
    }
    const periodKey = String(row.periodKey || "").trim();
    if (!periodKey) continue;
    const arr = round2(Number(row.arr || 0));
    bucket.valuesByPeriod[periodKey] = round2((bucket.valuesByPeriod[periodKey] || 0) + arr);
  }

  for (const row of planRows || []) {
    const key = normalizeStripeKey(row.customerKey);
    if (!key) continue;
    if (!customers.has(key)) {
      customers.set(key, {
        customerKey: key,
        matchingKeys: new Set<string>([key]),
        workspaceIds: new Set<string>(),
        valuesByPeriod: {},
        plansByPeriod: {},
      });
    }

    const bucket = customers.get(key)!;
    aliasesToCustomerKey.set(key, key);
    for (const workspaceId of row.workspaceIds || []) {
      const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
      if (normalizedWorkspaceId) bucket.workspaceIds.add(normalizedWorkspaceId);
    }
    const periodKey = String(row.periodKey || "").trim();
    if (!periodKey) continue;
    const plan = normalizeCombinedPlan(String(row.plan || "free"));
    bucket.plansByPeriod[periodKey] = betterPlan(bucket.plansByPeriod[periodKey], plan);
  }

  return { customers, aliasesToCustomerKey };
}

function arrRowsFromPlanRows(planRows: StripeThroughMrrCustomerPlanRow[]): StripeThroughMrrCustomerArrRow[] {
  return (planRows || []).map((row) => ({
    customerKey: row.customerKey,
    customerIds: row.customerIds || [],
    workspaceIds: row.workspaceIds || [],
    periodKey: row.periodKey,
    periodLabel: row.periodLabel,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    arr: round2(Number(row.arr || 0)),
  }));
}

function mergeStripeIntoHubspotAccounts(
  periods: Array<{ key: string; label: string }>,
  accounts: Map<string, HubspotAccountAggregate>,
  stripeCustomers: Map<string, StripeCustomerAggregate>,
  aliasesToCustomerKey: Map<string, string>,
  claimedStripeCustomerKeys: Set<string> = new Set<string>(),
) {
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
      for (const workspaceId of stripeCustomer.workspaceIds) {
        account.matchedStripeWorkspaceIds.add(workspaceId);
      }

      for (const period of periods) {
        const value = round2(Number(stripeCustomer.valuesByPeriod[period.key] || 0));
        account.stripeValuesByPeriod[period.key] = round2((account.stripeValuesByPeriod[period.key] || 0) + value);
        account.valuesByPeriod[period.key] = round2((account.valuesByPeriod[period.key] || 0) + value);
        const stripePlan = stripeCustomer.plansByPeriod[period.key] || "free";
        account.stripePlansByPeriod[period.key] = betterPlan(account.stripePlansByPeriod[period.key], stripePlan);
        account.plansByPeriod[period.key] = betterPlan(
          account.hubspotPlansByPeriod[period.key],
          account.stripePlansByPeriod[period.key],
        );
      }
    }
  }

  return claimedStripeCustomerKeys;
}

function mergeStripeIntoHubspotAccountsByWorkspace(
  periods: Array<{ key: string; label: string }>,
  accounts: Map<string, HubspotAccountAggregate>,
  stripeCustomers: Map<string, StripeCustomerAggregate>,
  claimedStripeCustomerKeys: Set<string> = new Set<string>(),
) {
  const workspaceIdToAccountKey = new Map<string, string>();
  for (const account of accounts.values()) {
    for (const companyId of account.companyIds) {
      const normalizedCompanyId = normalizeWorkspaceId(companyId);
      if (!normalizedCompanyId) continue;
      if (!workspaceIdToAccountKey.has(normalizedCompanyId)) {
        workspaceIdToAccountKey.set(normalizedCompanyId, account.accountKey);
      }
    }
  }

  const sortedStripeCustomers = Array.from(stripeCustomers.entries()).sort(([a], [b]) => a.localeCompare(b));
  for (const [customerKey, stripeCustomer] of sortedStripeCustomers) {
    if (claimedStripeCustomerKeys.has(customerKey)) continue;
    const matchedAccountKeys = Array.from(
      new Set(
        Array.from(stripeCustomer.workspaceIds)
          .map((workspaceId) => workspaceIdToAccountKey.get(normalizeWorkspaceId(workspaceId)))
          .filter((value): value is string => Boolean(value)),
      ),
    ).sort((a, b) => a.localeCompare(b));
    if (!matchedAccountKeys.length) continue;
    const account = accounts.get(matchedAccountKeys[0]);
    if (!account) continue;

    claimedStripeCustomerKeys.add(customerKey);
    for (const matchingKey of stripeCustomer.matchingKeys) {
      account.matchedStripeKeys.add(matchingKey);
    }
    for (const workspaceId of stripeCustomer.workspaceIds) {
      account.matchedStripeWorkspaceIds.add(workspaceId);
    }
    for (const period of periods) {
      const value = round2(Number(stripeCustomer.valuesByPeriod[period.key] || 0));
      account.stripeValuesByPeriod[period.key] = round2((account.stripeValuesByPeriod[period.key] || 0) + value);
      account.valuesByPeriod[period.key] = round2((account.valuesByPeriod[period.key] || 0) + value);
      const stripePlan = stripeCustomer.plansByPeriod[period.key] || "free";
      account.stripePlansByPeriod[period.key] = betterPlan(account.stripePlansByPeriod[period.key], stripePlan);
      account.plansByPeriod[period.key] = betterPlan(
        account.hubspotPlansByPeriod[period.key],
        account.stripePlansByPeriod[period.key],
      );
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

function sortRowsForDisplay(
  periods: Array<{ key: string }>,
  rows: CombinedAllSubsRow[],
  displayMode: CombinedAllSubsDisplayMode,
) {
  if (displayMode === "plan") {
    const latestKey = periods.length ? periods[periods.length - 1].key : "";
    return [...rows].sort((a, b) => {
      const aPlan = normalizeCombinedPlan(a.plansByPeriod?.[latestKey] || "free");
      const bPlan = normalizeCombinedPlan(b.plansByPeriod?.[latestKey] || "free");
      const rankDiff = PLAN_RANK[bPlan] - PLAN_RANK[aPlan];
      if (rankDiff !== 0) return rankDiff;
      return a.customerLabel.localeCompare(b.customerLabel);
    });
  }
  return [...rows].sort((a, b) => {
    const diff = latestPeriodValue(periods, b.valuesByPeriod) - latestPeriodValue(periods, a.valuesByPeriod);
    if (Math.abs(diff) > 1e-9) return diff;
    return a.customerLabel.localeCompare(b.customerLabel);
  });
}

function ensurePlanDefaults(
  periods: Array<{ key: string; label: string }>,
  plansByPeriod: Record<string, CombinedAllSubsPlan>,
) {
  for (const period of periods) {
    plansByPeriod[period.key] = plansByPeriod[period.key] || "free";
  }
}

function applyNonZeroPaygoFallback(
  periods: Array<{ key: string; label: string }>,
  valuesByPeriod: Record<string, number>,
  plansByPeriod: Record<string, CombinedAllSubsPlan>,
) {
  for (const period of periods) {
    const key = period.key;
    const value = round2(Number(valuesByPeriod[key] || 0));
    const plan = normalizeCombinedPlan(plansByPeriod[key] || "free");
    if (value > 0 && plan === "free") {
      plansByPeriod[key] = "pay_as_you_go";
    }
  }
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
  const displayMode = normalizeDisplayMode(request.displayMode);
  const planGrain = normalizePlanGrain(request.planGrain);
  const includePlanData = Boolean(request.includePlanData);
  const groupedMatchStrategy = normalizeGroupedMatchStrategy(request.groupedMatchStrategy);
  const includeSalesAssist = request.includeSalesAssist !== false;
  const target = targetCurrency();
  const needsPlanRows = displayMode === "plan" || includePlanData;
  const canReusePlanQueryForArr = displayMode === "arr" && includePlanData;

  const hubspotPromise = generateReport({
    startDate,
    endDate,
    mode: "contracted",
    grain: planGrain,
  });
  const stripePlanPromise: Promise<StripeThroughMrrCustomerPlanResult | null> = needsPlanRows
    ? queryStripeThroughMrrCustomerPlanFromBigQuery(
        {
          startDate,
          endDate,
          targetCurrency: target,
          grain: planGrain,
        },
        STRIPE_QUERY_OPTIONS,
      )
    : Promise.resolve(null);
  const stripeArrPromise: Promise<StripeThroughMrrCustomerArrResult | null> =
    displayMode === "arr" && !canReusePlanQueryForArr
      ? queryStripeThroughMrrCustomerArrFromBigQuery(
          {
            startDate,
            endDate,
            targetCurrency: target,
            grain: planGrain,
          },
          STRIPE_QUERY_OPTIONS,
        )
      : Promise.resolve(null);

  const [hubspotReport, stripeCustomerPlan, stripeCustomerArr] = await Promise.all([
    hubspotPromise,
    stripePlanPromise,
    stripeArrPromise,
  ]);

  const stripeArrRows: StripeThroughMrrCustomerArrRow[] =
    stripeCustomerArr?.rows || (canReusePlanQueryForArr ? arrRowsFromPlanRows(stripeCustomerPlan?.rows || []) : []);
  const stripePlanRows: StripeThroughMrrCustomerPlanRow[] = stripeCustomerPlan?.rows || [];

  const { periods, accounts, companyIdToAccountKey } = buildHubspotAccountMap(hubspotReport);
  const latestPeriodKey = periods.length ? periods[periods.length - 1].key : "";
  const { customers: stripeCustomers, aliasesToCustomerKey } = buildStripeCustomerMap(
    stripeArrRows,
    stripePlanRows,
  );
  const warnings: string[] = [];
  let salesAssistByWorkspaceMonth = new Map<string, Map<string, boolean>>();
  if (includeSalesAssist) {
    try {
      const eventsByWorkspaceId = await loadSalesAssistWorkspaceEventsByWorkspaceId();
      salesAssistByWorkspaceMonth = buildSalesAssistMonthMap(
        eventsByWorkspaceId,
        periods.map((period) => period.key),
      );
    } catch (error: unknown) {
      warnings.push(
        `Sales-assist flag is temporarily unavailable. Cause: ${summarizeErrorMessage(error)}`,
      );
    }
  }
  let effectiveCombineMode: CombinedAllSubsCombineMode = combineMode;
  let matchedStripeCustomerKeys = new Set<string>();

  if (combineMode === "grouped") {
    try {
      matchedStripeCustomerKeys = mergeStripeIntoHubspotAccountsByWorkspace(
        periods,
        accounts,
        stripeCustomers,
        matchedStripeCustomerKeys,
      );
      if (groupedMatchStrategy === "full") {
        await attachStripeKeysFromHubspotContacts(
          accounts,
          companyIdToAccountKey,
          stripeCustomers,
          matchedStripeCustomerKeys,
        );
        matchedStripeCustomerKeys = mergeStripeIntoHubspotAccounts(
          periods,
          accounts,
          stripeCustomers,
          aliasesToCustomerKey,
          matchedStripeCustomerKeys,
        );
      }
    } catch (error: unknown) {
      effectiveCombineMode = "simple";
      warnings.push(
        `Grouped matching is temporarily unavailable. Showing Simple mode results instead. Cause: ${summarizeErrorMessage(error)}`,
      );
    }
  }

  const rows: CombinedAllSubsRow[] = [];
  for (const account of accounts.values()) {
    const salesAssistByPeriod = buildSalesAssistByPeriodForWorkspaceSet(
      account.matchedStripeWorkspaceIds,
      periods,
      salesAssistByWorkspaceMonth,
    );
    rows.push({
      id: `hubspot:${account.accountKey}`,
      source: "hubspot_account",
      customerLabel: customerLabel(account.accountName, account.accountId),
      accountId: account.accountId,
      accountName: account.accountName,
      salesAssist: (latestPeriodKey && salesAssistByPeriod[latestPeriodKey]) || "no",
      salesAssistByPeriod,
      deskEarlyAccessByPeriod: account.deskEarlyAccessByPeriod,
      stripeKeys: Array.from(account.stripeKeys).sort(),
      matchedStripeKeys: Array.from(account.matchedStripeKeys).sort(),
      hubspotValuesByPeriod: account.hubspotValuesByPeriod,
      stripeValuesByPeriod: account.stripeValuesByPeriod,
      valuesByPeriod: account.valuesByPeriod,
      hubspotPlansByPeriod: account.hubspotPlansByPeriod,
      stripePlansByPeriod: account.stripePlansByPeriod,
      plansByPeriod: account.plansByPeriod,
    });
  }

  for (const [customerKey, stripeCustomer] of stripeCustomers.entries()) {
    if (effectiveCombineMode === "grouped" && matchedStripeCustomerKeys.has(customerKey)) continue;

    const valuesByPeriod: Record<string, number> = {};
    const plansByPeriod: Record<string, CombinedAllSubsPlan> = {};
    for (const period of periods) {
      valuesByPeriod[period.key] = round2(Number(stripeCustomer.valuesByPeriod[period.key] || 0));
      plansByPeriod[period.key] = stripeCustomer.plansByPeriod[period.key] || "free";
    }
    ensurePlanDefaults(periods, plansByPeriod);

    const salesAssistByPeriod = buildSalesAssistByPeriodForWorkspaceSet(
      stripeCustomer.workspaceIds,
      periods,
      salesAssistByWorkspaceMonth,
    );
    rows.push({
      id: `stripe:${customerKey}`,
      source: "stripe_only_customer",
      customerLabel: customerKey,
      accountId: "",
      accountName: "",
      salesAssist: (latestPeriodKey && salesAssistByPeriod[latestPeriodKey]) || "no",
      salesAssistByPeriod,
      stripeKeys: Array.from(stripeCustomer.matchingKeys).sort(),
      matchedStripeKeys: [],
      hubspotValuesByPeriod: {},
      stripeValuesByPeriod: valuesByPeriod,
      valuesByPeriod,
      hubspotPlansByPeriod: Object.fromEntries(periods.map((period) => [period.key, "free"])) as Record<string, CombinedAllSubsPlan>,
      stripePlansByPeriod: plansByPeriod,
      plansByPeriod,
    });
  }

  for (const row of rows) {
    row.hubspotPlansByPeriod = row.hubspotPlansByPeriod || {};
    row.stripePlansByPeriod = row.stripePlansByPeriod || {};
    row.plansByPeriod = row.plansByPeriod || {};
    applyNonZeroPaygoFallback(periods, row.hubspotValuesByPeriod, row.hubspotPlansByPeriod);
    applyNonZeroPaygoFallback(periods, row.stripeValuesByPeriod, row.stripePlansByPeriod);
    applyNonZeroPaygoFallback(periods, row.valuesByPeriod, row.plansByPeriod);
    ensurePlanDefaults(periods, row.hubspotPlansByPeriod);
    ensurePlanDefaults(periods, row.stripePlansByPeriod);
    ensurePlanDefaults(periods, row.plansByPeriod);
  }

  const sortedRows = sortRowsForDisplay(periods, rows, displayMode);

  const totalsByPeriod = periods.map((period) => ({
    key: period.key,
    label: period.label,
    total:
      displayMode === "arr"
        ? round2(
            sortedRows.reduce((sum, row) => sum + Number(row.valuesByPeriod[period.key] || 0), 0),
          )
        : sortedRows.reduce(
            (sum, row) => sum + ((row.plansByPeriod?.[period.key] || "free") === "free" ? 0 : 1),
            0,
          ),
  }));

  return {
    startDate,
    endDate,
    combineMode: effectiveCombineMode,
    displayMode,
    planGrain,
    targetCurrency: String(target || "USD").toUpperCase(),
    warnings,
    periods,
    totalsByPeriod,
    rows: sortedRows,
    summary: {
      hubspotAccounts: sortedRows.filter((row) => row.source === "hubspot_account").length,
      hubspotAccountsWithStripeMatch:
        effectiveCombineMode === "grouped"
          ? sortedRows.filter((row) => row.source === "hubspot_account" && row.matchedStripeKeys.length > 0).length
          : 0,
      stripeCustomers: stripeCustomers.size,
      stripeCustomersMatched: effectiveCombineMode === "grouped" ? matchedStripeCustomerKeys.size : 0,
      stripeCustomersOnly:
        effectiveCombineMode === "grouped"
          ? sortedRows.filter((row) => row.source === "stripe_only_customer").length
          : stripeCustomers.size,
    },
  };
}
