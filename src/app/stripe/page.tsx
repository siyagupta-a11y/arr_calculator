"use client";

import Link from "next/link";
import React, { useMemo, useState } from "react";
import type { Grain, ReportResponse } from "@/lib/types";

type CurrencyDisplay = "normal" | "thousands" | "millions";
type GroupField = "customerId" | "lineItemDescription";

const GROUP_BY_OPTIONS: Array<{ key: GroupField; label: string }> = [
  { key: "customerId", label: "Customer ID" },
  { key: "lineItemDescription", label: "Line Item Description" },
];

type UiRow = {
  customerName: string;
  customerId: string;
  lineItemId: string;
  lineItemDescription: string;
  groupValues: Partial<Record<GroupField, string>>;
  valuesByPeriod: Record<string, number>;
};

function round2(n: number) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function fmtMoney(n: number, currencyDisplay: CurrencyDisplay) {
  const fractionDigits = currencyDisplay === "normal" ? 0 : 2;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(n || 0);
}

function hasAnyNonZeroValue(valuesByPeriod: Record<string, number>) {
  return Object.values(valuesByPeriod || {}).some((value) => Math.abs(Number(value) || 0) > 1e-9);
}

function groupValueForRow(row: UiRow, field: GroupField) {
  if (field === "customerId") return row.customerId || "(blank)";
  return row.lineItemDescription || "(blank)";
}

export default function StripePage() {
  const [startDate, setStartDate] = useState("2025-01-01");
  const [endDate, setEndDate] = useState("2025-12-31");
  const [grain, setGrain] = useState<Grain>("monthly");
  const [currencyDisplay, setCurrencyDisplay] = useState<CurrencyDisplay>("normal");

  const [groupByFields, setGroupByFields] = useState<GroupField[]>([]);
  const [groupByToAdd, setGroupByToAdd] = useState<GroupField | "none">("none");

  const [filterCustomerName, setFilterCustomerName] = useState("");
  const [filterCustomerId, setFilterCustomerId] = useState("");
  const [filterLineItemDescription, setFilterLineItemDescription] = useState("");

  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    setData(null);

    try {
      const res = await fetch("/api/stripe-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate,
          endDate,
          grain,
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
        throw new Error(text || "Request failed");
      }

      if (!json || typeof json !== "object") throw new Error("Invalid API response");
      setData(json as ReportResponse);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Unknown error";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  const displayedRows: UiRow[] = useMemo(() => {
    if (!data) return [];

    const customerNameNeedle = filterCustomerName.trim().toLowerCase();
    const customerIdNeedle = filterCustomerId.trim().toLowerCase();
    const lineItemDescriptionNeedle = filterLineItemDescription.trim().toLowerCase();

    const baseRows: UiRow[] = (data.rows || []).map((r) => ({
      customerName: r.dealName || "",
      customerId: r.dealId || "",
      lineItemId: r.lineItemId || "",
      lineItemDescription: r.lineItemDescription || "",
      groupValues: {},
      valuesByPeriod: r.valuesByPeriod || {},
    }));

    const filteredBaseRows = baseRows.filter((r) => {
      const customerNameOk = !customerNameNeedle || r.customerName.toLowerCase().includes(customerNameNeedle);
      const customerIdOk = !customerIdNeedle || r.customerId.toLowerCase().includes(customerIdNeedle);
      const lineItemDescriptionOk =
        !lineItemDescriptionNeedle || r.lineItemDescription.toLowerCase().includes(lineItemDescriptionNeedle);
      return customerNameOk && customerIdOk && lineItemDescriptionOk;
    });

    if (groupByFields.length === 0) {
      return filteredBaseRows.filter((r) => hasAnyNonZeroValue(r.valuesByPeriod));
    }

    const map = new Map<string, UiRow>();

    for (const row of filteredBaseRows) {
      const key = groupByFields.map((field) => `${field}:${groupValueForRow(row, field)}`).join("|");

      if (!map.has(key)) {
        const groupValues: Partial<Record<GroupField, string>> = {};
        for (const field of groupByFields) {
          groupValues[field] = groupValueForRow(row, field);
        }

        map.set(key, {
          customerName: row.customerName,
          customerId: row.customerId,
          lineItemId: row.lineItemId,
          lineItemDescription: row.lineItemDescription,
          groupValues,
          valuesByPeriod: { ...row.valuesByPeriod },
        });
      } else {
        const agg = map.get(key)!;
        for (const periodKey of Object.keys(row.valuesByPeriod || {})) {
          agg.valuesByPeriod[periodKey] = (agg.valuesByPeriod[periodKey] || 0) + (row.valuesByPeriod[periodKey] || 0);
        }
      }
    }

    for (const agg of map.values()) {
      for (const periodKey of Object.keys(agg.valuesByPeriod)) {
        agg.valuesByPeriod[periodKey] = round2(agg.valuesByPeriod[periodKey] || 0);
      }
    }

    return Array.from(map.values()).filter((r) => hasAnyNonZeroValue(r.valuesByPeriod));
  }, [data, filterCustomerName, filterCustomerId, filterLineItemDescription, groupByFields]);

  const totalsByPeriodForDisplayed = useMemo(() => {
    if (!data) return [];
    return data.periods.map((p) => {
      const total = displayedRows.reduce((acc, r) => acc + (r.valuesByPeriod[p.key] || 0), 0);
      return { key: p.key, label: p.label, total: round2(total) };
    });
  }, [data, displayedRows]);

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

  function currencySuffix() {
    if (currencyDisplay === "thousands") return " (K)";
    if (currencyDisplay === "millions") return " (M)";
    return "";
  }

  function escapeCsvCell(value: string | number) {
    const text = String(value ?? "");
    if (text.includes(",") || text.includes('"') || text.includes("\n")) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }

  function exportBreakdownCsv() {
    if (!data) return;

    const csvHeaders = breakdownHeaders.map((h) =>
      h !== "Customer" && h !== "Customer ID" && h !== "Line Item ID" && h !== "Line Item Description"
        ? `${h}${currencySuffix()}`
        : h,
    );
    const lines: string[] = [csvHeaders.map(escapeCsvCell).join(",")];

    for (const r of displayedRows) {
      const leadingColumns = showDefaultColumns
        ? [r.customerName, r.customerId, r.lineItemId, r.lineItemDescription]
        : groupByFields.map((field) => r.groupValues[field] || "(blank)");
      const valueCols = (data.periods || []).map((p) => round2(scaleCurrency(r.valuesByPeriod[p.key] || 0)));
      const row = [...leadingColumns, ...valueCols];
      lines.push(row.map(escapeCsvCell).join(","));
    }

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `stripe-arr-breakdown-${stamp}.csv`;
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
              <div style={{ fontSize: 18 }}>{displayedRows.length}</div>
            </div>

            <div style={{ marginTop: 12, display: "flex", gap: 12, flexWrap: "wrap" }}>
              <div>
                <label>Filter Customer</label>
                <br />
                <input
                  type="text"
                  value={filterCustomerName}
                  onChange={(e) => setFilterCustomerName(e.target.value)}
                  placeholder="contains..."
                />
              </div>

              <div>
                <label>Filter Customer ID</label>
                <br />
                <input
                  type="text"
                  value={filterCustomerId}
                  onChange={(e) => setFilterCustomerId(e.target.value)}
                  placeholder="contains..."
                />
              </div>

              <div>
                <label>Filter Line Description</label>
                <br />
                <input
                  type="text"
                  value={filterLineItemDescription}
                  onChange={(e) => setFilterLineItemDescription(e.target.value)}
                  placeholder="contains..."
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
                        {fmtMoney(scaleCurrency(t.total), currencyDisplay)}
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

          <div style={{ marginBottom: 8 }}>
            <button onClick={exportBreakdownCsv}>Export breakdown CSV</button>
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
                        {fmtMoney(scaleCurrency(r.valuesByPeriod[p.key] || 0), currencyDisplay)}
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
