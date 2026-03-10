"use client";

import Link from "next/link";
import React, { useMemo, useState } from "react";

type GroupBy =
  | "none"
  | "customer_id"
  | "product_id"
  | "price_id"
  | "subscription_id"
  | "subscription_item_id"
  | "event_type";

type MonthlyRow = {
  monthKey: string;
  monthLabel: string;
  monthEndMrr: number;
  newMrr: number;
  expansionMrr: number;
  contractionMrr: number;
  churnMrr: number;
  netMrrChange: number;
};

type RawDetailRow = {
  eventTimestampUtc: string;
  eventType: string;
  mrrChange: number;
  customerId: string;
  subscriptionId: string;
  subscriptionItemId: string;
  productId: string;
  productDescription: string;
  priceId: string;
  priceDescription: string;
};

type GroupedDetailRow = {
  groupKey: string;
  groupLabel: string;
  monthKey: string;
  monthLabel: string;
  eventCount: number;
  netMrrChange: number;
  newMrr: number;
  expansionMrr: number;
  contractionMrr: number;
  churnMrr: number;
};

type ApiResponse = {
  startDate: string;
  endDate: string;
  detailStartMonth: string;
  detailEndMonth: string;
  groupBy: GroupBy;
  targetCurrency: string;
  totalMrr: number;
  months: MonthlyRow[];
  detailRows: Array<RawDetailRow | GroupedDetailRow>;
  detailMode: "raw" | "grouped";
  pagination: {
    page: number;
    pageSize: number;
    returnedRows: number;
    totalRows: number;
    totalPages: number;
    hasMore: boolean;
  };
};

type DetailMetricKey = "newMrr" | "expansionMrr" | "contractionMrr" | "churnMrr" | "netMrrChange" | "eventCount";

const DETAIL_METRIC_OPTIONS: Array<{ key: DetailMetricKey; label: string }> = [
  { key: "newMrr", label: "New" },
  { key: "expansionMrr", label: "Expansion" },
  { key: "contractionMrr", label: "Contraction" },
  { key: "churnMrr", label: "Churn" },
  { key: "netMrrChange", label: "Net change" },
  { key: "eventCount", label: "Events" },
];

const GROUP_BY_OPTIONS: Array<{ key: GroupBy; label: string }> = [
  { key: "none", label: "No grouping (line items)" },
  { key: "customer_id", label: "Customer ID" },
  { key: "product_id", label: "Product ID" },
  { key: "price_id", label: "Price ID" },
  { key: "subscription_id", label: "Subscription ID" },
  { key: "subscription_item_id", label: "Subscription Item ID" },
  { key: "event_type", label: "Event Type" },
];

const PAGE_SIZE = 1000;

function defaultDateRange() {
  const end = new Date();
  const start = new Date(end.getFullYear() - 1, end.getMonth(), 1);
  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    startDate: toIso(start),
    endDate: toIso(end),
    startMonth: toIso(start).slice(0, 7),
    endMonth: toIso(end).slice(0, 7),
  };
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

function withDescription(id: string, description: string) {
  const cleanId = String(id || "").trim() || "(blank)";
  const cleanDescription = String(description || "").trim();
  if (!cleanDescription || cleanDescription === "(blank)" || cleanDescription === cleanId) return cleanId;
  return `${cleanId} (${cleanDescription})`;
}

function isGroupedRow(row: RawDetailRow | GroupedDetailRow): row is GroupedDetailRow {
  return "groupLabel" in row;
}

function metricValue(row: GroupedDetailRow | undefined, metric: DetailMetricKey) {
  if (!row) return 0;
  if (metric === "newMrr") return row.newMrr;
  if (metric === "expansionMrr") return row.expansionMrr;
  if (metric === "contractionMrr") return row.contractionMrr;
  if (metric === "churnMrr") return row.churnMrr;
  if (metric === "netMrrChange") return row.netMrrChange;
  return row.eventCount;
}

function isMoneyMetric(metric: DetailMetricKey) {
  return metric !== "eventCount";
}

export default function StripeThroughMrrPage() {
  const defaults = useMemo(() => defaultDateRange(), []);

  const [startDate, setStartDate] = useState(defaults.startDate);
  const [endDate, setEndDate] = useState(defaults.endDate);
  const [detailStartMonth, setDetailStartMonth] = useState(defaults.startMonth);
  const [detailEndMonth, setDetailEndMonth] = useState(defaults.endMonth);
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [selectedMetrics, setSelectedMetrics] = useState<DetailMetricKey[]>([
    "newMrr",
    "expansionMrr",
    "contractionMrr",
    "churnMrr",
    "netMrrChange",
  ]);

  const [page, setPage] = useState(1);
  const [pageJumpInput, setPageJumpInput] = useState("1");
  const [hasRunOnce, setHasRunOnce] = useState(false);

  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(targetPage = 1) {
    setHasRunOnce(true);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/stripe-through-mrr-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate,
          endDate,
          detailStartMonth,
          detailEndMonth,
          groupBy,
          page: targetPage,
          pageSize: PAGE_SIZE,
        }),
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
      const report = json as ApiResponse;
      setData(report);
      setPage(report.pagination.page);
      setPageJumpInput(String(report.pagination.page));
      setDetailStartMonth(report.detailStartMonth);
      setDetailEndMonth(report.detailEndMonth);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Unknown error";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  function runFresh() {
    setPage(1);
    setPageJumpInput("1");
    void run(1);
  }

  function goToPage(target: number) {
    const totalPages = data?.pagination.totalPages || 1;
    const safe = Math.max(1, Math.min(totalPages, Math.floor(target)));
    setPage(safe);
    setPageJumpInput(String(safe));
    void run(safe);
  }

  const summaryCurrency = data?.targetCurrency || "USD";
  const detailMode = data?.detailMode || (groupBy === "none" ? "raw" : "grouped");
  const months = useMemo(() => data?.months || [], [data]);
  const detailRows = useMemo(() => data?.detailRows || [], [data]);
  const effectiveDetailStartMonth = data?.detailStartMonth || detailStartMonth;
  const effectiveDetailEndMonth = data?.detailEndMonth || detailEndMonth;

  const detailMonthsInRange = useMemo(
    () =>
      months.filter((month) => month.monthKey >= effectiveDetailStartMonth && month.monthKey <= effectiveDetailEndMonth),
    [months, effectiveDetailStartMonth, effectiveDetailEndMonth],
  );

  const groupedMatrixRows = useMemo(() => {
    if (detailMode !== "grouped") return [];
    const groupedRows = detailRows.filter(isGroupedRow);
    const byGroup = new Map<
      string,
      { groupKey: string; groupLabel: string; totalNet: number; byMonth: Map<string, GroupedDetailRow> }
    >();
    for (const row of groupedRows) {
      const mapKey = `${row.groupKey}|${row.groupLabel}`;
      if (!byGroup.has(mapKey)) {
        byGroup.set(mapKey, {
          groupKey: row.groupKey,
          groupLabel: row.groupLabel || row.groupKey || "(blank)",
          totalNet: 0,
          byMonth: new Map(),
        });
      }
      const entry = byGroup.get(mapKey)!;
      entry.byMonth.set(row.monthKey, row);
      entry.totalNet += row.netMrrChange;
    }
    return Array.from(byGroup.values()).sort((a, b) => {
      const diff = b.totalNet - a.totalNet;
      if (Math.abs(diff) > 1e-9) return diff;
      return a.groupLabel.localeCompare(b.groupLabel);
    });
  }, [detailMode, detailRows]);

  function toggleMetric(metric: DetailMetricKey) {
    setSelectedMetrics((prev) => {
      if (prev.includes(metric)) {
        const next = prev.filter((value) => value !== metric);
        return next.length ? next : prev;
      }
      return [...prev, metric];
    });
  }

  return (
    <div className="stripe-ui">
      <section className="stripe-ui__hero ui-reveal">
        <div className="stripe-ui__eyebrow">Revenue intelligence</div>
        <div className="stripe-ui__hero-row">
          <div>
            <h1 className="stripe-ui__title">Stripe through MRR</h1>
            <p className="stripe-ui__subtitle">
              Uses `botpress-stripe-data-pipeline.stripe.subscription_item_change_events_v2_beta` to compute monthly
              MRR, cumulative total MRR to end date, and monthly New/Expansion/Contraction/Churn. Detail rows are
              served backend-side for fast rendering.
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <Link href="/stripe-arr-correct" className="stripe-ui__hero-link">
              Open Stripe ARR (Correct)
            </Link>
            <Link href="/stripe-billing-overview" className="stripe-ui__hero-link">
              Open Stripe Billing Overview
            </Link>
            <Link href="/" className="stripe-ui__hero-link">
              Open HubSpot report
            </Link>
          </div>
        </div>
      </section>

      <section className="stripe-ui__panel ui-reveal ui-reveal-1">
        <h2 className="stripe-ui__panel-title">Report controls</h2>
        <p className="stripe-ui__panel-subtitle">
          Select date range, detail month range, and grouping. All heavy processing runs in backend BigQuery.
        </p>

        <div className="stripe-ui__control-grid">
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="stripe-through-mrr-start-date">
              Start date
            </label>
            <input
              id="stripe-through-mrr-start-date"
              className="stripe-ui__control"
              type="date"
              value={startDate}
              onChange={(e) => {
                const nextStart = e.target.value;
                setStartDate(nextStart);
                const nextStartMonth = nextStart.slice(0, 7);
                if (detailStartMonth < nextStartMonth) setDetailStartMonth(nextStartMonth);
                if (detailEndMonth < nextStartMonth) setDetailEndMonth(nextStartMonth);
              }}
            />
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="stripe-through-mrr-end-date">
              End date
            </label>
            <input
              id="stripe-through-mrr-end-date"
              className="stripe-ui__control"
              type="date"
              value={endDate}
              onChange={(e) => {
                const nextEnd = e.target.value;
                setEndDate(nextEnd);
                const nextEndMonth = nextEnd.slice(0, 7);
                if (detailEndMonth > nextEndMonth) setDetailEndMonth(nextEndMonth);
                if (detailStartMonth > nextEndMonth) setDetailStartMonth(nextEndMonth);
              }}
            />
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="stripe-through-mrr-detail-start-month">
              Detail start month
            </label>
            <input
              id="stripe-through-mrr-detail-start-month"
              className="stripe-ui__control"
              type="month"
              min={startDate.slice(0, 7)}
              max={detailEndMonth || endDate.slice(0, 7)}
              value={detailStartMonth}
              onChange={(e) => setDetailStartMonth(e.target.value)}
            />
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="stripe-through-mrr-detail-end-month">
              Detail end month
            </label>
            <input
              id="stripe-through-mrr-detail-end-month"
              className="stripe-ui__control"
              type="month"
              min={detailStartMonth || startDate.slice(0, 7)}
              max={endDate.slice(0, 7)}
              value={detailEndMonth}
              onChange={(e) => setDetailEndMonth(e.target.value)}
            />
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="stripe-through-mrr-group-by">
              Group detail rows by
            </label>
            <select
              id="stripe-through-mrr-group-by"
              className="stripe-ui__control"
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as GroupBy)}
            >
              {GROUP_BY_OPTIONS.map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="stripe-through-mrr-run-btn">
              Run report
            </label>
            <button
              id="stripe-through-mrr-run-btn"
              className="stripe-ui__btn stripe-ui__btn--primary"
              onClick={runFresh}
              disabled={loading}
            >
              {loading ? "Running..." : "Run"}
            </button>
          </div>
        </div>
      </section>

      {loading && (
        <section className="stripe-ui__panel stripe-ui__loading-panel ui-reveal ui-reveal-2" aria-live="polite" aria-busy="true">
          <h2 className="stripe-ui__panel-title">Loading report...</h2>
          <p className="stripe-ui__panel-subtitle">Computing monthly MRR and loading detail rows.</p>
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
            <button className="stripe-ui__btn stripe-ui__btn--secondary" onClick={() => void run(page)} disabled={loading}>
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
                <p className="stripe-ui__stat-label">Total MRR (as of {data.endDate})</p>
                <p className="stripe-ui__stat-value">{formatMoney(data.totalMrr, summaryCurrency)}</p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Months in range</p>
                <p className="stripe-ui__stat-value">{months.length}</p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Detail month range</p>
                <p className="stripe-ui__stat-value">{`${data.detailStartMonth} to ${data.detailEndMonth}`}</p>
              </div>
            </div>
          </section>

          <section className="stripe-ui__panel ui-reveal ui-reveal-3">
            <div className="stripe-ui__section-head">
              <div>
                <h2 className="stripe-ui__panel-title">Monthly MRR movement</h2>
                <p className="stripe-ui__panel-subtitle" style={{ marginBottom: 0 }}>
                  New = `ACTIVE_START`, Expansion = `ACTIVE_UPGRADE`, Contraction = `ACTIVE_DOWNGRADE`, Churn =
                  `ACTIVE_END`.
                </p>
              </div>
            </div>
            <div className="stripe-ui__table-wrap" style={{ marginTop: "0.9rem" }}>
              <table className="stripe-ui__table" aria-label="Stripe through MRR monthly summary table">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th className="stripe-ui__num">MRR (month end)</th>
                    <th className="stripe-ui__num">New</th>
                    <th className="stripe-ui__num">Expansion</th>
                    <th className="stripe-ui__num">Contraction</th>
                    <th className="stripe-ui__num">Churn</th>
                    <th className="stripe-ui__num">Net change</th>
                  </tr>
                </thead>
                <tbody>
                  {months.map((row) => (
                    <tr key={row.monthKey}>
                      <td>{row.monthLabel}</td>
                      <td className={`stripe-ui__num ${row.monthEndMrr < 0 ? "stripe-ui__money--negative" : ""}`}>
                        {formatMoney(row.monthEndMrr, summaryCurrency)}
                      </td>
                      <td className={`stripe-ui__num ${row.newMrr < 0 ? "stripe-ui__money--negative" : ""}`}>
                        {formatMoney(row.newMrr, summaryCurrency)}
                      </td>
                      <td className={`stripe-ui__num ${row.expansionMrr < 0 ? "stripe-ui__money--negative" : ""}`}>
                        {formatMoney(row.expansionMrr, summaryCurrency)}
                      </td>
                      <td className={`stripe-ui__num ${row.contractionMrr < 0 ? "stripe-ui__money--negative" : ""}`}>
                        {formatMoney(row.contractionMrr, summaryCurrency)}
                      </td>
                      <td className={`stripe-ui__num ${row.churnMrr < 0 ? "stripe-ui__money--negative" : ""}`}>
                        {formatMoney(row.churnMrr, summaryCurrency)}
                      </td>
                      <td className={`stripe-ui__num ${row.netMrrChange < 0 ? "stripe-ui__money--negative" : ""}`}>
                        {formatMoney(row.netMrrChange, summaryCurrency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="stripe-ui__panel ui-reveal ui-reveal-3">
            <div className="stripe-ui__section-head">
              <div>
                <h2 className="stripe-ui__panel-title">
                  Detail rows from {data.detailStartMonth} to {data.detailEndMonth} (
                  {detailMode === "raw" ? "line items" : "grouped by month"})
                </h2>
                <p className="stripe-ui__panel-subtitle" style={{ marginBottom: 0 }}>
                  Grouped mode shows month column groups with selectable metrics for each month.
                </p>
              </div>
            </div>

            {detailMode === "grouped" && (
              <div className="stripe-ui__toolbar">
                <div className="stripe-ui__toolbar-group" style={{ flexWrap: "wrap", gap: "0.45rem" }}>
                  <span className="stripe-ui__hint">Displayed metrics:</span>
                  {DETAIL_METRIC_OPTIONS.map((metric) => (
                    <label key={metric.key} className="stripe-ui__hint" style={{ display: "inline-flex", gap: "0.3rem" }}>
                      <input
                        type="checkbox"
                        checked={selectedMetrics.includes(metric.key)}
                        onChange={() => toggleMetric(metric.key)}
                      />
                      {metric.label}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="stripe-ui__toolbar">
              <div className="stripe-ui__toolbar-group">
                <span className="stripe-ui__hint">{`Page ${data.pagination.page} of ${data.pagination.totalPages}`}</span>
                <span className="stripe-ui__hint">{`${data.pagination.totalRows} rows`}</span>
              </div>

              <div className="stripe-ui__toolbar-group">
                <button
                  className="stripe-ui__btn stripe-ui__btn--ghost"
                  onClick={() => goToPage(page - 1)}
                  disabled={loading || page <= 1}
                >
                  Prev
                </button>
                <button
                  className="stripe-ui__btn stripe-ui__btn--ghost"
                  onClick={() => goToPage(page + 1)}
                  disabled={loading || page >= data.pagination.totalPages}
                >
                  Next
                </button>
                <input
                  className="stripe-ui__control stripe-ui__page-jump"
                  type="number"
                  min={1}
                  max={data.pagination.totalPages || 1}
                  value={pageJumpInput}
                  onChange={(e) => setPageJumpInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    const next = Number(pageJumpInput || "1");
                    if (!Number.isFinite(next)) return;
                    goToPage(next);
                  }}
                />
                <button
                  className="stripe-ui__btn stripe-ui__btn--secondary"
                  onClick={() => {
                    const next = Number(pageJumpInput || "1");
                    if (!Number.isFinite(next)) return;
                    goToPage(next);
                  }}
                  disabled={loading}
                >
                  Jump
                </button>
              </div>
            </div>

            <div className="stripe-ui__table-wrap" style={{ marginTop: "0.9rem" }}>
              <table className="stripe-ui__table" aria-label="Stripe through MRR detail table">
                <thead>
                  {detailMode === "raw" ? (
                    <tr>
                      <th>Event timestamp (UTC)</th>
                      <th>Event type</th>
                      <th className="stripe-ui__num">MRR change</th>
                      <th>Customer</th>
                      <th>Product</th>
                      <th>Price</th>
                      <th>Subscription Item</th>
                      <th>Subscription</th>
                    </tr>
                  ) : (
                    <>
                      <tr>
                        <th rowSpan={2}>Group</th>
                        {detailMonthsInRange.map((month) => (
                          <th key={month.monthKey} className="stripe-ui__num" colSpan={selectedMetrics.length}>
                            {month.monthLabel}
                          </th>
                        ))}
                      </tr>
                      <tr>
                        {detailMonthsInRange.flatMap((month) =>
                          selectedMetrics.map((metric) => (
                            <th key={`${month.monthKey}:${metric}`} className="stripe-ui__num">
                              {DETAIL_METRIC_OPTIONS.find((option) => option.key === metric)?.label || metric}
                            </th>
                          )),
                        )}
                      </tr>
                    </>
                  )}
                </thead>
                <tbody>
                  {detailMode === "raw"
                    ? (detailRows as RawDetailRow[]).map((row, idx) =>
                      <tr key={`${row.eventTimestampUtc}:${row.subscriptionItemId}:${idx}`}>
                        <td>{row.eventTimestampUtc}</td>
                        <td>{row.eventType || "(blank)"}</td>
                        <td className={`stripe-ui__num ${row.mrrChange < 0 ? "stripe-ui__money--negative" : ""}`}>
                          {formatMoney(row.mrrChange, summaryCurrency)}
                        </td>
                        <td>{row.customerId || "(blank)"}</td>
                        <td>{withDescription(row.productId, row.productDescription)}</td>
                        <td>{withDescription(row.priceId, row.priceDescription)}</td>
                        <td>{row.subscriptionItemId || "(blank)"}</td>
                        <td>{row.subscriptionId || "(blank)"}</td>
                      </tr>
                    )
                    : groupedMatrixRows.map((group) => (
                        <tr key={`${group.groupKey}|${group.groupLabel}`}>
                          <td>{group.groupLabel || group.groupKey || "(blank)"}</td>
                          {detailMonthsInRange.flatMap((month) =>
                            selectedMetrics.map((metric) => {
                              const value = metricValue(group.byMonth.get(month.monthKey), metric);
                              const isMoney = isMoneyMetric(metric);
                              return (
                                <td
                                  key={`${group.groupKey}|${month.monthKey}|${metric}`}
                                  className={`stripe-ui__num ${isMoney && value < 0 ? "stripe-ui__money--negative" : ""}`}
                                >
                                  {isMoney ? formatMoney(value, summaryCurrency) : value}
                                </td>
                              );
                            }),
                          )}
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {!loading && !error && !data && hasRunOnce && (
        <section className="stripe-ui__panel ui-reveal ui-reveal-2">
          <h2 className="stripe-ui__panel-title">No data</h2>
          <p className="stripe-ui__panel-subtitle">No rows were returned for this selection.</p>
        </section>
      )}
    </div>
  );
}
