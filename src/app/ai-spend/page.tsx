"use client";

import Link from "next/link";
import React, { useCallback, useEffect, useMemo, useState } from "react";

type Grain = "daily" | "weekly" | "monthly" | "quarterly";

type AiSpendPoint = {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  revenue: number;
  lineCount: number;
  customerCount: number;
};

type AiSpendGroupRow = {
  key: string;
  label: string;
  revenue: number;
  lineCount: number;
};

type AiSpendPriceRow = {
  priceId: string;
  priceLabel: string;
  productId: string;
  productLabel: string;
  revenue: number;
  lineCount: number;
};

type AiSpendDetailRow = {
  invoiceDate: string;
  customerId: string;
  customerName: string;
  lineItemId: string;
  lineItemDescription: string;
  priceId: string;
  priceLabel: string;
  productId: string;
  productLabel: string;
  revenue: number;
  quantity: number;
};

type ApiResponse = {
  startDate: string;
  endDate: string;
  grain: Grain;
  targetCurrency: string;
  totalRevenue: number;
  points: AiSpendPoint[];
  topCustomers: AiSpendGroupRow[];
  topProducts: AiSpendGroupRow[];
  topPrices: AiSpendPriceRow[];
  detailRows: AiSpendDetailRow[];
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

function withLabel(id: string, label: string) {
  const cleanId = String(id || "").trim() || "(blank)";
  const cleanLabel = String(label || "").trim();
  if (!cleanLabel || cleanLabel === cleanId || cleanLabel === "(blank)") return cleanId;
  return `${cleanId} (${cleanLabel})`;
}

export default function AiSpendPage() {
  const defaults = useMemo(() => defaultDateRange(), []);

  const [startDate, setStartDate] = useState(defaults.startDate);
  const [endDate, setEndDate] = useState(defaults.endDate);
  const [grain, setGrain] = useState<Grain>("monthly");
  const [topLimit, setTopLimit] = useState(25);
  const [detailLimit, setDetailLimit] = useState(300);

  const [hasRunOnce, setHasRunOnce] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiResponse | null>(null);

  const run = useCallback(async (request: {
    startDate: string;
    endDate: string;
    grain: Grain;
    topLimit: number;
    detailLimit: number;
  }) => {
    setHasRunOnce(true);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/stripe-ai-spend-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
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
      setData(json as ApiResponse);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Unknown error";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void run({
      startDate: defaults.startDate,
      endDate: defaults.endDate,
      grain: "monthly",
      topLimit: 25,
      detailLimit: 300,
    });
  }, [defaults.endDate, defaults.startDate, run]);

  const summaryCurrency = data?.targetCurrency || "USD";
  const points = useMemo(() => data?.points || [], [data]);
  const totalLineCount = useMemo(
    () => points.reduce((sum, point) => sum + (point.lineCount || 0), 0),
    [points],
  );
  const uniqueCustomersShown = useMemo(() => {
    const set = new Set<string>();
    for (const row of data?.detailRows || []) {
      if (row.customerId) set.add(row.customerId);
    }
    return set.size;
  }, [data]);

  return (
    <div className="stripe-ui">
      <section className="stripe-ui__hero ui-reveal">
        <div className="stripe-ui__eyebrow">Revenue intelligence</div>
        <div className="stripe-ui__hero-row">
          <div>
            <h1 className="stripe-ui__title">AI spend</h1>
            <p className="stripe-ui__subtitle">
              Mirrors Stripe&apos;s Revenue from metered usage report using backend-aggregated data from Stripe invoice lines and
              displays period totals, top contributors, and raw metered line items.
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <Link href="/combined-billing-overview" className="stripe-ui__hero-link">
              Open Combined Billing Overview
            </Link>
            <Link href="/stripe-billing-overview" className="stripe-ui__hero-link">
              Open Stripe Billing Overview
            </Link>
            <Link href="/stripe-through-mrr" className="stripe-ui__hero-link">
              Open Stripe through MRR
            </Link>
            <Link href="/hubspot" className="stripe-ui__hero-link">
              Open HubSpot report
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
        <h2 className="stripe-ui__panel-title">Report controls</h2>
        <p className="stripe-ui__panel-subtitle">Select range and grain, then load metered usage revenue.</p>

        <div className="stripe-ui__control-grid">
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="ai-spend-start-date">
              Start date
            </label>
            <input
              id="ai-spend-start-date"
              className="stripe-ui__control"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="ai-spend-end-date">
              End date
            </label>
            <input
              id="ai-spend-end-date"
              className="stripe-ui__control"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="ai-spend-grain">
              Time grain
            </label>
            <select
              id="ai-spend-grain"
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
            <label className="stripe-ui__field-label" htmlFor="ai-spend-top-limit">
              Top rows per group
            </label>
            <input
              id="ai-spend-top-limit"
              className="stripe-ui__control"
              type="number"
              min={1}
              max={500}
              value={topLimit}
              onChange={(e) => setTopLimit(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            />
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="ai-spend-detail-limit">
              Detail rows limit
            </label>
            <input
              id="ai-spend-detail-limit"
              className="stripe-ui__control"
              type="number"
              min={1}
              max={1000}
              value={detailLimit}
              onChange={(e) => setDetailLimit(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            />
          </div>
        </div>

        <div className="stripe-ui__actions">
          <button
            id="ai-spend-run-report"
            className="stripe-ui__btn stripe-ui__btn--primary"
            onClick={() =>
              void run({
                startDate,
                endDate,
                grain,
                topLimit,
                detailLimit,
              })
            }
          >
            {loading ? "Loading..." : "Run report"}
          </button>
        </div>
      </section>

      {error ? <section className="stripe-ui__error">{error}</section> : null}

      {loading ? (
        <section className="stripe-ui__panel stripe-ui__loading-panel">
          <div className="stripe-ui__panel-title">Loading AI spend...</div>
          <div className="stripe-ui__skeleton-grid">
            <div className="stripe-ui__skeleton-row" />
            <div className="stripe-ui__skeleton-row" />
            <div className="stripe-ui__skeleton-row stripe-ui__skeleton-row--short" />
          </div>
        </section>
      ) : null}

      {!loading && data ? (
        <>
          <section className="stripe-ui__panel ui-reveal ui-reveal-2">
            <h2 className="stripe-ui__panel-title">Summary</h2>
            <div className="stripe-ui__stats" style={{ gridTemplateColumns: "repeat(4, minmax(140px, 1fr))" }}>
              <article className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Total metered revenue</p>
                <p className="stripe-ui__stat-value">{formatMoney(data.totalRevenue || 0, summaryCurrency)}</p>
              </article>
              <article className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Periods</p>
                <p className="stripe-ui__stat-value">{points.length}</p>
              </article>
              <article className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Line items (period sum)</p>
                <p className="stripe-ui__stat-value">{totalLineCount}</p>
              </article>
              <article className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Customers in details</p>
                <p className="stripe-ui__stat-value">{uniqueCustomersShown}</p>
              </article>
            </div>

            <div className="stripe-ui__table-wrap">
              <table className="stripe-ui__table">
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Period start</th>
                    <th>Period end</th>
                    <th className="stripe-ui__num">Revenue</th>
                    <th className="stripe-ui__num">Customers</th>
                    <th className="stripe-ui__num">Line items</th>
                  </tr>
                </thead>
                <tbody>
                  {points.length === 0 ? (
                    <tr>
                      <td colSpan={6}>No metered usage revenue found for this range.</td>
                    </tr>
                  ) : (
                    points.map((point) => (
                      <tr key={point.key}>
                        <td>{point.label}</td>
                        <td>{point.periodStart}</td>
                        <td>{point.periodEnd}</td>
                        <td className="stripe-ui__num">{formatMoney(point.revenue, summaryCurrency)}</td>
                        <td className="stripe-ui__num">{point.customerCount}</td>
                        <td className="stripe-ui__num">{point.lineCount}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="stripe-ui__panel ui-reveal ui-reveal-2">
            <h2 className="stripe-ui__panel-title">Top contributors</h2>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
                gap: "0.72rem",
              }}
            >
              <article className="stripe-ui__table-wrap">
                <table className="stripe-ui__table">
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th className="stripe-ui__num">Revenue</th>
                      <th className="stripe-ui__num">Lines</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.topCustomers || []).map((row) => (
                      <tr key={`customer-${row.key}`}>
                        <td>{withLabel(row.key, row.label)}</td>
                        <td className="stripe-ui__num">{formatMoney(row.revenue, summaryCurrency)}</td>
                        <td className="stripe-ui__num">{row.lineCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </article>

              <article className="stripe-ui__table-wrap">
                <table className="stripe-ui__table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th className="stripe-ui__num">Revenue</th>
                      <th className="stripe-ui__num">Lines</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.topProducts || []).map((row) => (
                      <tr key={`product-${row.key}`}>
                        <td>{withLabel(row.key, row.label)}</td>
                        <td className="stripe-ui__num">{formatMoney(row.revenue, summaryCurrency)}</td>
                        <td className="stripe-ui__num">{row.lineCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </article>

              <article className="stripe-ui__table-wrap">
                <table className="stripe-ui__table">
                  <thead>
                    <tr>
                      <th>Price</th>
                      <th>Product</th>
                      <th className="stripe-ui__num">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.topPrices || []).map((row) => (
                      <tr key={`price-${row.priceId}-${row.productId}`}>
                        <td>{withLabel(row.priceId, row.priceLabel)}</td>
                        <td>{withLabel(row.productId, row.productLabel)}</td>
                        <td className="stripe-ui__num">{formatMoney(row.revenue, summaryCurrency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </article>
            </div>
          </section>

          <section className="stripe-ui__panel ui-reveal ui-reveal-3">
            <h2 className="stripe-ui__panel-title">Metered usage line items</h2>
            <p className="stripe-ui__panel-subtitle">
              Showing up to {detailLimit} rows sorted by highest revenue contribution first.
            </p>
            <div className="stripe-ui__table-wrap">
              <table className="stripe-ui__table">
                <thead>
                  <tr>
                    <th>Invoice date</th>
                    <th>Customer</th>
                    <th>Line item</th>
                    <th>Price</th>
                    <th>Product</th>
                    <th className="stripe-ui__num">Quantity</th>
                    <th className="stripe-ui__num">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.detailRows || []).length === 0 ? (
                    <tr>
                      <td colSpan={7}>No metered line items found for this range.</td>
                    </tr>
                  ) : (
                    (data.detailRows || []).map((row) => (
                      <tr key={`${row.lineItemId}-${row.invoiceDate}-${row.customerId}`}>
                        <td>{row.invoiceDate}</td>
                        <td>{withLabel(row.customerId, row.customerName)}</td>
                        <td className="stripe-ui__break-cell" title={row.lineItemDescription || ""}>
                          {withLabel(row.lineItemId, row.lineItemDescription)}
                        </td>
                        <td>{withLabel(row.priceId, row.priceLabel)}</td>
                        <td>{withLabel(row.productId, row.productLabel)}</td>
                        <td className="stripe-ui__num">{row.quantity}</td>
                        <td className="stripe-ui__num">{formatMoney(row.revenue, summaryCurrency)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}

      {!loading && !data && hasRunOnce && !error ? (
        <section className="stripe-ui__panel">No results to display.</section>
      ) : null}
    </div>
  );
}
