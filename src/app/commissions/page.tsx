"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import type { CommissionDealRow, CommissionReportResponse } from "@/lib/commissionsReport";

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function formatMoney(value: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(value || 0));
  } catch {
    return Number(value || 0).toFixed(2);
  }
}

function statusLabel(row: CommissionDealRow) {
  if (row.status === "clawback") return `${row.clawbackType === "downgrade" ? "Downgrade" : "Churn"} clawback`;
  if (row.status === "protected") return "3-month payment cleared";
  if (row.status === "unmapped") return "Stripe mapping missing";
  if (row.status === "ineligible") return "Frequency ineligible";
  return "Monitoring first 3 months";
}

function statusColor(row: CommissionDealRow) {
  if (row.status === "clawback") return "#b91c1c";
  if (row.status === "protected") return "#166534";
  if (row.status === "unmapped" || row.status === "ineligible") return "#92400e";
  return "#1d4ed8";
}

export default function CommissionsPage() {
  const initialMonth = useMemo(currentMonth, []);
  const [month, setMonth] = useState(initialMonth);
  const [data, setData] = useState<CommissionReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const run = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/commissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, targetCurrency: "USD" }),
      });
      const text = await response.text();
      const payload = text ? (JSON.parse(text) as CommissionReportResponse & { error?: string }) : null;
      if (!response.ok) throw new Error(payload?.error || text || `HTTP ${response.status}`);
      if (!payload) throw new Error("Empty commissions response");
      setData(payload);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load commissions");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [month]);

  const currency = data?.targetCurrency || "USD";

  return (
    <div className="stripe-ui">
      <section className="stripe-ui__hero ui-reveal">
        <div className="stripe-ui__eyebrow">Admin · Sales compensation</div>
        <div className="stripe-ui__hero-row">
          <div>
            <h1 className="stripe-ui__title">Commissions</h1>
            <p className="stripe-ui__subtitle">
              Closed-won New Business and approved-rep Existing Business by deal owner, with Stripe payment-based
              churn and downgrade clawbacks.
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <Link href="/combined-all-subs" className="stripe-ui__hero-link">
              Open Combined All Subs
            </Link>
            <Link href="/hubspot" className="stripe-ui__hero-link">
              Open HubSpot report
            </Link>
          </div>
        </div>
      </section>

      <section className="stripe-ui__panel ui-reveal ui-reveal-1">
        <h2 className="stripe-ui__panel-title">Report month</h2>
        <p className="stripe-ui__panel-subtitle">
          Gross commissions are booked in the deal close month. Clawbacks appear only in the Stripe churn or downgrade
          month, including adjustments to deals closed in an earlier month.
        </p>
        <div style={{ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap" }}>
          <div className="stripe-ui__field" style={{ minWidth: 220 }}>
            <label className="stripe-ui__field-label" htmlFor="commissions-month">
              Month
            </label>
            <input
              id="commissions-month"
              className="stripe-ui__control"
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
            />
          </div>
          <button className="stripe-ui__btn stripe-ui__btn--primary" type="button" onClick={() => void run()} disabled={loading || !month}>
            {loading ? "Calculating…" : "Load commissions"}
          </button>
        </div>
        {error ? (
          <p style={{ color: "#b91c1c", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 12px" }}>
            {error}
          </p>
        ) : null}
      </section>

      {data ? (
        <>
          <section className="stripe-ui__panel ui-reveal ui-reveal-2">
            <h2 className="stripe-ui__panel-title">{data.monthLabel} summary</h2>
            <div className="stripe-ui__stats" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
              <article className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Deal owners</p>
                <p className="stripe-ui__stat-value">{data.totals.ownerCount}</p>
              </article>
              <article className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Commissioned deals</p>
                <p className="stripe-ui__stat-value">{data.totals.dealCount}</p>
              </article>
              <article className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Commissioned deal amount</p>
                <p className="stripe-ui__stat-value">{formatMoney(data.totals.dealAmount, currency)}</p>
              </article>
              <article className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Gross commission</p>
                <p className="stripe-ui__stat-value">{formatMoney(data.totals.grossCommission, currency)}</p>
              </article>
              <article className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Clawbacks</p>
                <p className="stripe-ui__stat-value" style={{ color: data.totals.clawback > 0 ? "#b91c1c" : undefined }}>
                  {formatMoney(data.totals.clawback, currency)}
                </p>
              </article>
              <article className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Net commission</p>
                <p className="stripe-ui__stat-value">{formatMoney(data.totals.netCommission, currency)}</p>
              </article>
            </div>
            {data.warnings.length ? (
              <div style={{ marginTop: 16, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "10px 12px" }}>
                {data.warnings.map((warning) => <div key={warning}>{warning}</div>)}
              </div>
            ) : null}
          </section>

          {data.owners.length ? data.owners.map((owner) => (
            <section className="stripe-ui__panel ui-reveal" key={owner.ownerId || "unassigned"}>
              <div className="stripe-ui__hero-row" style={{ alignItems: "end" }}>
                <div>
                  <h2 className="stripe-ui__panel-title">{owner.ownerName}</h2>
                  <p className="stripe-ui__panel-subtitle">
                    {owner.dealCount} commissioned deal{owner.dealCount === 1 ? "" : "s"} · Net {formatMoney(owner.netCommission, currency)}
                  </p>
                </div>
                <div style={{ color: "#475569", textAlign: "right" }}>
                  Gross {formatMoney(owner.grossCommission, currency)} · Clawback {formatMoney(owner.clawback, currency)}
                </div>
              </div>
              <div className="stripe-ui__table-wrap">
                <table className="stripe-ui__table">
                  <thead>
                    <tr>
                      <th>Deal</th>
                      <th>Close / pipeline</th>
                      <th>Workspace</th>
                      <th>Frequency</th>
                      <th>Deal amount</th>
                      <th>Gross</th>
                      <th>Stripe plan paid (net)</th>
                      <th>Clawback</th>
                      <th>Net</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {owner.deals.map((deal) => (
                      <tr key={deal.dealId}>
                        <td>
                          <a href={deal.hubspotUrl} target="_blank" rel="noreferrer" style={{ fontWeight: 700 }}>
                            {deal.dealName}
                          </a>
                          <div style={{ color: "#64748b", fontSize: 12 }}>#{deal.dealId}</div>
                        </td>
                        <td>
                          <div>{deal.closeDate}</div>
                          <div style={{ color: "#64748b", fontSize: 12 }}>{deal.pipelineName}</div>
                          <div style={{ color: "#64748b", fontSize: 12 }}>{deal.dealType}</div>
                        </td>
                        <td style={{ maxWidth: 210, overflowWrap: "anywhere" }}>
                          {deal.workspaceId || "—"}
                          {deal.stripeCustomerIds.length ? (
                            <div style={{ color: "#64748b", fontSize: 12 }}>{deal.stripeCustomerIds.join(", ")}</div>
                          ) : null}
                        </td>
                        <td>
                          <div style={{ textTransform: "capitalize" }}>{deal.paymentFrequency}</div>
                          <div style={{ color: "#64748b", fontSize: 12 }}>{deal.commissionRatePct}% · {deal.termMonths} mo.</div>
                        </td>
                        <td>
                          {formatMoney(deal.dealAmount, currency)}
                          {deal.dealCurrency !== currency ? (
                            <div style={{ color: "#64748b", fontSize: 12 }}>
                              {formatMoney(deal.dealAmountOriginal, deal.dealCurrency)} source
                            </div>
                          ) : null}
                        </td>
                        <td>{formatMoney(deal.grossCommission, currency)}</td>
                        <td>
                          {formatMoney(deal.paidAmount, currency)}
                          <div style={{ color: "#64748b", fontSize: 12 }}>
                            3-mo target {formatMoney(deal.protectedAmount, currency)}
                          </div>
                          {deal.proratedOpeningPaymentAmount > 0 ? (
                            <div style={{ color: "#92400e", fontSize: 12 }}>
                              Opening proration {formatMoney(deal.proratedOpeningPaymentAmount, currency)} excluded from target · Clock starts {deal.monitoringStart}
                            </div>
                          ) : null}
                        </td>
                        <td style={{ color: deal.clawback > 0 ? "#b91c1c" : undefined }}>
                          {formatMoney(deal.clawback, currency)}
                          {deal.clawbackEventDate ? (
                            <div style={{ fontSize: 12 }}>{deal.clawbackEventDate}</div>
                          ) : null}
                        </td>
                        <td style={{ fontWeight: 700 }}>{formatMoney(deal.netCommission, currency)}</td>
                        <td style={{ minWidth: 170 }}>
                          <span style={{ color: statusColor(deal), fontWeight: 700 }}>{statusLabel(deal)}</span>
                          {deal.fullyProtectedAt ? (
                            <div style={{ color: "#64748b", fontSize: 12 }}>Paid through {deal.fullyProtectedAt}</div>
                          ) : null}
                          {deal.notes.map((note) => (
                            <div key={note} style={{ color: "#92400e", fontSize: 12 }}>{note}</div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )) : (
            <section className="stripe-ui__panel ui-reveal">
              <h2 className="stripe-ui__panel-title">No commission activity</h2>
              <p className="stripe-ui__panel-subtitle">No new commissions or one-time clawbacks were found for {data.monthLabel}.</p>
            </section>
          )}

          <section className="stripe-ui__panel ui-reveal">
            <h2 className="stripe-ui__panel-title">Methodology</h2>
            <p className="stripe-ui__panel-subtitle">{data.methodology.clawbackRule}</p>
            <p style={{ color: "#475569", marginBottom: 0 }}>
              HubSpot: {data.methodology.includedPipelines.join(" + ")} · Deal types: {data.methodology.dealTypes.join(" + ")} ({data.methodology.existingBusinessOwners.join(", ")}) · Rates: monthly 8%, quarterly 10%, annual 11%.{" "}
              Stripe source: {data.methodology.paymentSource}.
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}
