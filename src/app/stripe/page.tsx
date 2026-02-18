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
  customerName: string;
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

  const [filterCustomerName, setFilterCustomerName] = useState("");
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
          filterCustomerName,
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
          filterCustomerName,
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
    filterCustomerName,
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
        customerName: r.dealName || "",
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
    filterCustomerName,
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
      ? ["Customer", "Customer ID", "Line Item ID", "Line Item Description"]
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
        filterCustomerName,
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

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 24, marginBottom: 0 }}>Stripe ARR Report</h1>
        <Link href="/">Open HubSpot report</Link>
      </div>

      <p style={{ marginTop: 8, color: "#666" }}>
        Pulls Stripe invoice line items and annualizes each line by its billing period (`period.start` to
        `period.end`).
      </p>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end", marginTop: 16 }}>
        <div>
          <label>Start date</label>
          <br />
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>

        <div>
          <label>End date</label>
          <br />
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>

        <div>
          <label>Time grain</label>
          <br />
          <select value={grain} onChange={(e) => setGrain(e.target.value as Grain)}>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="annually">Annually</option>
            <option value="daily">Daily (not recommended)</option>
          </select>
        </div>

        <div>
          <label>Currency display</label>
          <br />
          <select value={currencyDisplay} onChange={(e) => setCurrencyDisplay(e.target.value as CurrencyDisplay)}>
            <option value="normal">Normal</option>
            <option value="thousands">Thousands (K)</option>
            <option value="millions">Millions (M)</option>
          </select>
        </div>

        <div>
          <label>Group by</label>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <select value={groupByToAdd} onChange={(e) => setGroupByToAdd(e.target.value as GroupField | "none")}>
              <option value="none">Select field</option>
              {GROUP_BY_OPTIONS.map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button onClick={addGroupBy} disabled={groupByToAdd === "none"}>
              Add
            </button>
            <button onClick={() => setGroupByFields([])} disabled={groupByFields.length === 0}>
              Clear
            </button>
          </div>
          {groupByFields.length > 0 && (
            <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
              {groupByFields.map((field) => (
                <button
                  key={field}
                  onClick={() => removeGroupBy(field)}
                  style={{ border: "1px solid #ddd", borderRadius: 6, padding: "2px 8px", background: "#fafafa" }}
                >
                  {(GROUP_BY_OPTIONS.find((opt) => opt.key === field)?.label || field) + " x"}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={run}
          disabled={loading}
          style={{
            padding: "8px 14px",
            borderRadius: 8,
            border: "1px solid #ccc",
            background: loading ? "#f2f2f2" : "white",
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Running…" : "Run Stripe ARR"}
        </button>
      </div>

      {error && (
        <div style={{ marginTop: 16, padding: 12, borderRadius: 8, background: "#ffecec", color: "#8a1f1f" }}>
          {error}
        </div>
      )}

      {data && (
        <>
          <div style={{ marginTop: 20, padding: 12, border: "1px solid #eee", borderRadius: 10 }}>
            <div>
              <div style={{ color: "#666", fontSize: 12 }}>
                Rows {showDefaultColumns ? "(line items)" : `(groups: ${groupByLabel})`}
              </div>
              <div style={{ fontSize: 18 }}>{data.pagination?.totalRows ?? displayedRows.length}</div>
            </div>

            <div style={{ marginTop: 12, display: "flex", gap: 12, flexWrap: "wrap" }}>
              <div>
                <label>Filter Customer</label>
                <br />
                <input
                  type="text"
                  value={filterCustomerName}
                  onChange={(e) => setFilterCustomerName(e.target.value)}
                  placeholder="foo, bar, NOT baz"
                />
              </div>

              <div>
                <label>Filter Customer ID</label>
                <br />
                <input
                  type="text"
                  value={filterCustomerId}
                  onChange={(e) => setFilterCustomerId(e.target.value)}
                  placeholder="foo, bar, NOT baz"
                />
              </div>

              <div>
                <label>Filter Line Description</label>
                <br />
                <input
                  type="text"
                  value={filterLineItemDescription}
                  onChange={(e) => setFilterLineItemDescription(e.target.value)}
                  placeholder="foo, bar, NOT baz"
                />
              </div>

              <div>
                <label>Filter Description Prefix</label>
                <br />
                <input
                  type="text"
                  value={filterLineItemDescriptionPrefix}
                  onChange={(e) => setFilterLineItemDescriptionPrefix(e.target.value)}
                  placeholder="foo, bar, NOT baz"
                />
              </div>
            </div>

            <div style={{ marginTop: 12, overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr>
                    {data.periods.map((p) => (
                      <th key={p.key} style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 8 }}>
                        {p.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    {totalsByPeriodForDisplayed.map((t) => (
                      <td key={t.key} style={{ textAlign: "right", padding: 8 }}>
                        {fmtMoney(scaleCurrency(t.total))}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <h2 style={{ marginTop: 24, fontSize: 18 }}>
            Breakdown {showDefaultColumns ? "(per line item)" : `(grouped by ${groupByLabel})`}
          </h2>

          <div style={{ marginBottom: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label>Sort rows by period</label>
            <select value={sortByPeriodKey} onChange={(e) => setSortByPeriodKey(e.target.value)}>
              <option value="none">None</option>
              {(data.periods || []).map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label} (desc)
                </option>
              ))}
            </select>
            <span style={{ color: "#666", fontSize: 12 }}>
              {`Page ${data.pagination?.page || page}${data.pagination?.totalPages ? ` of ${data.pagination.totalPages}` : ""}`}
            </span>
            <span style={{ color: "#666", fontSize: 12 }}>
              {`Rows: ${data.pagination?.returnedRows || 0}${data.pagination?.totalRows ? ` / ${data.pagination.totalRows}` : ""} (page size ${FIXED_PAGE_SIZE})`}
            </span>
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={loading || (data.pagination?.page || page) <= 1}
              style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #ddd", background: "white" }}
            >
              Prev
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={loading || !data.pagination?.hasMore}
              style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #ddd", background: "white" }}
            >
              Next
            </button>
          </div>

          <div style={{ marginBottom: 8 }}>
            <button onClick={exportBreakdownCsv} disabled={!data || exporting}>
              {exporting ? "Exporting full CSV…" : "Export full breakdown CSV"}
            </button>
          </div>

          <div style={{ overflowX: "auto", border: "1px solid #eee", borderRadius: 10 }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  {breakdownHeaders.map((h) => (
                    <th
                      key={h}
                      style={{
                        borderBottom: "1px solid #ddd",
                        padding: 8,
                        textAlign: "left",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {displayedRows.map((r, idx) => (
                  <tr key={`${r.lineItemId || "group"}-${idx}`} style={{ borderBottom: "1px solid #f2f2f2" }}>
                    {showDefaultColumns ? (
                      <>
                        <td style={{ padding: 8, whiteSpace: "nowrap" }}>{r.customerName || "(blank)"}</td>
                        <td style={{ padding: 8, whiteSpace: "nowrap" }}>{r.customerId || "(blank)"}</td>
                        <td style={{ padding: 8, whiteSpace: "nowrap" }}>{r.lineItemId || "(blank)"}</td>
                        <td style={{ padding: 8, whiteSpace: "nowrap" }}>{r.lineItemDescription || "(blank)"}</td>
                      </>
                    ) : (
                      groupByFields.map((field) => (
                        <td key={field} style={{ padding: 8, whiteSpace: "nowrap" }}>
                          {r.groupValues[field] || "(blank)"}
                        </td>
                      ))
                    )}

                    {data.periods.map((p) => (
                      <td key={p.key} style={{ padding: 8, textAlign: "right", whiteSpace: "nowrap" }}>
                        {fmtMoney(scaleCurrency(r.valuesByPeriod[p.key] || 0))}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
