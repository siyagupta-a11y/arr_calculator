import { NextResponse } from "next/server";
import { generateReport } from "@/lib/report";
import type { ReportResponse, ReportRow } from "@/lib/types";
import {
  queryStripeAiSpendFromBigQuery,
  queryStripeBillingOverviewFromBigQuery,
  type StripeBillingOverviewPoint,
  type StripeBillingOverviewCustomerArrRow,
} from "@/lib/stripeBigquery";
import { resolveEnterprisePrepaidAiSpendExclusions } from "@/lib/aiSpendEnterprisePrepaidExclusions";
import { generateCombinedAllSubsReport } from "@/lib/combinedAllSubsReport";
import { queryBambooHrFullTimeHeadcountByDate } from "@/lib/bamboohr";
import { fetchQuickBooksSalesMarketingCostsByMonth } from "@/lib/quickbooks";
import {
  getMonthlyAverageCurrencyLayerFxRateForCloseMonth,
  getMonthlyAverageFxRateForCloseMonth,
} from "@/lib/fx";
import { FX_TARGET_CURRENCY } from "@/lib/logic";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 300;
const CACHE_TTL_MS = readTtlMs("API_COMBINED_BILLING_OVERVIEW_CACHE_TTL_MS", 60_000);

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

function annualizedArrFromRevenueForPeriod(revenue: number, periodStart: string, periodEnd: string) {
  const start = parseIsoDateOnly(String(periodStart || "").slice(0, 10));
  const end = parseIsoDateOnly(String(periodEnd || "").slice(0, 10));
  if (!start || !end || end.getTime() < start.getTime()) {
    return round2(Number(revenue || 0) * 12);
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
  const shouldComputeLtv = grain === "monthly";
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
    const exclusions = await resolveEnterprisePrepaidAiSpendExclusions({
      startDate,
      endDate,
      targetCurrency,
    }).catch(() => ({ customerMonthPrepaidOffsets: [] }));
    return queryStripeAiSpendFromBigQuery(
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
    );
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

  const stripeMainPromise = queryStripeBillingOverviewFromBigQuery(
    {
      startDate,
      endDate,
      grain,
      groupBy: "none",
      targetCurrency,
      includeCustomerArrRows: includeCac || shouldComputeLtv,
      includeCurrentMonthProjection: false,
    },
    { profile: "stripe_arr_correct" },
  );
  const hubspotMainPromise = generateReport({ startDate, endDate, mode: "contracted", grain });
  const hubspotBaselinePromise = generateReport({
    startDate: previousRange.startDate,
    endDate: previousRange.endDate,
    mode: "contracted",
    grain,
  });
  const stripeBaselinePromise: Promise<Awaited<ReturnType<typeof queryStripeBillingOverviewFromBigQuery>> | null> = includeCac || shouldComputeLtv
    ? queryStripeBillingOverviewFromBigQuery(
        {
          startDate: previousRange.startDate,
          endDate: previousRange.endDate,
          grain,
          groupBy: "none",
          targetCurrency,
          includeCustomerArrRows: includeCac || shouldComputeLtv,
          includeCurrentMonthProjection: false,
        },
        { profile: "stripe_arr_correct" },
      ).catch(() => null)
    : Promise.resolve(null);
  const [hubspotMain, hubspotBaseline, stripeMain, stripeBaseline] = await Promise.all([
    hubspotMainPromise,
    hubspotBaselinePromise,
    stripeMainPromise,
    stripeBaselinePromise,
  ]);

  const periodOrder: PeriodRef[] = (hubspotMain.periods || []).map((period) => ({
    key: String(period.key || ""),
    label: String(period.label || period.key || ""),
  }));

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
    const aiBuild = buildAiSpendSourceSeries(
      periodOrder,
      grain,
      (aiSpendSeries.points || []).map((point) => ({
        periodStart: String(point.periodStart || ""),
        periodEnd: String(point.periodEnd || ""),
        revenue: Number(point.revenue || 0),
      })),
      previousRange.startDate,
    );
    aiSpendSourcePoints = aiBuild.points;
    linePoints = mergeCombinedAndAiSeries(points, aiSpendSourcePoints, initialPrevCombinedMrr, aiBuild.initialPrevMrr);
  } catch {
    aiSpendSourcePoints = aiSpendSourcePoints.map((point) => ({ ...point }));
    linePoints = points;
  }
  const lineSourcePoints: LineSourcePoints = {
    salesled: hubPoints,
    selfserve: selfservePoints,
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
  }));
  try {
    const snapshotDateByKey = new Map<string, string>();
    for (const point of linePoints) {
      const key = canonicalHubPeriodKey(point.key, grain) || point.key;
      const snapshotDate = periodEndIsoFromKey(key, grain);
      if (snapshotDate) snapshotDateByKey.set(key, snapshotDate);
    }
    const headcountByDate = await queryBambooHrFullTimeHeadcountByDate(Array.from(snapshotDateByKey.values()));
    arrPerEmployeePoints = linePoints.map((point) => {
      const key = canonicalHubPeriodKey(point.key, grain) || point.key;
      const snapshotDate = snapshotDateByKey.get(key) || "";
      const fullTimeEmployees = Math.max(0, Math.round(Number(headcountByDate.get(snapshotDate) || 0)));
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

  const currentMrr = points.length ? points[points.length - 1].mrrEnd : 0;
  const retentionPoints: RetentionSeriesPoint[] = periodOrder.map((period, idx) => {
    const key = canonicalHubPeriodKey(period.key, grain) || period.key;
    return {
      key,
      label: period.label,
      selfserveGdrPct: selfservePoints[idx]?.gdrPct || 0,
      salesledGdrPct: hubPoints[idx]?.gdrPct || 0,
      combinedGdrPct: points[idx]?.gdrPct || 0,
      selfserveNdrPct: selfservePoints[idx]?.ndrPct || 0,
      salesledNdrPct: hubPoints[idx]?.ndrPct || 0,
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
    retentionPoints,
    ltvPoints,
    cacPoints,
    cacCurrencyLayerPoints,
    cacCadPoints,
    ltvNotice,
    arrPerEmployeeNotice,
    cacNotice,
    cacCurrencyLayerNotice,
    cacCadNotice,
    cacCadCurrency,
  };
}

async function validateAndRun(body: Partial<RequestBody>) {
  const payload = parsePayload(body);
  const key = `api:combined-billing-overview:${stableStringify(payload)}`;
  return getOrSetCache(key, CACHE_TTL_MS, () =>
    buildCombinedBillingOverview(
      payload.startDate,
      payload.endDate,
      payload.grain,
      payload.accountIds,
      payload.accountNames,
      payload.includeCac,
    ),
  );
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Partial<RequestBody>;
    const report = await validateAndRun(body);
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

export async function GET(req: Request) {
  try {
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
    const report = await validateAndRun(body);
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
