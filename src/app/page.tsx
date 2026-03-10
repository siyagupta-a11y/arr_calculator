"use client";

import Link from "next/link";
import React, { useCallback, useMemo, useState } from "react";
import type { ReportRequest, ReportResponse, ReportRow, Grain, ReportMode } from "@/lib/types";

function fmtMoney(n: number, currencyDisplay: CurrencyDisplay) {
  const fractionDigits = currencyDisplay === "normal" ? 0 : 2;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(n || 0);
}

type CurrencyDisplay = "normal" | "thousands" | "millions";
type ArrDisplayScope = "all" | "cloud";

type GroupField =
  | "dealName"
  | "deploymentType"
  | "accountId"
  | "territory"
  | "country"
  | "industry"
  | "dealType";

const GROUP_BY_OPTIONS: Array<{ key: GroupField; label: string }> = [
  { key: "dealName", label: "Deal Name" },
  { key: "deploymentType", label: "Deployment Type" },
  { key: "accountId", label: "Account ID" },
  { key: "territory", label: "Territory" },
  { key: "country", label: "Country" },
  { key: "industry", label: "Industry" },
  { key: "dealType", label: "Deal Type" },
];

type UiRow = {
  dealName: string;
  dealId: string;
  companyCountry?: string;
  deploymentType?: string;
  accountId?: string;
  accountName?: string;
  territory?: string;
  country?: string;
  industry?: string;
  dealType?: string;
  groupValues: Partial<Record<GroupField, string>>;
  valuesByPeriod: Record<string, number>;
};

function groupValueForRow(r: UiRow, field: GroupField) {
  if (field === "dealName") return r.dealName || "(blank)";
  if (field === "deploymentType") return r.deploymentType || "(blank)";
  if (field === "territory") return r.territory || "(blank)";
  if (field === "country") {
    const country = String(r.country || "").trim();
    return country ? canonicalCountryLabel(country) : "(blank)";
  }
  if (field === "industry") return r.industry || "(blank)";
  if (field === "dealType") return r.dealType || "(blank)";
  const accountId = String(r.accountId || "").trim();
  const accountName = String(r.accountName || "").trim();
  if (accountName && accountId) return `${accountName} (${accountId})`;
  if (accountName) return accountName;
  if (accountId) return accountId;
  return "(blank)";
}

function normalizeCaseInsensitiveValue(value: string) {
  return String(value || "").trim().toLowerCase();
}

function canonicalCountryKey(value: string) {
  const normalized = normalizeCaseInsensitiveValue(value);
  if (!normalized) return "";

  const compact = normalized.replace(/[^a-z0-9]/g, "");

  if (
    compact === "us" ||
    compact === "usa" ||
    compact === "unitedstates" ||
    compact === "unitedstatesofamerica"
  ) {
    return "united states";
  }

  if (compact === "uae" || compact === "unitedarabemirates") {
    return "united arab emirates";
  }

  return normalized;
}

function canonicalCountryLabel(value: string) {
  const key = canonicalCountryKey(value);
  if (key === "united states") return "United States";
  if (key === "united arab emirates") return "United Arab Emirates";
  return String(value || "").trim();
}

function normalizeGroupKeyValue(field: GroupField, value: string) {
  if (field === "country") return canonicalCountryKey(value);
  return String(value || "").trim();
}

function isCloudDeploymentType(value: string) {
  return normalizeCaseInsensitiveValue(value) === "cloud";
}

function round2(n: number) {
  return Math.round((Number(n) || 0) * 100) / 100;
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

function historyStartForGrain(startDate: string, grain: Grain) {
  const parsed = parseIsoDateOnly(startDate);
  if (!parsed) return startDate;

  if (grain === "daily") {
    const prevDay = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate() - 1));
    return toIsoDateOnly(prevDay);
  }

  if (grain === "monthly") {
    const prevMonthStart = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() - 1, 1));
    return toIsoDateOnly(prevMonthStart);
  }

  if (grain === "quarterly") {
    const qStartMonth = Math.floor(parsed.getUTCMonth() / 3) * 3;
    const prevQuarterStart = new Date(Date.UTC(parsed.getUTCFullYear(), qStartMonth - 3, 1));
    return toIsoDateOnly(prevQuarterStart);
  }

  const prevYearStart = new Date(Date.UTC(parsed.getUTCFullYear() - 1, 0, 1));
  return toIsoDateOnly(prevYearStart);
}

function accountGroupingKey(row: UiRow) {
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
  return "(blank)";
}

function fmtPercent(n: number) {
  return `${new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n || 0)}%`;
}

function tickIndices(size: number) {
  if (size <= 1) return [0];
  if (size <= 4) return Array.from({ length: size }, (_, i) => i);
  const out = new Set<number>([0, Math.floor((size - 1) / 2), size - 1]);
  return Array.from(out).sort((a, b) => a - b);
}

type TrendPoint = {
  key: string;
  label: string;
  mrr: number;
  arr: number;
  newMrr: number;
  expansionMrr: number;
  contractionMrr: number;
  churnMrr: number;
  netMrrChange: number;
  mrrGrowthRatePct: number;
  arrGrowth: number;
};

type LineChartProps = {
  title: string;
  subtitle: string;
  points: TrendPoint[];
  valueAccessor: (point: TrendPoint) => number;
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
  const paddingLeft = 88;
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

  const tooltipWidth = 210;
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
          {hoveredPoint ? `${hoveredPoint.label}: ${valueFormatter(hoveredValue)}` : "Hover on chart for values"}
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
  points: TrendPoint[];
};

function GrowthBreakdownChart({ points }: GrowthBreakdownChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const width = 640;
  const height = 280;
  const paddingLeft = 88;
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

    return { point, components, positiveTotal, negativeTotal };
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
            Account-level movement (Contracted ARR, Cloud only) split into New, Expansion, Contraction, and Churn (MRR).
          </p>
        </div>
        <div className="stripe-ui__hint" aria-live="polite">
          {hovered ? `${hovered.point.label}: Net ${fmtMoney(hovered.point.netMrrChange, "normal")}` : "Hover on bars for values"}
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
              {fmtMoney(maxValue, "normal")}
            </text>
            <text x={paddingLeft - 8} y={paddingTop + plotHeight} textAnchor="end" fill="#8ea7cb" fontSize="12">
              {fmtMoney(minValue, "normal")}
            </text>
          </svg>

          {hovered && (
            <div className="stripe-ui__panel" style={{ marginTop: "0.8rem", padding: "0.75rem" }}>
              <div className="stripe-ui__hint" style={{ marginBottom: "0.35rem" }}>
                {hovered.point.label}
              </div>
              <div className="stripe-ui__hint">New: {fmtMoney(hovered.point.newMrr, "normal")}</div>
              <div className="stripe-ui__hint">Expansion: {fmtMoney(hovered.point.expansionMrr, "normal")}</div>
              <div className="stripe-ui__hint">Contraction: {fmtMoney(hovered.point.contractionMrr, "normal")}</div>
              <div className="stripe-ui__hint">Churn: {fmtMoney(hovered.point.churnMrr, "normal")}</div>
              <div className="stripe-ui__hint">Net: {fmtMoney(hovered.point.netMrrChange, "normal")}</div>
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
  points: TrendPoint[];
  valueAccessor: (point: TrendPoint) => number;
  valueFormatter: (value: number) => string;
};

function DeltaBarChartCard({ title, subtitle, points, valueAccessor, valueFormatter }: DeltaBarChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const width = 640;
  const height = 280;
  const paddingLeft = 88;
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
  const hovered = hoverIndex != null && hoverIndex >= 0 && hoverIndex < points.length ? points[hoverIndex] : null;

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
          {hovered ? `${hovered.label}: ${valueFormatter(valueAccessor(hovered))}` : "Hover on bars for values"}
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

export default function Home() {
  const [startDate, setStartDate] = useState("2025-01-01");
  const [endDate, setEndDate] = useState("2025-12-31");
  const [mode, setMode] = useState<ReportMode>("arr");
  const [grain, setGrain] = useState<Grain>("monthly");

  const [groupByFields, setGroupByFields] = useState<GroupField[]>([]);
  const [groupByToAdd, setGroupByToAdd] = useState<GroupField | "none">("none");

  const [filterDealName, setFilterDealName] = useState("");
  const [filterDeploymentType, setFilterDeploymentType] = useState("all");
  const [filterAccountId, setFilterAccountId] = useState("");
  const [filterTerritory, setFilterTerritory] = useState("all");
  const [filterCountry, setFilterCountry] = useState("all");
  const [filterIndustry, setFilterIndustry] = useState("all");
  const [filterDealType, setFilterDealType] = useState("all");
  const [currencyDisplay, setCurrencyDisplay] = useState<CurrencyDisplay>("normal");
  const [arrDisplayScope, setArrDisplayScope] = useState<ArrDisplayScope>("all");

  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ReportResponse | null>(null);
  const [chartData, setChartData] = useState<ReportResponse | null>(null);
  const [chartHistoryData, setChartHistoryData] = useState<ReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    setData(null);
    setChartData(null);
    setChartHistoryData(null);

    const payload: ReportRequest = {
      startDate,
      endDate,
      mode,
      grain,
    };

    const chartPayload: ReportRequest = {
      startDate,
      endDate,
      mode: "contracted",
      grain,
    };

    try {
      const fetchReport = async (requestPayload: ReportRequest) => {
        const res = await fetch("/api/report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestPayload),
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
          throw new Error(text || "Request failed");
        }

        if (!json || typeof json !== "object") throw new Error("Invalid API response");
        return json as ReportResponse;
      };

      const [mainReport, chartMainReport] = await Promise.all([
        fetchReport(payload),
        fetchReport(chartPayload),
      ]);
      setData(mainReport);
      setChartData(chartMainReport);

      const historyStart = historyStartForGrain(startDate, grain);
      if (historyStart !== startDate) {
        try {
          const historyPayload: ReportRequest = {
            ...chartPayload,
            startDate: historyStart,
          };
          const historyReport = await fetchReport(historyPayload);
          setChartHistoryData(historyReport);
        } catch {
          setChartHistoryData(chartMainReport);
        }
      } else {
        setChartHistoryData(chartMainReport);
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Unknown error";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  const deploymentTypeOptions = useMemo(() => {
    if (!data) return [];
    const values = new Set<string>();
    for (const r of data.rows || []) {
      const value = String(r.deploymentType || "").trim();
      if (value) values.add(value);
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [data]);

  const territoryOptions = useMemo(() => {
    if (!data) return [];
    const values = new Set<string>();
    for (const r of data.rows || []) {
      const value = String(r.territory || "").trim();
      if (value) values.add(value);
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [data]);

  const countryOptions = useMemo(() => {
    if (!data) return [];
    const valuesByNormalized = new Map<string, string>();
    for (const r of data.rows || []) {
      const value = String(r.country || "").trim();
      if (!value) continue;
      const normalized = canonicalCountryKey(value);
      if (!valuesByNormalized.has(normalized)) valuesByNormalized.set(normalized, canonicalCountryLabel(value));
    }
    return Array.from(valuesByNormalized.values()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [data]);

  const industryOptions = useMemo(() => {
    if (!data) return [];
    const values = new Set<string>();
    for (const r of data.rows || []) {
      const value = String(r.industry || "").trim();
      if (value) values.add(value);
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [data]);

  const dealTypeOptions = useMemo(() => {
    if (!data) return [];
    const values = new Set<string>();
    for (const r of data.rows || []) {
      const value = String(r.dealType || "").trim();
      if (value) values.add(value);
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [data]);

  const buildFilteredLineItemRows = useCallback((
    sourceData: ReportResponse | null,
    options?: { forceCloudOnly?: boolean },
  ) => {
    if (!sourceData) return [] as UiRow[];

    const baseRows: UiRow[] = (sourceData.rows || []).map((r: ReportRow) => ({
      dealName: r.dealName || "",
      dealId: r.dealId || "",
      companyCountry: r.companyCountry || "",
      deploymentType: r.deploymentType || "",
      accountId: r.accountId || "",
      accountName: r.accountName || "",
      territory: r.territory || "",
      country: r.country || "",
      industry: r.industry || "",
      dealType: r.dealType || "",
      groupValues: {},
      valuesByPeriod: r.valuesByPeriod || {},
    }));

    const dealNameNeedle = filterDealName.trim().toLowerCase();
    const accountIdNeedle = filterAccountId.trim().toLowerCase();

    const filteredBaseRows = baseRows.filter((r) => {
      const forceCloudOnly = options?.forceCloudOnly === true;
      const displayScopeOk = forceCloudOnly
        ? isCloudDeploymentType(r.deploymentType || "")
        : arrDisplayScope === "all" || isCloudDeploymentType(r.deploymentType || "");
      const dealNameOk = !dealNameNeedle || (r.dealName || "").toLowerCase().includes(dealNameNeedle);
      const deploymentTypeOk = forceCloudOnly
        ? isCloudDeploymentType(r.deploymentType || "")
        : filterDeploymentType === "all" || (r.deploymentType || "") === filterDeploymentType;
      const accountIdOk = !accountIdNeedle || (r.accountId || "").toLowerCase().includes(accountIdNeedle);
      const territoryOk = filterTerritory === "all" || (r.territory || "") === filterTerritory;
      const countryOk =
        filterCountry === "all" ||
        canonicalCountryKey(r.country || "") === canonicalCountryKey(filterCountry);
      const industryOk = filterIndustry === "all" || (r.industry || "") === filterIndustry;
      const dealTypeOk = filterDealType === "all" || (r.dealType || "") === filterDealType;
      return (
        displayScopeOk &&
        dealNameOk &&
        deploymentTypeOk &&
        accountIdOk &&
        territoryOk &&
        countryOk &&
        industryOk &&
        dealTypeOk
      );
    });

    return filteredBaseRows.filter((r) => hasAnyNonZeroValue(r.valuesByPeriod));
  }, [
    filterDealName,
    filterDeploymentType,
    filterAccountId,
    filterTerritory,
    filterCountry,
    filterIndustry,
    filterDealType,
    arrDisplayScope,
  ]);

  const filteredLineItemRows: UiRow[] = useMemo(() => buildFilteredLineItemRows(data), [
    buildFilteredLineItemRows,
    data,
  ]);

  const chartDisplayData = chartData || data;
  const chartSourceData = chartHistoryData || chartDisplayData;
  const filteredChartLineItemRows: UiRow[] = useMemo(() => buildFilteredLineItemRows(chartSourceData, { forceCloudOnly: true }), [
    buildFilteredLineItemRows,
    chartSourceData,
  ]);

  const displayedRows: UiRow[] = useMemo(() => {
    if (groupByFields.length === 0) return filteredLineItemRows;

    const map = new Map<string, UiRow>();

    for (const r of filteredLineItemRows) {
      const key = groupByFields
        .map((field) => `${field}:${normalizeGroupKeyValue(field, groupValueForRow(r, field))}`)
        .join("|");

      if (!map.has(key)) {
        const groupValues: Partial<Record<GroupField, string>> = {};
        for (const field of groupByFields) {
          groupValues[field] = groupValueForRow(r, field);
        }

        map.set(key, {
          dealName: r.dealName,
          dealId: r.dealId,
          companyCountry: r.companyCountry,
          deploymentType: r.deploymentType,
          accountId: r.accountId,
          accountName: r.accountName,
          territory: r.territory,
          country: r.country,
          industry: r.industry,
          dealType: r.dealType,
          groupValues,
          valuesByPeriod: { ...r.valuesByPeriod },
        });
      } else {
        const agg = map.get(key)!;
        for (const p of Object.keys(r.valuesByPeriod || {})) {
          agg.valuesByPeriod[p] = (agg.valuesByPeriod[p] || 0) + (r.valuesByPeriod[p] || 0);
        }
      }
    }

    for (const agg of map.values()) {
      for (const p of Object.keys(agg.valuesByPeriod)) {
        agg.valuesByPeriod[p] = round2(agg.valuesByPeriod[p] || 0);
      }
    }

    return Array.from(map.values()).filter((r) => hasAnyNonZeroValue(r.valuesByPeriod));
  }, [
    filteredLineItemRows,
    groupByFields,
  ]);

  const totalsByPeriodForDisplayed = useMemo(() => {
    if (!data) return [];
    return data.periods.map((p) => {
      const total = displayedRows.reduce((acc, r) => acc + (r.valuesByPeriod[p.key] || 0), 0);
      return { key: p.key, label: p.label, total: round2(total) };
    });
  }, [data, displayedRows]);

  const accountArrByPeriod = useMemo(() => {
    if (!chartSourceData) return new Map<string, Record<string, number>>();
    const periodOrder = chartSourceData.periods || [];
    const grouped = new Map<string, Record<string, number>>();

    for (const row of filteredChartLineItemRows) {
      const key = accountGroupingKey(row);
      if (!grouped.has(key)) grouped.set(key, {});
      const bucket = grouped.get(key)!;
      for (const period of periodOrder) {
        bucket[period.key] = round2((bucket[period.key] || 0) + (row.valuesByPeriod[period.key] || 0));
      }
    }

    return grouped;
  }, [chartSourceData, filteredChartLineItemRows]);

  const chartPoints: TrendPoint[] = useMemo(() => {
    if (!chartDisplayData) return [];

    const periodOrder = chartDisplayData.periods || [];
    const sourcePeriods = chartSourceData?.periods || periodOrder;
    const sourcePeriodKeys = sourcePeriods.map((period) => period.key);
    const sourcePeriodIndex = new Map<string, number>(sourcePeriodKeys.map((key, idx) => [key, idx]));

    const totalByPeriodAll = new Map<string, number>();
    for (const accountTotals of accountArrByPeriod.values()) {
      for (const [periodKey, value] of Object.entries(accountTotals)) {
        totalByPeriodAll.set(periodKey, round2((totalByPeriodAll.get(periodKey) || 0) + (value || 0)));
      }
    }

    return periodOrder.map((period, idx) => {
      const sourceIdx = sourcePeriodIndex.get(period.key) ?? -1;
      const prevPeriodKey =
        idx > 0
          ? periodOrder[idx - 1].key
          : sourceIdx > 0
            ? sourcePeriodKeys[sourceIdx - 1]
            : "";

      const arr = round2(totalByPeriodAll.get(period.key) || 0);
      const mrr = round2(arr / 12);
      const prevArr = round2(prevPeriodKey ? totalByPeriodAll.get(prevPeriodKey) || 0 : 0);
      const prevMrr = round2(prevArr / 12);
      const arrGrowth = round2(arr - prevArr);
      const mrrGrowthRatePct =
        prevPeriodKey && Math.abs(prevMrr) > 1e-9 ? round2(((mrr - prevMrr) / Math.abs(prevMrr)) * 100) : 0;

      let newMrr = 0;
      let expansionMrr = 0;
      let contractionMrr = 0;
      let churnMrr = 0;

      for (const accountTotals of accountArrByPeriod.values()) {
        const currArr = round2(accountTotals[period.key] || 0);
        const prevAccountArr = round2(idx > 0 ? accountTotals[prevPeriodKey] || 0 : 0);
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
        mrr,
        arr,
        newMrr,
        expansionMrr,
        contractionMrr,
        churnMrr,
        netMrrChange,
        mrrGrowthRatePct,
        arrGrowth,
      };
    });
  }, [chartDisplayData, chartSourceData, accountArrByPeriod]);

  const showDealIdColumn = groupByFields.length === 0;
  const groupByLabel = groupByFields
    .map((field) => GROUP_BY_OPTIONS.find((opt) => opt.key === field)?.label || field)
    .join(" + ");
  const breakdownHeaders = [
    ...(groupByFields.length === 0
      ? ["Deal name"]
      : groupByFields.map((field) => GROUP_BY_OPTIONS.find((opt) => opt.key === field)?.label || field)),
    ...(showDealIdColumn ? ["Deal ID"] : []),
    ...(showDealIdColumn ? ["Account"] : []),
    ...(showDealIdColumn ? ["Territory"] : []),
    ...(showDealIdColumn ? ["Company Country"] : []),
    ...(data?.periods.map((p) => p.label) || []),
  ];

  function scaleCurrency(n: number) {
    if (currencyDisplay === "thousands") return n / 1_000;
    if (currencyDisplay === "millions") return n / 1_000_000;
    return n;
  }

  function currencySuffix() {
    if (currencyDisplay === "thousands") return " (K)";
    if (currencyDisplay === "millions") return " (M)";
    return "";
  }

  function escapeCsvCell(value: string | number) {
    const text = String(value ?? "");
    if (text.includes(",") || text.includes("\"") || text.includes("\n")) {
      return `"${text.replace(/"/g, "\"\"")}"`;
    }
    return text;
  }

  function exportBreakdownCsv() {
    if (!data) return;

    const csvHeaders = breakdownHeaders.map((h) =>
      h !== "Deal name" && h !== "Deal ID" && h !== "Account" && h !== "Territory" && h !== "Company Country"
        ? `${h}${currencySuffix()}`
        : h,
    );
    const lines: string[] = [csvHeaders.map(escapeCsvCell).join(",")];

    for (const r of displayedRows) {
      const leadingColumns =
        groupByFields.length === 0
          ? [r.dealName]
          : groupByFields.map((field) => r.groupValues[field] || "(blank)");
      const dealIdCol = showDealIdColumn ? [r.dealId] : [];
      const accountCol = showDealIdColumn ? [groupValueForRow(r, "accountId")] : [];
      const territoryCol = showDealIdColumn ? [r.territory || "(blank)"] : [];
      const companyCountryCol = showDealIdColumn ? [r.companyCountry || "(blank)"] : [];
      const valueCols = (data.periods || []).map((p) => round2(scaleCurrency(r.valuesByPeriod[p.key] || 0)));
      const row = [...leadingColumns, ...dealIdCol, ...accountCol, ...territoryCol, ...companyCountryCol, ...valueCols];
      lines.push(row.map(escapeCsvCell).join(","));
    }

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `arr-breakdown-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function addGroupBy() {
    if (groupByToAdd === "none") return;
    setGroupByFields((prev) => (prev.includes(groupByToAdd) ? prev : [...prev, groupByToAdd]));
    setGroupByToAdd("none");
  }

  function removeGroupBy(field: GroupField) {
    setGroupByFields((prev) => prev.filter((f) => f !== field));
  }

  return (
    <div className="stripe-ui">
      <section className="stripe-ui__hero ui-reveal">
        <div className="stripe-ui__eyebrow">Revenue intelligence</div>
        <div className="stripe-ui__hero-row">
          <div>
            <h1 className="stripe-ui__title">HubSpot ARR Report</h1>
            <p className="stripe-ui__subtitle">
              Select a date range and mode to analyze ARR, MRR, growth breakdown, and period trends from HubSpot data.
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <Link href="/stripe-arr-correct" className="stripe-ui__hero-link">
              Open Stripe ARR (Correct)
            </Link>
            <Link href="/stripe-through-mrr" className="stripe-ui__hero-link">
              Open Stripe through MRR
            </Link>
            <Link href="/stripe-billing-overview" className="stripe-ui__hero-link">
              Open Stripe Billing Overview
            </Link>
          </div>
        </div>
      </section>

      <section className="stripe-ui__panel ui-reveal ui-reveal-1">
        <h2 className="stripe-ui__panel-title">Controls</h2>
        <p className="stripe-ui__panel-subtitle">Set date range, mode, grain, and grouping, then run the report.</p>

        <div className="stripe-ui__control-grid">
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="hubspot-start-date">
              Start date
            </label>
            <input
              id="hubspot-start-date"
              className="stripe-ui__control"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="hubspot-end-date">
              End date
            </label>
            <input
              id="hubspot-end-date"
              className="stripe-ui__control"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="hubspot-mode">
              Mode
            </label>
            <select
              id="hubspot-mode"
              className="stripe-ui__control"
              value={mode}
              onChange={(e) => setMode(e.target.value as ReportMode)}
            >
              <option value="arr">ARR</option>
              <option value="contracted">Contracted ARR</option>
            </select>
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="hubspot-grain">
              Time grain
            </label>
            <select
              id="hubspot-grain"
              className="stripe-ui__control"
              value={grain}
              onChange={(e) => setGrain(e.target.value as Grain)}
            >
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="annually">Annually</option>
              <option value="daily">Daily (not recommended)</option>
            </select>
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="hubspot-currency-display">
              Currency display
            </label>
            <select
              id="hubspot-currency-display"
              className="stripe-ui__control"
              value={currencyDisplay}
              onChange={(e) => setCurrencyDisplay(e.target.value as CurrencyDisplay)}
            >
              <option value="normal">Normal</option>
              <option value="thousands">Thousands (K)</option>
              <option value="millions">Millions (M)</option>
            </select>
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="hubspot-arr-display">
              ARR display
            </label>
            <select
              id="hubspot-arr-display"
              className="stripe-ui__control"
              value={arrDisplayScope}
              onChange={(e) => setArrDisplayScope(e.target.value as ArrDisplayScope)}
            >
              <option value="all">All</option>
              <option value="cloud">Cloud</option>
            </select>
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="hubspot-group-by">
              Group by field
            </label>
            <select
              id="hubspot-group-by"
              className="stripe-ui__control"
              value={groupByToAdd}
              onChange={(e) => setGroupByToAdd(e.target.value as GroupField | "none")}
            >
              <option value="none">Select field</option>
              {GROUP_BY_OPTIONS.map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="hubspot-add-group">
              Add group
            </label>
            <button
              id="hubspot-add-group"
              className="stripe-ui__btn stripe-ui__btn--secondary"
              onClick={addGroupBy}
              disabled={groupByToAdd === "none"}
            >
              Add
            </button>
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="hubspot-clear-groups">
              Clear groups
            </label>
            <button
              id="hubspot-clear-groups"
              className="stripe-ui__btn stripe-ui__btn--ghost"
              onClick={() => setGroupByFields([])}
              disabled={groupByFields.length === 0}
            >
              Clear
            </button>
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="hubspot-run-report">
              Run report
            </label>
            <button
              id="hubspot-run-report"
              className="stripe-ui__btn stripe-ui__btn--primary"
              onClick={run}
              disabled={loading}
            >
              {loading ? "Running..." : "Run"}
            </button>
          </div>
        </div>

        {groupByFields.length > 0 && (
          <div className="stripe-ui__chips">
            {groupByFields.map((field) => (
              <button
                key={field}
                className="stripe-ui__chip"
                onClick={() => removeGroupBy(field)}
                type="button"
              >
                {(GROUP_BY_OPTIONS.find((opt) => opt.key === field)?.label || field) + " x"}
              </button>
            ))}
          </div>
        )}
      </section>

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

      {loading && (
        <section className="stripe-ui__panel stripe-ui__loading-panel ui-reveal ui-reveal-2" aria-live="polite" aria-busy="true">
          <h2 className="stripe-ui__panel-title">Running report...</h2>
          <p className="stripe-ui__panel-subtitle">Loading HubSpot data and calculating chart metrics.</p>
          <div className="stripe-ui__skeleton-grid">
            <div className="stripe-ui__skeleton-row" />
            <div className="stripe-ui__skeleton-row" />
            <div className="stripe-ui__skeleton-row stripe-ui__skeleton-row--short" />
          </div>
        </section>
      )}

      {!loading && data && (
        <>
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
              subtitle="MRR derived from Contracted ARR / 12 (Cloud deployments, grouped by account ID)."
              points={chartPoints}
              valueAccessor={(p) => p.mrr}
              valueFormatter={(v) => fmtMoney(v, "normal")}
              stroke="#4f8df9"
            />

            <GrowthBreakdownChart points={chartPoints} />

            <LineChartCard
              title="MRR Growth Rate Over Time"
              subtitle="Period-over-period MRR growth rate using prior-period baseline."
              points={chartPoints}
              valueAccessor={(p) => p.mrrGrowthRatePct}
              valueFormatter={(v) => fmtPercent(v)}
              stroke="#f59e0b"
              includeZero
            />

            <LineChartCard
              title="ARR Over Time"
              subtitle="Contracted ARR at the end of each period (Cloud deployments only)."
              points={chartPoints}
              valueAccessor={(p) => p.arr}
              valueFormatter={(v) => fmtMoney(v, "normal")}
              stroke="#1fc16b"
            />

            <DeltaBarChartCard
              title="ARR Growth Over Time"
              subtitle="Absolute Contracted ARR change per period."
              points={chartPoints}
              valueAccessor={(p) => p.arrGrowth}
              valueFormatter={(v) => fmtMoney(v, "normal")}
            />
          </div>

          <section className="stripe-ui__panel ui-reveal ui-reveal-2">
            <div className="stripe-ui__section-head">
              <div>
                <h2 className="stripe-ui__panel-title">Filters & Totals</h2>
                <p className="stripe-ui__panel-subtitle" style={{ marginBottom: 0 }}>
                  Apply filters to rows. Charts are always Contracted ARR + Cloud-only, grouped by account ID.
                </p>
              </div>
              <div className="stripe-ui__hint">
                Rows ({groupByFields.length === 0 ? "line items" : `groups: ${groupByLabel}`}): {displayedRows.length}
              </div>
            </div>

            <div className="stripe-ui__filter-grid">
              <div className="stripe-ui__field">
                <label className="stripe-ui__field-label" htmlFor="filter-deal-name">
                  Filter Deal Name
                </label>
                <input
                  id="filter-deal-name"
                  className="stripe-ui__control"
                  type="text"
                  value={filterDealName}
                  onChange={(e) => setFilterDealName(e.target.value)}
                  placeholder="contains..."
                />
              </div>

              <div className="stripe-ui__field">
                <label className="stripe-ui__field-label" htmlFor="filter-deployment-type">
                  Filter Deployment Type
                </label>
                <select
                  id="filter-deployment-type"
                  className="stripe-ui__control"
                  value={filterDeploymentType}
                  onChange={(e) => setFilterDeploymentType(e.target.value)}
                >
                  <option value="all">All</option>
                  {deploymentTypeOptions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>

              <div className="stripe-ui__field">
                <label className="stripe-ui__field-label" htmlFor="filter-account-id">
                  Filter Account ID
                </label>
                <input
                  id="filter-account-id"
                  className="stripe-ui__control"
                  type="text"
                  value={filterAccountId}
                  onChange={(e) => setFilterAccountId(e.target.value)}
                  placeholder="contains..."
                />
              </div>

              <div className="stripe-ui__field">
                <label className="stripe-ui__field-label" htmlFor="filter-territory">
                  Filter Territory
                </label>
                <select
                  id="filter-territory"
                  className="stripe-ui__control"
                  value={filterTerritory}
                  onChange={(e) => setFilterTerritory(e.target.value)}
                >
                  <option value="all">All</option>
                  {territoryOptions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>

              <div className="stripe-ui__field">
                <label className="stripe-ui__field-label" htmlFor="filter-country">
                  Filter Country
                </label>
                <select
                  id="filter-country"
                  className="stripe-ui__control"
                  value={filterCountry}
                  onChange={(e) => setFilterCountry(e.target.value)}
                >
                  <option value="all">All</option>
                  {countryOptions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>

              <div className="stripe-ui__field">
                <label className="stripe-ui__field-label" htmlFor="filter-industry">
                  Filter Industry
                </label>
                <select
                  id="filter-industry"
                  className="stripe-ui__control"
                  value={filterIndustry}
                  onChange={(e) => setFilterIndustry(e.target.value)}
                >
                  <option value="all">All</option>
                  {industryOptions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>

              <div className="stripe-ui__field">
                <label className="stripe-ui__field-label" htmlFor="filter-deal-type">
                  Filter Deal Type
                </label>
                <select
                  id="filter-deal-type"
                  className="stripe-ui__control"
                  value={filterDealType}
                  onChange={(e) => setFilterDealType(e.target.value)}
                >
                  <option value="all">All</option>
                  {dealTypeOptions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="stripe-ui__table-wrap" style={{ marginTop: "0.85rem" }}>
              <table className="stripe-ui__table">
                <thead>
                  <tr>
                    {data.periods.map((p) => (
                      <th key={p.key} className="stripe-ui__num">
                        {p.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    {totalsByPeriodForDisplayed.map((t) => (
                      <td key={t.key} className="stripe-ui__num">
                        {fmtMoney(scaleCurrency(t.total), currencyDisplay)}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="stripe-ui__panel ui-reveal ui-reveal-2">
            <div className="stripe-ui__toolbar">
              <div>
                <h2 className="stripe-ui__panel-title">
                  Breakdown {groupByFields.length === 0 ? "(per line item)" : `(grouped by ${groupByLabel})`}
                </h2>
              </div>
              <div className="stripe-ui__toolbar-group">
                <button className="stripe-ui__btn stripe-ui__btn--secondary" onClick={exportBreakdownCsv}>
                  Export breakdown CSV
                </button>
              </div>
            </div>

            <div className="stripe-ui__table-wrap">
              <table className="stripe-ui__table">
                <thead>
                  <tr>
                    {breakdownHeaders.map((h) => (
                      <th key={h} className={data.periods.some((p) => p.label === h) ? "stripe-ui__num" : ""}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {displayedRows.map((r, idx) => (
                    <tr key={`${r.dealId || r.dealName}-${idx}`}>
                      {groupByFields.length === 0 ? (
                        <td>{r.dealName}</td>
                      ) : (
                        groupByFields.map((field) => (
                          <td key={field}>{r.groupValues[field] || "(blank)"}</td>
                        ))
                      )}
                      {showDealIdColumn && <td>{r.dealId}</td>}
                      {showDealIdColumn && <td>{groupValueForRow(r, "accountId")}</td>}
                      {showDealIdColumn && <td>{r.territory || "(blank)"}</td>}
                      {showDealIdColumn && <td>{r.companyCountry || "(blank)"}</td>}

                      {data.periods.map((p) => (
                        <td key={p.key} className="stripe-ui__num">
                          {fmtMoney(scaleCurrency(r.valuesByPeriod[p.key] || 0), currencyDisplay)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
