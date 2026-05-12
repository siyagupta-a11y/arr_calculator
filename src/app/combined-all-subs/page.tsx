"use client";

import Link from "next/link";
import React, { useCallback, useMemo, useState } from "react";

type CombineMode = "grouped" | "simple";
type DisplayMode = "arr" | "plan";
type PlanGrain = "daily" | "monthly";
type CombinedPlan = "enterprise" | "managed" | "team" | "plus" | "pay_as_you_go" | "free";

type CombinedAllSubsRow = {
  id: string;
  source: "hubspot_account" | "stripe_only_customer";
  customerLabel: string;
  accountId: string;
  accountName: string;
  salesAssist: "yes" | "no";
  salesAssistByPeriod?: Record<string, "yes" | "no">;
  stripeKeys: string[];
  matchedStripeKeys: string[];
  hubspotValuesByPeriod: Record<string, number>;
  stripeValuesByPeriod: Record<string, number>;
  valuesByPeriod: Record<string, number>;
  hubspotPlansByPeriod?: Record<string, CombinedPlan>;
  stripePlansByPeriod?: Record<string, CombinedPlan>;
  plansByPeriod?: Record<string, CombinedPlan>;
};

type CombinedAllSubsResponse = {
  startDate: string;
  endDate: string;
  combineMode: CombineMode;
  displayMode: DisplayMode;
  planGrain: PlanGrain;
  targetCurrency: string;
  warnings?: string[];
  periods: Array<{ key: string; label: string }>;
  totalsByPeriod: Array<{ key: string; label: string; total: number }>;
  rows: CombinedAllSubsRow[];
  summary: {
    hubspotAccounts: number;
    hubspotAccountsWithStripeMatch: number;
    stripeCustomers: number;
    stripeCustomersMatched: number;
    stripeCustomersOnly: number;
  };
};

function defaultDateRange() {
  const end = new Date();
  const start = new Date(end.getFullYear(), end.getMonth(), 1);
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

function latestPeriodKey(data: CombinedAllSubsResponse | null) {
  if (!data?.periods?.length) return "";
  return String(data.periods[data.periods.length - 1].key || "");
}

function hasRunResult(data: CombinedAllSubsResponse | null) {
  return !!data && Array.isArray(data.periods) && data.periods.length > 0;
}

function formatPlanLabel(value: string) {
  const key = String(value || "free").trim().toLowerCase();
  if (key === "pay_as_you_go") return "Pay as you go";
  if (!key) return "Free";
  return key
    .split("_")
    .map((part) => (part ? `${part[0].toUpperCase()}${part.slice(1)}` : part))
    .join(" ");
}

function csvEscape(value: string | number | boolean | null | undefined) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function downloadCsv(filename: string, rows: Array<Array<string | number | boolean | null | undefined>>) {
  const lines = rows.map((row) => row.map((cell) => csvEscape(cell)).join(","));
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function csvTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export default function CombinedAllSubsPage() {
  const defaults = useMemo(() => defaultDateRange(), []);

  const [startDate, setStartDate] = useState(defaults.startDate);
  const [endDate, setEndDate] = useState(defaults.endDate);
  const [combineMode, setCombineMode] = useState<CombineMode>("simple");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("arr");
  const [planGrain, setPlanGrain] = useState<PlanGrain>("monthly");

  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<CombinedAllSubsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/combined-all-subs-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate, endDate, combineMode, displayMode, planGrain }),
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
      setData(json as CombinedAllSubsResponse);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [combineMode, displayMode, endDate, planGrain, startDate]);

  const currency = data?.targetCurrency || "USD";
  const effectiveCombineMode = data?.combineMode || combineMode;
  const effectiveDisplayMode = data?.displayMode || displayMode;
  const effectivePlanGrain = data?.planGrain || planGrain;
  const lastKey = latestPeriodKey(data);

  function exportSummaryCsv() {
    if (!data) return;
    if (effectiveDisplayMode === "plan") {
      const rows: Array<Array<string | number>> = [
        [
          "id",
          "source",
          "customer_label",
          "account_id",
          "account_name",
          "sales_assist",
          "matched_stripe_keys",
          "latest_hubspot_plan",
          "latest_stripe_plan",
          "latest_combined_plan",
        ],
        ...data.rows.map((row) => [
          row.id,
          row.source,
          row.customerLabel,
          row.accountId,
          row.accountName,
          row.salesAssist,
          row.matchedStripeKeys.join(" | "),
          formatPlanLabel(row.hubspotPlansByPeriod?.[lastKey] || "free"),
          formatPlanLabel(row.stripePlansByPeriod?.[lastKey] || "free"),
          formatPlanLabel(row.plansByPeriod?.[lastKey] || "free"),
        ]),
      ];
      downloadCsv(`combined-all-subs-summary-plan-${effectiveCombineMode}-${csvTimestamp()}.csv`, rows);
      return;
    }

    const rows: Array<Array<string | number>> = [
      [
        "id",
        "source",
        "customer_label",
        "account_id",
        "account_name",
        "sales_assist",
        "matched_stripe_keys",
        "hubspot_latest_arr",
        "stripe_latest_arr",
        "combined_latest_arr",
      ],
      ...data.rows.map((row) => [
        row.id,
        row.source,
        row.customerLabel,
        row.accountId,
        row.accountName,
        row.salesAssist,
        row.matchedStripeKeys.join(" | "),
        Number(row.hubspotValuesByPeriod[lastKey] || 0),
        Number(row.stripeValuesByPeriod[lastKey] || 0),
        Number(row.valuesByPeriod[lastKey] || 0),
      ]),
    ];
    downloadCsv(`combined-all-subs-summary-arr-${effectiveCombineMode}-${csvTimestamp()}.csv`, rows);
  }

  function exportFullCsv() {
    if (!data) return;
    if (effectiveDisplayMode === "plan") {
      const header: Array<string> = [
        "id",
        "source",
        "customer_label",
        "account_id",
        "account_name",
        "sales_assist",
        "stripe_keys",
        "matched_stripe_keys",
      ];
      for (const period of data.periods) {
        header.push(`sales_assist_${period.key}`);
        header.push(`hubspot_plan_${period.key}`);
        header.push(`stripe_plan_${period.key}`);
        header.push(`combined_plan_${period.key}`);
      }
      const rows: Array<Array<string | number>> = [header];
      for (const row of data.rows) {
        const cells: Array<string | number> = [
          row.id,
          row.source,
          row.customerLabel,
          row.accountId,
          row.accountName,
          row.salesAssist,
          row.stripeKeys.join(" | "),
          row.matchedStripeKeys.join(" | "),
        ];
        for (const period of data.periods) {
          cells.push(row.salesAssistByPeriod?.[period.key] || "no");
          cells.push(formatPlanLabel(row.hubspotPlansByPeriod?.[period.key] || "free"));
          cells.push(formatPlanLabel(row.stripePlansByPeriod?.[period.key] || "free"));
          cells.push(formatPlanLabel(row.plansByPeriod?.[period.key] || "free"));
        }
        rows.push(cells);
      }
      downloadCsv(`combined-all-subs-full-plan-${effectiveCombineMode}-${effectivePlanGrain}-${csvTimestamp()}.csv`, rows);
      return;
    }

    const header: Array<string> = [
      "id",
      "source",
      "customer_label",
      "account_id",
      "account_name",
      "sales_assist",
      "stripe_keys",
      "matched_stripe_keys",
    ];
    for (const period of data.periods) {
      header.push(`sales_assist_${period.key}`);
      header.push(`hubspot_arr_${period.key}`);
      header.push(`stripe_arr_${period.key}`);
      header.push(`combined_arr_${period.key}`);
    }

    const rows: Array<Array<string | number>> = [header];
    for (const row of data.rows) {
      const cells: Array<string | number> = [
        row.id,
        row.source,
        row.customerLabel,
        row.accountId,
        row.accountName,
        row.salesAssist,
        row.stripeKeys.join(" | "),
        row.matchedStripeKeys.join(" | "),
      ];
      for (const period of data.periods) {
        cells.push(row.salesAssistByPeriod?.[period.key] || "no");
        cells.push(Number(row.hubspotValuesByPeriod[period.key] || 0));
        cells.push(Number(row.stripeValuesByPeriod[period.key] || 0));
        cells.push(Number(row.valuesByPeriod[period.key] || 0));
      }
      rows.push(cells);
    }

    downloadCsv(`combined-all-subs-full-arr-${effectiveCombineMode}-${csvTimestamp()}.csv`, rows);
  }

  function exportCombinedOnlyCsv() {
    if (!data) return;
    if (effectiveDisplayMode === "plan") {
      const header: Array<string> = [
        "id",
      "source",
      "customer_label",
      "account_id",
      "account_name",
      "sales_assist",
    ];
    for (const period of data.periods) {
      header.push(`sales_assist_${period.key}`);
      header.push(`combined_plan_${period.key}`);
    }

      const rows: Array<Array<string | number>> = [header];
      for (const row of data.rows) {
        const cells: Array<string | number> = [
          row.id,
          row.source,
          row.customerLabel,
          row.accountId,
          row.accountName,
          row.salesAssist,
        ];
        for (const period of data.periods) {
          cells.push(row.salesAssistByPeriod?.[period.key] || "no");
          cells.push(formatPlanLabel(row.plansByPeriod?.[period.key] || "free"));
        }
        rows.push(cells);
      }

      downloadCsv(
        `combined-all-subs-combined-only-plan-${effectiveCombineMode}-${effectivePlanGrain}-${csvTimestamp()}.csv`,
        rows,
      );
      return;
    }

    const header: Array<string> = [
      "id",
      "source",
      "customer_label",
      "account_id",
      "account_name",
      "sales_assist",
    ];
    for (const period of data.periods) {
      header.push(`sales_assist_${period.key}`);
      header.push(`combined_arr_${period.key}`);
    }

    const rows: Array<Array<string | number>> = [header];
    for (const row of data.rows) {
      const cells: Array<string | number> = [
        row.id,
        row.source,
        row.customerLabel,
        row.accountId,
        row.accountName,
        row.salesAssist,
      ];
      for (const period of data.periods) {
        cells.push(row.salesAssistByPeriod?.[period.key] || "no");
        cells.push(Number(row.valuesByPeriod[period.key] || 0));
      }
      rows.push(cells);
    }

    downloadCsv(`combined-all-subs-combined-only-arr-${effectiveCombineMode}-${csvTimestamp()}.csv`, rows);
  }

  return (
    <div className="stripe-ui">
      <section className="stripe-ui__hero ui-reveal">
        <div className="stripe-ui__eyebrow">Revenue intelligence</div>
        <div className="stripe-ui__hero-row">
          <div>
            <h1 className="stripe-ui__title">Combined All Subs</h1>
            <p className="stripe-ui__subtitle">
              Compare two views of the same dataset: Grouped mode matches Stripe customers to HubSpot accounts via
              associated contact emails, while Simple mode just appends HubSpot and Stripe rows without matching.
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <Link href="/combined-billing-overview" className="stripe-ui__hero-link">
              Open Combined Billing Overview
            </Link>
            <Link href="/hubspot" className="stripe-ui__hero-link">
              Open HubSpot report
            </Link>
            <Link href="/stripe-through-mrr" className="stripe-ui__hero-link">
              Open Stripe through MRR
            </Link>
            <Link href="/tofu" className="stripe-ui__hero-link">
              Open TOFU
            </Link>
            <Link href="/ndr-gdr" className="stripe-ui__hero-link">
              Open NDR/GDR
            </Link>
            <Link href="/model-update" className="stripe-ui__hero-link">
              Open Model Update
            </Link>
            <Link href="/salesled" className="stripe-ui__hero-link">
              Open Sales-led
            </Link>
            <Link href="/selfserve" className="stripe-ui__hero-link">
              Open Self Serve
            </Link>
            <Link href="/access-control" className="stripe-ui__hero-link">
              Open Access Control
            </Link>
          </div>
        </div>
      </section>

      <section className="stripe-ui__panel ui-reveal ui-reveal-1">
        <h2 className="stripe-ui__panel-title">Report controls</h2>
        <p className="stripe-ui__panel-subtitle">
          Pick date range and combine mode, then choose whether to display ARR or Plan by period.
        </p>
        <div className="stripe-ui__control-grid" style={{ gridTemplateColumns: "repeat(6, minmax(180px, 1fr))" }}>
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="combined-all-subs-start-date">
              Start date
            </label>
            <input
              id="combined-all-subs-start-date"
              className="stripe-ui__control"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="combined-all-subs-end-date">
              End date
            </label>
            <input
              id="combined-all-subs-end-date"
              className="stripe-ui__control"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="combined-all-subs-combine-mode">
              Combine mode
            </label>
            <select
              id="combined-all-subs-combine-mode"
              className="stripe-ui__control"
              value={combineMode}
              onChange={(e) => setCombineMode(e.target.value as CombineMode)}
            >
              <option value="grouped">Grouped (match HubSpot contact emails to Stripe emails)</option>
              <option value="simple">Simple (no matching; append HubSpot + Stripe)</option>
            </select>
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="combined-all-subs-display-mode">
              Display mode
            </label>
            <select
              id="combined-all-subs-display-mode"
              className="stripe-ui__control"
              value={displayMode}
              onChange={(e) => setDisplayMode(e.target.value as DisplayMode)}
            >
              <option value="arr">ARR</option>
              <option value="plan">Plan</option>
            </select>
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="combined-all-subs-plan-grain">
              Time grain
            </label>
            <select
              id="combined-all-subs-plan-grain"
              className="stripe-ui__control"
              value={planGrain}
              onChange={(e) => setPlanGrain(e.target.value as PlanGrain)}
            >
              <option value="monthly">Monthly</option>
              <option value="daily">Daily</option>
            </select>
          </div>

          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="combined-all-subs-run-btn">
              Run report
            </label>
            <button
              id="combined-all-subs-run-btn"
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
          <p className="stripe-ui__panel-subtitle">
            {displayMode === "plan"
              ? `Combining HubSpot accounts with Stripe customer plans (${planGrain}).`
              : `Combining HubSpot accounts with Stripe customer ARR (${planGrain}).`}
          </p>
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

      {!loading && !error && data?.warnings && data.warnings.length > 0 && (
        <section className="stripe-ui__panel ui-reveal ui-reveal-1">
          <h2 className="stripe-ui__panel-title">Warnings</h2>
          <div className="stripe-ui__panel-subtitle">
            {data.warnings.map((warning, idx) => (
              <div key={`warning:${idx}`}>{warning}</div>
            ))}
          </div>
        </section>
      )}

      {!loading && !error && hasRunResult(data) && (
        <>
          <section className="stripe-ui__panel ui-reveal ui-reveal-2">
            <div className="stripe-ui__stats">
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">HubSpot accounts (cloud)</p>
                <p className="stripe-ui__stat-value">{data?.summary.hubspotAccounts || 0}</p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">
                  {effectiveCombineMode === "grouped" ? "Accounts with Stripe match" : "Matching mode"}
                </p>
                <p className="stripe-ui__stat-value">
                  {effectiveCombineMode === "grouped"
                    ? data?.summary.hubspotAccountsWithStripeMatch || 0
                    : "Simple (off)"}
                </p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Stripe-only customers</p>
                <p className="stripe-ui__stat-value">{data?.summary.stripeCustomersOnly || 0}</p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">
                  {effectiveDisplayMode === "plan" ? "Latest paid customers" : "Latest total ARR"}
                </p>
                <p className="stripe-ui__stat-value">
                  {effectiveDisplayMode === "plan"
                    ? Number(data?.totalsByPeriod.find((total) => total.key === lastKey)?.total || 0)
                    : formatMoney(
                        Number(data?.totalsByPeriod.find((total) => total.key === lastKey)?.total || 0),
                        currency,
                      )}
                </p>
              </div>
            </div>
          </section>

          <section className="stripe-ui__panel ui-reveal ui-reveal-3">
            <div className="stripe-ui__section-head">
              <div>
                <h2 className="stripe-ui__panel-title">
                  {effectiveDisplayMode === "plan" ? "Plan breakdown by customer" : "ARR breakdown by customer"}
                </h2>
                <p className="stripe-ui__panel-subtitle" style={{ marginBottom: 0 }}>
                  Includes all HubSpot cloud accounts plus Stripe customers not matched to any HubSpot account contact.
                  {` Time grain: ${effectivePlanGrain}.`}
                </p>
              </div>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <button className="stripe-ui__btn stripe-ui__btn--secondary" onClick={exportCombinedOnlyCsv}>
                  Export Combined-Only CSV
                </button>
                <button className="stripe-ui__btn stripe-ui__btn--secondary" onClick={exportSummaryCsv}>
                  Export Summary CSV
                </button>
                <button className="stripe-ui__btn stripe-ui__btn--secondary" onClick={exportFullCsv}>
                  Export Full CSV
                </button>
              </div>
            </div>

            <div className="stripe-ui__table-wrap" style={{ marginTop: "0.9rem" }}>
              <table className="stripe-ui__table" aria-label="Combined all subscriptions table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Source</th>
                    <th>Sales assist</th>
                    <th>Matched Stripe Emails</th>
                    {data?.periods.map((period) => (
                      <th key={period.key} className={effectiveDisplayMode === "arr" ? "stripe-ui__num" : ""}>
                        {period.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data?.rows.map((row) => {
                    return (
                      <tr key={row.id}>
                        <td>{row.customerLabel}</td>
                        <td>{row.source === "hubspot_account" ? "HubSpot account" : "Stripe only"}</td>
                        <td>{row.salesAssist}</td>
                        <td>
                          {row.matchedStripeKeys.length > 0
                            ? row.matchedStripeKeys.join(", ")
                            : row.source === "stripe_only_customer"
                              ? row.stripeKeys.join(", ")
                              : "-"}
                        </td>
                        {effectiveDisplayMode === "arr" ? (
                          <>
                            {data?.periods.map((period) => (
                              <td key={`${row.id}:${period.key}`} className="stripe-ui__num">
                                {formatMoney(Number(row.valuesByPeriod[period.key] || 0), currency)}
                              </td>
                            ))}
                          </>
                        ) : (
                          <>
                            {data?.periods.map((period) => (
                              <td key={`${row.id}:${period.key}`}>{formatPlanLabel(row.plansByPeriod?.[period.key] || "free")}</td>
                            ))}
                          </>
                        )}
                      </tr>
                    );
                  })}
                  <tr>
                    {effectiveDisplayMode === "arr" ? (
                      <>
                        <td style={{ fontWeight: 700 }}>Totals</td>
                        <td colSpan={3} />
                        {data?.periods.map((period) => (
                          <td key={`totals:${period.key}`} className="stripe-ui__num" style={{ fontWeight: 700 }}>
                            {formatMoney(
                              Number(data?.totalsByPeriod.find((total) => total.key === period.key)?.total || 0),
                              currency,
                            )}
                          </td>
                        ))}
                      </>
                    ) : (
                      <>
                        <td style={{ fontWeight: 700 }}>Paid customer count</td>
                        <td colSpan={3} />
                        {data?.periods.map((period) => (
                          <td key={`totals:${period.key}`} style={{ fontWeight: 700 }}>
                            {Number(data?.totalsByPeriod.find((total) => total.key === period.key)?.total || 0)}
                          </td>
                        ))}
                      </>
                    )}
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
