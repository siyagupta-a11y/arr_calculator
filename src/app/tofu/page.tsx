"use client";

import Link from "next/link";
import React, { useMemo, useState } from "react";

type CombineMode = "grouped" | "simple";
type TofuDetailMetric = "beginningArr" | "newArr" | "expansionArr" | "contractionArr" | "churnArr" | "endingArr";

type TofuMonthRow = {
  periodKey: string;
  periodLabel: string;
  beginningArr: number;
  newArr: number;
  expansionArr: number;
  contractionArr: number;
  churnArr: number;
  endingArr: number;
};

type TofuResponse = {
  startDate: string;
  endDate: string;
  combineMode: CombineMode;
  targetCurrency: string;
  rows: TofuMonthRow[];
};

type TofuDetailRow = {
  customerId: string;
  customerLabel: string;
  source: "hubspot_account" | "stripe_only_customer";
  previousArr: number;
  currentArr: number;
  deltaArr: number;
  previousMrr: number;
  currentMrr: number;
  deltaMrr: number;
  contributionArr: number;
  contributionMrr: number;
};

type TofuDetailResponse = {
  startDate: string;
  endDate: string;
  combineMode: CombineMode;
  targetCurrency: string;
  detailPeriodKey: string;
  detailPeriodLabel: string;
  detailPreviousPeriodKey: string;
  detailPreviousPeriodLabel: string;
  detailMetric: TofuDetailMetric;
  rows: TofuDetailRow[];
  summary: {
    rowCount: number;
    totalArr: number;
    totalMrr: number;
  };
};

const METRIC_LABELS: Record<TofuDetailMetric, string> = {
  beginningArr: "Beginning ARR",
  newArr: "New ARR",
  expansionArr: "Expansion ARR",
  contractionArr: "Contraction ARR",
  churnArr: "Churn ARR",
  endingArr: "Ending ARR",
};

function defaultDateRange() {
  const end = new Date();
  const start = new Date(end.getFullYear() - 1, end.getMonth(), 1);
  const toIso = (value: Date) => value.toISOString().slice(0, 10);
  return {
    startDate: toIso(start),
    endDate: toIso(end),
  };
}

function formatMoney(value: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: String(currency || "USD").toUpperCase(),
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

function sumField(rows: TofuMonthRow[], key: keyof TofuMonthRow) {
  return rows.reduce((sum, row) => sum + Number(row[key] || 0), 0);
}

async function parseApiResponse(res: Response) {
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
  return json;
}

export default function TofuPage() {
  const defaults = useMemo(() => defaultDateRange(), []);

  const [startDate, setStartDate] = useState(defaults.startDate);
  const [endDate, setEndDate] = useState(defaults.endDate);
  const [combineMode, setCombineMode] = useState<CombineMode>("grouped");

  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<TofuResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailData, setDetailData] = useState<TofuDetailResponse | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    setDetailData(null);
    setDetailError(null);

    try {
      const res = await fetch("/api/tofu-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate, endDate, combineMode }),
      });
      const json = await parseApiResponse(res);
      setData(json as TofuResponse);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function openDetail(periodKey: string, metric: TofuDetailMetric) {
    setDetailLoading(true);
    setDetailError(null);
    setDetailData(null);

    try {
      const res = await fetch("/api/tofu-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate,
          endDate,
          combineMode: effectiveCombineMode,
          detailPeriodKey: periodKey,
          detailMetric: metric,
        }),
      });
      const json = await parseApiResponse(res);
      setDetailData(json as TofuDetailResponse);
    } catch (err: unknown) {
      setDetailData(null);
      setDetailError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setDetailLoading(false);
    }
  }

  const currency = data?.targetCurrency || "USD";
  const effectiveCombineMode = data?.combineMode || combineMode;
  const rows = data?.rows || [];

  function renderDrillCell(row: TofuMonthRow, metric: TofuDetailMetric, value: number) {
    return (
      <button
        type="button"
        className="stripe-ui__btn stripe-ui__btn--ghost"
        style={{ minHeight: 0, height: "auto", padding: 0, width: "100%", justifyContent: "flex-end" }}
        onClick={() => void openDetail(row.periodKey, metric)}
        disabled={detailLoading}
        title={`Show ${METRIC_LABELS[metric]} contributors for ${row.periodLabel}`}
      >
        {formatMoney(value, currency)}
      </button>
    );
  }

  return (
    <div className="stripe-ui">
      <section className="stripe-ui__hero ui-reveal">
        <div className="stripe-ui__eyebrow">Revenue intelligence</div>
        <div className="stripe-ui__hero-row">
          <div>
            <h1 className="stripe-ui__title">TOFU</h1>
            <p className="stripe-ui__subtitle">
              Monthly ARR bridge based on Combined All Subs. Choose Grouped mode to use contact-based matching, or
              Simple mode to use the non-grouped HubSpot+Stripe table.
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <Link href="/combined-all-subs" className="stripe-ui__hero-link">
              Open Combined All Subs
            </Link>
            <Link href="/combined-billing-overview" className="stripe-ui__hero-link">
              Open Combined Billing Overview
            </Link>
            <Link href="/stripe-through-mrr" className="stripe-ui__hero-link">
              Open Stripe through MRR
            </Link>
          </div>
        </div>
      </section>

      <section className="stripe-ui__panel ui-reveal ui-reveal-1">
        <h2 className="stripe-ui__panel-title">Report controls</h2>
        <p className="stripe-ui__panel-subtitle">Select date range and mode, then run monthly TOFU ARR breakdown.</p>
        <div className="stripe-ui__control-grid" style={{ gridTemplateColumns: "repeat(4, minmax(180px, 1fr))" }}>
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="tofu-start-date">
              Start date
            </label>
            <input
              id="tofu-start-date"
              className="stripe-ui__control"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="tofu-end-date">
              End date
            </label>
            <input
              id="tofu-end-date"
              className="stripe-ui__control"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="tofu-combine-mode">
              Combine mode
            </label>
            <select
              id="tofu-combine-mode"
              className="stripe-ui__control"
              value={combineMode}
              onChange={(e) => setCombineMode(e.target.value as CombineMode)}
            >
              <option value="grouped">Grouped (contact matching)</option>
              <option value="simple">Simple (non-grouped append)</option>
            </select>
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="tofu-run-btn">
              Run report
            </label>
            <button
              id="tofu-run-btn"
              className="stripe-ui__btn stripe-ui__btn--primary"
              onClick={() => void run()}
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
          <p className="stripe-ui__panel-subtitle">Computing monthly TOFU bridge from Combined All Subs.</p>
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
                <p className="stripe-ui__stat-label">Months</p>
                <p className="stripe-ui__stat-value">{rows.length}</p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Mode</p>
                <p className="stripe-ui__stat-value">
                  {effectiveCombineMode === "grouped" ? "Grouped" : "Simple"}
                </p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Total New ARR</p>
                <p className="stripe-ui__stat-value">{formatMoney(sumField(rows, "newArr"), currency)}</p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Total Churn ARR</p>
                <p className="stripe-ui__stat-value">{formatMoney(sumField(rows, "churnArr"), currency)}</p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Latest Ending ARR</p>
                <p className="stripe-ui__stat-value">
                  {formatMoney(rows.length ? rows[rows.length - 1].endingArr : 0, currency)}
                </p>
              </div>
            </div>
          </section>

          <section className="stripe-ui__panel ui-reveal ui-reveal-3">
            <h2 className="stripe-ui__panel-title">Monthly TOFU ARR bridge</h2>
            <p className="stripe-ui__panel-subtitle">
              Contraction and Churn are shown as negative ARR movement so each month follows:
              Ending = Beginning + New + Expansion + Contraction + Churn.
            </p>
            <p className="stripe-ui__panel-subtitle" style={{ marginTop: "-0.2rem" }}>
              Click any ARR value to see the customer rows used for that month/metric, including previous and current MRR.
            </p>

            <div className="stripe-ui__table-wrap" style={{ marginTop: "0.9rem" }}>
              <table className="stripe-ui__table" aria-label="TOFU monthly ARR bridge table">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th className="stripe-ui__num">Beginning ARR</th>
                    <th className="stripe-ui__num">New ARR</th>
                    <th className="stripe-ui__num">Expansion ARR</th>
                    <th className="stripe-ui__num">Contraction ARR</th>
                    <th className="stripe-ui__num">Churn ARR</th>
                    <th className="stripe-ui__num">Ending ARR</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.periodKey}>
                      <td>{row.periodLabel}</td>
                      <td className="stripe-ui__num">{renderDrillCell(row, "beginningArr", row.beginningArr)}</td>
                      <td className="stripe-ui__num">{renderDrillCell(row, "newArr", row.newArr)}</td>
                      <td className="stripe-ui__num">{renderDrillCell(row, "expansionArr", row.expansionArr)}</td>
                      <td className={`stripe-ui__num ${row.contractionArr < 0 ? "stripe-ui__money--negative" : ""}`}>
                        {renderDrillCell(row, "contractionArr", row.contractionArr)}
                      </td>
                      <td className={`stripe-ui__num ${row.churnArr < 0 ? "stripe-ui__money--negative" : ""}`}>
                        {renderDrillCell(row, "churnArr", row.churnArr)}
                      </td>
                      <td className="stripe-ui__num">{renderDrillCell(row, "endingArr", row.endingArr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {detailLoading && (
              <div style={{ marginTop: "0.8rem" }} className="stripe-ui__panel-subtitle">
                Loading detail rows...
              </div>
            )}

            {detailError && (
              <div className="stripe-ui__error" style={{ marginTop: "0.8rem" }} role="alert" aria-live="assertive">
                {detailError}
              </div>
            )}

            {detailData && !detailLoading && !detailError && (
              <div style={{ marginTop: "1rem" }}>
                <h3 className="stripe-ui__panel-title" style={{ fontSize: "1rem" }}>
                  {METRIC_LABELS[detailData.detailMetric]} detail - {detailData.detailPeriodLabel}
                </h3>
                <p className="stripe-ui__panel-subtitle" style={{ marginBottom: "0.5rem" }}>
                  {detailData.summary.rowCount} rows. Total {METRIC_LABELS[detailData.detailMetric]}:{" "}
                  {formatMoney(detailData.summary.totalArr, currency)} ({formatMoney(detailData.summary.totalMrr, currency)} MRR)
                </p>
                <div className="stripe-ui__table-wrap">
                  <table className="stripe-ui__table" aria-label="TOFU metric detail table">
                    <thead>
                      <tr>
                        <th>Customer</th>
                        <th>Source</th>
                        <th className="stripe-ui__num">
                          Previous MRR ({detailData.detailPreviousPeriodLabel || "N/A"})
                        </th>
                        <th className="stripe-ui__num">Current MRR ({detailData.detailPeriodLabel})</th>
                        <th className="stripe-ui__num">Delta MRR</th>
                        <th className="stripe-ui__num">Contribution MRR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailData.rows.map((row) => (
                        <tr key={`${detailData.detailMetric}:${detailData.detailPeriodKey}:${row.customerId}`}>
                          <td>{row.customerLabel}</td>
                          <td>{row.source === "hubspot_account" ? "HubSpot account" : "Stripe only"}</td>
                          <td className="stripe-ui__num">{formatMoney(row.previousMrr, currency)}</td>
                          <td className="stripe-ui__num">{formatMoney(row.currentMrr, currency)}</td>
                          <td className={`stripe-ui__num ${row.deltaMrr < 0 ? "stripe-ui__money--negative" : ""}`}>
                            {formatMoney(row.deltaMrr, currency)}
                          </td>
                          <td className={`stripe-ui__num ${row.contributionMrr < 0 ? "stripe-ui__money--negative" : ""}`}>
                            {formatMoney(row.contributionMrr, currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
