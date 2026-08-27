"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { MigrationReportResponse } from "@/lib/migrationReport";

function formatMoney(value: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: String(currency || "USD").toUpperCase(),
      maximumFractionDigits: 0,
    }).format(Number(value || 0));
  } catch {
    return Number(value || 0).toFixed(0);
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00.000Z`));
}

export default function MigrationPage() {
  const [data, setData] = useState<MigrationReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/migration", { cache: "no-store" });
      const text = await response.text();
      const payload = text ? (JSON.parse(text) as MigrationReportResponse & { error?: string }) : null;
      if (!response.ok) throw new Error(payload?.error || text || `HTTP ${response.status}`);
      if (!payload) throw new Error("Empty migration response");
      setData(payload);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load migration report");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const maxMonthlyArr = useMemo(
    () => Math.max(1, ...(data?.months || []).map((month) => month.arrMigrated)),
    [data],
  );

  return (
    <div className="stripe-ui">
      <section className="stripe-ui__hero ui-reveal">
        <div className="stripe-ui__eyebrow">Pricing migration</div>
        <div className="stripe-ui__hero-row">
          <div>
            <h1 className="stripe-ui__title">Migration</h1>
            <p className="stripe-ui__subtitle">
              Customers and ARR migrated from v3 to v4 plans since April 2026, combining Stripe BigQuery and closed-won HubSpot Sales Default Pipeline deals.
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <Link href="/account-management" className="stripe-ui__hero-link">Open Account Management</Link>
            <Link href="/hubspot" className="stripe-ui__hero-link">Open HubSpot report</Link>
            <Link href="/combined-all-subs" className="stripe-ui__hero-link">Open Combined All Subs</Link>
          </div>
        </div>
      </section>

      {loading ? (
        <section className="stripe-ui__panel ui-reveal ui-reveal-1">
          <h2 className="stripe-ui__panel-title">Loading v3 → v4 migrations</h2>
          <p className="stripe-ui__panel-subtitle">Reading Stripe plan-change history and HubSpot closed-won plan line items.</p>
          <div className="stripe-ui__skeleton-grid" aria-label="Loading migration report">
            <div className="stripe-ui__skeleton-row" />
            <div className="stripe-ui__skeleton-row" />
            <div className="stripe-ui__skeleton-row stripe-ui__skeleton-row--short" />
          </div>
        </section>
      ) : null}

      {error ? (
        <section className="stripe-ui__panel ui-reveal ui-reveal-1">
          <div className="stripe-ui__error migration__error">
            <span>{error}</span>
            <button className="stripe-ui__btn stripe-ui__btn--secondary" type="button" onClick={() => void load()}>
              Retry
            </button>
          </div>
        </section>
      ) : null}

      {!loading && data ? (
        <>
          <section className="stripe-ui__panel migration__summary ui-reveal ui-reveal-1">
            <div className="stripe-ui__section-head">
              <div>
                <h2 className="stripe-ui__panel-title">Migration totals</h2>
                <p className="stripe-ui__panel-subtitle">
                  Fiscal year from {formatDate(data.fiscalYearStart)} through {formatDate(data.asOfDate)}.
                </p>
              </div>
              <span className="migration__as-of">As of {formatDate(data.asOfDate)}</span>
            </div>
            <div className="stripe-ui__stats migration__headline-stats">
              <article className="stripe-ui__stat migration__headline-stat">
                <p className="stripe-ui__stat-label">Fiscal-year ARR migrated</p>
                <p className="stripe-ui__stat-value">{formatMoney(data.fiscalYear.arrMigrated, data.targetCurrency)}</p>
              </article>
              <article className="stripe-ui__stat migration__headline-stat">
                <p className="stripe-ui__stat-label">Fiscal-year logos migrated</p>
                <p className="stripe-ui__stat-value">{data.fiscalYear.logosMigrated}</p>
              </article>
              <article className="stripe-ui__stat migration__headline-stat migration__headline-stat--month">
                <p className="stripe-ui__stat-label">Current-month ARR migrated</p>
                <p className="stripe-ui__stat-value">{formatMoney(data.currentMonth.arrMigrated, data.targetCurrency)}</p>
              </article>
              <article className="stripe-ui__stat migration__headline-stat migration__headline-stat--month">
                <p className="stripe-ui__stat-label">Current-month logos migrated</p>
                <p className="stripe-ui__stat-value">{data.currentMonth.logosMigrated}</p>
              </article>
            </div>
            {data.warnings.length ? (
              <div className="commissions-warning">
                {data.warnings.map((warning) => <div key={warning}>{warning}</div>)}
              </div>
            ) : null}
          </section>

          <section className="stripe-ui__panel ui-reveal ui-reveal-2">
            <h2 className="stripe-ui__panel-title">By source</h2>
            <p className="stripe-ui__panel-subtitle">HubSpot takes precedence when the same workspace appears in both sources.</p>
            <div className="migration__source-grid">
              {data.sourceBreakdown.map((source) => (
                <article className="migration__source-card" key={source.source}>
                  <h3>{source.sourceLabel}</h3>
                  <div><span>Fiscal-year ARR</span><strong>{formatMoney(source.fiscalYear.arrMigrated, data.targetCurrency)}</strong></div>
                  <div><span>Fiscal-year logos</span><strong>{source.fiscalYear.logosMigrated}</strong></div>
                  <div><span>Current-month ARR</span><strong>{formatMoney(source.currentMonth.arrMigrated, data.targetCurrency)}</strong></div>
                  <div><span>Current-month logos</span><strong>{source.currentMonth.logosMigrated}</strong></div>
                </article>
              ))}
            </div>
          </section>

          <section className="stripe-ui__panel ui-reveal">
            <h2 className="stripe-ui__panel-title">Monthly migration pace</h2>
            <p className="stripe-ui__panel-subtitle">ARR and customer logos migrated in each fiscal-year month.</p>
            <div className="migration__month-list">
              {data.months.map((month) => (
                <article className="migration__month-row" key={month.monthKey}>
                  <div className="migration__month-label">
                    <strong>{month.monthLabel}</strong>
                    <span>{month.logosMigrated} logo{month.logosMigrated === 1 ? "" : "s"}</span>
                  </div>
                  <div className="migration__month-track" aria-label={`${month.monthLabel}: ${formatMoney(month.arrMigrated, data.targetCurrency)}`}>
                    <div style={{ width: `${Math.max(0, (month.arrMigrated / maxMonthlyArr) * 100)}%` }} />
                  </div>
                  <strong className="migration__month-amount">{formatMoney(month.arrMigrated, data.targetCurrency)}</strong>
                </article>
              ))}
            </div>
          </section>

          <section className="stripe-ui__panel ui-reveal">
            <div className="stripe-ui__section-head">
              <div>
                <h2 className="stripe-ui__panel-title">Migrated customers</h2>
                <p className="stripe-ui__panel-subtitle">Each customer appears once at their first qualifying v4 plan activation.</p>
              </div>
              <span className="migration__as-of">{data.migrations.length} total</span>
            </div>
            <div className="stripe-ui__table-wrap">
              <table className="stripe-ui__table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Source</th>
                    <th>Migration date</th>
                    <th>Workspace</th>
                    <th>Prior v3 ARR</th>
                    <th>v4 ARR migrated</th>
                  </tr>
                </thead>
                <tbody>
                  {data.migrations.length ? data.migrations.map((migration) => (
                    <tr key={migration.migrationKey}>
                      <td>
                        <a href={migration.recordUrl} target="_blank" rel="noreferrer" style={{ fontWeight: 700 }}>
                          {migration.customerName}
                        </a>
                        <div className="account-management__muted">{migration.customerId}</div>
                      </td>
                      <td>{migration.source === "stripe" ? "Stripe / BigQuery" : "HubSpot"}</td>
                      <td>{formatDate(migration.migratedAt)}</td>
                      <td>{migration.workspaceId || "—"}</td>
                      <td>{formatMoney(migration.priorV3Arr, data.targetCurrency)}</td>
                      <td>{formatMoney(migration.migratedV4Arr, data.targetCurrency)}</td>
                    </tr>
                  )) : (
                    <tr><td colSpan={6}>No qualifying v3-to-v4 migrations were found.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="stripe-ui__panel ui-reveal">
            <h2 className="stripe-ui__panel-title">Methodology</h2>
            <div className="account-management__methodology">
              {data.methodology.map((line) => <p key={line}>{line}</p>)}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
