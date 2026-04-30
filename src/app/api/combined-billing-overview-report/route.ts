import { getToken } from "next-auth/jwt";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { generateReport } from "@/lib/report";
import type { ReportResponse, ReportRow } from "@/lib/types";
import { fetchDealsInStageClosedBetween } from "@/lib/hubspot";
import {
  queryStripeAiSpendFromBigQuery,
  queryStripeAiSpendCurrentMonthFromUpcomingFromBigQuery,
  queryStripeAiSpendDailyAnnualizedFromUpcomingSnapshotsFromBigQuery,
  queryStripeBillingOverviewFromBigQuery,
  queryStripeLatestUpcomingSnapshotDateFromBigQuery,
  type StripeBillingOverviewPoint,
  type StripeBillingOverviewCustomerArrRow,
} from "@/lib/stripeBigquery";
import {
  type EnterprisePrepaidAiSpendExclusionRow,
  resolveEnterprisePrepaidAiSpendCurrentMonthCarryForwardOffsets,
  resolveEnterprisePrepaidAiSpendExclusions,
} from "@/lib/aiSpendEnterprisePrepaidExclusions";
import {
  generateCombinedAllSubsReport,
  type CombinedAllSubsResponse,
} from "@/lib/combinedAllSubsReport";
import { queryBambooHrFullTimeRosterByDate } from "@/lib/bamboohr";
import { fetchQuickBooksSalesMarketingCostsByMonth } from "@/lib/quickbooks";
import { loadQuickBooksCacDefaultSelection } from "@/lib/quickbooksCacDefaultsStore";
import {
  getMonthlyAverageCurrencyLayerFxRateForCloseMonth,
  getMonthlyAverageFxRateForCloseMonth,
} from "@/lib/fx";
import { FX_TARGET_CURRENCY, parseDate } from "@/lib/logic";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 300;
const CACHE_TTL_MS = readTtlMs("API_COMBINED_BILLING_OVERVIEW_CACHE_TTL_MS", 24 * 60 * 60 * 1000);
const AI_SPEND_EXCLUSIONS_CACHE_TTL_MS = readTtlMs("API_STRIPE_AI_SPEND_EXCLUSIONS_CACHE_TTL_MS", 24 * 60 * 60 * 1000);
const SALES_CYCLE_CACHE_TTL_MS = readTtlMs("API_COMBINED_BILLING_OVERVIEW_SALES_CYCLE_CACHE_TTL_MS", 24 * 60 * 60 * 1000);
const SUBQUERY_CACHE_TTL_MS = readTtlMs("API_COMBINED_BILLING_OVERVIEW_SUBQUERY_CACHE_TTL_MS", 24 * 60 * 60 * 1000);
const MONTHLY_CANONICAL_START_DATE = (() => {
  const configured = String(process.env.COMBINED_BILLING_OVERVIEW_MONTHLY_CACHE_START || "2023-01-01").trim();
  return isIsoDate(configured) ? configured : "2023-01-01";
})();
const AI_SPEND_UPCOMING_PRODUCT_TERMS = ["ai tokens", "web search and crawl"];

type CombinedGrain = "daily" | "monthly" | "quarterly";
type CacFxProvider = "frankfurter" | "currencylayer";

type CombinedPoint = {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  mrrEnd: number;
  newMrr: number;
  expansionMrr: number;
  contractionMrr: number;
  churnMrr: number;
  netMrrChange: number;
  mrrGrowthRatePct: number;
  ndrPct: number;
  gdrPct: number;
  arr: number;
  arrGrowth: number;
};

type LineSourcePoints = {
  salesled: CombinedPoint[];
  selfserve: CombinedPoint[];
  aiSpend: CombinedPoint[];
};

type PeriodRef = {
  key: string;
  label: string;
};

type RetentionSeriesPoint = {
  key: string;
  label: string;
  selfserveGdrPct: number;
  salesledGdrPct: number;
  combinedGdrPct: number;
  selfserveNdrPct: number;
  salesledNdrPct: number;
  combinedNdrPct: number;
};

type CacPoint = {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  salesMarketingCost: number;
  newCustomerCount: number;
  cac: number;
  accountCostsByAccountId?: Record<string, number>;
};

type LtvPoint = {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  totalArr: number;
  activeCustomers: number;
  churnedCustomers: number;
  arpuMonthly: number;
  churnRatePct: number;
  ltv: number;
};

type ArrPerEmployeePoint = {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  arr: number;
  fullTimeEmployees: number;
  arrPerEmployee: number;
  employeeNames: string[];
};

type SalesCyclePoint = {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  avgSalesCycleDays: number;
  closedWonDealCount: number;
};

type LogoChurnCounts = {
  prevActive: number;
  churned: number;
};

type CombinedLtvUserCounts = {
  activeByPeriod: Map<string, number>;
  logoChurnByPeriod: Map<string, LogoChurnCounts>;
};

type AiSpendSeriesBuildResult = {
  points: CombinedPoint[];
  monthlyArrByPeriod: Map<string, number>;
  initialPrevMrr: number;
};

type AiSpendDailyPointBreakdown = {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  aiSpendWithoutExclusions: number;
  aiSpendWithExclusions: number;
  aiSpendExcluded: number;
};

type QuickBooksSalesMarketingCostPoint = {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  totalCost: number;
  matchedAccounts: string[];
  accountCostsByAccountId?: Record<string, number>;
  costByCurrency?: Record<string, number>;
};

type QuickBooksSalesMarketingCostResponse = {
  realmId: string;
  accountMatchMode: "selected_accounts" | "department" | "exact_names" | "keywords";
  selectedAccountIds?: string[];
  departmentIds?: string[];
  departmentNames?: string[];
  matchedDepartments?: Array<{ id: string; name: string }>;
  accountNames: string[];
  keywords: string[];
  accountingMethod: string;
  currency: string;
  currencies?: string[];
  realmCurrencyByRealmId?: Record<string, string>;
  accountCurrencyByAccountId?: Record<string, string>;
  points: QuickBooksSalesMarketingCostPoint[];
  matchedAccounts: string[];
};

type FxConversionDiagnostics = {
  provider: CacFxProvider;
  targetCurrency: string;
  requestedPairCount: number;
  zeroRatePairCount: number;
  rateLimitedPairCount: number;
  rawFallbackPairCount: number;
};

type ConvertedQuickBooksSalesMarketingCostsWithFx = {
  payload: QuickBooksSalesMarketingCostResponse;
  diagnostics: FxConversionDiagnostics;
};

type RequestBody = {
  startDate?: string;
  endDate?: string;
  grain?: string;
  accountIds?: string[];
  accountNames?: string[];
  includeCac?: boolean;
};

function round2(n: number) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function parseIsoDateOnly(value: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}

function toIsoDateOnly(d: Date) {
  return d.toISOString().slice(0, 10);
}

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeEntityId(value: string) {
  return String(value || "").trim().replace(/\.0+$/, "");
}

function normalizeIdList(values: unknown) {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => normalizeEntityId(String(value || "")))
        .filter(Boolean),
    ),
  );
}

function normalizeNames(values: unknown) {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

function previousPeriodRangeForGrain(startDate: string, grain: CombinedGrain) {
  const parsed = parseIsoDateOnly(startDate);
  if (!parsed) return { startDate, endDate: startDate };

  if (grain === "daily") {
    const prevDay = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate() - 1));
    const iso = toIsoDateOnly(prevDay);
    return { startDate: iso, endDate: iso };
  }

  if (grain === "monthly") {
    const prevMonthStart = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() - 1, 1));
    const prevMonthEnd = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), 0));
    return { startDate: toIsoDateOnly(prevMonthStart), endDate: toIsoDateOnly(prevMonthEnd) };
  }

  const qStartMonth = Math.floor(parsed.getUTCMonth() / 3) * 3;
  const prevQuarterStart = new Date(Date.UTC(parsed.getUTCFullYear(), qStartMonth - 3, 1));
  const prevQuarterEnd = new Date(Date.UTC(parsed.getUTCFullYear(), qStartMonth, 0));
  return { startDate: toIsoDateOnly(prevQuarterStart), endDate: toIsoDateOnly(prevQuarterEnd) };
}

function buildPeriodKeySetForRange(startDate: string, endDate: string, grain: CombinedGrain) {
  const start = parseIsoDateOnly(startDate);
  const end = parseIsoDateOnly(endDate);
  const out = new Set<string>();
  if (!start || !end || end.getTime() < start.getTime()) return out;

  if (grain === "daily") {
    for (
      let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
      cursor.getTime() <= end.getTime();
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() + 1))
    ) {
      out.add(toIsoDateOnly(cursor));
    }
    return out;
  }

  if (grain === "monthly") {
    for (
      let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
      cursor.getTime() <= end.getTime();
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))
    ) {
      out.add(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    }
    return out;
  }

  for (
    let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    cursor.getTime() <= end.getTime();
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))
  ) {
    const quarter = Math.floor(cursor.getUTCMonth() / 3) + 1;
    out.add(`${cursor.getUTCFullYear()}-Q${quarter}`);
  }
  return out;
}

function sliceReportByPeriodKeys(report: ReportResponse, keepKeys: Set<string>): ReportResponse {
  const periods = (report.periods || []).filter((period) => keepKeys.has(String(period.key || "")));
  const rows = (report.rows || []).map((row) => {
    const nextValuesByPeriod: Record<string, number> = {};
    for (const period of periods) {
      const key = String(period.key || "");
      nextValuesByPeriod[key] = Number(row.valuesByPeriod?.[key] || 0);
    }
    return {
      ...row,
      valuesByPeriod: nextValuesByPeriod,
    };
  });
  const totalsByPeriod = periods.map((period) => {
    const key = String(period.key || "");
    const total = round2(rows.reduce((sum, row) => sum + Number(row.valuesByPeriod?.[key] || 0), 0));
    return {
      key,
      label: String(period.label || key),
      total,
    };
  });
  return { periods, rows, totalsByPeriod };
}

function isCloudDeploymentType(value: string) {
  return String(value || "").trim().toLowerCase() === "cloud";
}

function hasAnyNonZeroValue(valuesByPeriod: Record<string, number>) {
  return Object.values(valuesByPeriod || {}).some((value) => Math.abs(Number(value) || 0) > 1e-9);
}

function accountGroupingKey(row: { accountId: string }) {
  const raw = String(row.accountId || "").trim();
  if (raw) {
    const numericToken =
      raw
        .split(/[,\s;|]+/)
        .map((part) => part.trim())
        .find((part) => /^\d+$/.test(part)) || "";
    if (numericToken) return numericToken;
    return raw.toLowerCase();
  }
  return "";
}

function addAccountPeriodValues(
  accountMap: Map<string, Record<string, number>>,
  accountKey: string,
  valuesByPeriod: Record<string, number>,
  periodOrder: PeriodRef[],
) {
  if (!accountMap.has(accountKey)) accountMap.set(accountKey, {});
  const bucket = accountMap.get(accountKey)!;
  for (const period of periodOrder) {
    bucket[period.key] = round2((bucket[period.key] || 0) + (valuesByPeriod[period.key] || 0));
  }
}

function calculateRetentionRates(prevMrr: number, expansionMrr: number, contractionMrr: number, churnMrr: number) {
  if (Math.abs(prevMrr) <= 1e-9) {
    return { ndrPct: 0, gdrPct: 0 };
  }
  return {
    ndrPct: round2(((prevMrr + expansionMrr + contractionMrr + churnMrr) / prevMrr) * 100),
    gdrPct: round2(((prevMrr + contractionMrr + churnMrr) / prevMrr) * 100),
  };
}

function buildHubPointsFromAccounts(
  periodOrder: PeriodRef[],
  accountArrByPeriod: Map<string, Record<string, number>>,
  baselineAccountArrByAccount: Map<string, number>,
): CombinedPoint[] {
  const totalByPeriodSelected = new Map<string, number>();
  for (const accountTotals of accountArrByPeriod.values()) {
    for (const [periodKey, value] of Object.entries(accountTotals)) {
      totalByPeriodSelected.set(periodKey, round2((totalByPeriodSelected.get(periodKey) || 0) + (value || 0)));
    }
  }

  const baselineArrTotal = round2(
    Array.from(baselineAccountArrByAccount.values()).reduce((acc, value) => acc + value, 0),
  );

  return periodOrder.map((period, idx) => {
    const prevPeriodKey = idx > 0 ? periodOrder[idx - 1].key : "";
    const arr = round2(totalByPeriodSelected.get(period.key) || 0);
    const mrrEnd = round2(arr / 12);
    const prevArr = round2(
      idx === 0
        ? baselineArrTotal
        : prevPeriodKey
          ? totalByPeriodSelected.get(prevPeriodKey) || 0
          : 0,
    );
    const prevMrr = round2(prevArr / 12);
    const arrGrowth = round2(arr - prevArr);
    const mrrGrowthRatePct =
      Math.abs(prevMrr) > 1e-9
        ? round2(((mrrEnd - prevMrr) / Math.abs(prevMrr)) * 100)
        : 0;

    let newMrr = 0;
    let expansionMrr = 0;
    let contractionMrr = 0;
    let churnMrr = 0;

    for (const [accountKey, accountTotals] of accountArrByPeriod.entries()) {
      const currArr = round2(accountTotals[period.key] || 0);
      const prevAccountArr = round2(
        idx === 0
          ? baselineAccountArrByAccount.get(accountKey) || 0
          : prevPeriodKey
            ? accountTotals[prevPeriodKey] || 0
            : 0,
      );
      const diffArr = round2(currArr - prevAccountArr);

      const currHas = Math.abs(currArr) > 1e-9;
      const prevHas = Math.abs(prevAccountArr) > 1e-9;
      if (!currHas && !prevHas) continue;

      if (!prevHas && currHas) {
        newMrr = round2(newMrr + currArr / 12);
        continue;
      }

      if (prevHas && !currHas) {
        churnMrr = round2(churnMrr - prevAccountArr / 12);
        continue;
      }

      if (diffArr > 1e-9) {
        expansionMrr = round2(expansionMrr + diffArr / 12);
      } else if (diffArr < -1e-9) {
        contractionMrr = round2(contractionMrr + diffArr / 12);
      }
    }

    const netMrrChange = round2(newMrr + expansionMrr + contractionMrr + churnMrr);
    const retention = calculateRetentionRates(prevMrr, expansionMrr, contractionMrr, churnMrr);

    return {
      key: period.key,
      label: period.label,
      periodStart: period.key,
      periodEnd: period.key,
      mrrEnd,
      newMrr,
      expansionMrr,
      contractionMrr,
      churnMrr,
      netMrrChange,
      mrrGrowthRatePct,
      ndrPct: retention.ndrPct,
      gdrPct: retention.gdrPct,
      arr,
      arrGrowth,
    };
  });
}

function quarterKeyFromIsoDate(isoDate: string) {
  const parsed = parseIsoDateOnly(isoDate);
  if (!parsed) return "";
  const year = parsed.getUTCFullYear();
  const quarter = Math.floor(parsed.getUTCMonth() / 3) + 1;
  return `${year}-Q${quarter}`;
}

function canonicalHubPeriodKey(periodKey: string, grain: CombinedGrain) {
  const key = String(periodKey || "").trim();
  if (!key) return "";
  if (grain === "daily") return key.slice(0, 10);
  if (grain === "monthly") return key.slice(0, 7);
  const m = /^(\d{4})-Q([1-4])$/i.exec(key);
  if (m) return `${m[1]}-Q${m[2]}`;
  return key;
}

function canonicalStripePeriodKey(point: StripeBillingOverviewPoint, grain: CombinedGrain) {
  if (grain === "daily") return String(point.periodStart || "").slice(0, 10);
  if (grain === "monthly") return String(point.periodStart || "").slice(0, 7);
  return quarterKeyFromIsoDate(String(point.periodStart || ""));
}

function canonicalStripeCustomerPeriodKey(row: StripeBillingOverviewCustomerArrRow, grain: CombinedGrain) {
  const periodStart = String(row.periodStart || "").trim();
  const periodKey = String(row.periodKey || "").trim();
  if (grain === "daily") {
    return (periodStart || periodKey).slice(0, 10);
  }
  if (grain === "monthly") {
    return (periodStart || periodKey).slice(0, 7);
  }
  const fromStart = quarterKeyFromIsoDate(periodStart);
  if (fromStart) return fromStart;
  const quarterKeyMatch = /^(\d{4})-Q([1-4])$/i.exec(periodKey);
  if (quarterKeyMatch) return `${quarterKeyMatch[1]}-Q${quarterKeyMatch[2]}`;
  return periodKey;
}

function periodKeyFromIsoDateForGrain(isoDate: string, grain: CombinedGrain) {
  const normalized = String(isoDate || "").trim();
  if (!normalized) return "";
  if (grain === "daily") return normalized.slice(0, 10);
  if (grain === "monthly") return normalized.slice(0, 7);
  return quarterKeyFromIsoDate(normalized);
}

function periodEndIsoFromKey(periodKey: string, grain: CombinedGrain) {
  const key = String(periodKey || "").trim();
  if (!key) return "";
  if (grain === "daily") {
    return parseIsoDateOnly(key) ? key.slice(0, 10) : "";
  }
  if (grain === "monthly") {
    const m = /^(\d{4})-(\d{2})$/.exec(key);
    if (!m) return "";
    const year = Number(m[1]);
    const month = Number(m[2]) - 1;
    const last = new Date(Date.UTC(year, month + 1, 0));
    return toIsoDateOnly(last);
  }
  const q = /^(\d{4})-Q([1-4])$/i.exec(key);
  if (!q) return "";
  const year = Number(q[1]);
  const quarter = Number(q[2]);
  const endMonth = quarter * 3;
  const last = new Date(Date.UTC(year, endMonth, 0));
  return toIsoDateOnly(last);
}

async function buildMonthlySalesCycleSeries(periodOrder: PeriodRef[], includedDealstage: string): Promise<SalesCyclePoint[]> {
  const monthlyPeriods = periodOrder.map((period) => {
    const key = canonicalHubPeriodKey(period.key, "monthly") || period.key;
    const periodStart = `${key}-01`;
    const periodEnd = periodEndIsoFromKey(key, "monthly") || periodStart;
    return {
      key,
      label: period.label,
      periodStart,
      periodEnd,
    };
  });

  const stage = String(includedDealstage || "").trim();
  if (!stage) {
    return monthlyPeriods.map((period) => ({
      ...period,
      avgSalesCycleDays: 0,
      closedWonDealCount: 0,
    }));
  }

  if (!monthlyPeriods.length) return [];
  const rangeStartIso = monthlyPeriods[0].periodStart;
  const rangeEndIso = monthlyPeriods[monthlyPeriods.length - 1].periodEnd;

  const deals = await getOrSetCache(
    `api:combined-billing-overview:sales-cycle:deals:${stableStringify({
      stage,
      rangeStartIso,
      rangeEndIso,
    })}`,
    SALES_CYCLE_CACHE_TTL_MS,
    () => fetchDealsInStageClosedBetween(["createdate", "closedate"], stage, rangeStartIso, rangeEndIso),
  );
  const millisPerDay = 24 * 60 * 60 * 1000;
  const totalsByMonth = new Map<string, { sumDays: number; count: number }>();
  for (const deal of deals) {
    const properties = deal.properties || {};
    const createdDate = parseDate(properties.createdate);
    const closeDate = parseDate(properties.closedate);
    if (!createdDate || !closeDate) continue;

    const closeIso = [
      String(closeDate.getFullYear()).padStart(4, "0"),
      String(closeDate.getMonth() + 1).padStart(2, "0"),
      String(closeDate.getDate()).padStart(2, "0"),
    ].join("-");
    const monthKey = periodKeyFromIsoDateForGrain(closeIso, "monthly");
    if (!monthKey) continue;

    const cycleDays = (closeDate.getTime() - createdDate.getTime()) / millisPerDay;
    if (!Number.isFinite(cycleDays) || cycleDays < 0) continue;

    const current = totalsByMonth.get(monthKey) || { sumDays: 0, count: 0 };
    current.sumDays += cycleDays;
    current.count += 1;
    totalsByMonth.set(monthKey, current);
  }

  return monthlyPeriods.map((period) => {
    const totals = totalsByMonth.get(period.key);
    const count = totals?.count || 0;
    const avgSalesCycleDays = count > 0 ? round2((totals?.sumDays || 0) / count) : 0;
    return {
      ...period,
      avgSalesCycleDays,
      closedWonDealCount: count,
    };
  });
}

function annualizedArrFromRevenueForPeriod(revenue: number, periodStart: string, periodEnd: string) {
  const start = parseIsoDateOnly(String(periodStart || "").slice(0, 10));
  const end = parseIsoDateOnly(String(periodEnd || "").slice(0, 10));
  if (!start || !end || end.getTime() < start.getTime()) {
    return round2(Number(revenue || 0) * 12);
  }

  const startYear = start.getUTCFullYear();
  const startMonth = start.getUTCMonth();
  const startDay = start.getUTCDate();
  const endYear = end.getUTCFullYear();
  const endMonth = end.getUTCMonth();
  const endDay = end.getUTCDate();
  const endMonthLastDay = new Date(Date.UTC(endYear, endMonth + 1, 0)).getUTCDate();

  // Full calendar month buckets should annualize at exactly 12x.
  if (startDay === 1 && startYear === endYear && startMonth === endMonth && endDay === endMonthLastDay) {
    return round2(Number(revenue || 0) * 12);
  }

  // Full calendar quarter buckets should annualize at exactly 4x.
  const isQuarterStartMonth = startMonth === 0 || startMonth === 3 || startMonth === 6 || startMonth === 9;
  if (
    startDay === 1 &&
    isQuarterStartMonth &&
    endDay === endMonthLastDay &&
    endMonth === startMonth + 2 &&
    endYear === startYear
  ) {
    return round2(Number(revenue || 0) * 4);
  }

  const msPerDay = 24 * 60 * 60 * 1000;
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / msPerDay) + 1);
  return round2((Number(revenue || 0) * 365) / days);
}

function buildAiSpendSourceSeries(
  periodOrder: PeriodRef[],
  grain: CombinedGrain,
  aiSpendPoints: Array<{ periodStart: string; periodEnd: string; revenue: number }>,
  previousPeriodStartDate: string,
): AiSpendSeriesBuildResult {
  const totalsByPeriodKey = new Map<string, { mrr: number; arr: number }>();
  for (const point of aiSpendPoints || []) {
    const key = periodKeyFromIsoDateForGrain(point.periodStart, grain);
    if (!key) continue;
    const arr = annualizedArrFromRevenueForPeriod(Number(point.revenue || 0), point.periodStart, point.periodEnd);
    const mrr = round2(arr / 12);
    const current = totalsByPeriodKey.get(key) || { mrr: 0, arr: 0 };
    totalsByPeriodKey.set(key, {
      mrr: round2(current.mrr + mrr),
      arr: round2(current.arr + arr),
    });
  }

  const previousKey = periodKeyFromIsoDateForGrain(previousPeriodStartDate, grain);
  const initialPrevMrr = previousKey ? round2(totalsByPeriodKey.get(previousKey)?.mrr || 0) : 0;
  const monthlyArrByPeriod = new Map<string, number>();
  const rawPoints: CombinedPoint[] = periodOrder.map((period) => {
    const key = canonicalHubPeriodKey(period.key, grain) || period.key;
    const totals = totalsByPeriodKey.get(key) || { mrr: 0, arr: 0 };
    if (grain === "monthly") {
      monthlyArrByPeriod.set(key, round2(totals.arr));
    }
    const periodStart = grain === "monthly" ? `${key}-01` : key;
    return {
      key,
      label: period.label,
      periodStart,
      periodEnd: periodStart,
      mrrEnd: round2(totals.mrr),
      newMrr: 0,
      expansionMrr: 0,
      contractionMrr: 0,
      churnMrr: 0,
      netMrrChange: 0,
      mrrGrowthRatePct: 0,
      ndrPct: 0,
      gdrPct: 0,
      arr: round2(totals.arr),
      arrGrowth: 0,
    };
  });

  const points: CombinedPoint[] = [];
  for (let idx = 0; idx < rawPoints.length; idx += 1) {
    const point = rawPoints[idx];
    const prevMrr = idx === 0 ? initialPrevMrr : points[idx - 1].mrrEnd;
    const prevArr = round2(prevMrr * 12);
    const netMrrChange = round2(point.mrrEnd - prevMrr);
    const mrrGrowthRatePct =
      Math.abs(prevMrr) > 1e-9 ? round2(((point.mrrEnd - prevMrr) / Math.abs(prevMrr)) * 100) : 0;
    points.push({
      ...point,
      newMrr: netMrrChange,
      netMrrChange,
      mrrGrowthRatePct,
      arrGrowth: round2(point.arr - prevArr),
    });
  }

  return { points, monthlyArrByPeriod, initialPrevMrr };
}

type SourceSegment = "salesled" | "selfserve";
type SourceSegmentAccumulator = {
  prevMrr: number;
  mrrEnd: number;
  newMrr: number;
  expansionMrr: number;
  contractionMrr: number;
  churnMrr: number;
};

function periodStartIsoFromCanonicalKey(periodKey: string, grain: CombinedGrain) {
  const key = String(periodKey || "").trim();
  if (!key) return "";
  if (grain === "daily") return key;
  if (grain === "monthly") return `${key}-01`;
  const quarterMatch = /^(\d{4})-Q([1-4])$/i.exec(key);
  if (!quarterMatch) return key;
  const year = Number(quarterMatch[1]);
  const quarter = Number(quarterMatch[2]);
  const month = (quarter - 1) * 3 + 1;
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function resolveCombinedAllSubsPeriodKey(
  canonicalPeriodKey: string,
  grain: CombinedGrain,
  availablePeriodKeys: Set<string>,
) {
  const canonical = String(canonicalPeriodKey || "").trim();
  if (!canonical) return "";
  if (grain === "daily" || grain === "monthly") {
    return availablePeriodKeys.has(canonical) ? canonical : "";
  }

  const quarterMatch = /^(\d{4})-Q([1-4])$/i.exec(canonical);
  if (!quarterMatch) return "";
  const year = Number(quarterMatch[1]);
  const quarter = Number(quarterMatch[2]);
  const endMonth = quarter * 3;
  const endMonthKey = `${year}-${String(endMonth).padStart(2, "0")}`;
  if (availablePeriodKeys.has(endMonthKey)) return endMonthKey;

  const monthCandidates = Array.from(availablePeriodKeys)
    .filter((key) => /^\d{4}-\d{2}$/.test(key))
    .filter((key) => {
      const m = /^(\d{4})-(\d{2})$/.exec(key);
      if (!m) return false;
      const y = Number(m[1]);
      const month = Number(m[2]);
      return y === year && Math.floor((month - 1) / 3) + 1 === quarter;
    })
    .sort((a, b) => a.localeCompare(b));
  return monthCandidates.length ? monthCandidates[monthCandidates.length - 1] : "";
}

function sourceSegmentForCombinedAllSubsRow(
  row: CombinedAllSubsResponse["rows"][number],
  reportPeriodKey: string,
): SourceSegment {
  if (row.source === "hubspot_account") return "salesled";
  const salesAssistValue =
    row.salesAssistByPeriod?.[reportPeriodKey] ??
    row.salesAssist ??
    "no";
  return String(salesAssistValue || "").trim().toLowerCase() === "yes" ? "salesled" : "selfserve";
}

function applySegmentMovement(
  acc: SourceSegmentAccumulator,
  segment: SourceSegment,
  prevSegment: SourceSegment,
  currSegment: SourceSegment,
  prevArr: number,
  currArr: number,
) {
  const prevHas = Math.abs(prevArr) > 1e-9;
  const currHas = Math.abs(currArr) > 1e-9;
  const prevIn = prevHas && prevSegment === segment;
  const currIn = currHas && currSegment === segment;

  if (prevIn) acc.prevMrr = round2(acc.prevMrr + prevArr / 12);
  if (currIn) acc.mrrEnd = round2(acc.mrrEnd + currArr / 12);

  if (!prevIn && !currIn) return;

  if (!prevIn && currIn) {
    if (!prevHas) {
      acc.newMrr = round2(acc.newMrr + currArr / 12);
    } else {
      acc.expansionMrr = round2(acc.expansionMrr + currArr / 12);
    }
    return;
  }

  if (prevIn && !currIn) {
    acc.churnMrr = round2(acc.churnMrr - prevArr / 12);
    return;
  }

  const diffArr = round2(currArr - prevArr);
  if (diffArr > 1e-9) {
    acc.expansionMrr = round2(acc.expansionMrr + diffArr / 12);
  } else if (diffArr < -1e-9) {
    acc.contractionMrr = round2(acc.contractionMrr + diffArr / 12);
  }
}

function buildSourcePointsFromCombinedAllSubsReport(
  periodOrder: PeriodRef[],
  grain: CombinedGrain,
  previousRange: { startDate: string; endDate: string },
  report: CombinedAllSubsResponse,
) {
  const availablePeriodKeys = new Set((report.periods || []).map((period) => String(period.key || "").trim()).filter(Boolean));
  const periodRefs = periodOrder.map((period) => {
    const canonical = canonicalHubPeriodKey(period.key, grain) || period.key;
    const reportKey = resolveCombinedAllSubsPeriodKey(canonical, grain, availablePeriodKeys);
    return {
      sourceKey: period.key,
      canonicalKey: canonical,
      reportKey,
      label: period.label,
    };
  });

  const previousCanonicalKey = periodKeyFromIsoDateForGrain(previousRange.endDate, grain);
  const previousReportKey = resolveCombinedAllSubsPeriodKey(previousCanonicalKey, grain, availablePeriodKeys);
  const segmentOrder: SourceSegment[] = ["salesled", "selfserve"];
  const bySegment: Record<SourceSegment, CombinedPoint[]> = {
    salesled: [],
    selfserve: [],
  };

  for (let idx = 0; idx < periodRefs.length; idx += 1) {
    const period = periodRefs[idx];
    const prevPeriod = idx > 0 ? periodRefs[idx - 1] : null;
    const prevKey = prevPeriod?.reportKey || previousReportKey;

    const accBySegment: Record<SourceSegment, SourceSegmentAccumulator> = {
      salesled: {
        prevMrr: 0,
        mrrEnd: 0,
        newMrr: 0,
        expansionMrr: 0,
        contractionMrr: 0,
        churnMrr: 0,
      },
      selfserve: {
        prevMrr: 0,
        mrrEnd: 0,
        newMrr: 0,
        expansionMrr: 0,
        contractionMrr: 0,
        churnMrr: 0,
      },
    };

    for (const row of report.rows || []) {
      const currArr = round2(Number(row.valuesByPeriod?.[period.reportKey] || 0));
      const prevArr = round2(Number(row.valuesByPeriod?.[prevKey] || 0));
      const currSegment = sourceSegmentForCombinedAllSubsRow(row, period.reportKey);
      const prevSegment = sourceSegmentForCombinedAllSubsRow(row, prevKey);

      for (const segment of segmentOrder) {
        applySegmentMovement(accBySegment[segment], segment, prevSegment, currSegment, prevArr, currArr);
      }
    }

    const periodStart = periodStartIsoFromCanonicalKey(period.canonicalKey, grain);
    const periodEnd = periodEndIsoFromKey(period.canonicalKey, grain) || periodStart;

    for (const segment of segmentOrder) {
      const acc = accBySegment[segment];
      const prevMrr = round2(acc.prevMrr);
      const mrrEnd = round2(acc.mrrEnd);
      const newMrr = round2(acc.newMrr);
      const expansionMrr = round2(acc.expansionMrr);
      const contractionMrr = round2(acc.contractionMrr);
      const churnMrr = round2(acc.churnMrr);
      const netMrrChange = round2(newMrr + expansionMrr + contractionMrr + churnMrr);
      const mrrGrowthRatePct =
        Math.abs(prevMrr) > 1e-9
          ? round2(((mrrEnd - prevMrr) / Math.abs(prevMrr)) * 100)
          : 0;
      const retention = calculateRetentionRates(prevMrr, expansionMrr, contractionMrr, churnMrr);
      const arr = round2(mrrEnd * 12);
      const arrGrowth = round2(arr - prevMrr * 12);
      bySegment[segment].push({
        key: period.canonicalKey,
        label: period.label,
        periodStart,
        periodEnd,
        mrrEnd,
        newMrr,
        expansionMrr,
        contractionMrr,
        churnMrr,
        netMrrChange,
        mrrGrowthRatePct,
        ndrPct: retention.ndrPct,
        gdrPct: retention.gdrPct,
        arr,
        arrGrowth,
      });
    }
  }

  return bySegment;
}

function mergeCombinedAndAiSeries(
  combinedPoints: CombinedPoint[],
  aiPoints: CombinedPoint[],
  initialPrevCombinedMrr: number,
  initialPrevAiMrr: number,
): CombinedPoint[] {
  const out: CombinedPoint[] = [];
  for (let idx = 0; idx < combinedPoints.length; idx += 1) {
    const combined = combinedPoints[idx];
    const ai = aiPoints[idx];
    const mrrEnd = round2((combined?.mrrEnd || 0) + (ai?.mrrEnd || 0));
    const arr = round2((combined?.arr || 0) + (ai?.arr || 0));
    const prevMrr = idx === 0 ? round2(initialPrevCombinedMrr + initialPrevAiMrr) : out[idx - 1].mrrEnd;
    const prevArr = round2(prevMrr * 12);
    const netMrrChange = round2(mrrEnd - prevMrr);
    const mrrGrowthRatePct =
      Math.abs(prevMrr) > 1e-9 ? round2(((mrrEnd - prevMrr) / Math.abs(prevMrr)) * 100) : 0;
    out.push({
      ...combined,
      mrrEnd,
      arr,
      netMrrChange,
      mrrGrowthRatePct,
      arrGrowth: round2(arr - prevArr),
    });
  }
  return out;
}

function buildCostByMonth(points: QuickBooksSalesMarketingCostPoint[]) {
  const byMonth = new Map<string, number>();
  for (const point of points || []) {
    const key = String(point.key || point.periodStart || "").trim().slice(0, 7);
    if (!key) continue;
    byMonth.set(key, round2((byMonth.get(key) || 0) + Number(point.totalCost || 0)));
  }
  return byMonth;
}

function buildCostByMonthByAccount(points: QuickBooksSalesMarketingCostPoint[]) {
  const byMonthByAccount = new Map<string, Map<string, number>>();
  for (const point of points || []) {
    const monthKey = String(point.key || point.periodStart || "").trim().slice(0, 7);
    if (!monthKey) continue;
    const accountCosts = point.accountCostsByAccountId || {};
    if (!byMonthByAccount.has(monthKey)) byMonthByAccount.set(monthKey, new Map<string, number>());
    const monthBucket = byMonthByAccount.get(monthKey)!;
    for (const [rawAccountId, rawAmount] of Object.entries(accountCosts)) {
      const accountId = normalizeEntityId(String(rawAccountId || ""));
      if (!accountId) continue;
      monthBucket.set(accountId, round2((monthBucket.get(accountId) || 0) + Number(rawAmount || 0)));
    }
  }
  return byMonthByAccount;
}

function buildCacSeries(
  periodOrder: PeriodRef[],
  grain: CombinedGrain,
  costByMonth: Map<string, number>,
  newCustomerCountByPeriod: Map<string, number>,
  costByMonthByAccount?: Map<string, Map<string, number>>,
): CacPoint[] {
  return periodOrder.map((period) => {
    const key = canonicalHubPeriodKey(period.key, grain) || period.key;
    const salesMarketingCost = round2(costByMonth.get(key) || 0);
    const newCustomerCount = newCustomerCountByPeriod.get(key) || 0;
    const cac = newCustomerCount > 0 ? round2(salesMarketingCost / newCustomerCount) : 0;
    const periodStart = grain === "monthly" ? `${key}-01` : key;
    const accountCostsByAccountId =
      costByMonthByAccount && costByMonthByAccount.has(key)
        ? Object.fromEntries(
            Array.from(costByMonthByAccount.get(key)!.entries()).map(([accountId, amount]) => [accountId, round2(amount)]),
          )
        : undefined;
    return {
      key,
      label: period.label,
      periodStart,
      periodEnd: periodStart,
      salesMarketingCost,
      newCustomerCount,
      cac,
      ...(accountCostsByAccountId ? { accountCostsByAccountId } : {}),
    };
  });
}

function buildActiveAccountCountByPeriod(
  periodOrder: PeriodRef[],
  accountArrByPeriod: Map<string, Record<string, number>>,
) {
  const out = new Map<string, number>();
  for (const period of periodOrder) {
    const key = canonicalHubPeriodKey(period.key, "monthly") || period.key;
    let count = 0;
    for (const accountTotals of accountArrByPeriod.values()) {
      if (Math.abs(Number(accountTotals[period.key] || 0)) > 1e-9) count += 1;
    }
    out.set(key, count);
  }
  return out;
}

function buildActiveStripeCustomerCountByPeriod(
  stripeArrByCustomer: Map<string, Map<string, number>>,
) {
  const out = new Map<string, number>();
  for (const valuesByPeriod of stripeArrByCustomer.values()) {
    for (const [periodKey, arr] of valuesByPeriod.entries()) {
      if (Math.abs(Number(arr || 0)) <= 1e-9) continue;
      out.set(periodKey, (out.get(periodKey) || 0) + 1);
    }
  }
  return out;
}

function buildLtvSeries(
  periodOrder: PeriodRef[],
  grain: CombinedGrain,
  combinedPoints: CombinedPoint[],
  activeHubByPeriod: Map<string, number>,
  activeStripeByPeriod: Map<string, number>,
  activeCombinedUsersByPeriod: Map<string, number>,
  aiSpendArrByMonth: Map<string, number>,
  logoChurnCountsByPeriod: Map<string, LogoChurnCounts>,
): LtvPoint[] {
  return periodOrder.map((period, idx) => {
    const key = canonicalHubPeriodKey(period.key, grain) || period.key;
    const periodStart = grain === "monthly" ? `${key}-01` : key;
    const point = combinedPoints[idx];
    const aiSpendArr = round2(aiSpendArrByMonth.get(key) || 0);
    const totalArr = round2((point?.arr || 0) + aiSpendArr);
    const fallbackActiveCustomers = Math.max(
      0,
      (activeHubByPeriod.get(key) || 0) + (activeStripeByPeriod.get(key) || 0),
    );
    const activeCustomers = Math.max(0, activeCombinedUsersByPeriod.get(key) || fallbackActiveCustomers);
    const arpuMonthly = activeCustomers > 0 ? round2(totalArr / 12 / activeCustomers) : 0;
    const logoCounts = logoChurnCountsByPeriod.get(key) || { prevActive: 0, churned: 0 };
    const churnedCustomers = Math.max(0, Math.round(logoCounts.churned || 0));
    const churnRate =
      logoCounts.prevActive > 0
        ? Math.min(1, Math.max(0, Number(logoCounts.churned || 0) / Number(logoCounts.prevActive || 0)))
        : 0;
    const churnRatePct = round2(churnRate * 100);
    const ltv = churnRate > 1e-9 ? round2(arpuMonthly / churnRate) : 0;

    return {
      key,
      label: period.label,
      periodStart,
      periodEnd: periodStart,
      totalArr,
      activeCustomers,
      churnedCustomers,
      arpuMonthly,
      churnRatePct,
      ltv,
    };
  });
}

function buildCombinedLtvUserCounts(
  periods: Array<{ key: string; label: string }>,
  rows: Array<{ valuesByPeriod?: Record<string, number> }>,
  grain: CombinedGrain,
) : CombinedLtvUserCounts {
  const activeByPeriod = new Map<string, number>();
  const logoChurnByPeriod = new Map<string, LogoChurnCounts>();
  const normalizedPeriods = (periods || [])
    .map((period) => {
      const sourceKey = String(period.key || "");
      const key = canonicalHubPeriodKey(sourceKey, grain) || sourceKey;
      return { sourceKey, key };
    })
    .filter((period) => Boolean(period.key && period.sourceKey));

  for (const period of normalizedPeriods) {
    if (!activeByPeriod.has(period.key)) activeByPeriod.set(period.key, 0);
    if (!logoChurnByPeriod.has(period.key)) logoChurnByPeriod.set(period.key, { prevActive: 0, churned: 0 });
  }

  for (const row of rows || []) {
    for (let idx = 0; idx < normalizedPeriods.length; idx += 1) {
      const period = normalizedPeriods[idx];
      const currHas = Math.abs(Number(row.valuesByPeriod?.[period.sourceKey] || 0)) > 1e-9;
      if (currHas) {
        activeByPeriod.set(period.key, (activeByPeriod.get(period.key) || 0) + 1);
      }
      if (idx === 0) continue;
      const prevPeriod = normalizedPeriods[idx - 1];
      const prevHas = Math.abs(Number(row.valuesByPeriod?.[prevPeriod.sourceKey] || 0)) > 1e-9;
      const counts = logoChurnByPeriod.get(period.key) || { prevActive: 0, churned: 0 };
      if (prevHas) counts.prevActive += 1;
      if (prevHas && !currHas) counts.churned += 1;
      logoChurnByPeriod.set(period.key, counts);
    }
  }

  return { activeByPeriod, logoChurnByPeriod };
}

function buildCacAccountMatchNotice(
  qbCosts: QuickBooksSalesMarketingCostResponse,
  normalizedSelectedAccountIds: string[],
) {
  const matchedDepartmentCount = qbCosts.matchedDepartments?.length || 0;
  if (
    qbCosts.accountMatchMode === "selected_accounts" &&
    normalizedSelectedAccountIds.length > 0 &&
    qbCosts.matchedAccounts.length === 0
  ) {
    return "Selected CAC expense accounts returned no matching costs for this range. Update your account selection from the ... menu on the CAC chart.";
  }
  if (qbCosts.accountMatchMode === "department" && matchedDepartmentCount === 0) {
    return "QuickBooks is connected, but no Sales/Marketing departments matched. Set QUICKBOOKS_CAC_DEPARTMENT_IDS or QUICKBOOKS_CAC_DEPARTMENT_NAMES.";
  }
  if (qbCosts.accountMatchMode !== "department" && qbCosts.matchedAccounts.length === 0) {
    return "QuickBooks is connected, but no sales/marketing expense accounts matched in this range. Configure QUICKBOOKS_CAC_EXPENSE_ACCOUNT_NAMES if your account names differ.";
  }
  return null;
}

function pickTargetCurrency() {
  return (
    String(process.env.STRIPE_BILLING_OVERVIEW_TARGET_CURRENCY || "").trim() ||
    String(process.env.STRIPE_THROUGH_MRR_TARGET_CURRENCY || "").trim() ||
    String(process.env.STRIPE_ARR_CORRECT_TARGET_CURRENCY || "").trim() ||
    "USD"
  );
}

async function convertQuickBooksSalesMarketingCostsWithFx(
  payload: QuickBooksSalesMarketingCostResponse,
  fxProvider: CacFxProvider,
  explicitTargetCurrency?: string,
): Promise<ConvertedQuickBooksSalesMarketingCostsWithFx> {
  const defaultSourceCurrency = String(payload.currency || "USD").trim().toUpperCase() || "USD";
  const targetCurrency = String(explicitTargetCurrency || FX_TARGET_CURRENCY || "USD").trim().toUpperCase() || "USD";
  const monthlyRateForMonth =
    fxProvider === "currencylayer"
      ? (fromCurrency: string, toCurrency: string, closeDate: Date | null) =>
          getMonthlyAverageCurrencyLayerFxRateForCloseMonth(fromCurrency, toCurrency, closeDate, {
            persistedOnly: true,
          })
      : getMonthlyAverageFxRateForCloseMonth;

  const points = Array.isArray(payload.points) ? payload.points : [];
  if (!targetCurrency || !points.length) {
    return {
      payload,
      diagnostics: {
        provider: fxProvider,
        targetCurrency,
        requestedPairCount: 0,
        zeroRatePairCount: 0,
        rateLimitedPairCount: 0,
        rawFallbackPairCount: 0,
      },
    };
  }

  const accountCurrencyByAccountId = payload.accountCurrencyByAccountId || {};
  const realmCurrencyByRealmId = payload.realmCurrencyByRealmId || {};
  const conversionPairs = new Set<string>();
  const sourceCurrencies = new Set<string>();

  const monthKeyFromPoint = (point: { key?: string; periodStart?: string }) =>
    String(point.key || point.periodStart || "").slice(0, 7);
  const realmIdFromScopedAccountId = (value: string) => {
    const text = String(value || "").trim();
    const idx = text.indexOf(":");
    if (idx <= 0) return "";
    return text.slice(0, idx).trim();
  };

  for (const point of points) {
    const monthKey = monthKeyFromPoint(point);
    if (!monthKey) continue;
    const pointCostByCurrency =
      point.costByCurrency && Object.keys(point.costByCurrency).length > 0
        ? point.costByCurrency
        : { [defaultSourceCurrency]: Number(point.totalCost || 0) };
    for (const sourceCurrencyRaw of Object.keys(pointCostByCurrency)) {
      const sourceCurrency = String(sourceCurrencyRaw || "").trim().toUpperCase() || defaultSourceCurrency;
      if (!sourceCurrency) continue;
      sourceCurrencies.add(sourceCurrency);
      if (sourceCurrency !== targetCurrency) {
        conversionPairs.add(`${sourceCurrency}|${targetCurrency}|${monthKey}`);
      }
    }
    for (const accountId of Object.keys(point.accountCostsByAccountId || {})) {
      const sourceCurrency = (
        String(accountCurrencyByAccountId[accountId] || "").trim().toUpperCase() ||
        String(realmCurrencyByRealmId[realmIdFromScopedAccountId(accountId)] || "").trim().toUpperCase() ||
        defaultSourceCurrency
      );
      sourceCurrencies.add(sourceCurrency);
      if (sourceCurrency !== targetCurrency) {
        conversionPairs.add(`${sourceCurrency}|${targetCurrency}|${monthKey}`);
      }
    }
  }

  const fxMap = new Map<string, number>();
  const zeroRatePairs = new Set<string>();
  const rateLimitedPairs = new Set<string>();
  await Promise.all(
    Array.from(conversionPairs).map(async (pairKey) => {
      const [sourceCurrency, targetCurrencyForPair, monthKey] = pairKey.split("|");
      const date = new Date(`${monthKey}-01T00:00:00Z`);
      const fx = await monthlyRateForMonth(sourceCurrency, targetCurrencyForPair, date);
      fxMap.set(pairKey, fx.rate);
      if (Number(fx.rate || 0) <= 0) zeroRatePairs.add(pairKey);
      if (fx.status === "rate_limited") rateLimitedPairs.add(pairKey);
    }),
  );

  const rawFallbackPairs = new Set<string>();
  const convertAmount = (amount: number, sourceCurrencyRaw: string, monthKey: string) => {
    const sourceCurrency = String(sourceCurrencyRaw || "").trim().toUpperCase() || defaultSourceCurrency;
    const rawAmount = Number(amount || 0);
    if (!sourceCurrency || sourceCurrency === targetCurrency) return round2(rawAmount);
    const pairKey = `${sourceCurrency}|${targetCurrency}|${monthKey}`;
    const rate = fxMap.get(pairKey) || 0;
    if (rate <= 0) {
      // For Currencylayer CAC, never silently pass through raw source currency.
      if (fxProvider === "currencylayer") return 0;
      rawFallbackPairs.add(pairKey);
      return round2(rawAmount);
    }
    return round2(rawAmount * rate);
  };

  const convertedPoints = points.map((point) => {
    const monthKey = monthKeyFromPoint(point);
    const pointCostByCurrency =
      point.costByCurrency && Object.keys(point.costByCurrency).length > 0
        ? point.costByCurrency
        : { [defaultSourceCurrency]: Number(point.totalCost || 0) };
    let convertedTotalCost = 0;
    for (const [sourceCurrency, amount] of Object.entries(pointCostByCurrency)) {
      convertedTotalCost = round2(convertedTotalCost + convertAmount(Number(amount || 0), sourceCurrency, monthKey));
    }

    const convertedAccountCostsByAccountId: Record<string, number> = {};
    for (const [accountId, amountRaw] of Object.entries(point.accountCostsByAccountId || {})) {
      const sourceCurrency = (
        String(accountCurrencyByAccountId[accountId] || "").trim().toUpperCase() ||
        String(realmCurrencyByRealmId[realmIdFromScopedAccountId(accountId)] || "").trim().toUpperCase() ||
        defaultSourceCurrency
      );
      convertedAccountCostsByAccountId[accountId] = convertAmount(Number(amountRaw || 0), sourceCurrency, monthKey);
    }

    return {
      ...point,
      totalCost: round2(convertedTotalCost),
      accountCostsByAccountId: convertedAccountCostsByAccountId,
    };
  });

  return {
    payload: {
      ...payload,
      currency: targetCurrency,
      currencies: Array.from(sourceCurrencies).sort(),
      points: convertedPoints,
    },
    diagnostics: {
      provider: fxProvider,
      targetCurrency,
      requestedPairCount: conversionPairs.size,
      zeroRatePairCount: zeroRatePairs.size,
      rateLimitedPairCount: rateLimitedPairs.size,
      rawFallbackPairCount: rawFallbackPairs.size,
    },
  };
}

function buildCurrencyLayerFxNotice(diagnostics: FxConversionDiagnostics) {
  if (diagnostics.provider !== "currencylayer") return null;
  const warnings: string[] = [];
  if (diagnostics.rateLimitedPairCount > 0) {
    warnings.push(
      `rate-limited for ${diagnostics.rateLimitedPairCount} monthly FX pair(s)`,
    );
  }
  if (diagnostics.zeroRatePairCount > 0) {
    warnings.push(
      `missing/zero rates for ${diagnostics.zeroRatePairCount} monthly FX pair(s)`,
    );
  }
  if (diagnostics.rawFallbackPairCount > 0) {
    warnings.push(
      `non-Currencylayer fallback used for ${diagnostics.rawFallbackPairCount} pair(s)`,
    );
  }
  if (!warnings.length) return null;
  return `Currencylayer FX warning: ${warnings.join("; ")}. Affected conversions are set to 0 (not raw source amounts).`;
}

function conciseErrorMessage(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  const trimmed = String(message || fallback).trim();
  if (!trimmed) return fallback;
  return trimmed.length > 220 ? `${trimmed.slice(0, 220)}...` : trimmed;
}

function parsePayload(raw: Partial<RequestBody>) {
  const startDate = String(raw.startDate || "").trim();
  const endDate = String(raw.endDate || "").trim();
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    throw new Error("Invalid startDate/endDate");
  }

  const grainRaw = String(raw.grain || "monthly").trim().toLowerCase();
  const allowed = new Set<CombinedGrain>(["daily", "monthly", "quarterly"]);
  if (!allowed.has(grainRaw as CombinedGrain)) {
    throw new Error("Invalid grain");
  }

  return {
    startDate,
    endDate,
    grain: grainRaw as CombinedGrain,
    accountIds: normalizeIdList(raw.accountIds),
    accountNames: normalizeNames(raw.accountNames),
    includeCac: raw.includeCac !== false,
  };
}

function monthKeyFromPointLike(value: { key?: string; periodStart?: string; monthKey?: string; asOfDate?: string }) {
  const key = String(value.key || "").trim();
  if (/^\d{4}-\d{2}$/.test(key)) return key;
  const monthKey = String(value.monthKey || "").trim();
  if (/^\d{4}-\d{2}$/.test(monthKey)) return monthKey;
  const periodStart = String(value.periodStart || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) return periodStart.slice(0, 7);
  const asOfDate = String(value.asOfDate || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) return asOfDate.slice(0, 7);
  return "";
}

function filterMonthlyRange<T extends { key?: string; periodStart?: string; monthKey?: string; asOfDate?: string }>(
  rows: T[] | undefined,
  startMonthKey: string,
  endMonthKey: string,
) {
  return (rows || []).filter((row) => {
    const monthKey = monthKeyFromPointLike(row);
    if (!monthKey) return false;
    return monthKey >= startMonthKey && monthKey <= endMonthKey;
  });
}

async function cachedGenerateHubspotReport(request: Parameters<typeof generateReport>[0]) {
  const key = `api:combined-billing-overview:hubspot-report:${stableStringify(request)}`;
  return getOrSetCache(key, SUBQUERY_CACHE_TTL_MS, () => generateReport(request));
}

async function cachedQueryStripeBillingOverview(request: Parameters<typeof queryStripeBillingOverviewFromBigQuery>[0]) {
  const key = `api:combined-billing-overview:stripe-overview:${stableStringify(request)}`;
  return getOrSetCache(key, SUBQUERY_CACHE_TTL_MS, () =>
    queryStripeBillingOverviewFromBigQuery(request, { profile: "stripe_arr_correct" }),
  );
}

async function buildCombinedBillingOverview(
  startDate: string,
  endDate: string,
  grain: CombinedGrain,
  accountIds: string[],
  accountNames: string[],
  includeCac: boolean,
) {
  const previousRange = previousPeriodRangeForGrain(startDate, grain);
  const targetCurrency = pickTargetCurrency();
  const nowUtc = new Date();
  const todayIso = toIsoDateOnly(nowUtc);
  const currentMonthStartObj = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), 1, 0, 0, 0, 0));
  const nextMonthStartObj = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  const currentMonthStartIso = toIsoDateOnly(currentMonthStartObj);
  const startDateObj = parseIsoDateOnly(startDate);
  const endDateObj = parseIsoDateOnly(endDate);
  const currentMonthIncludedInRange =
    grain === "monthly" &&
    !!startDateObj &&
    !!endDateObj &&
    endDateObj.getTime() >= currentMonthStartObj.getTime() &&
    startDateObj.getTime() < nextMonthStartObj.getTime();
  const shouldComputeLtv = grain === "monthly";
  const sourcePlanGrain = grain === "daily" ? "daily" : "monthly";
  let aiSpendExcludedEnterprisePrepaidCustomers: EnterprisePrepaidAiSpendExclusionRow[] = [];
  let aiSpendDailyPointBreakdown: AiSpendDailyPointBreakdown[] = [];
  const sourceCombinedAllSubsPromise = getOrSetCache(
    `api:combined-billing-overview:combined-all-subs-source:${stableStringify({
      startDate: previousRange.startDate,
      endDate,
      grain: sourcePlanGrain,
    })}`,
    SUBQUERY_CACHE_TTL_MS,
    () =>
      generateCombinedAllSubsReport({
        startDate: previousRange.startDate,
        endDate,
        combineMode: "grouped",
        displayMode: "arr",
        planGrain: sourcePlanGrain,
        includeSalesAssist: true,
      }),
  );
  const ltvCombinedUsersPromise: Promise<CombinedLtvUserCounts> = shouldComputeLtv
    ? generateCombinedAllSubsReport({
        startDate: previousRange.startDate,
        endDate,
        combineMode: "grouped",
        displayMode: "arr",
        planGrain: "monthly",
        includeSalesAssist: false,
      }).then((report) => buildCombinedLtvUserCounts(report.periods || [], report.rows || [], "monthly"))
    : Promise.resolve({ activeByPeriod: new Map<string, number>(), logoChurnByPeriod: new Map<string, LogoChurnCounts>() });
  const aiSpendSeriesPromise = (async () => {
    if (grain === "daily") {
      const aiDailyBaselineDate = previousRange.endDate;
      const exclusions = await getOrSetCache(
        `api:stripe-ai-spend:enterprise-prepaid-exclusions:${stableStringify({
          startDate,
          endDate,
          invoiceMonthOffset: 1,
          targetCurrency,
        })}`,
        AI_SPEND_EXCLUSIONS_CACHE_TTL_MS,
        () =>
          resolveEnterprisePrepaidAiSpendExclusions({
            startDate,
            endDate,
            targetCurrency,
          }),
      ).catch(() => ({ customerMonthPairs: [], customerMonthPrepaidOffsets: [], rows: [] }));
      aiSpendExcludedEnterprisePrepaidCustomers = exclusions.rows || [];

      const dailySnapshotSeries = await queryStripeAiSpendDailyAnnualizedFromUpcomingSnapshotsFromBigQuery(
        {
          startDate: aiDailyBaselineDate,
          endDate,
          targetCurrency,
          productDescriptionIncludes: AI_SPEND_UPCOMING_PRODUCT_TERMS,
          // Keep daily exclusions aligned with AI Spend page behavior:
          // apply prepaid offsets, but do not hard-exclude customer-month pairs.
          excludeCustomerMonthPairs: [],
          prepaidOffsetByCustomerMonthPairs: (exclusions.customerMonthPrepaidOffsets || []).map((entry) => ({
            pairKey: entry.pairKey,
            prepaidAppliedMajor: entry.prepaidAppliedMajor,
          })),
        },
        { profile: "stripe_arr_correct" },
      );

      const points = (dailySnapshotSeries.points || []).map((point) => {
        const annualizedArr = Number(point.annualizedArr || 0);
        const dailyRevenueEquivalent = round2(annualizedArr / 365);
        return {
          key: String(point.snapshotDate || ""),
          label: String(point.snapshotDate || ""),
          periodStart: String(point.snapshotDate || ""),
          periodEnd: String(point.snapshotDate || ""),
          revenue: dailyRevenueEquivalent,
          lineCount: Math.max(0, Math.round(Number(point.lineCount || 0))),
          customerCount: Math.max(0, Math.round(Number(point.customerCount || 0))),
        };
      });
      aiSpendDailyPointBreakdown = (dailySnapshotSeries.points || []).map((point) => {
        const key = String(point.snapshotDate || "");
        const withExclusions = round2(Number(point.annualizedArr || 0));
        const withoutExclusions = round2(Number(point.annualizedArrWithoutExclusions || 0));
        const excluded = round2(Number(point.annualizedArrExcluded || Math.max(withoutExclusions - withExclusions, 0)));
        return {
          key,
          label: key,
          periodStart: key,
          periodEnd: key,
          aiSpendWithoutExclusions: withoutExclusions,
          aiSpendWithExclusions: withExclusions,
          aiSpendExcluded: excluded,
        };
      });

      return {
        startDate: aiDailyBaselineDate,
        endDate,
        grain,
        targetCurrency: dailySnapshotSeries.targetCurrency || String(targetCurrency || "USD").toUpperCase(),
        totalRevenue: round2(points.reduce((sum, point) => sum + Number(point.revenue || 0), 0)),
        points,
        topCustomers: [],
        topProducts: [],
        topPrices: [],
        detailRows: [],
      };
    }

    const exclusions = await getOrSetCache(
      `api:stripe-ai-spend:enterprise-prepaid-exclusions:${stableStringify({
        startDate,
        endDate,
        invoiceMonthOffset: 1,
        targetCurrency,
      })}`,
      AI_SPEND_EXCLUSIONS_CACHE_TTL_MS,
      () =>
        resolveEnterprisePrepaidAiSpendExclusions({
          startDate,
          endDate,
          targetCurrency,
        }),
    ).catch(() => ({ customerMonthPrepaidOffsets: [], rows: [] }));
    aiSpendExcludedEnterprisePrepaidCustomers = exclusions.rows || [];
    const historical = await getOrSetCache(
      `api:combined-billing-overview:ai-spend-historical:${stableStringify({
        startDate: previousRange.startDate,
        endDate,
        grain,
        targetCurrency,
        topLimit: 1,
        detailLimit: 1,
        prepaidOffsetByCustomerMonthPairs: (exclusions.customerMonthPrepaidOffsets || []).map((entry) => ({
          pairKey: entry.pairKey,
          prepaidAppliedMajor: entry.prepaidAppliedMajor,
        })),
      })}`,
      SUBQUERY_CACHE_TTL_MS,
      () =>
        queryStripeAiSpendFromBigQuery(
          {
            startDate: previousRange.startDate,
            endDate,
            grain,
            targetCurrency,
            topLimit: 1,
            detailLimit: 1,
            excludeCustomerIds: [],
            excludeCustomerMonthPairs: [],
            prepaidOffsetByCustomerMonthPairs: (exclusions.customerMonthPrepaidOffsets || []).map((entry) => ({
              pairKey: entry.pairKey,
              prepaidAppliedMajor: entry.prepaidAppliedMajor,
            })),
          },
          { profile: "stripe_arr_correct" },
        ),
    );
    if (!currentMonthIncludedInRange) return historical;

    const effectiveCurrentMonthEndIso =
      endDateObj && endDateObj.getTime() < nowUtc.getTime() ? endDate : todayIso;
    if (effectiveCurrentMonthEndIso < currentMonthStartIso) return historical;
    const latestSnapshotDateForCarryForward = await getOrSetCache(
      "api:combined-billing-overview:latest-upcoming-snapshot-date",
      CACHE_TTL_MS,
      () => queryStripeLatestUpcomingSnapshotDateFromBigQuery({ profile: "stripe_arr_correct" }),
    ).catch(() => "");
    const carryForwardAsOfDate = isIsoDate(latestSnapshotDateForCarryForward)
      ? latestSnapshotDateForCarryForward
      : todayIso;

    const carryForward = await getOrSetCache(
      `api:combined-billing-overview:ai-spend-carry-forward:${stableStringify({
        monthStartDate: currentMonthStartIso,
        asOfDate: carryForwardAsOfDate,
        targetCurrency,
      })}`,
      CACHE_TTL_MS,
      () =>
        resolveEnterprisePrepaidAiSpendCurrentMonthCarryForwardOffsets({
          currentMonthStartDate: currentMonthStartIso,
          asOfDate: carryForwardAsOfDate,
          targetCurrency,
        }),
    ).catch(() => ({
      currentMonthStartDate: currentMonthStartIso,
      currentMonthEndDate: currentMonthStartIso,
      lastMonthStartDate: "",
      lastMonthEndDate: "",
      carriedCustomerIds: [],
      prepaidOffsetByCustomerIds: [],
      excludedCustomers: [],
    }));

    const upcomingCurrentMonth = await getOrSetCache(
      `api:combined-billing-overview:ai-spend-upcoming:${stableStringify({
        startDate: currentMonthStartIso,
        endDate: effectiveCurrentMonthEndIso,
        grain,
        targetCurrency,
        productDescriptionIncludes: AI_SPEND_UPCOMING_PRODUCT_TERMS,
        prepaidOffsetByCustomerIds: carryForward.prepaidOffsetByCustomerIds || [],
      })}`,
      CACHE_TTL_MS,
      () =>
        queryStripeAiSpendCurrentMonthFromUpcomingFromBigQuery(
          {
            startDate: currentMonthStartIso,
            endDate: effectiveCurrentMonthEndIso,
            grain,
            targetCurrency,
            topLimit: 1,
            detailLimit: 1,
            productDescriptionIncludes: AI_SPEND_UPCOMING_PRODUCT_TERMS,
            excludeCustomerIds: [],
            prepaidOffsetByCustomerIds: carryForward.prepaidOffsetByCustomerIds || [],
          },
          { profile: "stripe_arr_correct" },
        ),
    ).catch(() => null);
    if (!upcomingCurrentMonth) return historical;

    const currentMonthKey = currentMonthStartIso.slice(0, 7);
    const replacementPoint = (upcomingCurrentMonth.points || []).find(
      (point) => periodKeyFromIsoDateForGrain(String(point.periodStart || ""), "monthly") === currentMonthKey,
    );
    if (!replacementPoint) return historical;

    const nextPoints = (historical.points || []).filter(
      (point) => periodKeyFromIsoDateForGrain(String(point.periodStart || ""), "monthly") !== currentMonthKey,
    );
    nextPoints.push(replacementPoint);
    nextPoints.sort((a, b) => String(a.periodStart || "").localeCompare(String(b.periodStart || "")));

    return {
      ...historical,
      points: nextPoints,
      totalRevenue: round2(nextPoints.reduce((sum, point) => sum + Number(point.revenue || 0), 0)),
    };
  })();
  const ltvAiSpendPromise: Promise<Map<string, number>> = shouldComputeLtv
    ? (async () => {
        const aiSpend = await aiSpendSeriesPromise;
        const aiSpendArrByMonth = new Map<string, number>();
        for (const point of aiSpend.points || []) {
          const monthKey = periodKeyFromIsoDateForGrain(String(point.periodStart || ""), "monthly");
          if (!monthKey) continue;
          const arr = annualizedArrFromRevenueForPeriod(
            Number(point.revenue || 0),
            String(point.periodStart || ""),
            String(point.periodEnd || ""),
          );
          aiSpendArrByMonth.set(monthKey, round2((aiSpendArrByMonth.get(monthKey) || 0) + arr));
        }
        return aiSpendArrByMonth;
      })()
    : Promise.resolve(new Map<string, number>());

  const stripeMainPromise = cachedQueryStripeBillingOverview({
    startDate,
    endDate,
    grain,
    groupBy: "none",
    targetCurrency,
    includeCustomerArrRows: includeCac || shouldComputeLtv,
    includeCurrentMonthProjection: false,
  });
  const hubspotExpandedPromise = cachedGenerateHubspotReport({
    startDate: previousRange.startDate,
    endDate,
    mode: "contracted",
    grain,
  });
  const stripeBaselinePromise: Promise<Awaited<ReturnType<typeof queryStripeBillingOverviewFromBigQuery>> | null> = includeCac || shouldComputeLtv
    ? cachedQueryStripeBillingOverview(
        {
          startDate: previousRange.startDate,
          endDate: previousRange.endDate,
          grain,
          groupBy: "none",
          targetCurrency,
          includeCustomerArrRows: includeCac || shouldComputeLtv,
          includeCurrentMonthProjection: false,
        },
      ).catch(() => null)
    : Promise.resolve(null);
  const [hubspotExpanded, stripeMain, stripeBaseline] = await Promise.all([
    hubspotExpandedPromise,
    stripeMainPromise,
    stripeBaselinePromise,
  ]);

  const hubspotMainKeys = buildPeriodKeySetForRange(startDate, endDate, grain);
  const hubspotBaselineKeys = buildPeriodKeySetForRange(previousRange.startDate, previousRange.endDate, grain);
  const hubspotMain = sliceReportByPeriodKeys(hubspotExpanded, hubspotMainKeys);
  const hubspotBaseline = sliceReportByPeriodKeys(hubspotExpanded, hubspotBaselineKeys);

  const periodOrder: PeriodRef[] = (hubspotMain.periods || []).map((period) => ({
    key: String(period.key || ""),
    label: String(period.label || period.key || ""),
  }));
  const salesCyclePromise: Promise<{ points: SalesCyclePoint[]; notice: string | null }> =
    grain !== "monthly"
      ? Promise.resolve({
          points: [],
          notice:
            "Sales cycle currently supports monthly grain. Switch Time grain to Monthly to load average sales-cycle days.",
        })
      : (async () => {
          try {
            const points = await buildMonthlySalesCycleSeries(periodOrder, process.env.INCLUDED_DEALSTAGE || "");
            if (!points.some((point) => point.closedWonDealCount > 0)) {
              return {
                points,
                notice: "No closed-won HubSpot deals were found in this range.",
              };
            }
            return { points, notice: null };
          } catch (error: unknown) {
            return {
              points: [],
              notice: `Sales cycle unavailable: ${conciseErrorMessage(error, "HubSpot deal query failed.")}`,
            };
          }
        })();

  const mapHubRows = (report: ReportResponse): Array<{ accountId: string; deploymentType: string; valuesByPeriod: Record<string, number> }> =>
    (report.rows || []).map((row: ReportRow) => ({
      accountId: String(row.accountId || ""),
      deploymentType: String(row.deploymentType || ""),
      valuesByPeriod: row.valuesByPeriod || {},
    }));

  const filteredHubRows = mapHubRows(hubspotMain)
    .filter((row) => isCloudDeploymentType(row.deploymentType))
    .filter((row) => hasAnyNonZeroValue(row.valuesByPeriod));
  const filteredBaselineRows = mapHubRows(hubspotBaseline)
    .filter((row) => isCloudDeploymentType(row.deploymentType))
    .filter((row) => hasAnyNonZeroValue(row.valuesByPeriod));

  const accountArrByPeriod = new Map<string, Record<string, number>>();
  for (const row of filteredHubRows) {
    const accountKey = accountGroupingKey(row);
    if (!accountKey) continue;
    addAccountPeriodValues(accountArrByPeriod, accountKey, row.valuesByPeriod, periodOrder);
  }

  const baselineAccountArrByAccount = new Map<string, number>();
  const baselinePeriodKeys = (hubspotBaseline.periods || []).map((period) => period.key);
  for (const row of filteredBaselineRows) {
    const accountKey = accountGroupingKey(row);
    if (!accountKey) continue;
    const rowBaselineArr = round2(
      baselinePeriodKeys.reduce((acc, periodKey) => acc + (row.valuesByPeriod[periodKey] || 0), 0),
    );
    if (Math.abs(rowBaselineArr) < 1e-9) continue;
    baselineAccountArrByAccount.set(
      accountKey,
      round2((baselineAccountArrByAccount.get(accountKey) || 0) + rowBaselineArr),
    );
  }

  const hubPoints = buildHubPointsFromAccounts(periodOrder, accountArrByPeriod, baselineAccountArrByAccount);
  const hubPointMap = new Map<string, CombinedPoint>();
  periodOrder.forEach((period, idx) => {
    hubPointMap.set(canonicalHubPeriodKey(period.key, grain), hubPoints[idx]);
  });

  const hasStripeExactSeries =
    stripeMain.stripeExactPoints !== undefined || stripeMain.stripeExactHistoryPoints !== undefined;
  const stripePoints = hasStripeExactSeries ? stripeMain.stripeExactPoints || [] : stripeMain.points || [];
  const stripeHistoryPoints = hasStripeExactSeries
    ? stripeMain.stripeExactHistoryPoints || []
    : stripeMain.historyPoints || [];

  const stripePointMap = new Map<string, StripeBillingOverviewPoint>();
  for (const point of stripePoints) {
    stripePointMap.set(canonicalStripePeriodKey(point, grain), point);
  }

  const stripePrevMrr =
    stripeHistoryPoints.length > 0
      ? stripeHistoryPoints[stripeHistoryPoints.length - 1].mrrEnd
      : stripePoints.length > 0
        ? round2(stripePoints[0].mrrEnd - stripePoints[0].netMrrChange)
        : 0;
  const hubBaselineArr = round2(
    Array.from(baselineAccountArrByAccount.values()).reduce((acc, value) => acc + value, 0),
  );
  const hubPrevMrr = round2(hubBaselineArr / 12);
  const initialPrevCombinedMrr = round2(stripePrevMrr + hubPrevMrr);

  const rawSelfserve: CombinedPoint[] = periodOrder.map((period) => {
    const canonical = canonicalHubPeriodKey(period.key, grain);
    const stripePoint = stripePointMap.get(canonical);
    const stripeNewWithReactivation = round2((stripePoint?.newMrr || 0) + (stripePoint?.reactivationMrr || 0));

    const stripeFallbackStart =
      grain === "daily"
        ? period.key
        : grain === "monthly"
          ? `${period.key}-01`
          : stripePoint?.periodStart || period.key;

    return {
      key: canonical || period.key,
      label: period.label,
      periodStart: stripePoint?.periodStart || stripeFallbackStart,
      periodEnd: stripePoint?.periodEnd || stripeFallbackStart,
      mrrEnd: round2(stripePoint?.mrrEnd || 0),
      newMrr: stripeNewWithReactivation,
      expansionMrr: round2(stripePoint?.expansionMrr || 0),
      contractionMrr: round2(stripePoint?.contractionMrr || 0),
      churnMrr: round2(stripePoint?.churnMrr || 0),
      netMrrChange: round2(stripePoint?.netMrrChange || 0),
      mrrGrowthRatePct: 0,
      ndrPct: 0,
      gdrPct: 0,
      arr: round2(stripePoint?.arr || 0),
      arrGrowth: round2(stripePoint?.arrGrowth || 0),
    };
  });

  const selfservePoints = rawSelfserve.map((point, idx) => {
    const prevMrr = idx === 0 ? stripePrevMrr : rawSelfserve[idx - 1].mrrEnd;
    const mrrGrowthRatePct =
      Math.abs(prevMrr) > 1e-9
        ? round2(((point.mrrEnd - prevMrr) / Math.abs(prevMrr)) * 100)
        : 0;
    const retention = calculateRetentionRates(prevMrr, point.expansionMrr, point.contractionMrr, point.churnMrr);
    return { ...point, mrrGrowthRatePct, ndrPct: retention.ndrPct, gdrPct: retention.gdrPct };
  });

  const rawCombined: CombinedPoint[] = periodOrder.map((period) => {
    const canonical = canonicalHubPeriodKey(period.key, grain);
    const hub = hubPointMap.get(canonical);
    const stripePoint = stripePointMap.get(canonical);
    const stripeNewWithReactivation = round2((stripePoint?.newMrr || 0) + (stripePoint?.reactivationMrr || 0));

    const stripeFallbackStart =
      grain === "daily"
        ? period.key
        : grain === "monthly"
          ? `${period.key}-01`
          : stripePoint?.periodStart || period.key;

    return {
      key: canonical || period.key,
      label: period.label,
      periodStart: stripePoint?.periodStart || hub?.periodStart || stripeFallbackStart,
      periodEnd: stripePoint?.periodEnd || hub?.periodEnd || stripeFallbackStart,
      mrrEnd: round2((hub?.mrrEnd || 0) + (stripePoint?.mrrEnd || 0)),
      newMrr: round2((hub?.newMrr || 0) + stripeNewWithReactivation),
      expansionMrr: round2((hub?.expansionMrr || 0) + (stripePoint?.expansionMrr || 0)),
      contractionMrr: round2((hub?.contractionMrr || 0) + (stripePoint?.contractionMrr || 0)),
      churnMrr: round2((hub?.churnMrr || 0) + (stripePoint?.churnMrr || 0)),
      netMrrChange: round2((hub?.netMrrChange || 0) + (stripePoint?.netMrrChange || 0)),
      mrrGrowthRatePct: 0,
      ndrPct: 0,
      gdrPct: 0,
      arr: round2((hub?.arr || 0) + (stripePoint?.arr || 0)),
      arrGrowth: round2((hub?.arrGrowth || 0) + (stripePoint?.arrGrowth || 0)),
    };
  });

  const points = rawCombined.map((point, idx) => {
    const prevMrr = idx === 0 ? initialPrevCombinedMrr : rawCombined[idx - 1].mrrEnd;
    const mrrGrowthRatePct =
      Math.abs(prevMrr) > 1e-9
        ? round2(((point.mrrEnd - prevMrr) / Math.abs(prevMrr)) * 100)
        : 0;
    const retention = calculateRetentionRates(prevMrr, point.expansionMrr, point.contractionMrr, point.churnMrr);
    return { ...point, mrrGrowthRatePct, ndrPct: retention.ndrPct, gdrPct: retention.gdrPct };
  });

  let aiSpendSourcePoints: CombinedPoint[] = periodOrder.map((period) => {
    const key = canonicalHubPeriodKey(period.key, grain) || period.key;
    const periodStart = grain === "monthly" ? `${key}-01` : key;
    return {
      key,
      label: period.label,
      periodStart,
      periodEnd: periodStart,
      mrrEnd: 0,
      newMrr: 0,
      expansionMrr: 0,
      contractionMrr: 0,
      churnMrr: 0,
      netMrrChange: 0,
      mrrGrowthRatePct: 0,
      ndrPct: 0,
      gdrPct: 0,
      arr: 0,
      arrGrowth: 0,
    };
  });
  let linePoints: CombinedPoint[] = points;
  try {
    const aiSpendSeries = await aiSpendSeriesPromise;
    const aiPreviousReferenceDate = grain === "daily" ? previousRange.endDate : previousRange.startDate;
    const aiBuild = buildAiSpendSourceSeries(
      periodOrder,
      grain,
      (aiSpendSeries.points || []).map((point) => ({
        periodStart: String(point.periodStart || ""),
        periodEnd: String(point.periodEnd || ""),
        revenue: Number(point.revenue || 0),
      })),
      aiPreviousReferenceDate,
    );
    aiSpendSourcePoints = aiBuild.points;
    linePoints = mergeCombinedAndAiSeries(points, aiSpendSourcePoints, initialPrevCombinedMrr, aiBuild.initialPrevMrr);
  } catch {
    aiSpendSourcePoints = aiSpendSourcePoints.map((point) => ({ ...point }));
    linePoints = points;
  }
  let salesledSourcePoints = hubPoints;
  let selfserveSourcePoints = selfservePoints;
  try {
    const sourceCombinedAllSubs = await sourceCombinedAllSubsPromise;
    const sourceSplit = buildSourcePointsFromCombinedAllSubsReport(
      periodOrder,
      grain,
      previousRange,
      sourceCombinedAllSubs,
    );
    salesledSourcePoints = sourceSplit.salesled;
    selfserveSourcePoints = sourceSplit.selfserve;
  } catch {
    salesledSourcePoints = hubPoints;
    selfserveSourcePoints = selfservePoints;
  }
  const lineSourcePoints: LineSourcePoints = {
    salesled: salesledSourcePoints,
    selfserve: selfserveSourcePoints,
    aiSpend: aiSpendSourcePoints,
  };

  let arrPerEmployeeNotice: string | null = null;
  let arrPerEmployeePoints: ArrPerEmployeePoint[] = linePoints.map((point) => ({
    key: point.key,
    label: point.label,
    periodStart: point.periodStart,
    periodEnd: point.periodEnd,
    arr: round2(point.arr || 0),
    fullTimeEmployees: 0,
    arrPerEmployee: 0,
    employeeNames: [],
  }));
  if (grain !== "monthly") {
    arrPerEmployeeNotice =
      "ARR per employee currently supports monthly grain only. Switch Time grain to Monthly to load ARR/FTE.";
    arrPerEmployeePoints = [];
  } else {
    try {
      const snapshotDateByKey = new Map<string, string>();
      for (const point of linePoints) {
        const key = canonicalHubPeriodKey(point.key, grain) || point.key;
        const snapshotDate = periodEndIsoFromKey(key, grain);
        if (snapshotDate) snapshotDateByKey.set(key, snapshotDate);
      }
      const snapshotDates = Array.from(new Set(Array.from(snapshotDateByKey.values()).filter(Boolean))).sort();
      const rosterByDate = await getOrSetCache(
        `api:combined-billing-overview:bamboo-roster:${stableStringify(snapshotDates)}`,
        Math.max(CACHE_TTL_MS, 5 * 60 * 1000),
        () => queryBambooHrFullTimeRosterByDate(snapshotDates),
      );
      arrPerEmployeePoints = linePoints.map((point) => {
        const key = canonicalHubPeriodKey(point.key, grain) || point.key;
        const snapshotDate = snapshotDateByKey.get(key) || "";
        const rosterSnapshot = rosterByDate.get(snapshotDate);
        const fullTimeEmployees = Math.max(0, Math.round(Number(rosterSnapshot?.count || 0)));
        const employeeNames = rosterSnapshot?.employeeNames || [];
        const arr = round2(point.arr || 0);
        const arrPerEmployee = fullTimeEmployees > 0 ? round2(arr / fullTimeEmployees) : 0;
        return {
          key: point.key,
          label: point.label,
          periodStart: point.periodStart,
          periodEnd: point.periodEnd,
          arr,
          fullTimeEmployees,
          arrPerEmployee,
          employeeNames,
        };
      });
      if (!arrPerEmployeePoints.some((point) => point.fullTimeEmployees > 0)) {
        arrPerEmployeeNotice = "BambooHR returned no full-time employee counts for this range.";
      }
    } catch (error: unknown) {
      arrPerEmployeeNotice = `ARR per employee unavailable: ${conciseErrorMessage(
        error,
        "BambooHR query failed.",
      )}`;
    }
  }

  const currentMrr = points.length ? points[points.length - 1].mrrEnd : 0;
  const retentionPoints: RetentionSeriesPoint[] = periodOrder.map((period, idx) => {
    const key = canonicalHubPeriodKey(period.key, grain) || period.key;
    return {
      key,
      label: period.label,
      selfserveGdrPct: lineSourcePoints.selfserve[idx]?.gdrPct || 0,
      salesledGdrPct: lineSourcePoints.salesled[idx]?.gdrPct || 0,
      combinedGdrPct: points[idx]?.gdrPct || 0,
      selfserveNdrPct: lineSourcePoints.selfserve[idx]?.ndrPct || 0,
      salesledNdrPct: lineSourcePoints.salesled[idx]?.ndrPct || 0,
      combinedNdrPct: points[idx]?.ndrPct || 0,
    };
  });

  const stripeArrByCustomer = new Map<string, Map<string, number>>();
  for (const row of stripeMain.customerArrRows || []) {
    const customerId = String(row.customerId || "").trim();
    const key = canonicalStripeCustomerPeriodKey(row, grain);
    if (!customerId || !key) continue;
    if (!stripeArrByCustomer.has(customerId)) stripeArrByCustomer.set(customerId, new Map<string, number>());
    const valuesByPeriod = stripeArrByCustomer.get(customerId)!;
    valuesByPeriod.set(key, round2((valuesByPeriod.get(key) || 0) + Number(row.arr || 0)));
  }
  const stripeBaselineArrByCustomer = new Map<string, number>();
  for (const row of stripeBaseline?.customerArrRows || []) {
    const customerId = String(row.customerId || "").trim();
    if (!customerId) continue;
    stripeBaselineArrByCustomer.set(
      customerId,
      round2((stripeBaselineArrByCustomer.get(customerId) || 0) + Number(row.arr || 0)),
    );
  }
  const activeHubByPeriod = buildActiveAccountCountByPeriod(periodOrder, accountArrByPeriod);
  const activeStripeByPeriod = buildActiveStripeCustomerCountByPeriod(stripeArrByCustomer);
  let activeCombinedUsersByPeriod = new Map<string, number>();
  let combinedLogoChurnCountsByPeriod = new Map<string, LogoChurnCounts>();
  if (shouldComputeLtv) {
    try {
      const combinedCounts = await ltvCombinedUsersPromise;
      activeCombinedUsersByPeriod = combinedCounts.activeByPeriod;
      combinedLogoChurnCountsByPeriod = combinedCounts.logoChurnByPeriod;
    } catch {
      activeCombinedUsersByPeriod = new Map<string, number>();
      combinedLogoChurnCountsByPeriod = new Map<string, LogoChurnCounts>();
    }
  }
  const logoChurnCountsByPeriod = new Map<string, LogoChurnCounts>();
  for (const period of periodOrder) {
    const key = canonicalHubPeriodKey(period.key, grain) || period.key;
    logoChurnCountsByPeriod.set(key, combinedLogoChurnCountsByPeriod.get(key) || { prevActive: 0, churned: 0 });
  }

  let ltvPoints: LtvPoint[] = [];
  let ltvNotice: string | null = null;
  let salesCyclePoints: SalesCyclePoint[] = [];
  let salesCycleNotice: string | null = null;
  if (grain !== "monthly") {
    ltvNotice = "LTV currently supports monthly grain. Switch Time grain to Monthly to load LTV over time.";
  } else {
    const buildFallbackLtv = () =>
      buildLtvSeries(
        periodOrder,
        grain,
        points,
        activeHubByPeriod,
        activeStripeByPeriod,
        activeCombinedUsersByPeriod,
        new Map<string, number>(),
        logoChurnCountsByPeriod,
      );
    try {
      const aiSpendArrByMonth = await ltvAiSpendPromise;
      ltvPoints = buildLtvSeries(
        periodOrder,
        grain,
        points,
        activeHubByPeriod,
        activeStripeByPeriod,
        activeCombinedUsersByPeriod,
        aiSpendArrByMonth,
        logoChurnCountsByPeriod,
      );
    } catch (error: unknown) {
      ltvNotice = `LTV warning: AI spend component unavailable (${conciseErrorMessage(
        error,
        "AI spend query failed.",
      )}). Using Stripe + HubSpot ARR only.`;
      ltvPoints = buildFallbackLtv();
    }
  }
  const salesCycleResult = await salesCyclePromise;
  salesCyclePoints = salesCycleResult.points;
  salesCycleNotice = salesCycleResult.notice;

  const combinedNewCustomerCountByPeriod = new Map<string, number>();
  if (includeCac) {
    const hubNewCustomerCountByPeriod = new Map<string, number>();
    periodOrder.forEach((period, idx) => {
      const key = canonicalHubPeriodKey(period.key, grain) || period.key;
      const prevKey = idx > 0 ? periodOrder[idx - 1].key : "";
      let count = 0;
      for (const [accountKey, accountTotals] of accountArrByPeriod.entries()) {
        const currArr = round2(accountTotals[period.key] || 0);
        const prevArr = round2(
          idx === 0
            ? baselineAccountArrByAccount.get(accountKey) || 0
            : prevKey
              ? accountTotals[prevKey] || 0
              : 0,
        );
        const currHas = Math.abs(currArr) > 1e-9;
        const prevHas = Math.abs(prevArr) > 1e-9;
        if (!prevHas && currHas) count += 1;
      }
      hubNewCustomerCountByPeriod.set(key, count);
    });

    const stripeNewCustomerCountByPeriod = new Map<string, number>();
    periodOrder.forEach((period, idx) => {
      const key = canonicalHubPeriodKey(period.key, grain) || period.key;
      const prevKey =
        idx > 0 ? canonicalHubPeriodKey(periodOrder[idx - 1].key, grain) || periodOrder[idx - 1].key : "";
      let count = 0;
      for (const [customerId, valuesByPeriod] of stripeArrByCustomer.entries()) {
        const currArr = round2(valuesByPeriod.get(key) || 0);
        const prevArr = round2(
          idx === 0
            ? stripeBaselineArrByCustomer.get(customerId) || 0
            : prevKey
              ? valuesByPeriod.get(prevKey) || 0
              : 0,
        );
        const currHas = Math.abs(currArr) > 1e-9;
        const prevHas = Math.abs(prevArr) > 1e-9;
        if (!prevHas && currHas) count += 1;
      }
      stripeNewCustomerCountByPeriod.set(key, count);
    });

    periodOrder.forEach((period) => {
      const key = canonicalHubPeriodKey(period.key, grain) || period.key;
      const count = (hubNewCustomerCountByPeriod.get(key) || 0) + (stripeNewCustomerCountByPeriod.get(key) || 0);
      combinedNewCustomerCountByPeriod.set(key, count);
    });
  }
  const emptyCacSeries = buildCacSeries(periodOrder, grain, new Map<string, number>(), combinedNewCustomerCountByPeriod);

  let cacPoints: CacPoint[] = [];
  let cacCurrencyLayerPoints: CacPoint[] = [];
  let cacCadPoints: CacPoint[] = [];
  let cacNotice: string | null = null;
  let cacCurrencyLayerNotice: string | null = null;
  let cacCadNotice: string | null = null;
  let cacCadCurrency = "CAD";
  if (grain !== "monthly") {
    cacNotice = "CAC currently supports monthly grain. Switch Time grain to Monthly to load CAC over time.";
    cacCurrencyLayerNotice =
      "Currencylayer CAC currently supports monthly grain. Switch Time grain to Monthly to load CAC over time.";
    cacCadNotice =
      "CAC (CAD) currently supports monthly grain. Switch Time grain to Monthly to load CAC over time.";
    cacPoints = emptyCacSeries;
    cacCurrencyLayerPoints = emptyCacSeries;
    cacCadPoints = emptyCacSeries;
  } else if (!includeCac) {
    cacNotice = "Loading CAC data...";
    cacCurrencyLayerNotice = "Loading Currencylayer CAC data...";
    cacCadNotice = "Loading CAD CAC data...";
    cacPoints = emptyCacSeries;
    cacCurrencyLayerPoints = emptyCacSeries;
    cacCadPoints = emptyCacSeries;
  } else {
    let cadRawCosts: QuickBooksSalesMarketingCostResponse | null = null;
    try {
      cadRawCosts = (await fetchQuickBooksSalesMarketingCostsByMonth(startDate, endDate, {
        selectedAccountIds: accountIds,
        selectedAccountNames: accountNames,
      })) as QuickBooksSalesMarketingCostResponse;
    } catch (error: unknown) {
      const reason = conciseErrorMessage(error, "QuickBooks cost query failed.");
      cacNotice = `CAC unavailable: ${reason}`;
      cacCurrencyLayerNotice = `Currencylayer CAC unavailable: ${reason}`;
      cacCadNotice = `CAD CAC unavailable: ${reason}`;
      cacPoints = emptyCacSeries;
      cacCurrencyLayerPoints = emptyCacSeries;
      cacCadPoints = emptyCacSeries;
      cadRawCosts = null;
    }

    if (cadRawCosts) {
      const [frankfurterResult, currencyLayerResult] = await Promise.allSettled([
        convertQuickBooksSalesMarketingCostsWithFx(cadRawCosts, "frankfurter"),
        convertQuickBooksSalesMarketingCostsWithFx(cadRawCosts, "currencylayer"),
      ]);
      const cadFxResult = await Promise.allSettled([
        convertQuickBooksSalesMarketingCostsWithFx(cadRawCosts, "frankfurter", "CAD"),
      ]);

      if (frankfurterResult.status === "fulfilled") {
        const frankfurterCosts = frankfurterResult.value.payload as QuickBooksSalesMarketingCostResponse;
        cacPoints = buildCacSeries(
          periodOrder,
          grain,
          buildCostByMonth(frankfurterCosts.points || []),
          combinedNewCustomerCountByPeriod,
          buildCostByMonthByAccount(frankfurterCosts.points || []),
        );
        cacNotice = buildCacAccountMatchNotice(frankfurterCosts, accountIds);
      } else {
        cacNotice = `CAC unavailable: ${conciseErrorMessage(
          frankfurterResult.reason,
          "FX conversion failed.",
        )}`;
        cacPoints = emptyCacSeries;
      }

      if (currencyLayerResult.status === "fulfilled") {
        const currencyLayerCosts = currencyLayerResult.value.payload as QuickBooksSalesMarketingCostResponse;
        cacCurrencyLayerPoints = buildCacSeries(
          periodOrder,
          grain,
          buildCostByMonth(currencyLayerCosts.points || []),
          combinedNewCustomerCountByPeriod,
          buildCostByMonthByAccount(currencyLayerCosts.points || []),
        );
        const accountMatchNotice = buildCacAccountMatchNotice(currencyLayerCosts, accountIds);
        const fxNotice = buildCurrencyLayerFxNotice(currencyLayerResult.value.diagnostics);
        const notices = [
          accountMatchNotice ? `Currencylayer CAC: ${accountMatchNotice}` : null,
          fxNotice,
        ].filter((value): value is string => !!value);
        cacCurrencyLayerNotice = notices.length ? notices.join(" ") : null;
      } else {
        cacCurrencyLayerNotice = `Currencylayer CAC unavailable: ${conciseErrorMessage(
          currencyLayerResult.reason,
          "FX conversion failed.",
        )}`;
        cacCurrencyLayerPoints = emptyCacSeries;
      }

      if (cadFxResult[0]?.status === "fulfilled") {
        const cadCosts = cadFxResult[0].value.payload as QuickBooksSalesMarketingCostResponse;
        cacCadCurrency = "CAD";
        cacCadPoints = buildCacSeries(
          periodOrder,
          grain,
          buildCostByMonth(cadCosts.points || []),
          combinedNewCustomerCountByPeriod,
          buildCostByMonthByAccount(cadCosts.points || []),
        );
        const accountMatchNotice = buildCacAccountMatchNotice(cadCosts, accountIds);
        cacCadNotice = accountMatchNotice ? `CAD CAC: ${accountMatchNotice}` : null;
      } else {
        cacCadNotice = `CAD CAC unavailable: ${conciseErrorMessage(
          cadFxResult[0]?.reason,
          "FX conversion failed.",
        )}`;
        cacCadPoints = emptyCacSeries;
      }
    }
  }

  return {
    startDate,
    endDate,
    grain,
    targetCurrency: String(stripeMain.targetCurrency || targetCurrency || "USD").toUpperCase(),
    currentMrr: round2(currentMrr),
    currentArr: round2(currentMrr * 12),
    points,
    linePoints,
    lineSourcePoints,
    arrPerEmployeePoints,
    salesCyclePoints,
    retentionPoints,
    ltvPoints,
    cacPoints,
    cacCurrencyLayerPoints,
    cacCadPoints,
    ltvNotice,
    arrPerEmployeeNotice,
    salesCycleNotice,
    cacNotice,
    cacCurrencyLayerNotice,
    cacCadNotice,
    cacCadCurrency,
    aiSpendExcludedEnterprisePrepaidCustomers,
    aiSpendDailyPointBreakdown,
  };
}

function sliceMonthlyCombinedBillingOverview(
  canonical: Awaited<ReturnType<typeof buildCombinedBillingOverview>>,
  requestedStartDate: string,
  requestedEndDate: string,
) {
  const startMonthKey = requestedStartDate.slice(0, 7);
  const endMonthKey = requestedEndDate.slice(0, 7);

  const points = filterMonthlyRange(canonical.points, startMonthKey, endMonthKey);
  const linePoints = filterMonthlyRange(canonical.linePoints, startMonthKey, endMonthKey);
  const lineSourcePoints = {
    salesled: filterMonthlyRange(canonical.lineSourcePoints?.salesled || [], startMonthKey, endMonthKey),
    selfserve: filterMonthlyRange(canonical.lineSourcePoints?.selfserve || [], startMonthKey, endMonthKey),
    aiSpend: filterMonthlyRange(canonical.lineSourcePoints?.aiSpend || [], startMonthKey, endMonthKey),
  };
  const arrPerEmployeePoints = filterMonthlyRange(canonical.arrPerEmployeePoints, startMonthKey, endMonthKey);
  const salesCyclePoints = filterMonthlyRange(canonical.salesCyclePoints, startMonthKey, endMonthKey);
  const retentionPoints = filterMonthlyRange(canonical.retentionPoints, startMonthKey, endMonthKey);
  const ltvPoints = filterMonthlyRange(canonical.ltvPoints, startMonthKey, endMonthKey);
  const cacPoints = filterMonthlyRange(canonical.cacPoints, startMonthKey, endMonthKey);
  const cacCurrencyLayerPoints = filterMonthlyRange(canonical.cacCurrencyLayerPoints, startMonthKey, endMonthKey);
  const cacCadPoints = filterMonthlyRange(canonical.cacCadPoints, startMonthKey, endMonthKey);
  const aiSpendExcludedEnterprisePrepaidCustomers = filterMonthlyRange(
    canonical.aiSpendExcludedEnterprisePrepaidCustomers,
    startMonthKey,
    endMonthKey,
  );
  const aiSpendDailyPointBreakdown = filterMonthlyRange(
    canonical.aiSpendDailyPointBreakdown,
    startMonthKey,
    endMonthKey,
  );

  const currentMrr = points.length ? round2(Number(points[points.length - 1].mrrEnd || 0)) : 0;
  const currentArr = round2(currentMrr * 12);

  return {
    ...canonical,
    startDate: requestedStartDate,
    endDate: requestedEndDate,
    currentMrr,
    currentArr,
    points,
    linePoints,
    lineSourcePoints,
    arrPerEmployeePoints,
    salesCyclePoints,
    retentionPoints,
    ltvPoints,
    cacPoints,
    cacCurrencyLayerPoints,
    cacCadPoints,
    aiSpendExcludedEnterprisePrepaidCustomers,
    aiSpendDailyPointBreakdown,
  };
}

async function resolveCacSelectionForRole(payload: ReturnType<typeof parsePayload>, isAdmin: boolean) {
  if (isAdmin) {
    return {
      accountIds: payload.accountIds,
      accountNames: payload.accountNames,
    };
  }
  try {
    const defaults = await loadQuickBooksCacDefaultSelection();
    return {
      accountIds: normalizeIdList(defaults.selectedAccountIds || []),
      accountNames: [] as string[],
    };
  } catch {
    return {
      accountIds: [] as string[],
      accountNames: [] as string[],
    };
  }
}

async function validateAndRun(body: Partial<RequestBody>, isAdmin: boolean) {
  const payload = parsePayload(body);
  const roleScopedSelection = await resolveCacSelectionForRole(payload, isAdmin);
  const cacheScopedSelection = payload.includeCac
    ? roleScopedSelection
    : { accountIds: [] as string[], accountNames: [] as string[] };
  if (payload.grain === "monthly") {
    const todayIso = toIsoDateOnly(new Date());
    const canonicalStartDate = payload.startDate < MONTHLY_CANONICAL_START_DATE
      ? payload.startDate
      : MONTHLY_CANONICAL_START_DATE;
    const canonicalEndDate = payload.endDate > todayIso ? payload.endDate : todayIso;
    const canonicalPayload = {
      ...payload,
      startDate: canonicalStartDate,
      endDate: canonicalEndDate,
      accountIds: cacheScopedSelection.accountIds,
      accountNames: cacheScopedSelection.accountNames,
    };
    const canonicalKey = `api:combined-billing-overview:${stableStringify(canonicalPayload)}`;
    const canonical = await getOrSetCache(canonicalKey, CACHE_TTL_MS, () =>
      buildCombinedBillingOverview(
        canonicalStartDate,
        canonicalEndDate,
        payload.grain,
        cacheScopedSelection.accountIds,
        cacheScopedSelection.accountNames,
        payload.includeCac,
      ),
    );
    return sliceMonthlyCombinedBillingOverview(canonical, payload.startDate, payload.endDate);
  }
  const roleScopedPayload = {
    ...payload,
    accountIds: cacheScopedSelection.accountIds,
    accountNames: cacheScopedSelection.accountNames,
  };
  const key = `api:combined-billing-overview:${stableStringify(roleScopedPayload)}`;
  return getOrSetCache(key, CACHE_TTL_MS, () =>
    buildCombinedBillingOverview(
      payload.startDate,
      payload.endDate,
      payload.grain,
      cacheScopedSelection.accountIds,
      cacheScopedSelection.accountNames,
      payload.includeCac,
    ),
  );
}

export async function POST(req: NextRequest) {
  try {
    const token = await getToken({
      req,
      secret: process.env.AUTH_SECRET,
    });
    const isAdmin = String(token?.role || "viewer").trim().toLowerCase() === "admin";
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Partial<RequestBody>;
    const report = await validateAndRun(body, isAdmin);
    return NextResponse.json(report);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") ||
      message.includes("Invalid grain") ||
      message.includes("endDate must be >= startDate")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function GET(req: NextRequest) {
  try {
    const token = await getToken({
      req,
      secret: process.env.AUTH_SECRET,
    });
    const isAdmin = String(token?.role || "viewer").trim().toLowerCase() === "admin";
    const { searchParams } = new URL(req.url);
    const body: Partial<RequestBody> = {
      startDate: searchParams.get("startDate") || "",
      endDate: searchParams.get("endDate") || "",
      grain: searchParams.get("grain") || "monthly",
      accountIds: (searchParams.get("accountIds") || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      accountNames: (searchParams.get("accountNames") || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      includeCac: (searchParams.get("includeCac") || "").toLowerCase() !== "false",
    };
    const report = await validateAndRun(body, isAdmin);
    return NextResponse.json(report);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") ||
      message.includes("Invalid grain") ||
      message.includes("endDate must be >= startDate")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
