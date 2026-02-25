"use client";

import Link from "next/link";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { Grain, ReportResponse } from "@/lib/types";

type CurrencyDisplay = "normal" | "thousands" | "millions";
type GroupField = "customerId" | "lineItemDescription" | "lineItemDescriptionPrefix";

const GROUP_BY_OPTIONS: Array<{ key: GroupField; label: string }> = [
  { key: "customerId", label: "Customer ID" },
  { key: "lineItemDescription", label: "Line Item Description" },
  { key: "lineItemDescriptionPrefix", label: "Line Description (before ' - ')" },
];

type UiRow = {
  customerId: string;
  lineItemId: string;
  lineItemDescription: string;
  groupValues: Partial<Record<GroupField, string>>;
  valuesByPeriod: Record<string, number>;
};

const FIXED_PAGE_SIZE = 1000;

function fmtMoney(n: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n || 0);
}

function defaultDateRange() {
  const end = new Date();
  const start = new Date(end.getFullYear() - 1, end.getMonth(), end.getDate());
  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  return { startDate: toIso(start), endDate: toIso(end) };
}

export default function StripePage() {
  const [startDate, setStartDate] = useState(() => defaultDateRange().startDate);
  const [endDate, setEndDate] = useState(() => defaultDateRange().endDate);
  const [grain, setGrain] = useState<Grain>("monthly");
  const [currencyDisplay, setCurrencyDisplay] = useState<CurrencyDisplay>("normal");

  const [groupByFields, setGroupByFields] = useState<GroupField[]>([]);
  const [groupByToAdd, setGroupByToAdd] = useState<GroupField | "none">("none");

  const [filterCustomerId, setFilterCustomerId] = useState("");
  const [filterLineItemDescription, setFilterLineItemDescription] = useState("");
  const [filterLineItemDescriptionPrefix, setFilterLineItemDescriptionPrefix] = useState("");
  const [sortByPeriodKey, setSortByPeriodKey] = useState<string>("none");
  const [page, setPage] = useState(1);
  const [hasRunOnce, setHasRunOnce] = useState(false);

  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [data, setData] = useState<ReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setHasRunOnce(true);
    setLoading(true);
    setError(null);
    setData(null);

    try {
      let res = await fetch("/api/stripe-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate,
          endDate,
          grain,
          filterCustomerId,
          filterLineItemDescription,
          filterLineItemDescriptionPrefix,
          groupByFields,
          sortByPeriodKey,
          page,
        }),
      });
      if (res.status === 405) {
        const qs = new URLSearchParams({
          startDate,
          endDate,
          grain,
          filterCustomerId,
          filterLineItemDescription,
          filterLineItemDescriptionPrefix,
          groupByFields: groupByFields.join(","),
          sortByPeriodKey,
          page: String(page),
        });
        res = await fetch(`/api/stripe-report?${qs.toString()}`, { method: "GET" });
      }
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }

      if (!res.ok) {
        if (json && typeof json === "object" && "error" in json) {
          const apiError = String((json as { error?: unknown }).error || "Request failed");
          throw new Error(`HTTP ${res.status}: ${apiError}`);
        }
        const snippet = (text || "").trim().slice(0, 500);
        throw new Error(`HTTP ${res.status}: ${snippet || "Request failed (empty response body)"}`);
      }

      if (!json || typeof json !== "object") throw new Error("Invalid API response");
      const report = json as ReportResponse;
      setData(report);
      const serverPage = report.pagination?.page;
      if (typeof serverPage === "number" && Number.isFinite(serverPage) && serverPage > 0 && serverPage !== page) {
        setPage(serverPage);
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Unknown error";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [
    startDate,
    endDate,
    grain,
    filterCustomerId,
    filterLineItemDescription,
    filterLineItemDescriptionPrefix,
    groupByFields,
    sortByPeriodKey,
    page,
  ]);

  const displayedRows: UiRow[] = useMemo(() => {
    if (!data) return [];
    return (data.rows || [])
      .map((r) => ({
        customerId: r.dealId || "",
        lineItemId: r.lineItemId || "",
        lineItemDescription: r.lineItemDescription || "",
        groupValues: (r.groupValues as Partial<Record<GroupField, string>>) || {},
        valuesByPeriod: r.valuesByPeriod || {},
      }));
  }, [data]);

  const totalsByPeriodForDisplayed = useMemo(() => {
    if (!data) return [];
    return data.totalsByPeriod || [];
  }, [data]);

  useEffect(() => {
    setPage(1);
  }, [
    startDate,
    endDate,
    grain,
    filterCustomerId,
    filterLineItemDescription,
    filterLineItemDescriptionPrefix,
    groupByFields,
    sortByPeriodKey,
  ]);

  useEffect(() => {
    if (!hasRunOnce) return;
    const t = setTimeout(() => {
      void run();
    }, 250);
    return () => clearTimeout(t);
  }, [
    hasRunOnce,
    run,
  ]);

  const showDefaultColumns = groupByFields.length === 0;
  const groupByLabel = groupByFields.map((f) => GROUP_BY_OPTIONS.find((o) => o.key === f)?.label || f).join(" + ");
  const breakdownHeaders = [
    ...(showDefaultColumns
      ? ["Customer ID", "Line Item ID", "Line Item Description"]
      : groupByFields.map((f) => GROUP_BY_OPTIONS.find((o) => o.key === f)?.label || f)),
    ...(data?.periods.map((p) => p.label) || []),
  ];

  function scaleCurrency(n: number) {
    if (currencyDisplay === "thousands") return n / 1_000;
    if (currencyDisplay === "millions") return n / 1_000_000;
    return n;
  }

  async function exportBreakdownCsv() {
    setError(null);
    setExporting(true);
    try {
      const qs = new URLSearchParams({
        startDate,
        endDate,
        grain,
        filterCustomerId,
        filterLineItemDescription,
        filterLineItemDescriptionPrefix,
        groupByFields: groupByFields.join(","),
        sortByPeriodKey,
      });
      const res = await fetch(`/api/stripe-report/export?${qs.toString()}`, { method: "GET" });
      if (!res.ok) {
        const text = await res.text();
        const snippet = text.trim().slice(0, 500);
        throw new Error(`HTTP ${res.status}: ${snippet || "CSV export failed"}`);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const contentDisposition = res.headers.get("content-disposition") || "";
      const filenameMatch = /filename="?([^"]+)"?/i.exec(contentDisposition);
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = filenameMatch?.[1] || `stripe-arr-breakdown-full-${stamp}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "CSV export failed";
      setError(message);
    } finally {
      setExporting(false);
    }
  }

  function addGroupBy() {
    if (groupByToAdd === "none") return;
    setGroupByFields((prev) => (prev.includes(groupByToAdd) ? prev : [...prev, groupByToAdd]));
    setGroupByToAdd("none");
  }

  function removeGroupBy(field: GroupField) {
    setGroupByFields((prev) => prev.filter((f) => f !== field));
  }

  const currentPage = data?.pagination?.page || page;
  const totalPages = data?.pagination?.totalPages || 0;
  const hasMorePages = !!data?.pagination?.hasMore;
  const totalRows = data?.pagination?.totalRows ?? displayedRows.length;
  const returnedRows = data?.pagination?.returnedRows || displayedRows.length;

  return (
    <div className="stripe-ui">
      <section className="stripe-ui__hero ui-reveal">
        <div className="stripe-ui__eyebrow">Revenue intelligence</div>
        <div className="stripe-ui__hero-row">
          <div>
            <h1 className="stripe-ui__title">Stripe ARR Report</h1>
            <p className="stripe-ui__subtitle">
              Tracks Stripe invoice lines and annualizes each value from its billing window (`period.start` to
              `period.end`) with backend-driven pagination and full CSV export.
            </p>
          </div>
          <Link href="/" className="stripe-ui__hero-link">
            Open HubSpot report
          </Link>
        </div>
      </section>

      <section className="stripe-ui__panel ui-reveal ui-reveal-1">
        <h2 className="stripe-ui__panel-title">Report controls</h2>
        <p className="stripe-ui__panel-subtitle">Choose date window, grain, grouping, then run the query.</p>

        <div className="stripe-ui__control-grid">
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label">Start date</label>
            <input
              className="stripe-ui__control"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label">End date</label>
            <input className="stripe-ui__control" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label">Time grain</label>
            <select className="stripe-ui__control" value={grain} onChange={(e) => setGrain(e.target.value as Grain)}>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="annually">Annually</option>
              <option value="daily">Daily (not recommended)</option>
            </select>
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label">Currency display</label>
            <select
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
            <label className="stripe-ui__field-label">Group by</label>
            <select className="stripe-ui__control" value={groupByToAdd} onChange={(e) => setGroupByToAdd(e.target.value as GroupField | "none")}>
              <option value="none">Select field</option>
              {GROUP_BY_OPTIONS.map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label">Run query</label>
            <button className="stripe-ui__btn stripe-ui__btn--primary" onClick={run} disabled={loading}>
              {loading ? "Running..." : "Run Stripe ARR"}
            </button>
          </div>
        </div>

        <div className="stripe-ui__actions">
          <button className="stripe-ui__btn stripe-ui__btn--secondary" onClick={addGroupBy} disabled={groupByToAdd === "none"}>
            Add group field
          </button>
          <button className="stripe-ui__btn stripe-ui__btn--ghost" onClick={() => setGroupByFields([])} disabled={groupByFields.length === 0}>
            Clear grouping
          </button>
        </div>

        {groupByFields.length > 0 && (
          <div className="stripe-ui__chips">
            {groupByFields.map((field) => (
              <button key={field} className="stripe-ui__chip" onClick={() => removeGroupBy(field)}>
                {(GROUP_BY_OPTIONS.find((opt) => opt.key === field)?.label || field) + " x"}
              </button>
            ))}
          </div>
        )}
      </section>

      {error && <div className="stripe-ui__error ui-reveal ui-reveal-1">{error}</div>}

      {data && (
        <>
          <section className="stripe-ui__panel ui-reveal ui-reveal-2">
            <div className="stripe-ui__stats">
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Rows</p>
                <p className="stripe-ui__stat-value">{totalRows}</p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Current page</p>
                <p className="stripe-ui__stat-value">{totalPages ? `${currentPage} / ${totalPages}` : currentPage}</p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Page payload</p>
                <p className="stripe-ui__stat-value">{returnedRows}</p>
              </div>
            </div>

            <div className="stripe-ui__filter-grid">
              <div className="stripe-ui__field">
                <label className="stripe-ui__field-label">Filter Customer ID</label>
                <input
                  className="stripe-ui__control"
                  type="text"
                  value={filterCustomerId}
                  onChange={(e) => setFilterCustomerId(e.target.value)}
                  placeholder="foo, bar, NOT baz"
                />
              </div>

              <div className="stripe-ui__field">
                <label className="stripe-ui__field-label">Filter Line Description</label>
                <input
                  className="stripe-ui__control"
                  type="text"
                  value={filterLineItemDescription}
                  onChange={(e) => setFilterLineItemDescription(e.target.value)}
                  placeholder="foo, bar, NOT baz"
                />
              </div>

              <div className="stripe-ui__field">
                <label className="stripe-ui__field-label">Filter Description Prefix</label>
                <input
                  className="stripe-ui__control"
                  type="text"
                  value={filterLineItemDescriptionPrefix}
                  onChange={(e) => setFilterLineItemDescriptionPrefix(e.target.value)}
                  placeholder="foo, bar, NOT baz"
                />
              </div>
            </div>

            <div className="stripe-ui__table-wrap" style={{ marginTop: "0.9rem" }}>
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
                      <td
                        key={t.key}
                        className={`stripe-ui__num ${(t.total || 0) < 0 ? "stripe-ui__money--negative" : "stripe-ui__money--positive"}`}
                      >
                        {fmtMoney(scaleCurrency(t.total))}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="stripe-ui__panel ui-reveal ui-reveal-3">
            <div className="stripe-ui__section-head">
              <div>
                <h2 className="stripe-ui__panel-title">
                  Breakdown {showDefaultColumns ? "(per line item)" : `(grouped by ${groupByLabel})`}
                </h2>
                <p className="stripe-ui__panel-subtitle" style={{ marginBottom: 0 }}>
                  Fixed page size {FIXED_PAGE_SIZE}; totals already include all matching rows across pages.
                </p>
              </div>
            </div>

            <div className="stripe-ui__toolbar">
              <div className="stripe-ui__toolbar-group">
                <label className="stripe-ui__field-label">Sort rows by period</label>
                <select className="stripe-ui__control" value={sortByPeriodKey} onChange={(e) => setSortByPeriodKey(e.target.value)}>
                  <option value="none">None</option>
                  {(data.periods || []).map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label} (desc)
                    </option>
                  ))}
                </select>
              </div>

              <div className="stripe-ui__toolbar-group">
                <span className="stripe-ui__hint">
                  {`Page ${currentPage}${totalPages ? ` of ${totalPages}` : ""}`}
                </span>
                <span className="stripe-ui__hint">
                  {`Rows: ${returnedRows}${totalRows ? ` / ${totalRows}` : ""}`}
                </span>
              </div>

              <div className="stripe-ui__toolbar-group">
                <button
                  className="stripe-ui__btn stripe-ui__btn--ghost"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={loading || currentPage <= 1}
                >
                  Prev
                </button>
                <button
                  className="stripe-ui__btn stripe-ui__btn--ghost"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={loading || !hasMorePages}
                >
                  Next
                </button>
                <button className="stripe-ui__btn stripe-ui__btn--secondary" onClick={exportBreakdownCsv} disabled={!data || exporting}>
                  {exporting ? "Exporting full CSV..." : "Export full breakdown CSV"}
                </button>
              </div>
            </div>

            <div className="stripe-ui__table-wrap">
              <table className="stripe-ui__table">
                <thead>
                  <tr>
                    {breakdownHeaders.map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {displayedRows.map((r, idx) => (
                    <tr key={`${r.lineItemId || "group"}-${idx}`}>
                      {showDefaultColumns ? (
                        <>
                          <td>{r.customerId || "(blank)"}</td>
                          <td>{r.lineItemId || "(blank)"}</td>
                          <td className="stripe-ui__break-cell">{r.lineItemDescription || "(blank)"}</td>
                        </>
                      ) : (
                        groupByFields.map((field) => <td key={field}>{r.groupValues[field] || "(blank)"}</td>)
                      )}

                      {data.periods.map((p) => {
                        const value = r.valuesByPeriod[p.key] || 0;
                        return (
                          <td key={p.key} className={`stripe-ui__num ${value < 0 ? "stripe-ui__money--negative" : ""}`}>
                            {fmtMoney(scaleCurrency(value))}
                          </td>
                        );
                      })}
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
