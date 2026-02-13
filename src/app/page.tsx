"use client";

import React, { useMemo, useState } from "react";
import type { ReportRequest, ReportResponse, ReportRow, Grain, ReportMode } from "@/lib/types";

function fmtMoney(n: number, currencyDisplay: CurrencyDisplay) {
  const fractionDigits = currencyDisplay === "normal" ? 0 : 2;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(n || 0);
}

type CurrencyDisplay = "normal" | "thousands" | "millions";

type GroupField =
  | "dealName"
  | "deploymentType"
  | "accountId"
  | "territory"
  | "country"
  | "industry"
  | "dealType";

const GROUP_BY_OPTIONS: Array<{ key: GroupField; label: string }> = [
  { key: "dealName", label: "Deal Name" },
  { key: "deploymentType", label: "Deployment Type" },
  { key: "accountId", label: "Account ID" },
  { key: "territory", label: "Territory" },
  { key: "country", label: "Country" },
  { key: "industry", label: "Industry" },
  { key: "dealType", label: "Deal Type" },
];

type UiRow = {
  dealName: string;
  dealId: string;
  deploymentType?: string;
  accountId?: string;
  territory?: string;
  country?: string;
  industry?: string;
  dealType?: string;
  groupValues: Partial<Record<GroupField, string>>;
  valuesByPeriod: Record<string, number>;
};

function groupValueForRow(r: UiRow, field: GroupField) {
  if (field === "dealName") return r.dealName || "(blank)";
  if (field === "deploymentType") return r.deploymentType || "(blank)";
  if (field === "territory") return r.territory || "(blank)";
  if (field === "country") return r.country || "(blank)";
  if (field === "industry") return r.industry || "(blank)";
  if (field === "dealType") return r.dealType || "(blank)";
  return r.accountId || "(blank)";
}

function round2(n: number) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function hasAnyNonZeroValue(valuesByPeriod: Record<string, number>) {
  return Object.values(valuesByPeriod || {}).some((value) => Math.abs(Number(value) || 0) > 1e-9);
}

export default function Home() {
  const [startDate, setStartDate] = useState("2025-01-01");
  const [endDate, setEndDate] = useState("2025-12-31");
  const [mode, setMode] = useState<ReportMode>("arr");
  const [grain, setGrain] = useState<Grain>("monthly");

  const [groupByFields, setGroupByFields] = useState<GroupField[]>([]);
  const [groupByToAdd, setGroupByToAdd] = useState<GroupField | "none">("none");

  const [filterDealName, setFilterDealName] = useState("");
  const [filterDeploymentType, setFilterDeploymentType] = useState("all");
  const [filterAccountId, setFilterAccountId] = useState("");
  const [filterTerritory, setFilterTerritory] = useState("all");
  const [filterCountry, setFilterCountry] = useState("all");
  const [filterIndustry, setFilterIndustry] = useState("all");
  const [filterDealType, setFilterDealType] = useState("all");
  const [currencyDisplay, setCurrencyDisplay] = useState<CurrencyDisplay>("normal");

  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    setData(null);

    const payload: ReportRequest = {
      startDate,
      endDate,
      mode,
      grain,
    };

    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Request failed");
      setData(json);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Unknown error";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  const deploymentTypeOptions = useMemo(() => {
    if (!data) return [];
    const values = new Set<string>();
    for (const r of data.rows || []) {
      const value = String(r.deploymentType || "").trim();
      if (value) values.add(value);
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [data]);

  const territoryOptions = useMemo(() => {
    if (!data) return [];
    const values = new Set<string>();
    for (const r of data.rows || []) {
      const value = String(r.territory || "").trim();
      if (value) values.add(value);
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [data]);

  const countryOptions = useMemo(() => {
    if (!data) return [];
    const values = new Set<string>();
    for (const r of data.rows || []) {
      const value = String(r.country || "").trim();
      if (value) values.add(value);
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [data]);

  const industryOptions = useMemo(() => {
    if (!data) return [];
    const values = new Set<string>();
    for (const r of data.rows || []) {
      const value = String(r.industry || "").trim();
      if (value) values.add(value);
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [data]);

  const dealTypeOptions = useMemo(() => {
    if (!data) return [];
    const values = new Set<string>();
    for (const r of data.rows || []) {
      const value = String(r.dealType || "").trim();
      if (value) values.add(value);
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [data]);

  const displayedRows: UiRow[] = useMemo(() => {
    if (!data) return [];

    const baseRows: UiRow[] = (data.rows || []).map((r: ReportRow) => ({
      dealName: r.dealName || "",
      dealId: r.dealId || "",
      deploymentType: r.deploymentType || "",
      accountId: r.accountId || "",
      territory: r.territory || "",
      country: r.country || "",
      industry: r.industry || "",
      dealType: r.dealType || "",
      groupValues: {},
      valuesByPeriod: r.valuesByPeriod || {},
    }));

    const dealNameNeedle = filterDealName.trim().toLowerCase();
    const accountIdNeedle = filterAccountId.trim().toLowerCase();

    const filteredBaseRows = baseRows.filter((r) => {
      const dealNameOk = !dealNameNeedle || (r.dealName || "").toLowerCase().includes(dealNameNeedle);
      const deploymentTypeOk =
        filterDeploymentType === "all" || (r.deploymentType || "") === filterDeploymentType;
      const accountIdOk = !accountIdNeedle || (r.accountId || "").toLowerCase().includes(accountIdNeedle);
      const territoryOk = filterTerritory === "all" || (r.territory || "") === filterTerritory;
      const countryOk = filterCountry === "all" || (r.country || "") === filterCountry;
      const industryOk = filterIndustry === "all" || (r.industry || "") === filterIndustry;
      const dealTypeOk = filterDealType === "all" || (r.dealType || "") === filterDealType;
      return dealNameOk && deploymentTypeOk && accountIdOk && territoryOk && countryOk && industryOk && dealTypeOk;
    });

    if (groupByFields.length === 0) {
      return filteredBaseRows.filter((r) => hasAnyNonZeroValue(r.valuesByPeriod));
    }

    const map = new Map<string, UiRow>();

    for (const r of filteredBaseRows) {
      const key = groupByFields.map((field) => `${field}:${groupValueForRow(r, field)}`).join("|");

      if (!map.has(key)) {
        const groupValues: Partial<Record<GroupField, string>> = {};
        for (const field of groupByFields) {
          groupValues[field] = groupValueForRow(r, field);
        }

        map.set(key, {
          dealName: r.dealName,
          dealId: r.dealId,
          deploymentType: r.deploymentType,
          accountId: r.accountId,
          territory: r.territory,
          country: r.country,
          industry: r.industry,
          dealType: r.dealType,
          groupValues,
          valuesByPeriod: { ...r.valuesByPeriod },
        });
      } else {
        const agg = map.get(key)!;
        for (const p of Object.keys(r.valuesByPeriod || {})) {
          agg.valuesByPeriod[p] = (agg.valuesByPeriod[p] || 0) + (r.valuesByPeriod[p] || 0);
        }
      }
    }

    for (const agg of map.values()) {
      for (const p of Object.keys(agg.valuesByPeriod)) {
        agg.valuesByPeriod[p] = round2(agg.valuesByPeriod[p] || 0);
      }
    }

    return Array.from(map.values()).filter((r) => hasAnyNonZeroValue(r.valuesByPeriod));
  }, [
    data,
    groupByFields,
    filterDealName,
    filterDeploymentType,
    filterAccountId,
    filterTerritory,
    filterCountry,
    filterIndustry,
    filterDealType,
  ]);

  const totalsByPeriodForDisplayed = useMemo(() => {
    if (!data) return [];
    return data.periods.map((p) => {
      const total = displayedRows.reduce((acc, r) => acc + (r.valuesByPeriod[p.key] || 0), 0);
      return { key: p.key, label: p.label, total: round2(total) };
    });
  }, [data, displayedRows]);

  const showDealIdColumn = groupByFields.length === 0;
  const groupByLabel = groupByFields
    .map((field) => GROUP_BY_OPTIONS.find((opt) => opt.key === field)?.label || field)
    .join(" + ");
  const breakdownHeaders = [
    ...(groupByFields.length === 0
      ? ["Deal name"]
      : groupByFields.map((field) => GROUP_BY_OPTIONS.find((opt) => opt.key === field)?.label || field)),
    ...(showDealIdColumn ? ["Deal ID"] : []),
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
    if (text.includes(",") || text.includes("\"") || text.includes("\n")) {
      return `"${text.replace(/"/g, "\"\"")}"`;
    }
    return text;
  }

  function exportBreakdownCsv() {
    if (!data) return;

    const csvHeaders = breakdownHeaders.map((h) =>
      h !== "Deal name" && h !== "Deal ID" ? `${h}${currencySuffix()}` : h,
    );
    const lines: string[] = [csvHeaders.map(escapeCsvCell).join(",")];

    for (const r of displayedRows) {
      const leadingColumns =
        groupByFields.length === 0
          ? [r.dealName]
          : groupByFields.map((field) => r.groupValues[field] || "(blank)");
      const dealIdCol = showDealIdColumn ? [r.dealId] : [];
      const valueCols = (data.periods || []).map((p) => round2(scaleCurrency(r.valuesByPeriod[p.key] || 0)));
      const row = [...leadingColumns, ...dealIdCol, ...valueCols];
      lines.push(row.map(escapeCsvCell).join(","));
    }

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `arr-breakdown-${stamp}.csv`;
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
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>ARR Report</h1>
      <p style={{ marginTop: 0, color: "#666" }}>
        Select a date range and mode. Top shows totals by period; below is the breakdown.
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
          <label>Mode</label>
          <br />
          <select value={mode} onChange={(e) => setMode(e.target.value as ReportMode)}>
            <option value="arr">ARR</option>
            <option value="contracted">Contracted ARR</option>
          </select>
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
          {loading ? "Running…" : "Run report"}
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
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ color: "#666", fontSize: 12 }}>
                  Rows ({groupByFields.length === 0 ? "line items" : `groups: ${groupByLabel}`})
                </div>
                <div style={{ fontSize: 18 }}>{displayedRows.length}</div>
              </div>
            </div>

            <div style={{ marginTop: 12, display: "flex", gap: 12, flexWrap: "wrap" }}>
              <div>
                <label>Filter Deal Name</label>
                <br />
                <input
                  type="text"
                  value={filterDealName}
                  onChange={(e) => setFilterDealName(e.target.value)}
                  placeholder="contains..."
                />
              </div>

              <div>
                <label>Filter Deployment Type</label>
                <br />
                <select value={filterDeploymentType} onChange={(e) => setFilterDeploymentType(e.target.value)}>
                  <option value="all">All</option>
                  {deploymentTypeOptions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label>Filter Account ID</label>
                <br />
                <input
                  type="text"
                  value={filterAccountId}
                  onChange={(e) => setFilterAccountId(e.target.value)}
                  placeholder="contains..."
                />
              </div>

              <div>
                <label>Filter Territory</label>
                <br />
                <select value={filterTerritory} onChange={(e) => setFilterTerritory(e.target.value)}>
                  <option value="all">All</option>
                  {territoryOptions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label>Filter Country</label>
                <br />
                <select value={filterCountry} onChange={(e) => setFilterCountry(e.target.value)}>
                  <option value="all">All</option>
                  {countryOptions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label>Filter Industry</label>
                <br />
                <select value={filterIndustry} onChange={(e) => setFilterIndustry(e.target.value)}>
                  <option value="all">All</option>
                  {industryOptions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label>Filter Deal Type</label>
                <br />
                <select value={filterDealType} onChange={(e) => setFilterDealType(e.target.value)}>
                  <option value="all">All</option>
                  {dealTypeOptions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
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
            Breakdown {groupByFields.length === 0 ? "(per line item)" : `(grouped by ${groupByLabel})`}
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
                  <tr key={`${r.dealId || r.dealName}-${idx}`} style={{ borderBottom: "1px solid #f2f2f2" }}>
                    {groupByFields.length === 0 ? (
                      <td style={{ padding: 8, whiteSpace: "nowrap" }}>{r.dealName}</td>
                    ) : (
                      groupByFields.map((field) => (
                        <td key={field} style={{ padding: 8, whiteSpace: "nowrap" }}>
                          {r.groupValues[field] || "(blank)"}
                        </td>
                      ))
                    )}
                    {showDealIdColumn && <td style={{ padding: 8, whiteSpace: "nowrap" }}>{r.dealId}</td>}

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
