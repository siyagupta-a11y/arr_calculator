"use client";

import Link from "next/link";
import React, { useMemo, useState } from "react";
import type { ReportResponse, ReportRow } from "@/lib/types";

type CombinedGrain = "daily" | "monthly" | "quarterly";

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

type CombinedOverviewData = {
  startDate: string;
  endDate: string;
  grain: CombinedGrain;
  targetCurrency: string;
  currentMrr: number;
  currentArr: number;
  points: CombinedPoint[];
};

function round2(n: number) {
  return Math.round((Number(n) || 0) * 100) / 100;
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

function tickIndices(size: number) {
  if (size <= 1) return [0];
  if (size <= 4) return Array.from({ length: size }, (_, i) => i);
  const out = new Set<number>([0, Math.floor((size - 1) / 2), size - 1]);
  return Array.from(out).sort((a, b) => a - b);
}

type LineChartProps = {
  title: string;
  subtitle: string;
  points: CombinedPoint[];
  valueAccessor: (point: CombinedPoint) => number;
  valueFormatter: (value: number) => string;
  stroke: string;
  includeZero?: boolean;
};

function LineChartCard({
  title,
  subtitle,
  points,
  valueAccessor,
  valueFormatter,
  stroke,
  includeZero = false,
}: LineChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

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

  return (
    <section className="stripe-ui__panel ui-reveal ui-reveal-2">
      <div className="stripe-ui__section-head">
        <div>
          <h2 className="stripe-ui__panel-title">{title}</h2>
          <p className="stripe-ui__panel-subtitle" style={{ marginBottom: 0 }}>
            {subtitle}
          </p>
        </div>
        <div className="stripe-ui__hint" aria-live="polite">
          {hoveredPoint
            ? `${hoveredPoint.label}: ${valueFormatter(hoveredValue)}`
            : "Hover on chart for values"}
        </div>
      </div>

      {points.length === 0 ? (
        <p className="stripe-ui__panel-subtitle" style={{ marginTop: "0.7rem", marginBottom: 0 }}>
          No data for selected range.
        </p>
      ) : (
        <div className="stripe-ui__table-wrap" style={{ marginTop: "0.9rem" }}>
          <svg
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

type GrowthBreakdownChartProps = {
  points: CombinedPoint[];
  currency: string;
};

function GrowthBreakdownChart({ points, currency }: GrowthBreakdownChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

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

  return (
    <section className="stripe-ui__panel ui-reveal ui-reveal-2">
      <div className="stripe-ui__section-head">
        <div>
          <h2 className="stripe-ui__panel-title">Growth Breakdown</h2>
          <p className="stripe-ui__panel-subtitle" style={{ marginBottom: 0 }}>
            Combined New, Expansion, Contraction, and Churn contributions (MRR).
          </p>
        </div>
        <div className="stripe-ui__hint" aria-live="polite">
          {hovered
            ? `${hovered.point.label}: Net ${formatMoney(hovered.point.netMrrChange, currency)}`
            : "Hover on bars for values"}
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

  return (
    <section className="stripe-ui__panel ui-reveal ui-reveal-2">
      <div className="stripe-ui__section-head">
        <div>
          <h2 className="stripe-ui__panel-title">{title}</h2>
          <p className="stripe-ui__panel-subtitle" style={{ marginBottom: 0 }}>
            {subtitle}
          </p>
        </div>
        <div className="stripe-ui__hint" aria-live="polite">
          {hovered
            ? `${hovered.label}: ${valueFormatter(valueAccessor(hovered))}`
            : "Hover on bars for values"}
        </div>
      </div>

      {points.length === 0 ? (
        <p className="stripe-ui__panel-subtitle" style={{ marginTop: "0.9rem", marginBottom: 0 }}>
          No data for selected range.
        </p>
      ) : (
        <div className="stripe-ui__table-wrap" style={{ marginTop: "0.9rem" }}>
          <svg
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

  async function run() {
    setHasRunOnce(true);
    setLoading(true);
    setError(null);

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

      const [hubspotMain, hubspotBaseline, stripe] = await Promise.all([
        fetchJson<ReportResponse>("/api/report", hubspotPayload),
        fetchJson<ReportResponse>("/api/report", hubspotBaselinePayload),
        fetchJson<StripeOverviewResponse>("/api/stripe-billing-overview-report", stripePayload),
      ]);

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
          arr: round2((hub?.arr || 0) + (stripePoint?.arr || 0)),
          arrGrowth: round2((hub?.arrGrowth || 0) + (stripePoint?.arrGrowth || 0)),
        };
      });

      const combinedPoints = rawCombined.map((point, idx) => {
        const prevMrr = idx === 0 ? initialPrevCombinedMrr : rawCombined[idx - 1].mrrEnd;
        const mrrGrowthRatePct = Math.abs(prevMrr) > 1e-9
          ? round2(((point.mrrEnd - prevMrr) / Math.abs(prevMrr)) * 100)
          : 0;
        return { ...point, mrrGrowthRatePct };
      });

      const currentMrr = combinedPoints.length ? combinedPoints[combinedPoints.length - 1].mrrEnd : 0;

      setData({
        startDate,
        endDate,
        grain,
        targetCurrency: String(stripe.targetCurrency || "USD").toUpperCase(),
        currentMrr,
        currentArr: round2(currentMrr * 12),
        points: combinedPoints,
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  const points = useMemo(() => data?.points ?? [], [data]);
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
