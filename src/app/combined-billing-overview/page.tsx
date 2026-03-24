"use client";

import Link from "next/link";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { downloadSvgAsPng } from "@/lib/chartDownload";
import type { ReportResponse, ReportRow } from "@/lib/types";

type CombinedGrain = "daily" | "monthly" | "quarterly";
type CacFxProvider = "frankfurter" | "currencylayer";
type CacMenuTarget = CacFxProvider | null;

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

type StripeOverviewPoint = {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  mrrEnd: number;
  newMrr: number;
  reactivationMrr?: number;
  expansionMrr: number;
  contractionMrr: number;
  churnMrr: number;
  netMrrChange: number;
  mrrGrowthRatePct: number;
  arr: number;
  arrGrowth: number;
};

type StripeOverviewCustomerArrRow = {
  customerId: string;
  periodKey: string;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  arr: number;
};

type StripeOverviewResponse = {
  startDate: string;
  endDate: string;
  grain: "daily" | "weekly" | "monthly" | "quarterly";
  targetCurrency: string;
  currentMrr: number;
  currentArr: number;
  historyPoints?: StripeOverviewPoint[];
  points: StripeOverviewPoint[];
  stripeExactHistoryPoints?: StripeOverviewPoint[];
  stripeExactPoints?: StripeOverviewPoint[];
  customerArrRows?: StripeOverviewCustomerArrRow[];
};

type QuickBooksSalesMarketingCostPoint = {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  totalCost: number;
  matchedAccounts: string[];
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
  points: QuickBooksSalesMarketingCostPoint[];
  matchedAccounts: string[];
};

type QuickBooksExpenseAccount = {
  id: string;
  name: string;
  fullyQualifiedName: string;
  accountType: string;
  subAccount: boolean;
  active: boolean;
};

type QuickBooksExpenseAccountsResponse = {
  realmId: string;
  accounts: QuickBooksExpenseAccount[];
};

type QuickBooksCacAccountDefaultResponse = {
  storage: "vercel_blob" | "local_tmp";
  selectedAccountIds: string[];
  updatedAt: number;
};

type CacPoint = {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  salesMarketingCost: number;
  newCustomerCount: number;
  cac: number;
};

type CombinedLiveArrResponse = {
  generatedAtUtc: string;
  liveArr: number;
  projectedArr: number;
};

type HubspotChartRow = {
  accountId: string;
  deploymentType: string;
  valuesByPeriod: Record<string, number>;
};

type PeriodRef = {
  key: string;
  label: string;
};

type RetentionSource = "combined" | "salesled" | "selfserve";

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

type CombinedOverviewData = {
  startDate: string;
  endDate: string;
  grain: CombinedGrain;
  targetCurrency: string;
  currentMrr: number;
  currentArr: number;
  liveArr: number;
  liveArrAsOfUtc: string;
  projectedArr: number;
  points: CombinedPoint[];
  retentionPoints: RetentionSeriesPoint[];
  cacPoints: CacPoint[];
  cacCurrencyLayerPoints: CacPoint[];
};

function round2(n: number) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function normalizeEntityId(value: string) {
  return String(value || "").trim().replace(/\.0+$/, "");
}

function normalizeIdList(values: string[]) {
  return Array.from(new Set(values.map((value) => normalizeEntityId(value)).filter(Boolean)));
}

function isCloudDeploymentType(value: string) {
  return String(value || "").trim().toLowerCase() === "cloud";
}

function hasAnyNonZeroValue(valuesByPeriod: Record<string, number>) {
  return Object.values(valuesByPeriod || {}).some((value) => Math.abs(Number(value) || 0) > 1e-9);
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

function accountGroupingKey(row: HubspotChartRow) {
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

function canonicalStripePeriodKey(point: StripeOverviewPoint, grain: CombinedGrain) {
  if (grain === "daily") return String(point.periodStart || "").slice(0, 10);
  if (grain === "monthly") return String(point.periodStart || "").slice(0, 7);
  return quarterKeyFromIsoDate(String(point.periodStart || ""));
}

function canonicalStripeCustomerPeriodKey(row: StripeOverviewCustomerArrRow, grain: CombinedGrain) {
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

function conciseErrorMessage(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  const trimmed = String(message || fallback).trim();
  if (!trimmed) return fallback;
  return trimmed.length > 220 ? `${trimmed.slice(0, 220)}...` : trimmed;
}

function defaultDateRange() {
  const end = new Date();
  const start = new Date(end.getFullYear() - 1, end.getMonth(), 1);
  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  return { startDate: toIso(start), endDate: toIso(end) };
}

function formatMoney(value: number, currency: string) {
  const normalized = String(currency || "USD").toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: normalized,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value || 0);
  } catch {
    return new Intl.NumberFormat(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value || 0);
  }
}

function formatPercent(value: number) {
  return `${new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value || 0)}%`;
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

function buildCostByMonth(points: QuickBooksSalesMarketingCostPoint[]) {
  const byMonth = new Map<string, number>();
  for (const point of points || []) {
    const key = String(point.key || point.periodStart || "").trim().slice(0, 7);
    if (!key) continue;
    byMonth.set(key, round2((byMonth.get(key) || 0) + Number(point.totalCost || 0)));
  }
  return byMonth;
}

function buildCacSeries(
  periodOrder: PeriodRef[],
  grain: CombinedGrain,
  costByMonth: Map<string, number>,
  newCustomerCountByPeriod: Map<string, number>,
): CacPoint[] {
  return periodOrder.map((period) => {
    const key = canonicalHubPeriodKey(period.key, grain) || period.key;
    const salesMarketingCost = round2(costByMonth.get(key) || 0);
    const newCustomerCount = newCustomerCountByPeriod.get(key) || 0;
    const cac = newCustomerCount > 0 ? round2(salesMarketingCost / newCustomerCount) : 0;
    const periodStart = grain === "monthly" ? `${key}-01` : key;
    return {
      key,
      label: period.label,
      periodStart,
      periodEnd: periodStart,
      salesMarketingCost,
      newCustomerCount,
      cac,
    };
  });
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

function csvEscape(value: string | number) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function downloadCsv(filename: string, rows: Array<Array<string | number>>) {
  const lines = rows.map((row) => row.map((cell) => csvEscape(cell)).join(","));
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function tickIndices(size: number) {
  if (size <= 1) return [0];
  if (size <= 4) return Array.from({ length: size }, (_, i) => i);
  const out = new Set<number>([0, Math.floor((size - 1) / 2), size - 1]);
  return Array.from(out).sort((a, b) => a - b);
}

type LineChartPointBase = {
  key: string;
  label: string;
};

type LineChartProps<TPoint extends LineChartPointBase> = {
  title: string;
  subtitle: string;
  points: TPoint[];
  valueAccessor: (point: TPoint) => number;
  valueFormatter: (value: number) => string;
  stroke: string;
  includeZero?: boolean;
};

function LineChartCard<TPoint extends LineChartPointBase>({
  title,
  subtitle,
  points,
  valueAccessor,
  valueFormatter,
  stroke,
  includeZero = false,
}: LineChartProps<TPoint>) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const chartRef = useRef<SVGSVGElement | null>(null);
  const [downloading, setDownloading] = useState(false);

  const width = 640;
  const height = 250;
  const paddingLeft = 54;
  const paddingRight = 20;
  const paddingTop = 20;
  const paddingBottom = 42;
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;

  const values = points.map((p) => valueAccessor(p));
  const minRaw = values.length ? Math.min(...values) : 0;
  const maxRaw = values.length ? Math.max(...values) : 1;
  let minValue = includeZero ? Math.min(minRaw, 0) : minRaw;
  let maxValue = includeZero ? Math.max(maxRaw, 0) : maxRaw;
  if (Math.abs(maxValue - minValue) < 1e-9) {
    minValue -= 1;
    maxValue += 1;
  }

  const xAt = (idx: number) => {
    if (points.length <= 1) return paddingLeft + plotWidth / 2;
    return paddingLeft + (idx / (points.length - 1)) * plotWidth;
  };
  const yAt = (value: number) => paddingTop + ((maxValue - value) / (maxValue - minValue)) * plotHeight;

  const pathD = points
    .map((p, idx) => `${idx === 0 ? "M" : "L"} ${xAt(idx)} ${yAt(valueAccessor(p))}`)
    .join(" ");

  const hoveredPoint =
    hoverIndex != null && hoverIndex >= 0 && hoverIndex < points.length ? points[hoverIndex] : null;
  const hoveredValue = hoveredPoint ? valueAccessor(hoveredPoint) : 0;
  const hoveredX = hoveredPoint && hoverIndex != null ? xAt(hoverIndex) : 0;
  const hoveredY = hoveredPoint ? yAt(hoveredValue) : 0;

  const tooltipWidth = 230;
  const tooltipHeight = 42;
  const tooltipX = Math.max(
    paddingLeft,
    Math.min(paddingLeft + plotWidth - tooltipWidth, hoveredX - tooltipWidth / 2),
  );
  const tooltipY = Math.max(paddingTop + 4, hoveredY - tooltipHeight - 10);
  const downloadChart = useCallback(async () => {
    if (!chartRef.current || downloading) return;
    setDownloading(true);
    try {
      await downloadSvgAsPng(chartRef.current, `combined-billing-overview-${title}`);
    } finally {
      setDownloading(false);
    }
  }, [downloading, title]);

  return (
    <section className="stripe-ui__panel ui-reveal ui-reveal-2">
      <div className="stripe-ui__section-head">
        <div>
          <h2 className="stripe-ui__panel-title">{title}</h2>
          <p className="stripe-ui__panel-subtitle" style={{ marginBottom: 0 }}>
            {subtitle}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button className="stripe-ui__btn stripe-ui__btn--ghost" onClick={() => void downloadChart()} disabled={downloading}>
            {downloading ? "Downloading..." : "Download SVG"}
          </button>
          <div className="stripe-ui__hint" aria-live="polite">
            {hoveredPoint
              ? `${hoveredPoint.label}: ${valueFormatter(hoveredValue)}`
              : "Hover on chart for values"}
          </div>
        </div>
      </div>

      {points.length === 0 ? (
        <p className="stripe-ui__panel-subtitle" style={{ marginTop: "0.7rem", marginBottom: 0 }}>
          No data for selected range.
        </p>
      ) : (
        <div className="stripe-ui__table-wrap" style={{ marginTop: "0.9rem" }}>
          <svg
            ref={chartRef}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={title}
            style={{ width: "100%", display: "block" }}
            onMouseLeave={() => setHoverIndex(null)}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const relX = ((e.clientX - rect.left) / rect.width) * width;
              const clamped = Math.max(paddingLeft, Math.min(paddingLeft + plotWidth, relX));
              const ratio = points.length > 1 ? (clamped - paddingLeft) / plotWidth : 0;
              const idx = Math.max(0, Math.min(points.length - 1, Math.round(ratio * Math.max(points.length - 1, 0))));
              setHoverIndex(idx);
            }}
          >
            <line
              x1={paddingLeft}
              y1={paddingTop + plotHeight}
              x2={paddingLeft + plotWidth}
              y2={paddingTop + plotHeight}
              stroke="#36557f"
              strokeWidth={1}
            />
            <line x1={paddingLeft} y1={paddingTop} x2={paddingLeft} y2={paddingTop + plotHeight} stroke="#36557f" strokeWidth={1} />

            {points.map((point, idx) => {
              const left = idx === 0 ? paddingLeft : (xAt(idx - 1) + xAt(idx)) / 2;
              const right = idx === points.length - 1 ? paddingLeft + plotWidth : (xAt(idx) + xAt(idx + 1)) / 2;
              return (
                <rect
                  key={`hover-${point.key}`}
                  x={left}
                  y={paddingTop}
                  width={Math.max(1, right - left)}
                  height={plotHeight}
                  fill="transparent"
                  onMouseEnter={() => setHoverIndex(idx)}
                />
              );
            })}

            <path d={pathD} fill="none" stroke={stroke} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />

            {hoverIndex != null && points[hoverIndex] && (
              <line
                x1={xAt(hoverIndex)}
                y1={paddingTop}
                x2={xAt(hoverIndex)}
                y2={paddingTop + plotHeight}
                stroke="#89a9d4"
                strokeOpacity={0.5}
                strokeDasharray="4 4"
              />
            )}

            {hoveredPoint && (
              <g>
                <rect x={tooltipX} y={tooltipY} width={tooltipWidth} height={tooltipHeight} rx={6} fill="#0e203b" opacity={0.97} />
                <text x={tooltipX + 10} y={tooltipY + 16} fill="#d9e6fa" fontSize="11.5">
                  {hoveredPoint.label}
                </text>
                <text x={tooltipX + 10} y={tooltipY + 32} fill={stroke} fontSize="12.5" fontWeight="600">
                  {valueFormatter(hoveredValue)}
                </text>
              </g>
            )}

            {points.map((point, idx) => (
              <circle
                key={point.key}
                cx={xAt(idx)}
                cy={yAt(valueAccessor(point))}
                r={hoverIndex === idx ? 4.6 : 3.2}
                fill={stroke}
                data-tooltip={`${point.label}: ${valueFormatter(valueAccessor(point))}`}
                onMouseEnter={() => setHoverIndex(idx)}
              />
            ))}

            {tickIndices(points.length).map((idx) => (
              <text
                key={`tick-${idx}`}
                x={xAt(idx)}
                y={height - 12}
                textAnchor={idx === 0 ? "start" : idx === points.length - 1 ? "end" : "middle"}
                fill="#b7c9e6"
                fontSize="12"
              >
                {points[idx]?.label || ""}
              </text>
            ))}

            <text x={paddingLeft - 8} y={paddingTop + 10} textAnchor="end" fill="#8ea7cb" fontSize="12">
              {valueFormatter(maxValue)}
            </text>
            <text x={paddingLeft - 8} y={paddingTop + plotHeight} textAnchor="end" fill="#8ea7cb" fontSize="12">
              {valueFormatter(minValue)}
            </text>
          </svg>
        </div>
      )}
    </section>
  );
}

type CacChartCardProps = {
  points: CacPoint[];
  currency: string;
  title?: string;
  subtitle?: string;
  accentColor?: string;
  downloadFilename?: string;
  tableTitle?: string;
  tableAriaLabel?: string;
  showAccountSelector?: boolean;
  expenseAccounts: QuickBooksExpenseAccount[];
  selectedAccountIds: string[];
  runLoading: boolean;
  accountMenuOpen: boolean;
  accountsLoading: boolean;
  accountsError: string;
  savingDefaultSelection: boolean;
  defaultSaveStatus: string;
  onToggleAccountMenu: () => void;
  onRefreshAccounts: () => void;
  onToggleAccountSelection: (accountId: string) => void;
  onSelectAllAccounts: () => void;
  onClearAccounts: () => void;
  onSaveDefaultSelection: () => void;
  onApplySelection: () => void;
};

function CacChartCard({
  points,
  currency,
  title = "CAC Over Time",
  subtitle = "CAC = Sales & Marketing Cost / Total Users. Click the chart to open the data table.",
  accentColor = "#e879f9",
  downloadFilename = "combined-billing-overview-cac-over-time",
  tableTitle = "CAC Table",
  tableAriaLabel = "CAC table",
  showAccountSelector = true,
  expenseAccounts,
  selectedAccountIds,
  runLoading,
  accountMenuOpen,
  accountsLoading,
  accountsError,
  savingDefaultSelection,
  defaultSaveStatus,
  onToggleAccountMenu,
  onRefreshAccounts,
  onToggleAccountSelection,
  onSelectAllAccounts,
  onClearAccounts,
  onSaveDefaultSelection,
  onApplySelection,
}: CacChartCardProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const chartRef = useRef<SVGSVGElement | null>(null);
  const [downloading, setDownloading] = useState(false);

  const width = 640;
  const height = 250;
  const paddingLeft = 54;
  const paddingRight = 20;
  const paddingTop = 20;
  const paddingBottom = 42;
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;

  const values = points.map((point) => point.cac);
  const minRaw = values.length ? Math.min(...values) : 0;
  const maxRaw = values.length ? Math.max(...values) : 1;
  let minValue = Math.min(minRaw, 0);
  let maxValue = Math.max(maxRaw, 0);
  if (Math.abs(maxValue - minValue) < 1e-9) {
    minValue -= 1;
    maxValue += 1;
  }

  const xAt = (idx: number) => {
    if (points.length <= 1) return paddingLeft + plotWidth / 2;
    return paddingLeft + (idx / (points.length - 1)) * plotWidth;
  };
  const yAt = (value: number) => paddingTop + ((maxValue - value) / (maxValue - minValue)) * plotHeight;

  const pathD = points
    .map((point, idx) => `${idx === 0 ? "M" : "L"} ${xAt(idx)} ${yAt(point.cac)}`)
    .join(" ");

  const hoveredPoint =
    hoverIndex != null && hoverIndex >= 0 && hoverIndex < points.length ? points[hoverIndex] : null;
  const hoveredX = hoveredPoint && hoverIndex != null ? xAt(hoverIndex) : 0;
  const hoveredY = hoveredPoint ? yAt(hoveredPoint.cac) : 0;

  const tooltipWidth = 280;
  const tooltipHeight = 72;
  const tooltipX = Math.max(
    paddingLeft,
    Math.min(paddingLeft + plotWidth - tooltipWidth, hoveredX - tooltipWidth / 2),
  );
  const tooltipY = Math.max(paddingTop + 4, hoveredY - tooltipHeight - 10);
  const selectedCount = selectedAccountIds.length;
  const selectedAccountIdSet = useMemo(
    () => new Set(normalizeIdList(selectedAccountIds)),
    [selectedAccountIds],
  );

  const downloadChart = useCallback(async () => {
    if (!chartRef.current || downloading) return;
    setDownloading(true);
    try {
      await downloadSvgAsPng(chartRef.current, downloadFilename);
    } finally {
      setDownloading(false);
    }
  }, [downloadFilename, downloading]);

  const exportTableCsv = () => {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const rows: Array<Array<string | number>> = [
      ["Period", "CAC", "Sales & Marketing Cost", "Total Users"],
      ...points.map((point) => [
        point.label,
        round2(point.cac),
        round2(point.salesMarketingCost),
        Math.max(0, Math.round(point.newCustomerCount || 0)),
      ]),
    ];
    downloadCsv(`combined-cac-over-time-${stamp}.csv`, rows);
  };

  return (
    <section className="stripe-ui__panel ui-reveal ui-reveal-2">
      <div className="stripe-ui__section-head">
        <div>
          <h2 className="stripe-ui__panel-title">{title}</h2>
          <p className="stripe-ui__panel-subtitle" style={{ marginBottom: 0 }}>
            {subtitle}
          </p>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
            flexWrap: "wrap",
            justifyContent: "flex-end",
            position: "relative",
          }}
        >
          {showAccountSelector ? (
            <button
              className="stripe-ui__btn stripe-ui__btn--ghost"
              onClick={onToggleAccountMenu}
              aria-haspopup="menu"
              aria-expanded={accountMenuOpen}
              title="Configure CAC expense accounts"
              style={{ minWidth: "2.2rem", paddingInline: "0.55rem" }}
            >
              ...
            </button>
          ) : null}
          <button className="stripe-ui__btn stripe-ui__btn--ghost" onClick={() => void downloadChart()} disabled={downloading}>
            {downloading ? "Downloading..." : "Download SVG"}
          </button>
          <div className="stripe-ui__hint" aria-live="polite">
            {hoveredPoint
              ? `${hoveredPoint.label}: CAC ${formatMoney(hoveredPoint.cac, currency)}`
              : "Hover on chart for values"}
          </div>

          {showAccountSelector && accountMenuOpen && (
            <div
              className="stripe-ui__panel"
              style={{
                position: "absolute",
                right: 0,
                top: "2.6rem",
                zIndex: 30,
                width: "min(460px, 92vw)",
                padding: "0.85rem",
                borderColor: "#3e5e89",
              }}
              role="menu"
            >
              <div className="stripe-ui__hint" style={{ marginBottom: "0.55rem" }}>
                Select expense accounts used for CAC Sales &amp; Marketing cost.
              </div>

              <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap", marginBottom: "0.55rem" }}>
                <button className="stripe-ui__btn stripe-ui__btn--secondary" onClick={onSelectAllAccounts} disabled={accountsLoading}>
                  Select all
                </button>
                <button className="stripe-ui__btn stripe-ui__btn--secondary" onClick={onClearAccounts} disabled={accountsLoading}>
                  Clear
                </button>
                <button className="stripe-ui__btn stripe-ui__btn--primary" onClick={onApplySelection} disabled={runLoading}>
                  Apply selection
                </button>
                <button
                  className="stripe-ui__btn stripe-ui__btn--primary"
                  onClick={onSaveDefaultSelection}
                  disabled={savingDefaultSelection}
                >
                  {savingDefaultSelection ? "Saving..." : "Save as default"}
                </button>
                <button className="stripe-ui__btn stripe-ui__btn--ghost" onClick={onRefreshAccounts} disabled={accountsLoading}>
                  Refresh
                </button>
              </div>

              {defaultSaveStatus ? (
                <div className="stripe-ui__hint" style={{ marginBottom: "0.55rem" }}>
                  {defaultSaveStatus}
                </div>
              ) : null}

              {accountsError ? (
                <div className="stripe-ui__hint" style={{ color: "#f4a4b7", marginBottom: "0.55rem" }}>
                  {accountsError}
                </div>
              ) : null}

              {accountsLoading ? (
                <div className="stripe-ui__hint">Loading expense accounts...</div>
              ) : expenseAccounts.length === 0 ? (
                <div className="stripe-ui__hint">No expense accounts found or QuickBooks is not connected.</div>
              ) : (
                <div
                  className="stripe-ui__table-wrap"
                  style={{ maxHeight: "240px", overflow: "auto", padding: "0.45rem", marginBottom: "0.45rem" }}
                >
                  <div style={{ display: "grid", gap: "0.35rem" }}>
                    {expenseAccounts.map((account) => {
                      const checked = selectedAccountIdSet.has(normalizeEntityId(String(account.id || "")));
                      return (
                        <label
                          key={`cac-account-${account.id}`}
                          style={{ display: "flex", alignItems: "flex-start", gap: "0.45rem", cursor: "pointer" }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => onToggleAccountSelection(account.id)}
                            style={{ marginTop: "0.2rem" }}
                          />
                          <span className="stripe-ui__hint">
                            {account.fullyQualifiedName || account.name}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="stripe-ui__hint">
                {selectedCount > 0
                  ? `${selectedCount} selected account${selectedCount === 1 ? "" : "s"} will be used for CAC cost.`
                  : "No accounts selected. CAC cost falls back to automatic Sales/Marketing matching."}
              </div>
            </div>
          )}
        </div>
      </div>

      {points.length === 0 ? (
        <p className="stripe-ui__panel-subtitle" style={{ marginTop: "0.7rem", marginBottom: 0 }}>
          No data for selected range.
        </p>
      ) : (
        <>
          <div className="stripe-ui__table-wrap" style={{ marginTop: "0.9rem", cursor: "pointer" }}>
            <svg
              ref={chartRef}
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label="CAC over time chart"
              style={{ width: "100%", display: "block" }}
              onClick={() => setShowTable(true)}
              onMouseLeave={() => setHoverIndex(null)}
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const relX = ((e.clientX - rect.left) / rect.width) * width;
                const clamped = Math.max(paddingLeft, Math.min(paddingLeft + plotWidth, relX));
                const ratio = points.length > 1 ? (clamped - paddingLeft) / plotWidth : 0;
                const idx = Math.max(0, Math.min(points.length - 1, Math.round(ratio * Math.max(points.length - 1, 0))));
                setHoverIndex(idx);
              }}
            >
              <line
                x1={paddingLeft}
                y1={paddingTop + plotHeight}
                x2={paddingLeft + plotWidth}
                y2={paddingTop + plotHeight}
                stroke="#36557f"
                strokeWidth={1}
              />
              <line
                x1={paddingLeft}
                y1={paddingTop}
                x2={paddingLeft}
                y2={paddingTop + plotHeight}
                stroke="#36557f"
                strokeWidth={1}
              />

              {points.map((point, idx) => {
                const left = idx === 0 ? paddingLeft : (xAt(idx - 1) + xAt(idx)) / 2;
                const right = idx === points.length - 1 ? paddingLeft + plotWidth : (xAt(idx) + xAt(idx + 1)) / 2;
                return (
                  <rect
                    key={`hover-${point.key}`}
                    x={left}
                    y={paddingTop}
                    width={Math.max(1, right - left)}
                    height={plotHeight}
                    fill="transparent"
                    onMouseEnter={() => setHoverIndex(idx)}
                  />
                );
              })}

              <path d={pathD} fill="none" stroke={accentColor} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />

              {hoverIndex != null && points[hoverIndex] && (
                <line
                  x1={xAt(hoverIndex)}
                  y1={paddingTop}
                  x2={xAt(hoverIndex)}
                  y2={paddingTop + plotHeight}
                  stroke="#89a9d4"
                  strokeOpacity={0.5}
                  strokeDasharray="4 4"
                />
              )}

              {hoveredPoint && (
                <g>
                  <rect x={tooltipX} y={tooltipY} width={tooltipWidth} height={tooltipHeight} rx={6} fill="#0e203b" opacity={0.97} />
                  <text x={tooltipX + 10} y={tooltipY + 16} fill="#d9e6fa" fontSize="11.5">
                    {hoveredPoint.label}
                  </text>
                  <text x={tooltipX + 10} y={tooltipY + 33} fill={accentColor} fontSize="12.5" fontWeight="600">
                    CAC: {formatMoney(hoveredPoint.cac, currency)}
                  </text>
                  <text x={tooltipX + 10} y={tooltipY + 50} fill="#d9e6fa" fontSize="11.5">
                    S&M Cost: {formatMoney(hoveredPoint.salesMarketingCost, currency)}
                  </text>
                  <text x={tooltipX + 10} y={tooltipY + 65} fill="#d9e6fa" fontSize="11.5">
                    Total Users: {Math.max(0, Math.round(hoveredPoint.newCustomerCount || 0))}
                  </text>
                </g>
              )}

              {points.map((point, idx) => (
                <circle
                  key={point.key}
                  cx={xAt(idx)}
                  cy={yAt(point.cac)}
                  r={hoverIndex === idx ? 4.6 : 3.2}
                  fill={accentColor}
                  data-tooltip={`${point.label}: CAC ${formatMoney(point.cac, currency)} | S&M ${formatMoney(point.salesMarketingCost, currency)} | Users ${Math.max(0, Math.round(point.newCustomerCount || 0))}`}
                  onMouseEnter={() => setHoverIndex(idx)}
                />
              ))}

              {tickIndices(points.length).map((idx) => (
                <text
                  key={`tick-${idx}`}
                  x={xAt(idx)}
                  y={height - 12}
                  textAnchor={idx === 0 ? "start" : idx === points.length - 1 ? "end" : "middle"}
                  fill="#b7c9e6"
                  fontSize="12"
                >
                  {points[idx]?.label || ""}
                </text>
              ))}

              <text x={paddingLeft - 8} y={paddingTop + 10} textAnchor="end" fill="#8ea7cb" fontSize="12">
                {formatMoney(maxValue, currency)}
              </text>
              <text x={paddingLeft - 8} y={paddingTop + plotHeight} textAnchor="end" fill="#8ea7cb" fontSize="12">
                {formatMoney(minValue, currency)}
              </text>
            </svg>
          </div>

          {showTable && (
            <div className="stripe-ui__panel" style={{ marginTop: "0.9rem", padding: "0.85rem" }}>
              <div className="stripe-ui__section-head" style={{ marginBottom: "0.65rem" }}>
                <h3 className="stripe-ui__panel-title" style={{ margin: 0, fontSize: "1rem" }}>
                  {tableTitle}
                </h3>
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                  <button className="stripe-ui__btn stripe-ui__btn--secondary" onClick={exportTableCsv}>
                    Export CSV
                  </button>
                  <button className="stripe-ui__btn stripe-ui__btn--ghost" onClick={() => setShowTable(false)}>
                    Hide table
                  </button>
                </div>
              </div>

              <div className="stripe-ui__table-wrap">
                <table className="stripe-ui__table" aria-label={tableAriaLabel}>
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th className="stripe-ui__num">CAC</th>
                      <th className="stripe-ui__num">Sales &amp; Marketing Cost</th>
                      <th className="stripe-ui__num">Total Users</th>
                    </tr>
                  </thead>
                  <tbody>
                    {points.map((point) => (
                      <tr key={`cac-row-${point.key}`}>
                        <td>{point.label}</td>
                        <td className="stripe-ui__num">{formatMoney(point.cac, currency)}</td>
                        <td className="stripe-ui__num">{formatMoney(point.salesMarketingCost, currency)}</td>
                        <td className="stripe-ui__num">{Math.max(0, Math.round(point.newCustomerCount || 0))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

type RetentionRatesChartCardProps = {
  points: RetentionSeriesPoint[];
};

function RetentionRatesChartCard({ points }: RetentionRatesChartCardProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [source, setSource] = useState<RetentionSource>("combined");
  const chartRef = useRef<SVGSVGElement | null>(null);
  const [downloading, setDownloading] = useState(false);

  const width = 640;
  const height = 250;
  const paddingLeft = 54;
  const paddingRight = 20;
  const paddingTop = 20;
  const paddingBottom = 42;
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;

  const sourceLabel =
    source === "salesled"
      ? "Sales-led (HubSpot only)"
      : source === "selfserve"
        ? "Self-serve (Stripe Billing Overview only)"
        : "Combined";
  const ndrFor = (point: RetentionSeriesPoint) =>
    source === "salesled"
      ? point.salesledNdrPct
      : source === "selfserve"
        ? point.selfserveNdrPct
        : point.combinedNdrPct;
  const gdrFor = (point: RetentionSeriesPoint) =>
    source === "salesled"
      ? point.salesledGdrPct
      : source === "selfserve"
        ? point.selfserveGdrPct
        : point.combinedGdrPct;

  const ndrValues = points.map((point) => ndrFor(point));
  const gdrValues = points.map((point) => gdrFor(point));
  const allValues = [...ndrValues, ...gdrValues];

  const minRaw = allValues.length ? Math.min(...allValues) : 0;
  const maxRaw = allValues.length ? Math.max(...allValues) : 1;
  let minValue = minRaw;
  let maxValue = maxRaw;
  if (Math.abs(maxValue - minValue) < 1e-9) {
    minValue -= 1;
    maxValue += 1;
  }

  const xAt = (idx: number) => {
    if (points.length <= 1) return paddingLeft + plotWidth / 2;
    return paddingLeft + (idx / (points.length - 1)) * plotWidth;
  };
  const yAt = (value: number) => paddingTop + ((maxValue - value) / (maxValue - minValue)) * plotHeight;

  const ndrPath = points
    .map((point, idx) => `${idx === 0 ? "M" : "L"} ${xAt(idx)} ${yAt(ndrFor(point))}`)
    .join(" ");
  const gdrPath = points
    .map((point, idx) => `${idx === 0 ? "M" : "L"} ${xAt(idx)} ${yAt(gdrFor(point))}`)
    .join(" ");

  const hoveredPoint =
    hoverIndex != null && hoverIndex >= 0 && hoverIndex < points.length ? points[hoverIndex] : null;
  const hoveredNdr = hoveredPoint ? ndrFor(hoveredPoint) : 0;
  const hoveredGdr = hoveredPoint ? gdrFor(hoveredPoint) : 0;
  const hoveredX = hoveredPoint && hoverIndex != null ? xAt(hoverIndex) : 0;
  const hoveredNdrY = hoveredPoint ? yAt(hoveredNdr) : 0;
  const hoveredGdrY = hoveredPoint ? yAt(hoveredGdr) : 0;
  const hoveredY = hoveredPoint ? Math.min(hoveredNdrY, hoveredGdrY) : 0;

  const tooltipWidth = 250;
  const tooltipHeight = 58;
  const tooltipX = Math.max(
    paddingLeft,
    Math.min(paddingLeft + plotWidth - tooltipWidth, hoveredX - tooltipWidth / 2),
  );
  const tooltipY = Math.max(paddingTop + 4, hoveredY - tooltipHeight - 10);
  const downloadChart = useCallback(async () => {
    if (!chartRef.current || downloading) return;
    setDownloading(true);
    try {
      await downloadSvgAsPng(chartRef.current, "combined-billing-overview-ndr-gdr-over-time");
    } finally {
      setDownloading(false);
    }
  }, [downloading]);

  const exportTableCsv = () => {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const tableRows: Array<[string, number[]]> = [
      ["selfserve GDR", points.map((point) => point.selfserveGdrPct)],
      ["salesled GDR", points.map((point) => point.salesledGdrPct)],
      ["Combined GDR", points.map((point) => point.combinedGdrPct)],
      ["selfserve NDR", points.map((point) => point.selfserveNdrPct)],
      ["salesled NDR", points.map((point) => point.salesledNdrPct)],
      ["Combined NDR", points.map((point) => point.combinedNdrPct)],
    ];
    const rows: Array<Array<string | number>> = [
      ["Metric", ...points.map((point) => point.label)],
      ...tableRows.map(([metric, values]) => [metric, ...values.map((value) => round2(value))]),
    ];
    downloadCsv(`combined-ndr-gdr-${stamp}.csv`, rows);
  };

  return (
    <section className="stripe-ui__panel ui-reveal ui-reveal-2">
      <div className="stripe-ui__section-head">
        <div>
          <h2 className="stripe-ui__panel-title">NDR / GDR Over Time</h2>
          <p className="stripe-ui__panel-subtitle" style={{ marginBottom: 0 }}>
            {sourceLabel} retention rates based on prior-period MRR baseline. Click chart to open the plotted table.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button className="stripe-ui__btn stripe-ui__btn--ghost" onClick={() => void downloadChart()} disabled={downloading}>
            {downloading ? "Downloading..." : "Download SVG"}
          </button>
          <div className="stripe-ui__hint" aria-live="polite">
            {hoveredPoint
              ? `${hoveredPoint.label}: NDR ${formatPercent(hoveredNdr)} | GDR ${formatPercent(hoveredGdr)}`
              : "Hover on chart for values"}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.7rem" }}>
        <button
          className={`stripe-ui__btn ${source === "combined" ? "stripe-ui__btn--primary" : "stripe-ui__btn--secondary"}`}
          onClick={() => setSource("combined")}
        >
          Combined
        </button>
        <button
          className={`stripe-ui__btn ${source === "salesled" ? "stripe-ui__btn--primary" : "stripe-ui__btn--secondary"}`}
          onClick={() => setSource("salesled")}
        >
          Sales-led
        </button>
        <button
          className={`stripe-ui__btn ${source === "selfserve" ? "stripe-ui__btn--primary" : "stripe-ui__btn--secondary"}`}
          onClick={() => setSource("selfserve")}
        >
          Self-serve
        </button>
      </div>

      <div style={{ display: "flex", gap: "0.8rem", flexWrap: "wrap", marginTop: "0.65rem" }}>
        <span className="stripe-ui__hint" style={{ color: "#4f8df9" }}>NDR</span>
        <span className="stripe-ui__hint" style={{ color: "#ef4444" }}>GDR</span>
      </div>

      {points.length === 0 ? (
        <p className="stripe-ui__panel-subtitle" style={{ marginTop: "0.9rem", marginBottom: 0 }}>
          No data for selected range.
        </p>
      ) : (
        <>
          <div className="stripe-ui__table-wrap" style={{ marginTop: "0.9rem", cursor: "pointer" }}>
            <svg
              ref={chartRef}
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label="NDR and GDR over time chart"
              style={{ width: "100%", display: "block" }}
              onClick={() => setShowTable(true)}
              onMouseLeave={() => setHoverIndex(null)}
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const relX = ((e.clientX - rect.left) / rect.width) * width;
                const clamped = Math.max(paddingLeft, Math.min(paddingLeft + plotWidth, relX));
                const ratio = points.length > 1 ? (clamped - paddingLeft) / plotWidth : 0;
                const idx = Math.max(0, Math.min(points.length - 1, Math.round(ratio * Math.max(points.length - 1, 0))));
                setHoverIndex(idx);
              }}
            >
              <line
                x1={paddingLeft}
                y1={paddingTop + plotHeight}
                x2={paddingLeft + plotWidth}
                y2={paddingTop + plotHeight}
                stroke="#36557f"
                strokeWidth={1}
              />
              <line
                x1={paddingLeft}
                y1={paddingTop}
                x2={paddingLeft}
                y2={paddingTop + plotHeight}
                stroke="#36557f"
                strokeWidth={1}
              />

              {points.map((point, idx) => {
                const left = idx === 0 ? paddingLeft : (xAt(idx - 1) + xAt(idx)) / 2;
                const right = idx === points.length - 1 ? paddingLeft + plotWidth : (xAt(idx) + xAt(idx + 1)) / 2;
                return (
                  <rect
                    key={`hover-${point.key}`}
                    x={left}
                    y={paddingTop}
                    width={Math.max(1, right - left)}
                    height={plotHeight}
                    fill="transparent"
                    onMouseEnter={() => setHoverIndex(idx)}
                  />
                );
              })}

              <path d={ndrPath} fill="none" stroke="#4f8df9" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
              <path d={gdrPath} fill="none" stroke="#ef4444" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />

              {hoverIndex != null && points[hoverIndex] && (
                <line
                  x1={xAt(hoverIndex)}
                  y1={paddingTop}
                  x2={xAt(hoverIndex)}
                  y2={paddingTop + plotHeight}
                  stroke="#89a9d4"
                  strokeOpacity={0.5}
                  strokeDasharray="4 4"
                />
              )}

              {hoveredPoint && (
                <g>
                  <rect x={tooltipX} y={tooltipY} width={tooltipWidth} height={tooltipHeight} rx={6} fill="#0e203b" opacity={0.97} />
                  <text x={tooltipX + 10} y={tooltipY + 16} fill="#d9e6fa" fontSize="11.5">
                    {hoveredPoint.label}
                  </text>
                  <text x={tooltipX + 10} y={tooltipY + 33} fill="#4f8df9" fontSize="12.5" fontWeight="600">
                    NDR: {formatPercent(hoveredNdr)}
                  </text>
                  <text x={tooltipX + 10} y={tooltipY + 50} fill="#ef4444" fontSize="12.5" fontWeight="600">
                    GDR: {formatPercent(hoveredGdr)}
                  </text>
                </g>
              )}

              {points.map((point, idx) => (
                <g key={point.key}>
                  <circle
                    cx={xAt(idx)}
                    cy={yAt(ndrFor(point))}
                    r={hoverIndex === idx ? 4.6 : 3.2}
                    fill="#4f8df9"
                    data-tooltip={`${point.label}: NDR ${formatPercent(ndrFor(point))}`}
                    onMouseEnter={() => setHoverIndex(idx)}
                  />
                  <circle
                    cx={xAt(idx)}
                    cy={yAt(gdrFor(point))}
                    r={hoverIndex === idx ? 4.6 : 3.2}
                    fill="#ef4444"
                    data-tooltip={`${point.label}: GDR ${formatPercent(gdrFor(point))}`}
                    onMouseEnter={() => setHoverIndex(idx)}
                  />
                </g>
              ))}

              {tickIndices(points.length).map((idx) => (
                <text
                  key={`tick-${idx}`}
                  x={xAt(idx)}
                  y={height - 12}
                  textAnchor={idx === 0 ? "start" : idx === points.length - 1 ? "end" : "middle"}
                  fill="#b7c9e6"
                  fontSize="12"
                >
                  {points[idx]?.label || ""}
                </text>
              ))}

              <text x={paddingLeft - 8} y={paddingTop + 10} textAnchor="end" fill="#8ea7cb" fontSize="12">
                {formatPercent(maxValue)}
              </text>
              <text x={paddingLeft - 8} y={paddingTop + plotHeight} textAnchor="end" fill="#8ea7cb" fontSize="12">
                {formatPercent(minValue)}
              </text>
            </svg>
          </div>

          {showTable && (
            <div className="stripe-ui__panel" style={{ marginTop: "0.9rem", padding: "0.85rem" }}>
              <div className="stripe-ui__section-head" style={{ marginBottom: "0.65rem" }}>
                <h3 className="stripe-ui__panel-title" style={{ margin: 0, fontSize: "1rem" }}>
                  NDR / GDR Table
                </h3>
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                  <button className="stripe-ui__btn stripe-ui__btn--secondary" onClick={exportTableCsv}>
                    Export CSV
                  </button>
                  <button className="stripe-ui__btn stripe-ui__btn--ghost" onClick={() => setShowTable(false)}>
                    Hide table
                  </button>
                </div>
              </div>

              <div className="stripe-ui__table-wrap">
                <table className="stripe-ui__table" aria-label="NDR and GDR table">
                  <thead>
                    <tr>
                      <th>Metric</th>
                      {points.map((point) => (
                        <th key={`retention-head-${point.key}`} className="stripe-ui__num">
                          {point.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>selfserve GDR</td>
                      {points.map((point) => (
                        <td key={`row-self-gdr-${point.key}`} className="stripe-ui__num">
                          {formatPercent(point.selfserveGdrPct)}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td>salesled GDR</td>
                      {points.map((point) => (
                        <td key={`row-sales-gdr-${point.key}`} className="stripe-ui__num">
                          {formatPercent(point.salesledGdrPct)}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td>Combined GDR</td>
                      {points.map((point) => (
                        <td key={`row-combined-gdr-${point.key}`} className="stripe-ui__num">
                          {formatPercent(point.combinedGdrPct)}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td>selfserve NDR</td>
                      {points.map((point) => (
                        <td key={`row-self-ndr-${point.key}`} className="stripe-ui__num">
                          {formatPercent(point.selfserveNdrPct)}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td>salesled NDR</td>
                      {points.map((point) => (
                        <td key={`row-sales-ndr-${point.key}`} className="stripe-ui__num">
                          {formatPercent(point.salesledNdrPct)}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td>Combined NDR</td>
                      {points.map((point) => (
                        <td key={`row-combined-ndr-${point.key}`} className="stripe-ui__num">
                          {formatPercent(point.combinedNdrPct)}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

type GrowthBreakdownChartProps = {
  points: CombinedPoint[];
  currency: string;
};

function GrowthBreakdownChart({ points, currency }: GrowthBreakdownChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const chartRef = useRef<SVGSVGElement | null>(null);
  const [downloading, setDownloading] = useState(false);

  const width = 640;
  const height = 280;
  const paddingLeft = 54;
  const paddingRight = 20;
  const paddingTop = 20;
  const paddingBottom = 44;
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;

  const bars = points.map((point) => {
    const components = [
      { key: "new", label: "New", value: point.newMrr, color: "#1fc16b" },
      { key: "expansion", label: "Expansion", value: point.expansionMrr, color: "#2698f0" },
      { key: "contraction", label: "Contraction", value: point.contractionMrr, color: "#f59e0b" },
      { key: "churn", label: "Churn", value: point.churnMrr, color: "#ef4444" },
    ] as const;

    const positiveTotal = components.reduce((sum, component) => sum + Math.max(component.value, 0), 0);
    const negativeTotal = components.reduce((sum, component) => sum + Math.min(component.value, 0), 0);

    return {
      point,
      components,
      positiveTotal,
      negativeTotal,
    };
  });

  const maxPositive = bars.length ? Math.max(...bars.map((b) => b.positiveTotal), 0) : 0;
  const minNegative = bars.length ? Math.min(...bars.map((b) => b.negativeTotal), 0) : 0;
  let minValue = minNegative;
  let maxValue = maxPositive;
  if (Math.abs(maxValue - minValue) < 1e-9) {
    minValue -= 1;
    maxValue += 1;
  }

  const xAt = (idx: number) => {
    if (points.length <= 1) return paddingLeft + plotWidth / 2;
    return paddingLeft + (idx / (points.length - 1)) * plotWidth;
  };
  const yAt = (value: number) => paddingTop + ((maxValue - value) / (maxValue - minValue)) * plotHeight;
  const zeroY = yAt(0);

  const barWidth = points.length > 0 ? Math.max(8, Math.min(28, (plotWidth / Math.max(points.length, 1)) * 0.62)) : 14;
  const hovered = hoverIndex != null && hoverIndex >= 0 && hoverIndex < bars.length ? bars[hoverIndex] : null;
  const chartTitle = "Growth Breakdown";
  const downloadChart = useCallback(async () => {
    if (!chartRef.current || downloading) return;
    setDownloading(true);
    try {
      await downloadSvgAsPng(chartRef.current, "combined-billing-overview-growth-breakdown");
    } finally {
      setDownloading(false);
    }
  }, [downloading]);

  return (
    <section className="stripe-ui__panel ui-reveal ui-reveal-2">
      <div className="stripe-ui__section-head">
        <div>
          <h2 className="stripe-ui__panel-title">{chartTitle}</h2>
          <p className="stripe-ui__panel-subtitle" style={{ marginBottom: 0 }}>
            Combined New, Expansion, Contraction, and Churn contributions (MRR).
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button className="stripe-ui__btn stripe-ui__btn--ghost" onClick={() => void downloadChart()} disabled={downloading}>
            {downloading ? "Downloading..." : "Download SVG"}
          </button>
          <div className="stripe-ui__hint" aria-live="polite">
            {hovered
              ? `${hovered.point.label}: Net ${formatMoney(hovered.point.netMrrChange, currency)}`
              : "Hover on bars for values"}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: "0.8rem", flexWrap: "wrap", marginTop: "0.7rem" }}>
        <span className="stripe-ui__hint" style={{ color: "#1fc16b" }}>New</span>
        <span className="stripe-ui__hint" style={{ color: "#2698f0" }}>Expansion</span>
        <span className="stripe-ui__hint" style={{ color: "#f59e0b" }}>Contraction</span>
        <span className="stripe-ui__hint" style={{ color: "#ef4444" }}>Churn</span>
      </div>

      {points.length === 0 ? (
        <p className="stripe-ui__panel-subtitle" style={{ marginTop: "0.9rem", marginBottom: 0 }}>
          No data for selected range.
        </p>
      ) : (
        <div className="stripe-ui__table-wrap" style={{ marginTop: "0.9rem" }}>
          <svg
            ref={chartRef}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label="Growth breakdown chart"
            style={{ width: "100%", display: "block" }}
            onMouseLeave={() => setHoverIndex(null)}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const relX = ((e.clientX - rect.left) / rect.width) * width;
              const clamped = Math.max(paddingLeft, Math.min(paddingLeft + plotWidth, relX));
              const ratio = points.length > 1 ? (clamped - paddingLeft) / plotWidth : 0;
              const idx = Math.max(0, Math.min(points.length - 1, Math.round(ratio * Math.max(points.length - 1, 0))));
              setHoverIndex(idx);
            }}
          >
            <line x1={paddingLeft} y1={paddingTop} x2={paddingLeft} y2={paddingTop + plotHeight} stroke="#36557f" strokeWidth={1} />
            <line x1={paddingLeft} y1={zeroY} x2={paddingLeft + plotWidth} y2={zeroY} stroke="#5073a3" strokeWidth={1.2} />

            {bars.map((bar, idx) => {
              const left = idx === 0 ? paddingLeft : (xAt(idx - 1) + xAt(idx)) / 2;
              const right = idx === bars.length - 1 ? paddingLeft + plotWidth : (xAt(idx) + xAt(idx + 1)) / 2;
              return (
                <rect
                  key={`hover-zone-${bar.point.key}`}
                  x={left}
                  y={paddingTop}
                  width={Math.max(1, right - left)}
                  height={plotHeight}
                  fill="transparent"
                  onMouseEnter={() => setHoverIndex(idx)}
                />
              );
            })}

            {bars.map((bar, idx) => {
              const centerX = xAt(idx);
              let positiveCursor = 0;
              let negativeCursor = 0;

              return (
                <g key={bar.point.key}>
                  {bar.components.map((component) => {
                    const value = component.value;
                    if (Math.abs(value) < 1e-9) return null;

                    if (value >= 0) {
                      const yTop = yAt(positiveCursor + value);
                      const yBottom = yAt(positiveCursor);
                      const h = Math.max(1.2, yBottom - yTop);
                      positiveCursor += value;
                      return (
                        <rect
                          key={`${bar.point.key}-${component.key}`}
                          x={centerX - barWidth / 2}
                          y={yTop}
                          width={barWidth}
                          height={h}
                          fill={component.color}
                          rx={1.2}
                          data-tooltip={`${bar.point.label}: ${component.label}: ${formatMoney(value, currency)}`}
                          onMouseEnter={() => setHoverIndex(idx)}
                        />
                      );
                    }

                    const yTop = yAt(negativeCursor);
                    const yBottom = yAt(negativeCursor + value);
                    const h = Math.max(1.2, yBottom - yTop);
                    negativeCursor += value;
                    return (
                      <rect
                        key={`${bar.point.key}-${component.key}`}
                        x={centerX - barWidth / 2}
                        y={yTop}
                        width={barWidth}
                        height={h}
                        fill={component.color}
                        rx={1.2}
                        data-tooltip={`${bar.point.label}: ${component.label}: ${formatMoney(value, currency)}`}
                        onMouseEnter={() => setHoverIndex(idx)}
                      />
                    );
                  })}
                </g>
              );
            })}

            {tickIndices(points.length).map((idx) => (
              <text
                key={`tick-${idx}`}
                x={xAt(idx)}
                y={height - 12}
                textAnchor={idx === 0 ? "start" : idx === points.length - 1 ? "end" : "middle"}
                fill="#b7c9e6"
                fontSize="12"
              >
                {points[idx]?.label || ""}
              </text>
            ))}

            <text x={paddingLeft - 8} y={paddingTop + 10} textAnchor="end" fill="#8ea7cb" fontSize="12">
              {formatMoney(maxValue, currency)}
            </text>
            <text x={paddingLeft - 8} y={paddingTop + plotHeight} textAnchor="end" fill="#8ea7cb" fontSize="12">
              {formatMoney(minValue, currency)}
            </text>
          </svg>

          {hovered && (
            <div className="stripe-ui__panel" style={{ marginTop: "0.8rem", padding: "0.75rem" }}>
              <div className="stripe-ui__hint" style={{ marginBottom: "0.35rem" }}>
                {hovered.point.label}
              </div>
              <div className="stripe-ui__hint">New: {formatMoney(hovered.point.newMrr, currency)}</div>
              <div className="stripe-ui__hint">Expansion: {formatMoney(hovered.point.expansionMrr, currency)}</div>
              <div className="stripe-ui__hint">Contraction: {formatMoney(hovered.point.contractionMrr, currency)}</div>
              <div className="stripe-ui__hint">Churn: {formatMoney(hovered.point.churnMrr, currency)}</div>
              <div className="stripe-ui__hint">Net: {formatMoney(hovered.point.netMrrChange, currency)}</div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

type DeltaBarChartProps = {
  title: string;
  subtitle: string;
  points: CombinedPoint[];
  valueAccessor: (point: CombinedPoint) => number;
  valueFormatter: (value: number) => string;
};

function DeltaBarChartCard({ title, subtitle, points, valueAccessor, valueFormatter }: DeltaBarChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const chartRef = useRef<SVGSVGElement | null>(null);
  const [downloading, setDownloading] = useState(false);

  const width = 640;
  const height = 280;
  const paddingLeft = 54;
  const paddingRight = 20;
  const paddingTop = 20;
  const paddingBottom = 44;
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;

  const values = points.map(valueAccessor);
  const maxPositive = values.length ? Math.max(0, ...values) : 0;
  const minNegative = values.length ? Math.min(0, ...values) : 0;
  let minValue = minNegative;
  let maxValue = maxPositive;
  if (Math.abs(maxValue - minValue) < 1e-9) {
    minValue -= 1;
    maxValue += 1;
  }

  const xAt = (idx: number) => {
    if (points.length <= 1) return paddingLeft + plotWidth / 2;
    return paddingLeft + (idx / (points.length - 1)) * plotWidth;
  };
  const yAt = (value: number) => paddingTop + ((maxValue - value) / (maxValue - minValue)) * plotHeight;
  const zeroY = yAt(0);

  const barWidth = points.length > 0 ? Math.max(8, Math.min(28, (plotWidth / Math.max(points.length, 1)) * 0.62)) : 14;
  const hovered =
    hoverIndex != null && hoverIndex >= 0 && hoverIndex < points.length
      ? points[hoverIndex]
      : null;
  const downloadChart = useCallback(async () => {
    if (!chartRef.current || downloading) return;
    setDownloading(true);
    try {
      await downloadSvgAsPng(chartRef.current, `combined-billing-overview-${title}`);
    } finally {
      setDownloading(false);
    }
  }, [downloading, title]);

  return (
    <section className="stripe-ui__panel ui-reveal ui-reveal-2">
      <div className="stripe-ui__section-head">
        <div>
          <h2 className="stripe-ui__panel-title">{title}</h2>
          <p className="stripe-ui__panel-subtitle" style={{ marginBottom: 0 }}>
            {subtitle}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button className="stripe-ui__btn stripe-ui__btn--ghost" onClick={() => void downloadChart()} disabled={downloading}>
            {downloading ? "Downloading..." : "Download SVG"}
          </button>
          <div className="stripe-ui__hint" aria-live="polite">
            {hovered
              ? `${hovered.label}: ${valueFormatter(valueAccessor(hovered))}`
              : "Hover on bars for values"}
          </div>
        </div>
      </div>

      {points.length === 0 ? (
        <p className="stripe-ui__panel-subtitle" style={{ marginTop: "0.9rem", marginBottom: 0 }}>
          No data for selected range.
        </p>
      ) : (
        <div className="stripe-ui__table-wrap" style={{ marginTop: "0.9rem" }}>
          <svg
            ref={chartRef}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={title}
            style={{ width: "100%", display: "block" }}
            onMouseLeave={() => setHoverIndex(null)}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const relX = ((e.clientX - rect.left) / rect.width) * width;
              const clamped = Math.max(paddingLeft, Math.min(paddingLeft + plotWidth, relX));
              const ratio = points.length > 1 ? (clamped - paddingLeft) / plotWidth : 0;
              const idx = Math.max(0, Math.min(points.length - 1, Math.round(ratio * Math.max(points.length - 1, 0))));
              setHoverIndex(idx);
            }}
          >
            <line x1={paddingLeft} y1={paddingTop} x2={paddingLeft} y2={paddingTop + plotHeight} stroke="#36557f" strokeWidth={1} />
            <line x1={paddingLeft} y1={zeroY} x2={paddingLeft + plotWidth} y2={zeroY} stroke="#5073a3" strokeWidth={1.2} />

            {points.map((point, idx) => {
              const left = idx === 0 ? paddingLeft : (xAt(idx - 1) + xAt(idx)) / 2;
              const right = idx === points.length - 1 ? paddingLeft + plotWidth : (xAt(idx) + xAt(idx + 1)) / 2;
              const value = valueAccessor(point);
              const yVal = yAt(value);
              const y0 = yAt(0);
              const y = Math.min(yVal, y0);
              const h = Math.max(1.2, Math.abs(yVal - y0));
              const fill = value >= 0 ? "#1fc16b" : "#ef4444";
              return (
                <g key={point.key}>
                  <rect
                    x={left}
                    y={paddingTop}
                    width={Math.max(1, right - left)}
                    height={plotHeight}
                    fill="transparent"
                    onMouseEnter={() => setHoverIndex(idx)}
                  />
                  <rect
                    x={xAt(idx) - barWidth / 2}
                    y={y}
                    width={barWidth}
                    height={h}
                    fill={fill}
                    rx={1.2}
                    data-tooltip={`${point.label}: ${valueFormatter(value)}`}
                    onMouseEnter={() => setHoverIndex(idx)}
                  />
                </g>
              );
            })}

            {tickIndices(points.length).map((idx) => (
              <text
                key={`tick-${idx}`}
                x={xAt(idx)}
                y={height - 12}
                textAnchor={idx === 0 ? "start" : idx === points.length - 1 ? "end" : "middle"}
                fill="#b7c9e6"
                fontSize="12"
              >
                {points[idx]?.label || ""}
              </text>
            ))}

            <text x={paddingLeft - 8} y={paddingTop + 10} textAnchor="end" fill="#8ea7cb" fontSize="12">
              {valueFormatter(maxValue)}
            </text>
            <text x={paddingLeft - 8} y={paddingTop + plotHeight} textAnchor="end" fill="#8ea7cb" fontSize="12">
              {valueFormatter(minValue)}
            </text>
          </svg>
        </div>
      )}
    </section>
  );
}

export default function CombinedBillingOverviewPage() {
  const defaults = useMemo(() => defaultDateRange(), []);

  const [startDate, setStartDate] = useState(defaults.startDate);
  const [endDate, setEndDate] = useState(defaults.endDate);
  const [grain, setGrain] = useState<CombinedGrain>("monthly");

  const [loading, setLoading] = useState(false);
  const [hasRunOnce, setHasRunOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CombinedOverviewData | null>(null);
  const [cacNotice, setCacNotice] = useState<string | null>(null);
  const [cacCurrencyLayerNotice, setCacCurrencyLayerNotice] = useState<string | null>(null);
  const [selectedCacAccountIds, setSelectedCacAccountIds] = useState<string[]>([]);
  const [cacAccountMenuTarget, setCacAccountMenuTarget] = useState<CacMenuTarget>(null);
  const [cacExpenseAccounts, setCacExpenseAccounts] = useState<QuickBooksExpenseAccount[]>([]);
  const [cacExpenseAccountsLoaded, setCacExpenseAccountsLoaded] = useState(false);
  const [cacExpenseAccountsLoading, setCacExpenseAccountsLoading] = useState(false);
  const [cacExpenseAccountsError, setCacExpenseAccountsError] = useState("");
  const [savingCacDefaultSelection, setSavingCacDefaultSelection] = useState(false);
  const [cacDefaultSaveStatus, setCacDefaultSaveStatus] = useState("");
  const runRequestRef = useRef(0);

  const fetchApiGetJson = useCallback(async <T,>(url: string): Promise<T> => {
    const res = await fetch(url, { method: "GET", cache: "no-store" });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      if (json && typeof json === "object" && "error" in json) {
        throw new Error(String((json as { error?: unknown }).error || "Request failed"));
      }
      throw new Error(text || `HTTP ${res.status}`);
    }
    if (!json || typeof json !== "object") throw new Error("Invalid API response");
    return json as T;
  }, []);

  const loadCacDefaultSelection = useCallback(async () => {
    try {
      const payload = await fetchApiGetJson<QuickBooksCacAccountDefaultResponse>(
        "/api/quickbooks/cac-account-default",
      );
      const ids = Array.isArray(payload.selectedAccountIds)
        ? normalizeIdList(payload.selectedAccountIds.map((id) => String(id || "")))
        : [];
      setSelectedCacAccountIds(ids);
    } catch {
      setSelectedCacAccountIds([]);
    }
  }, [fetchApiGetJson]);

  const loadCacExpenseAccounts = useCallback(async () => {
    setCacExpenseAccountsLoading(true);
    setCacExpenseAccountsError("");
    try {
      const payload = await fetchApiGetJson<QuickBooksExpenseAccountsResponse>(
        "/api/quickbooks/expense-accounts",
      );
      const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
      const accountIdSet = new Set(
        accounts
          .map((account) => normalizeEntityId(String(account.id || "")))
          .filter(Boolean),
      );
      setCacExpenseAccounts(accounts);
      setSelectedCacAccountIds((prev) => normalizeIdList(prev).filter((id) => accountIdSet.has(id)));
      setCacExpenseAccountsLoaded(true);
    } catch (e: unknown) {
      setCacExpenseAccountsError(conciseErrorMessage(e, "Failed to load expense accounts."));
    } finally {
      setCacExpenseAccountsLoading(false);
    }
  }, [fetchApiGetJson]);

  useEffect(() => {
    void loadCacDefaultSelection();
  }, [loadCacDefaultSelection]);

  const toggleCacAccountMenu = useCallback((target: CacFxProvider) => {
    setCacAccountMenuTarget((prev) => {
      const next = prev === target ? null : target;
      if (next && !cacExpenseAccountsLoaded && !cacExpenseAccountsLoading) {
        void loadCacExpenseAccounts();
      }
      return next;
    });
    setCacDefaultSaveStatus("");
  }, [cacExpenseAccountsLoaded, cacExpenseAccountsLoading, loadCacExpenseAccounts]);

  const toggleCacAccountSelection = useCallback((accountId: string) => {
    const id = normalizeEntityId(String(accountId || ""));
    if (!id) return;
    setSelectedCacAccountIds((prev) => {
      const normalizedPrev = normalizeIdList(prev);
      if (normalizedPrev.includes(id)) return normalizedPrev.filter((value) => value !== id);
      return [...normalizedPrev, id];
    });
    setCacDefaultSaveStatus("");
  }, []);

  const selectAllCacAccounts = useCallback(() => {
    const ids = normalizeIdList(
      cacExpenseAccounts
        .map((account) => String(account.id || ""))
        .filter(Boolean),
    );
    setSelectedCacAccountIds(ids);
    setCacDefaultSaveStatus("");
  }, [cacExpenseAccounts]);

  const clearCacAccounts = useCallback(() => {
    setSelectedCacAccountIds([]);
    setCacDefaultSaveStatus("");
  }, []);

  const saveCacDefaultSelection = useCallback(async () => {
    setSavingCacDefaultSelection(true);
    setCacExpenseAccountsError("");
    setCacDefaultSaveStatus("");
    try {
      const res = await fetch("/api/quickbooks/cac-account-default", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountIds: normalizeIdList(selectedCacAccountIds) }),
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        if (json && typeof json === "object" && "error" in json) {
          throw new Error(String((json as { error?: unknown }).error || "Request failed"));
        }
        throw new Error(text || `HTTP ${res.status}`);
      }
      const payload = (json || {}) as Partial<QuickBooksCacAccountDefaultResponse>;
      const ids = Array.isArray(payload.selectedAccountIds)
        ? normalizeIdList(payload.selectedAccountIds.map((id) => String(id || "")))
        : [];
      setSelectedCacAccountIds(ids);
      setCacDefaultSaveStatus(
        ids.length > 0
          ? `Saved default selection (${ids.length} account${ids.length === 1 ? "" : "s"}).`
          : "Saved default selection (automatic matching mode).",
      );
    } catch (e: unknown) {
      setCacExpenseAccountsError(conciseErrorMessage(e, "Failed to save default selection."));
    } finally {
      setSavingCacDefaultSelection(false);
    }
  }, [selectedCacAccountIds]);

  async function run() {
    const requestId = runRequestRef.current + 1;
    runRequestRef.current = requestId;
    const isStale = () => runRequestRef.current !== requestId;

    setHasRunOnce(true);
    setLoading(true);
    setError(null);
    setCacNotice(null);
    setCacCurrencyLayerNotice(null);

    try {
      const fetchJson = async <T,>(url: string, payload: unknown): Promise<T> => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const text = await res.text();
        let json: unknown = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }

        if (!res.ok) {
          if (json && typeof json === "object" && "error" in json) {
            throw new Error(String((json as { error?: unknown }).error || "Request failed"));
          }
          throw new Error(text || `HTTP ${res.status}`);
        }

        if (!json || typeof json !== "object") throw new Error("Invalid API response");
        return json as T;
      };

      const previousRange = previousPeriodRangeForGrain(startDate, grain);
      const hubspotPayload = { startDate, endDate, mode: "contracted", grain };
      const hubspotBaselinePayload = {
        startDate: previousRange.startDate,
        endDate: previousRange.endDate,
        mode: "contracted",
        grain,
      };
      const stripePayload = { startDate, endDate, grain };
      const stripeBaselinePayload = {
        startDate: previousRange.startDate,
        endDate: previousRange.endDate,
        grain,
      };

      // Avoid overlapping HubSpot-heavy endpoints (/api/report and /api/combined-live-arr),
      // which can trigger HubSpot throttling and serverless timeouts.
      const stripePromise = fetchJson<StripeOverviewResponse>("/api/stripe-billing-overview-report", stripePayload);
      const hubspotMain = await fetchJson<ReportResponse>("/api/report", hubspotPayload);
      if (isStale()) return;
      const hubspotBaseline = await fetchJson<ReportResponse>("/api/report", hubspotBaselinePayload);
      if (isStale()) return;
      const liveArrData = await fetchJson<CombinedLiveArrResponse>("/api/combined-live-arr", {});
      if (isStale()) return;
      const stripe = await stripePromise;
      if (isStale()) return;

      let stripeBaseline: StripeOverviewResponse | null = null;
      try {
        stripeBaseline = await fetchJson<StripeOverviewResponse>("/api/stripe-billing-overview-report", stripeBaselinePayload);
      } catch {
        stripeBaseline = null;
      }
      if (isStale()) return;

      const periodOrder: PeriodRef[] = (hubspotMain.periods || []).map((period) => ({
        key: String(period.key || ""),
        label: String(period.label || period.key || ""),
      }));

      const mapHubRows = (report: ReportResponse): HubspotChartRow[] =>
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
        stripe.stripeExactPoints !== undefined || stripe.stripeExactHistoryPoints !== undefined;
      const stripePoints = hasStripeExactSeries ? stripe.stripeExactPoints || [] : stripe.points || [];
      const stripeHistoryPoints = hasStripeExactSeries ? stripe.stripeExactHistoryPoints || [] : stripe.historyPoints || [];

      const stripePointMap = new Map<string, StripeOverviewPoint>();
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

      const combinedPoints = rawCombined.map((point, idx) => {
        const prevMrr = idx === 0 ? initialPrevCombinedMrr : rawCombined[idx - 1].mrrEnd;
        const mrrGrowthRatePct =
          Math.abs(prevMrr) > 1e-9
            ? round2(((point.mrrEnd - prevMrr) / Math.abs(prevMrr)) * 100)
            : 0;
        const retention = calculateRetentionRates(prevMrr, point.expansionMrr, point.contractionMrr, point.churnMrr);
        return { ...point, mrrGrowthRatePct, ndrPct: retention.ndrPct, gdrPct: retention.gdrPct };
      });

      const currentMrr = combinedPoints.length ? combinedPoints[combinedPoints.length - 1].mrrEnd : 0;
      const retentionPoints: RetentionSeriesPoint[] = periodOrder.map((period, idx) => {
        const key = canonicalHubPeriodKey(period.key, grain) || period.key;
        return {
          key,
          label: period.label,
          selfserveGdrPct: selfservePoints[idx]?.gdrPct || 0,
          salesledGdrPct: hubPoints[idx]?.gdrPct || 0,
          combinedGdrPct: combinedPoints[idx]?.gdrPct || 0,
          selfserveNdrPct: selfservePoints[idx]?.ndrPct || 0,
          salesledNdrPct: hubPoints[idx]?.ndrPct || 0,
          combinedNdrPct: combinedPoints[idx]?.ndrPct || 0,
        };
      });

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

      const stripeArrByCustomer = new Map<string, Map<string, number>>();
      for (const row of stripe.customerArrRows || []) {
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

      const stripeNewCustomerCountByPeriod = new Map<string, number>();
      periodOrder.forEach((period, idx) => {
        const key = canonicalHubPeriodKey(period.key, grain) || period.key;
        const prevKey = idx > 0 ? canonicalHubPeriodKey(periodOrder[idx - 1].key, grain) || periodOrder[idx - 1].key : "";
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

      const combinedNewCustomerCountByPeriod = new Map<string, number>();
      periodOrder.forEach((period) => {
        const key = canonicalHubPeriodKey(period.key, grain) || period.key;
        const count = (hubNewCustomerCountByPeriod.get(key) || 0) + (stripeNewCustomerCountByPeriod.get(key) || 0);
        combinedNewCustomerCountByPeriod.set(key, count);
      });

      let cacPoints: CacPoint[] = [];
      let cacCurrencyLayerPoints: CacPoint[] = [];
      let nextCacNotice: string | null = null;
      let nextCacCurrencyLayerNotice: string | null = null;
      const normalizedSelectedCacAccountIds = normalizeIdList(selectedCacAccountIds);
      const selectedCacAccountIdSet = new Set(normalizedSelectedCacAccountIds);
      const selectedCacAccountNames = Array.from(
        new Set(
          cacExpenseAccounts
            .filter((account) => selectedCacAccountIdSet.has(normalizeEntityId(String(account.id || ""))))
            .map((account) => String(account.fullyQualifiedName || account.name || "").trim())
            .filter(Boolean),
        ),
      );
      const emptyCacSeries = buildCacSeries(periodOrder, grain, new Map<string, number>(), combinedNewCustomerCountByPeriod);
      if (grain !== "monthly") {
        nextCacNotice = "CAC currently supports monthly grain. Switch Time grain to Monthly to load CAC over time.";
        nextCacCurrencyLayerNotice =
          "Currencylayer CAC currently supports monthly grain. Switch Time grain to Monthly to load CAC over time.";
        cacPoints = emptyCacSeries;
        cacCurrencyLayerPoints = emptyCacSeries;
      } else {
        const cacRequestPayload = {
          startDate,
          endDate,
          accountIds: normalizedSelectedCacAccountIds,
          accountNames: selectedCacAccountNames,
        };
        const loadCacCosts = async (fxProvider: CacFxProvider) =>
          fetchJson<QuickBooksSalesMarketingCostResponse>(
            "/api/quickbooks/sales-marketing-costs",
            {
              ...cacRequestPayload,
              fxProvider,
            },
          );

        const [frankfurterResult, currencyLayerResult] = await Promise.allSettled([
          loadCacCosts("frankfurter"),
          loadCacCosts("currencylayer"),
        ]);
        if (isStale()) return;

        if (frankfurterResult.status === "fulfilled") {
          const frankfurterCosts = frankfurterResult.value;
          cacPoints = buildCacSeries(
            periodOrder,
            grain,
            buildCostByMonth(frankfurterCosts.points || []),
            combinedNewCustomerCountByPeriod,
          );
          nextCacNotice = buildCacAccountMatchNotice(frankfurterCosts, normalizedSelectedCacAccountIds);
        } else {
          nextCacNotice = `CAC unavailable: ${conciseErrorMessage(
            frankfurterResult.reason,
            "QuickBooks cost query failed.",
          )}`;
          cacPoints = emptyCacSeries;
        }

        if (currencyLayerResult.status === "fulfilled") {
          const currencyLayerCosts = currencyLayerResult.value;
          cacCurrencyLayerPoints = buildCacSeries(
            periodOrder,
            grain,
            buildCostByMonth(currencyLayerCosts.points || []),
            combinedNewCustomerCountByPeriod,
          );
          const accountMatchNotice = buildCacAccountMatchNotice(currencyLayerCosts, normalizedSelectedCacAccountIds);
          nextCacCurrencyLayerNotice = accountMatchNotice ? `Currencylayer CAC: ${accountMatchNotice}` : null;
        } else {
          nextCacCurrencyLayerNotice = `Currencylayer CAC unavailable: ${conciseErrorMessage(
            currencyLayerResult.reason,
            "QuickBooks cost query failed.",
          )}`;
          cacCurrencyLayerPoints = emptyCacSeries;
        }
      }
      if (isStale()) return;

      setCacNotice(nextCacNotice);
      setCacCurrencyLayerNotice(nextCacCurrencyLayerNotice);

      setData({
        startDate,
        endDate,
        grain,
        targetCurrency: String(stripe.targetCurrency || "USD").toUpperCase(),
        currentMrr,
        currentArr: round2(currentMrr * 12),
        liveArr: round2(liveArrData.liveArr || 0),
        liveArrAsOfUtc: String(liveArrData.generatedAtUtc || ""),
        projectedArr: round2(liveArrData.projectedArr || 0),
        points: combinedPoints,
        retentionPoints,
        cacPoints,
        cacCurrencyLayerPoints,
      });
    } catch (e: unknown) {
      if (isStale()) return;
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      if (!isStale()) {
        setLoading(false);
      }
    }
  }

  const points = useMemo(() => data?.points ?? [], [data]);
  const retentionPoints = useMemo(() => data?.retentionPoints ?? [], [data]);
  const cacPoints = useMemo(() => data?.cacPoints ?? [], [data]);
  const cacCurrencyLayerPoints = useMemo(() => data?.cacCurrencyLayerPoints ?? [], [data]);
  const currency = useMemo(() => data?.targetCurrency || "USD", [data]);

  return (
    <div className="stripe-ui">
      <section className="stripe-ui__hero ui-reveal">
        <div className="stripe-ui__eyebrow">Revenue intelligence</div>
        <div className="stripe-ui__hero-row">
          <div>
            <h1 className="stripe-ui__title">Combined Billing Overview</h1>
            <p className="stripe-ui__subtitle">
              Combined billing trends where each metric is HubSpot (contracted ARR cloud-only method) + Stripe Billing
              Overview (Stripe method) for the same period.
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <Link href="/combined-billing-overview" className="stripe-ui__hero-link">
              Open Combined Billing Overview
            </Link>
            <Link href="/hubspot" className="stripe-ui__hero-link">
              Open HubSpot report
            </Link>
            <Link href="/stripe-billing-overview" className="stripe-ui__hero-link">
              Open Stripe Billing Overview
            </Link>
            <Link href="/stripe-arr-correct" className="stripe-ui__hero-link">
              Open Stripe ARR (Correct)
            </Link>
            <Link href="/stripe-through-mrr" className="stripe-ui__hero-link">
              Open Stripe through MRR
            </Link>
            <Link href="/combined-all-subs" className="stripe-ui__hero-link">
              Open Combined All Subs
            </Link>
            <Link href="/tofu" className="stripe-ui__hero-link">
              Open TOFU
            </Link>
            <Link href="/ai-spend" className="stripe-ui__hero-link">
              Open AI spend
            </Link>
            <Link href="/quickbooks" className="stripe-ui__hero-link">
              Open QuickBooks
            </Link>
          </div>
        </div>
      </section>

      <section className="stripe-ui__panel ui-reveal ui-reveal-1">
        <h2 className="stripe-ui__panel-title">Controls</h2>
        <p className="stripe-ui__panel-subtitle">Choose date range and grain, then load combined metrics.</p>

        <div className="stripe-ui__control-grid">
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="combined-start-date">
              Start date
            </label>
            <input
              id="combined-start-date"
              className="stripe-ui__control"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="combined-end-date">
              End date
            </label>
            <input
              id="combined-end-date"
              className="stripe-ui__control"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="combined-grain">
              Time grain
            </label>
            <select
              id="combined-grain"
              className="stripe-ui__control"
              value={grain}
              onChange={(e) => setGrain(e.target.value as CombinedGrain)}
            >
              <option value="daily">Daily</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
            </select>
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="combined-run">
              Load charts
            </label>
            <button id="combined-run" className="stripe-ui__btn stripe-ui__btn--primary" onClick={run} disabled={loading}>
              {loading ? "Loading..." : "Run"}
            </button>
          </div>
        </div>
      </section>

      {loading && (
        <section className="stripe-ui__panel stripe-ui__loading-panel ui-reveal ui-reveal-2" aria-live="polite" aria-busy="true">
          <h2 className="stripe-ui__panel-title">Loading charts...</h2>
          <p className="stripe-ui__panel-subtitle">Querying Stripe and HubSpot sources and combining metrics.</p>
          <div className="stripe-ui__skeleton-grid">
            <div className="stripe-ui__skeleton-row" />
            <div className="stripe-ui__skeleton-row" />
            <div className="stripe-ui__skeleton-row stripe-ui__skeleton-row--short" />
          </div>
        </section>
      )}

      {error && (
        <div className="stripe-ui__error ui-reveal ui-reveal-1" role="alert" aria-live="assertive">
          <div>{error}</div>
          <div className="stripe-ui__error-actions">
            <button className="stripe-ui__btn stripe-ui__btn--secondary" onClick={() => void run()} disabled={loading}>
              Retry
            </button>
          </div>
        </div>
      )}

      {!loading && !error && cacNotice && (
        <section className="stripe-ui__panel ui-reveal ui-reveal-2">
          <p className="stripe-ui__panel-subtitle" style={{ margin: 0 }}>
            {cacNotice}
          </p>
        </section>
      )}

      {!loading && !error && cacCurrencyLayerNotice && (
        <section className="stripe-ui__panel ui-reveal ui-reveal-2">
          <p className="stripe-ui__panel-subtitle" style={{ margin: 0 }}>
            {cacCurrencyLayerNotice}
          </p>
        </section>
      )}

      {!loading && !error && data && (
        <>
          <section className="stripe-ui__panel ui-reveal ui-reveal-2">
            <div className="stripe-ui__stats">
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Current MRR</p>
                <p className="stripe-ui__stat-value">{formatMoney(data.currentMrr, currency)}</p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Current ARR</p>
                <p className="stripe-ui__stat-value">{formatMoney(data.currentArr, currency)}</p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Live ARR</p>
                <p className="stripe-ui__stat-value">{formatMoney(data.liveArr, currency)}</p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Projected ARR</p>
                <p className="stripe-ui__stat-value">{formatMoney(data.projectedArr, currency)}</p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Points</p>
                <p className="stripe-ui__stat-value">{points.length}</p>
              </div>
            </div>
          </section>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
              gap: "0.95rem",
              alignItems: "start",
            }}
          >
            <LineChartCard
              title="MRR Over Time"
              subtitle="Combined MRR at period end (HubSpot method + Stripe method)."
              points={points}
              valueAccessor={(p) => p.mrrEnd}
              valueFormatter={(v) => formatMoney(v, currency)}
              stroke="#4f8df9"
            />

            <GrowthBreakdownChart points={points} currency={currency} />

            <LineChartCard
              title="MRR Growth Rate Over Time"
              subtitle="Period-over-period combined MRR growth rate."
              points={points}
              valueAccessor={(p) => p.mrrGrowthRatePct}
              valueFormatter={(v) => formatPercent(v)}
              stroke="#f59e0b"
              includeZero
            />

            <LineChartCard
              title="ARR Over Time"
              subtitle="Combined ARR at period end."
              points={points}
              valueAccessor={(p) => p.arr}
              valueFormatter={(v) => formatMoney(v, currency)}
              stroke="#1fc16b"
            />

            <DeltaBarChartCard
              title="ARR Growth Over Time"
              subtitle="Absolute combined ARR change per period."
              points={points}
              valueAccessor={(p) => p.arrGrowth}
              valueFormatter={(v) => formatMoney(v, currency)}
            />

            <CacChartCard
              points={cacPoints}
              currency={currency}
              expenseAccounts={cacExpenseAccounts}
              selectedAccountIds={selectedCacAccountIds}
              runLoading={loading}
              accountMenuOpen={cacAccountMenuTarget === "frankfurter"}
              accountsLoading={cacExpenseAccountsLoading}
              accountsError={cacExpenseAccountsError}
              savingDefaultSelection={savingCacDefaultSelection}
              defaultSaveStatus={cacDefaultSaveStatus}
              onToggleAccountMenu={() => toggleCacAccountMenu("frankfurter")}
              onRefreshAccounts={() => void loadCacExpenseAccounts()}
              onToggleAccountSelection={toggleCacAccountSelection}
              onSelectAllAccounts={selectAllCacAccounts}
              onClearAccounts={clearCacAccounts}
              onSaveDefaultSelection={() => void saveCacDefaultSelection()}
              onApplySelection={() => {
                setCacAccountMenuTarget(null);
                void run();
              }}
            />

            <CacChartCard
              points={cacCurrencyLayerPoints}
              currency={currency}
              title="CAC Over Time (Currencylayer FX)"
              subtitle="CAC = Sales & Marketing Cost / Total Users. Same CAC logic as above, with Currencylayer monthly FX conversion."
              accentColor="#f97316"
              downloadFilename="combined-billing-overview-cac-over-time-currencylayer"
              tableTitle="CAC Table (Currencylayer FX)"
              tableAriaLabel="CAC table using Currencylayer FX"
              expenseAccounts={cacExpenseAccounts}
              selectedAccountIds={selectedCacAccountIds}
              runLoading={loading}
              accountMenuOpen={cacAccountMenuTarget === "currencylayer"}
              accountsLoading={cacExpenseAccountsLoading}
              accountsError={cacExpenseAccountsError}
              savingDefaultSelection={savingCacDefaultSelection}
              defaultSaveStatus={cacDefaultSaveStatus}
              onToggleAccountMenu={() => toggleCacAccountMenu("currencylayer")}
              onRefreshAccounts={() => void loadCacExpenseAccounts()}
              onToggleAccountSelection={toggleCacAccountSelection}
              onSelectAllAccounts={selectAllCacAccounts}
              onClearAccounts={clearCacAccounts}
              onSaveDefaultSelection={() => void saveCacDefaultSelection()}
              onApplySelection={() => {
                setCacAccountMenuTarget(null);
                void run();
              }}
            />

            <RetentionRatesChartCard points={retentionPoints} />
          </div>
        </>
      )}

      {!loading && !error && !data && hasRunOnce && (
        <section className="stripe-ui__panel ui-reveal ui-reveal-2">
          <h2 className="stripe-ui__panel-title">No data</h2>
          <p className="stripe-ui__panel-subtitle">No points were returned for this selection.</p>
        </section>
      )}
    </div>
  );
}
