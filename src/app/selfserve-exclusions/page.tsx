"use client";

import Link from "next/link";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

type SelfserveExclusionsResponse = {
  startDate: string;
  endDate: string;
  targetCurrency: string;
  warnings: string[];
  periods: Array<{
    key: string;
    label: string;
    totalMrr: number;
    totalArr: number;
    emailCount: number;
  }>;
  emailRows: Array<{
    email: string;
    valuesByPeriod: Record<string, number>;
    totalMrr: number;
    totalArr: number;
  }>;
  summary: {
    matchedEmailCount: number;
    emailsWithAnyMrr: number;
  };
};

function defaultDateRange() {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1, 0, 0, 0, 0));
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end,
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

export default function SelfserveExclusionsPage() {
  const defaults = useMemo(() => defaultDateRange(), []);
  const [startDate, setStartDate] = useState(defaults.startDate);
  const [endDate, setEndDate] = useState(defaults.endDate);
  const [selectedPeriodKey, setSelectedPeriodKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SelfserveExclusionsResponse | null>(null);
  const didAutoRun = useRef(false);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/selfserve-exclusions-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate, endDate }),
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
      setData(json as SelfserveExclusionsResponse);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate]);

  useEffect(() => {
    if (didAutoRun.current) return;
    didAutoRun.current = true;
    void run();
  }, [run]);

  useEffect(() => {
    if (!data?.periods?.length) {
      setSelectedPeriodKey("");
      return;
    }
    const exists = data.periods.some((period) => period.key === selectedPeriodKey);
    if (exists) return;
    setSelectedPeriodKey(data.periods[data.periods.length - 1].key);
  }, [data, selectedPeriodKey]);

  const currency = data?.targetCurrency || "USD";
  const selectedPeriod = useMemo(
    () => data?.periods?.find((period) => period.key === selectedPeriodKey) || null,
    [data, selectedPeriodKey],
  );

  const selectedPeriodRows = useMemo(() => {
    if (!data?.emailRows?.length || !selectedPeriodKey) return [];
    return data.emailRows
      .map((row) => ({
        email: row.email,
        mrr: Number(row.valuesByPeriod?.[selectedPeriodKey] || 0),
        totalMrr: Number(row.totalMrr || 0),
      }))
      .filter((row) => Math.abs(row.mrr) > 1e-9)
      .sort((a, b) => {
        const diff = b.mrr - a.mrr;
        if (Math.abs(diff) > 1e-9) return diff;
        return a.email.localeCompare(b.email);
      });
  }, [data, selectedPeriodKey]);

  return (
    <div className="stripe-ui">
      <section className="stripe-ui__hero ui-reveal">
        <div className="stripe-ui__eyebrow">Revenue intelligence</div>
        <div className="stripe-ui__hero-row">
          <div>
            <h1 className="stripe-ui__title">Selfserve Exclusions</h1>
            <p className="stripe-ui__subtitle">
              Monthly MRR for matched Stripe emails from Combined All Subs, with per-email MRR breakdown.
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
        <p className="stripe-ui__panel-subtitle">
          Uses Grouped Combined All Subs matches and computes monthly Stripe MRR for the matched email set.
        </p>
        <div className="stripe-ui__control-grid" style={{ gridTemplateColumns: "repeat(3, minmax(180px, 1fr))" }}>
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="selfserve-exclusions-start-date">
              Start date
            </label>
            <input
              id="selfserve-exclusions-start-date"
              className="stripe-ui__control"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="selfserve-exclusions-end-date">
              End date
            </label>
            <input
              id="selfserve-exclusions-end-date"
              className="stripe-ui__control"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="selfserve-exclusions-run-btn">
              Run
            </label>
            <button
              id="selfserve-exclusions-run-btn"
              className="stripe-ui__btn stripe-ui__btn--primary"
              onClick={() => void run()}
              disabled={loading}
            >
              {loading ? "Running..." : "Run"}
            </button>
          </div>
        </div>
      </section>

      {error && (
        <section className="stripe-ui__panel ui-reveal ui-reveal-2" style={{ borderColor: "rgba(220,38,38,0.35)" }}>
          <h2 className="stripe-ui__panel-title" style={{ color: "#fca5a5" }}>Error</h2>
          <p className="stripe-ui__panel-subtitle" style={{ marginBottom: 0 }}>{error}</p>
        </section>
      )}

      {data && (
        <>
          {data.warnings?.length > 0 && (
            <section className="stripe-ui__panel ui-reveal ui-reveal-2">
              <h2 className="stripe-ui__panel-title">Warnings</h2>
              <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
                {data.warnings.map((warning, idx) => (
                  <li key={`${warning}-${idx}`}>{warning}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="stripe-ui__panel ui-reveal ui-reveal-2">
            <h2 className="stripe-ui__panel-title">Summary</h2>
            <div className="stripe-ui__stats-grid">
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Matched Stripe emails</p>
                <p className="stripe-ui__stat-value">{new Intl.NumberFormat().format(data.summary.matchedEmailCount || 0)}</p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Emails with any MRR</p>
                <p className="stripe-ui__stat-value">{new Intl.NumberFormat().format(data.summary.emailsWithAnyMrr || 0)}</p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Selected period total MRR</p>
                <p className="stripe-ui__stat-value">
                  {selectedPeriod ? formatMoney(selectedPeriod.totalMrr || 0, currency) : formatMoney(0, currency)}
                </p>
              </div>
            </div>
          </section>

          <section className="stripe-ui__panel ui-reveal ui-reveal-3">
            <h2 className="stripe-ui__panel-title">Monthly totals</h2>
            <div className="stripe-ui__table-wrap">
              <table className="stripe-ui__table" aria-label="Selfserve exclusion monthly totals">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th className="stripe-ui__num">Total MRR</th>
                    <th className="stripe-ui__num">Email count (non-zero MRR)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.periods.map((period) => (
                    <tr key={period.key}>
                      <td>{period.label}</td>
                      <td className="stripe-ui__num">{formatMoney(period.totalMrr || 0, currency)}</td>
                      <td className="stripe-ui__num">{new Intl.NumberFormat().format(period.emailCount || 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="stripe-ui__panel ui-reveal ui-reveal-3">
            <div className="stripe-ui__section-head">
              <div>
                <h2 className="stripe-ui__panel-title">Included email list</h2>
                <p className="stripe-ui__panel-subtitle" style={{ marginBottom: 0 }}>
                  Email-level MRR for the selected month.
                </p>
              </div>
            </div>
            <div className="stripe-ui__control-grid" style={{ gridTemplateColumns: "repeat(2, minmax(220px, 1fr))", marginBottom: "0.85rem" }}>
              <div className="stripe-ui__field">
                <label className="stripe-ui__field-label" htmlFor="selfserve-exclusions-period">
                  Period
                </label>
                <select
                  id="selfserve-exclusions-period"
                  className="stripe-ui__control"
                  value={selectedPeriodKey}
                  onChange={(e) => setSelectedPeriodKey(e.target.value)}
                >
                  {data.periods.map((period) => (
                    <option key={period.key} value={period.key}>
                      {period.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="stripe-ui__field">
                <label className="stripe-ui__field-label">Rows</label>
                <div className="stripe-ui__hint">
                  {new Intl.NumberFormat().format(selectedPeriodRows.length)} emails with non-zero MRR
                </div>
              </div>
            </div>
            <div className="stripe-ui__table-wrap">
              <table className="stripe-ui__table" aria-label="Selfserve exclusion email list">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th className="stripe-ui__num">MRR ({selectedPeriod?.label || "Selected period"})</th>
                    <th className="stripe-ui__num">Total MRR (range)</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedPeriodRows.map((row) => (
                    <tr key={row.email}>
                      <td>{row.email}</td>
                      <td className="stripe-ui__num">{formatMoney(row.mrr, currency)}</td>
                      <td className="stripe-ui__num">{formatMoney(row.totalMrr, currency)}</td>
                    </tr>
                  ))}
                  {!selectedPeriodRows.length && (
                    <tr>
                      <td colSpan={3} style={{ textAlign: "center", opacity: 0.8 }}>
                        No non-zero MRR emails in the selected period.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
