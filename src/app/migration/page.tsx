"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { MigrationCustomerExportRow, MigrationReportResponse, MigrationSource } from "@/lib/migrationReport";

const MIN_MIGRATION_DATE = "2026-04-01";

function todayInToronto() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

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

function formatNumber(value: number, maximumFractionDigits = 2) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(Number(value || 0));
}

function progressWidth(percent: number) {
  return `${Math.max(0, Math.min(100, Number(percent || 0)))}%`;
}

function csvValue(value: unknown) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadCustomerCsv(filename: string, rows: MigrationCustomerExportRow[], currency: string) {
  if (!rows.length) return;
  const headers = [
    "Customer name",
    "Email",
    "Customer ID",
    "Workspace ID",
    "Source",
    `ARR (${currency})`,
    "Migration date",
    "Previous plan",
    "Plan at range end",
    "Record URL",
  ];
  const orderedRows = rows.slice().sort(
    (a, b) => a.customerName.localeCompare(b.customerName) || a.customerId.localeCompare(b.customerId),
  );
  const lines = [
    headers.map(csvValue).join(","),
    ...orderedRows.map((row) => [
      row.customerName,
      row.customerEmail,
      row.customerId,
      row.workspaceId,
      row.source === "stripe" ? "Stripe / BigQuery" : "HubSpot",
      row.arr,
      row.migratedAt,
      row.previousPlan,
      row.currentPlan,
      row.recordUrl,
    ].map(csvValue).join(",")),
  ];
  const blob = new Blob([`\ufeff${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.replace(/[^a-z0-9._-]+/gi, "-").replace(/-+/g, "-").toLowerCase();
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function migrationRowsBetween(
  data: MigrationReportResponse,
  startDate: string,
  endDate: string,
  source?: MigrationSource,
) {
  return data.customerLists.migrations.filter((row) => (
    row.migratedAt >= startDate &&
    row.migratedAt <= endDate &&
    (!source || row.source === source)
  ));
}

export default function MigrationPage() {
  const [data, setData] = useState<MigrationReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [startDate, setStartDate] = useState(MIN_MIGRATION_DATE);
  const [endDate, setEndDate] = useState(() => todayInToronto());
  const [appliedStartDate, setAppliedStartDate] = useState(MIN_MIGRATION_DATE);
  const [appliedEndDate, setAppliedEndDate] = useState(() => todayInToronto());
  const [sessionRole, setSessionRole] = useState("");
  const maximumDate = todayInToronto();

  const load = useCallback(async (nextStartDate: string, nextEndDate: string) => {
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ startDate: nextStartDate, endDate: nextEndDate });
      const response = await fetch(`/api/migration?${query.toString()}`, { cache: "no-store" });
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
    let active = true;
    const initialEndDate = todayInToronto();
    void load(MIN_MIGRATION_DATE, initialEndDate);
    const loadSession = async () => {
      try {
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as { user?: { role?: string } };
        if (active) setSessionRole(String(payload.user?.role || "").trim().toLowerCase());
      } catch {
        if (active) setSessionRole("");
      }
    };
    void loadSession();
    return () => {
      active = false;
    };
  }, [load]);

  function applyDateRange(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (startDate < MIN_MIGRATION_DATE) {
      setError(`Start date cannot be before ${MIN_MIGRATION_DATE}.`);
      return;
    }
    if (endDate < startDate) {
      setError("End date must be on or after the start date.");
      return;
    }
    if (endDate > maximumDate) {
      setError("End date cannot be after today.");
      return;
    }
    setAppliedStartDate(startDate);
    setAppliedEndDate(endDate);
    void load(startDate, endDate);
  }

  const maxMonthlyArr = useMemo(
    () => Math.max(1, ...(data?.months || []).map((month) => month.arrMigrated)),
    [data],
  );
  const customerGroups = useMemo(() => {
    if (!data) return null;
    return {
      openingLegacy: data.customerLists.openingLegacy,
      currentLegacy: data.customerLists.currentLegacy,
      fiscalYearMigrations: migrationRowsBetween(data, data.fiscalYearStart, data.rangeEnd),
      selectedRangeMigrations: migrationRowsBetween(data, data.rangeStart, data.rangeEnd),
      currentMonthMigrations: migrationRowsBetween(data, data.currentMonthStart, data.rangeEnd),
    };
  }, [data]);

  function downloadCustomers(slug: string, rows: MigrationCustomerExportRow[]) {
    if (!data) return;
    downloadCustomerCsv(
      `migration-${slug}-${data.rangeStart}-to-${data.rangeEnd}.csv`,
      rows,
      data.targetCurrency,
    );
  }

  return (
    <div className="stripe-ui">
      <section className="stripe-ui__hero ui-reveal">
        <div className="stripe-ui__eyebrow">Pricing migration</div>
        <div className="stripe-ui__hero-row">
          <div>
            <h1 className="stripe-ui__title">Migration</h1>
            <p className="stripe-ui__subtitle">
              Customers and ARR migrated from V2/V3 to V4 plans since April 2026, combining Stripe BigQuery and closed-won HubSpot Sales Default Pipeline deals.
            </p>
          </div>
          {sessionRole && sessionRole !== "account_management" ? (
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
              <Link href="/account-management" className="stripe-ui__hero-link">Open Account Management</Link>
              <Link href="/hubspot" className="stripe-ui__hero-link">Open HubSpot report</Link>
              <Link href="/combined-all-subs" className="stripe-ui__hero-link">Open Combined All Subs</Link>
            </div>
          ) : null}
        </div>
      </section>

      <section className="stripe-ui__panel migration__filters-panel ui-reveal ui-reveal-1">
        <div>
          <h2 className="stripe-ui__panel-title">Reporting range</h2>
          <p className="stripe-ui__panel-subtitle">
            Defaults to the fiscal-year start through today. Dates can begin on or after April 1, 2026. Click any customer-backed total to download its CSV.
          </p>
        </div>
        <form className="migration__filters" onSubmit={applyDateRange}>
          <label className="migration__filter-field">
            <span>Start date</span>
            <input
              className="stripe-ui__control"
              type="date"
              value={startDate}
              min={MIN_MIGRATION_DATE}
              max={endDate || maximumDate}
              onChange={(event) => setStartDate(event.target.value)}
              required
            />
          </label>
          <label className="migration__filter-field">
            <span>End date</span>
            <input
              className="stripe-ui__control"
              type="date"
              value={endDate}
              min={startDate || MIN_MIGRATION_DATE}
              max={maximumDate}
              onChange={(event) => setEndDate(event.target.value)}
              required
            />
          </label>
          <button className="stripe-ui__btn stripe-ui__btn--primary" type="submit" disabled={loading}>
            {loading ? "Loading…" : "Apply range"}
          </button>
        </form>
      </section>

      {loading ? (
        <section className="stripe-ui__panel ui-reveal ui-reveal-1">
          <h2 className="stripe-ui__panel-title">Loading V2/V3 → V4 migrations</h2>
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
            <button className="stripe-ui__btn stripe-ui__btn--secondary" type="button" onClick={() => void load(appliedStartDate, appliedEndDate)}>
              Retry
            </button>
          </div>
        </section>
      ) : null}

      {!loading && data ? (
        <>
          <section className="stripe-ui__panel migration__goal ui-reveal ui-reveal-1">
            <div className="stripe-ui__section-head">
              <div>
                <h2 className="stripe-ui__panel-title">70% fiscal-year migration goal</h2>
                <p className="stripe-ui__panel-subtitle">
                  Targeting 70% of the V2/V3 customers active at the start of {formatDate(data.fiscalYearStart)}, by {formatDate(data.fiscalYearEnd)}.
                </p>
              </div>
              <span className="migration__as-of">Range ends {formatDate(data.rangeEnd)}</span>
            </div>

            <div className="stripe-ui__stats migration__goal-stats">
              <button
                className="stripe-ui__stat migration__goal-stat migration__goal-stat--current migration__download-card"
                type="button"
                disabled={!customerGroups?.currentLegacy.length}
                onClick={() => downloadCustomers("v2-v3-at-range-end", customerGroups?.currentLegacy || [])}
                title="Download the customers behind this total"
              >
                <p className="stripe-ui__stat-label">On V2/V3 at range end</p>
                <p className="stripe-ui__stat-value">{formatNumber(data.goal.currentLegacyCustomers, 0)}</p>
                <p className="migration__stat-note">{formatMoney(data.goal.currentLegacyArr, data.targetCurrency)} base-plan ARR</p>
              </button>
              <button
                className="stripe-ui__stat migration__goal-stat migration__download-card"
                type="button"
                disabled={!customerGroups?.openingLegacy.length}
                onClick={() => downloadCustomers("opening-v2-v3-customers", customerGroups?.openingLegacy || [])}
                title="Download the customers behind this total"
              >
                <p className="stripe-ui__stat-label">Opening V2/V3 customers</p>
                <p className="stripe-ui__stat-value">{formatNumber(data.goal.openingLegacyCustomers, 0)}</p>
                <p className="migration__stat-note">Baseline at fiscal-year start</p>
              </button>
              <article className="stripe-ui__stat migration__goal-stat">
                <p className="stripe-ui__stat-label">70% customer goal</p>
                <p className="stripe-ui__stat-value">{formatNumber(data.goal.fiscalYearCustomerTarget, 0)}</p>
                <p className="migration__stat-note">Rounded up to a whole customer</p>
              </article>
              <article className="stripe-ui__stat migration__goal-stat">
                <p className="stripe-ui__stat-label">Opening average plan ARR</p>
                <p className="stripe-ui__stat-value">{formatMoney(data.goal.openingAverageArr, data.targetCurrency)}</p>
                <p className="migration__stat-note">Excludes add-ons and AI tokens</p>
              </article>
              <article className="stripe-ui__stat migration__goal-stat migration__goal-stat--monthly">
                <p className="stripe-ui__stat-label">Monthly customer target</p>
                <p className="stripe-ui__stat-value">{formatNumber(data.goal.monthlyCustomerTarget)}</p>
                <p className="migration__stat-note">Evenly divided across 12 months</p>
              </article>
              <article className="stripe-ui__stat migration__goal-stat migration__goal-stat--monthly">
                <p className="stripe-ui__stat-label">Monthly ARR target</p>
                <p className="stripe-ui__stat-value">{formatMoney(data.goal.monthlyArrTarget, data.targetCurrency)}</p>
                <p className="migration__stat-note">FY target {formatMoney(data.goal.fiscalYearArrTarget, data.targetCurrency)}</p>
              </article>
            </div>

            <div className="migration__goal-progress-grid">
              <article className="migration__goal-progress">
                <div className="migration__goal-progress-head">
                  <span>Fiscal-year customers</span>
                  <button
                    className="migration__download-inline"
                    type="button"
                    disabled={!customerGroups?.fiscalYearMigrations.length}
                    onClick={() => downloadCustomers("fiscal-year-migrated-customers", customerGroups?.fiscalYearMigrations || [])}
                    title="Download the migrated customers in the numerator"
                  >
                    {data.fiscalYear.logosMigrated} / {data.goal.fiscalYearCustomerTarget}
                  </button>
                </div>
                <div className="migration__goal-track"><div style={{ width: progressWidth(data.goal.fiscalYearCustomerProgressPct) }} /></div>
                <p>{formatNumber(data.goal.fiscalYearCustomerProgressPct, 1)}% of the 70% goal</p>
              </article>
              <article className="migration__goal-progress">
                <div className="migration__goal-progress-head">
                  <span>Fiscal-year ARR</span>
                  <button
                    className="migration__download-inline"
                    type="button"
                    disabled={!customerGroups?.fiscalYearMigrations.length}
                    onClick={() => downloadCustomers("fiscal-year-migrated-arr-customers", customerGroups?.fiscalYearMigrations || [])}
                    title="Download the customers behind the migrated ARR"
                  >
                    {formatMoney(data.fiscalYear.arrMigrated, data.targetCurrency)} / {formatMoney(data.goal.fiscalYearArrTarget, data.targetCurrency)}
                  </button>
                </div>
                <div className="migration__goal-track"><div style={{ width: progressWidth(data.goal.fiscalYearArrProgressPct) }} /></div>
                <p>{formatNumber(data.goal.fiscalYearArrProgressPct, 1)}% of ARR goal</p>
              </article>
              <article className="migration__goal-progress migration__goal-progress--month">
                <div className="migration__goal-progress-head">
                  <span>Range-end month customers</span>
                  <button
                    className="migration__download-inline"
                    type="button"
                    disabled={!customerGroups?.currentMonthMigrations.length}
                    onClick={() => downloadCustomers("range-end-month-migrated-customers", customerGroups?.currentMonthMigrations || [])}
                    title="Download the migrated customers in the numerator"
                  >
                    {data.currentMonth.logosMigrated} / {formatNumber(data.goal.monthlyCustomerTarget)}
                  </button>
                </div>
                <div className="migration__goal-track"><div style={{ width: progressWidth(data.goal.currentMonthCustomerProgressPct) }} /></div>
                <p>{formatNumber(data.goal.currentMonthCustomerProgressPct, 1)}% of monthly target</p>
              </article>
              <article className="migration__goal-progress migration__goal-progress--month">
                <div className="migration__goal-progress-head">
                  <span>Range-end month ARR</span>
                  <button
                    className="migration__download-inline"
                    type="button"
                    disabled={!customerGroups?.currentMonthMigrations.length}
                    onClick={() => downloadCustomers("range-end-month-migrated-arr-customers", customerGroups?.currentMonthMigrations || [])}
                    title="Download the customers behind the migrated ARR"
                  >
                    {formatMoney(data.currentMonth.arrMigrated, data.targetCurrency)} / {formatMoney(data.goal.monthlyArrTarget, data.targetCurrency)}
                  </button>
                </div>
                <div className="migration__goal-track"><div style={{ width: progressWidth(data.goal.currentMonthArrProgressPct) }} /></div>
                <p>{formatNumber(data.goal.currentMonthArrProgressPct, 1)}% of monthly target</p>
              </article>
            </div>
          </section>

          <section className="stripe-ui__panel migration__summary ui-reveal ui-reveal-1">
            <div className="stripe-ui__section-head">
              <div>
                <h2 className="stripe-ui__panel-title">Migration totals</h2>
                <p className="stripe-ui__panel-subtitle">
                  Selected range from {formatDate(data.rangeStart)} through {formatDate(data.rangeEnd)}.
                </p>
              </div>
              <span className="migration__as-of">{formatDate(data.rangeStart)} – {formatDate(data.rangeEnd)}</span>
            </div>
            <div className="stripe-ui__stats migration__headline-stats">
              <button
                className="stripe-ui__stat migration__headline-stat migration__download-card"
                type="button"
                disabled={!customerGroups?.selectedRangeMigrations.length}
                onClick={() => downloadCustomers("selected-range-migrated-arr-customers", customerGroups?.selectedRangeMigrations || [])}
                title="Download the customers behind this ARR"
              >
                <p className="stripe-ui__stat-label">Selected-range ARR migrated</p>
                <p className="stripe-ui__stat-value">{formatMoney(data.selectedRange.arrMigrated, data.targetCurrency)}</p>
              </button>
              <button
                className="stripe-ui__stat migration__headline-stat migration__download-card"
                type="button"
                disabled={!customerGroups?.selectedRangeMigrations.length}
                onClick={() => downloadCustomers("selected-range-migrated-customers", customerGroups?.selectedRangeMigrations || [])}
                title="Download the customers behind this total"
              >
                <p className="stripe-ui__stat-label">Selected-range logos migrated</p>
                <p className="stripe-ui__stat-value">{data.selectedRange.logosMigrated}</p>
              </button>
              <button
                className="stripe-ui__stat migration__headline-stat migration__headline-stat--month migration__download-card"
                type="button"
                disabled={!customerGroups?.currentMonthMigrations.length}
                onClick={() => downloadCustomers("range-end-month-migrated-arr-customers", customerGroups?.currentMonthMigrations || [])}
                title="Download the customers behind this ARR"
              >
                <p className="stripe-ui__stat-label">Range-end month ARR migrated</p>
                <p className="stripe-ui__stat-value">{formatMoney(data.currentMonth.arrMigrated, data.targetCurrency)}</p>
              </button>
              <button
                className="stripe-ui__stat migration__headline-stat migration__headline-stat--month migration__download-card"
                type="button"
                disabled={!customerGroups?.currentMonthMigrations.length}
                onClick={() => downloadCustomers("range-end-month-migrated-customers", customerGroups?.currentMonthMigrations || [])}
                title="Download the customers behind this total"
              >
                <p className="stripe-ui__stat-label">Range-end month logos migrated</p>
                <p className="stripe-ui__stat-value">{data.currentMonth.logosMigrated}</p>
              </button>
            </div>
            {data.warnings.length ? (
              <div className="commissions-warning">
                {data.warnings.map((warning) => <div key={warning}>{warning}</div>)}
              </div>
            ) : null}
          </section>

          <section className="stripe-ui__panel ui-reveal ui-reveal-2">
            <h2 className="stripe-ui__panel-title">By source</h2>
            <p className="stripe-ui__panel-subtitle">Stripe / BigQuery and HubSpot Sales Default Pipeline customers are counted independently.</p>
            <div className="migration__source-grid">
              {data.sourceBreakdown.map((source) => {
                const population = data.goal.sourcePopulations.find((item) => item.source === source.source);
                const sourceOpeningRows = (customerGroups?.openingLegacy || []).filter((row) => row.source === source.source);
                const sourceCurrentRows = (customerGroups?.currentLegacy || []).filter((row) => row.source === source.source);
                const sourceSelectedRows = (customerGroups?.selectedRangeMigrations || []).filter((row) => row.source === source.source);
                const sourceMonthRows = (customerGroups?.currentMonthMigrations || []).filter((row) => row.source === source.source);
                return (
                  <article className="migration__source-card" key={source.source}>
                    <h3>{source.sourceLabel}</h3>
                    <button className="migration__source-download" type="button" disabled={!sourceOpeningRows.length} onClick={() => downloadCustomers(`${source.source}-opening-v2-v3-customers`, sourceOpeningRows)}>
                      <span>Opening V2/V3 customers</span><strong>{population?.opening.customers || 0}</strong>
                    </button>
                    <button className="migration__source-download" type="button" disabled={!sourceCurrentRows.length} onClick={() => downloadCustomers(`${source.source}-v2-v3-at-range-end`, sourceCurrentRows)}>
                      <span>V2/V3 customers at range end</span><strong>{population?.current.customers || 0}</strong>
                    </button>
                    <button className="migration__source-download" type="button" disabled={!sourceSelectedRows.length} onClick={() => downloadCustomers(`${source.source}-selected-range-migrated-arr-customers`, sourceSelectedRows)}>
                      <span>Selected-range ARR migrated</span><strong>{formatMoney(source.selectedRange.arrMigrated, data.targetCurrency)}</strong>
                    </button>
                    <button className="migration__source-download" type="button" disabled={!sourceSelectedRows.length} onClick={() => downloadCustomers(`${source.source}-selected-range-migrated-customers`, sourceSelectedRows)}>
                      <span>Selected-range logos migrated</span><strong>{source.selectedRange.logosMigrated}</strong>
                    </button>
                    <button className="migration__source-download" type="button" disabled={!sourceMonthRows.length} onClick={() => downloadCustomers(`${source.source}-range-end-month-migrated-arr-customers`, sourceMonthRows)}>
                      <span>Range-end month ARR</span><strong>{formatMoney(source.currentMonth.arrMigrated, data.targetCurrency)}</strong>
                    </button>
                    <button className="migration__source-download" type="button" disabled={!sourceMonthRows.length} onClick={() => downloadCustomers(`${source.source}-range-end-month-migrated-customers`, sourceMonthRows)}>
                      <span>Range-end month logos</span><strong>{source.currentMonth.logosMigrated}</strong>
                    </button>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="stripe-ui__panel ui-reveal">
            <h2 className="stripe-ui__panel-title">Monthly migration pace</h2>
            <p className="stripe-ui__panel-subtitle">ARR and customer logos migrated in each month of the selected range.</p>
            <div className="migration__month-list">
              {data.months.map((month) => (
                <button
                  className="migration__month-row migration__download-row"
                  type="button"
                  key={month.monthKey}
                  disabled={!customerGroups?.selectedRangeMigrations.some((row) => row.migratedAt.slice(0, 7) === month.monthKey)}
                  onClick={() => downloadCustomers(
                    `${month.monthKey}-migrated-customers`,
                    (customerGroups?.selectedRangeMigrations || []).filter((row) => row.migratedAt.slice(0, 7) === month.monthKey),
                  )}
                  title="Download the customers behind this month"
                >
                  <div className="migration__month-label">
                    <strong>{month.monthLabel}</strong>
                    <span>{month.logosMigrated} logo{month.logosMigrated === 1 ? "" : "s"}</span>
                  </div>
                  <div className="migration__month-track" aria-label={`${month.monthLabel}: ${formatMoney(month.arrMigrated, data.targetCurrency)}`}>
                    <div style={{ width: `${Math.max(0, (month.arrMigrated / maxMonthlyArr) * 100)}%` }} />
                  </div>
                  <strong className="migration__month-amount">{formatMoney(month.arrMigrated, data.targetCurrency)}</strong>
                </button>
              ))}
            </div>
          </section>

          <section className="stripe-ui__panel ui-reveal">
            <div className="stripe-ui__section-head">
              <div>
                <h2 className="stripe-ui__panel-title">Migrated customers</h2>
                <p className="stripe-ui__panel-subtitle">Each customer appears once at their first qualifying V4 plan activation within the selected range.</p>
              </div>
              <button
                className="migration__as-of migration__download-inline"
                type="button"
                disabled={!customerGroups?.selectedRangeMigrations.length}
                onClick={() => downloadCustomers("selected-range-migrated-customers", customerGroups?.selectedRangeMigrations || [])}
              >
                {data.migrations.length} total
              </button>
            </div>
            <div className="stripe-ui__table-wrap">
              <table className="stripe-ui__table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Source</th>
                    <th>Migration date</th>
                    <th>Workspace</th>
                    <th>Previous plan</th>
                    <th>Plan at range end</th>
                    <th>Prior V2/V3 ARR</th>
                    <th>V4 ARR migrated</th>
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
                      <td>{migration.previousPlan || "—"}</td>
                      <td>{migration.currentPlan || "—"}</td>
                      <td>{formatMoney(migration.priorLegacyArr, data.targetCurrency)}</td>
                      <td>{formatMoney(migration.migratedV4Arr, data.targetCurrency)}</td>
                    </tr>
                  )) : (
                    <tr><td colSpan={8}>No qualifying V2/V3-to-V4 migrations were found in this range.</td></tr>
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
