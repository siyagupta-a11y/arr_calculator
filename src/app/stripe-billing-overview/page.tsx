"use client";

import Link from "next/link";
import React, { useMemo, useState } from "react";

type Grain = "daily" | "weekly" | "monthly" | "quarterly";

type OverviewPoint = {
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

type OverviewResponse = {
  startDate: string;
  endDate: string;
  grain: Grain;
  targetCurrency: string;
  currentMrr: number;
  currentArr: number;
  points: OverviewPoint[];
};

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

function useTickIndices(size: number) {
  if (size <= 1) return [0];
  if (size <= 4) return Array.from({ length: size }, (_, i) => i);
  const out = new Set<number>([0, Math.floor((size - 1) / 2), size - 1]);
  return Array.from(out).sort((a, b) => a - b);
}

type LineChartProps = {
  title: string;
  subtitle: string;
  points: OverviewPoint[];
  valueAccessor: (point: OverviewPoint) => number;
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

  const width = 960;
  const height = 280;
  const paddingLeft = 56;
  const paddingRight = 20;
  const paddingTop = 20;
  const paddingBottom = 44;
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

  const tickIndices = useTickIndices(points.length);

  const hoveredPoint =
    hoverIndex != null && hoverIndex >= 0 && hoverIndex < points.length ? points[hoverIndex] : null;

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
            ? `${hoveredPoint.label}: ${valueFormatter(valueAccessor(hoveredPoint))}`
            : "Hover on chart for values"}
        </div>
      </div>

      {points.length === 0 ? (
        <p className="stripe-ui__panel-subtitle" style={{ marginTop: "0.7rem", marginBottom: 0 }}>
          No data for selected range.
        </p>
      ) : (
        <div className="stripe-ui__table-wrap" style={{ marginTop: "0.9rem", overflowX: "auto" }}>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={title}
            style={{ width: "100%", minWidth: 720, display: "block" }}
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

            {tickIndices.map((idx) => (
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
  points: OverviewPoint[];
  currency: string;
};

function GrowthBreakdownChart({ points, currency }: GrowthBreakdownChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const width = 960;
  const height = 320;
  const paddingLeft = 56;
  const paddingRight = 20;
  const paddingTop = 20;
  const paddingBottom = 46;
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
  const tickIndices = useTickIndices(points.length);
  const hovered = hoverIndex != null && hoverIndex >= 0 && hoverIndex < bars.length ? bars[hoverIndex] : null;

  return (
    <section className="stripe-ui__panel ui-reveal ui-reveal-2">
      <div className="stripe-ui__section-head">
        <div>
          <h2 className="stripe-ui__panel-title">Growth Breakdown</h2>
          <p className="stripe-ui__panel-subtitle" style={{ marginBottom: 0 }}>
            Stacked contributions for New, Expansion, Contraction, and Churn by period.
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
        <div className="stripe-ui__table-wrap" style={{ marginTop: "0.9rem", overflowX: "auto" }}>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label="Growth breakdown chart"
            style={{ width: "100%", minWidth: 720, display: "block" }}
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

            {tickIndices.map((idx) => (
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

export default function StripeBillingOverviewPage() {
  const defaults = useMemo(() => defaultDateRange(), []);

  const [startDate, setStartDate] = useState(defaults.startDate);
  const [endDate, setEndDate] = useState(defaults.endDate);
  const [grain, setGrain] = useState<Grain>("monthly");

  const [loading, setLoading] = useState(false);
  const [hasRunOnce, setHasRunOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<OverviewResponse | null>(null);

  async function run() {
    setHasRunOnce(true);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/stripe-billing-overview-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate, endDate, grain }),
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
      setData(json as OverviewResponse);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  const points = data?.points || [];
  const currency = data?.targetCurrency || "USD";

  return (
    <div className="stripe-ui">
      <section className="stripe-ui__hero ui-reveal">
        <div className="stripe-ui__eyebrow">Revenue intelligence</div>
        <div className="stripe-ui__hero-row">
          <div>
            <h1 className="stripe-ui__title">Stripe Billing Overview</h1>
            <p className="stripe-ui__subtitle">
              Trend dashboard for MRR, growth components, MRR growth rate, ARR, and ARR growth using the same Stripe
              MRR change source and event logic as the Stripe-through-MRR page.
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <Link href="/stripe-through-mrr" className="stripe-ui__hero-link">
              Open Stripe through MRR
            </Link>
            <Link href="/stripe-arr-correct" className="stripe-ui__hero-link">
              Open Stripe ARR (Correct)
            </Link>
            <Link href="/stripe" className="stripe-ui__hero-link">
              Open Stripe report
            </Link>
            <Link href="/" className="stripe-ui__hero-link">
              Open HubSpot report
            </Link>
          </div>
        </div>
      </section>

      <section className="stripe-ui__panel ui-reveal ui-reveal-1">
        <h2 className="stripe-ui__panel-title">Controls</h2>
        <p className="stripe-ui__panel-subtitle">Choose date range and time grain, then load charted metrics.</p>

        <div className="stripe-ui__control-grid">
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="stripe-billing-start-date">
              Start date
            </label>
            <input
              id="stripe-billing-start-date"
              className="stripe-ui__control"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="stripe-billing-end-date">
              End date
            </label>
            <input
              id="stripe-billing-end-date"
              className="stripe-ui__control"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="stripe-billing-grain">
              Time grain
            </label>
            <select
              id="stripe-billing-grain"
              className="stripe-ui__control"
              value={grain}
              onChange={(e) => setGrain(e.target.value as Grain)}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
            </select>
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="stripe-billing-run">
              Load charts
            </label>
            <button id="stripe-billing-run" className="stripe-ui__btn stripe-ui__btn--primary" onClick={run} disabled={loading}>
              {loading ? "Loading..." : "Run"}
            </button>
          </div>
        </div>
      </section>

      {loading && (
        <section className="stripe-ui__panel stripe-ui__loading-panel ui-reveal ui-reveal-2" aria-live="polite" aria-busy="true">
          <h2 className="stripe-ui__panel-title">Loading charts...</h2>
          <p className="stripe-ui__panel-subtitle">Querying Stripe MRR change series and rendering visuals.</p>
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

          <LineChartCard
            title="MRR Over Time"
            subtitle="MRR at the end of each selected period."
            points={points}
            valueAccessor={(p) => p.mrrEnd}
            valueFormatter={(v) => formatMoney(v, currency)}
            stroke="#4f8df9"
          />

          <GrowthBreakdownChart points={points} currency={currency} />

          <LineChartCard
            title="MRR Growth Rate Over Time"
            subtitle="Period-over-period MRR growth rate."
            points={points}
            valueAccessor={(p) => p.mrrGrowthRatePct}
            valueFormatter={(v) => formatPercent(v)}
            stroke="#f59e0b"
            includeZero
          />

          <LineChartCard
            title="ARR Over Time"
            subtitle="ARR = MRR x 12 at period end."
            points={points}
            valueAccessor={(p) => p.arr}
            valueFormatter={(v) => formatMoney(v, currency)}
            stroke="#1fc16b"
          />

          <LineChartCard
            title="ARR Growth Over Time"
            subtitle="Absolute ARR change per period."
            points={points}
            valueAccessor={(p) => p.arrGrowth}
            valueFormatter={(v) => formatMoney(v, currency)}
            stroke="#ef4444"
            includeZero
          />
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
