"use client";

import Link from "next/link";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { GtmMetric, GtmReportResponse } from "@/lib/gtmReport";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function monthEnd(monthKey: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return todayIso();
  return new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).toISOString().slice(0, 10);
}

function defaultControls() {
  const today = todayIso();
  return { monthKey: today.slice(0, 7), asOfDate: today };
}

function formatMoney(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: 0,
  }).format(value || 0);
}

function formatNumber(value: number, digits = 0) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value || 0);
}

function formatMetricValue(metric: Pick<GtmMetric, "format" | "value">, currency: string) {
  if (metric.value == null) return "—";
  if (metric.format === "currency") return formatMoney(metric.value, currency);
  if (metric.format === "percent") return `${formatNumber(metric.value * 100, 1)}%`;
  if (metric.format === "multiple") return `${formatNumber(metric.value, 2)}×`;
  return formatNumber(metric.value, 0);
}

function formatByFormat(value: number | null, format: GtmMetric["format"], currency: string) {
  return formatMetricValue({ value, format }, currency);
}

function parseJson(text: string, status: number, label: string) {
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    throw new Error(`${label} returned a non-JSON response (${status}).`);
  }
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export default function GtmPage() {
  const initial = defaultControls();
  const [monthKey, setMonthKey] = useState(initial.monthKey);
  const [asOfDate, setAsOfDate] = useState(initial.asOfDate);
  const [data, setData] = useState<GtmReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const gtmResponse = await fetch("/api/gtm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthKey, asOfDate }),
      });
      const gtmText = await gtmResponse.text();
      const gtmPayload = parseJson(gtmText, gtmResponse.status, "GTM report");
      if (!gtmResponse.ok) {
        const message = gtmPayload && typeof gtmPayload === "object" && "error" in gtmPayload
          ? String((gtmPayload as { error?: unknown }).error || "GTM report failed")
          : `GTM report failed (${gtmResponse.status})`;
        throw new Error(message);
      }
      setData(gtmPayload as GtmReportResponse);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load GTM report");
    } finally {
      setLoading(false);
    }
  }, [asOfDate, monthKey]);

  useEffect(() => {
    void run();
  }, [run]);

  const metrics = useMemo(() => data?.metrics || [], [data]);

  const sections = useMemo(() => {
    const bySection = new Map<string, GtmMetric[]>();
    for (const metric of metrics) {
      const rows = bySection.get(metric.section) || [];
      rows.push(metric);
      bySection.set(metric.section, rows);
    }
    return Array.from(bySection.entries());
  }, [metrics]);

  const headline = metrics.find((metric) => metric.id === "net_new_arr");
  const pipelineCoverage = metrics.find((metric) => metric.id === "pipeline_coverage");
  const newBusiness = data?.arrBridge.reduce((total, row) => row.segment === "total" ? total : total + row.newArr, 0) || 0;
  const endingArr = data?.arrBridge.find((row) => row.segment === "total")?.endingArr || 0;
  const statusCounts = metrics.reduce((counts, metric) => {
    counts[metric.status] = (counts[metric.status] || 0) + 1;
    return counts;
  }, {} as Record<string, number>);

  function updateMonth(nextMonth: string) {
    setMonthKey(nextMonth);
    const start = `${nextMonth}-01`;
    const end = monthEnd(nextMonth);
    const today = todayIso();
    setAsOfDate(today < start ? start : today > end ? end : today);
  }

  function downloadCsv() {
    if (!data) return;
    const header = ["Section", "Metric", "Owner", "Actual", "Prior month", "Paced target", "Monthly target", "Achievement", "Status", "Source", "Note"];
    const rows = metrics.map((metric) => [
      metric.section,
      metric.label,
      metric.owner,
      metric.value ?? "",
      metric.priorValue ?? "",
      metric.pacedTarget ?? "",
      metric.target ?? "",
      metric.achievement ?? "",
      metric.status,
      metric.source,
      metric.note || "",
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `gtm-scorecard-${data.monthKey}-${data.asOfDate}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="stripe-ui gtm">
      <section className="stripe-ui__hero ui-reveal">
        <div className="stripe-ui__eyebrow">Go-to-market operating system</div>
        <div className="stripe-ui__hero-row">
          <div>
            <h1 className="stripe-ui__title">GTM</h1>
            <p className="stripe-ui__subtitle">
              Automated scorecard using the HubSpot and Stripe data replicated in BigQuery, plus the FY27 Targets tab.
            </p>
          </div>
          <div className="gtm__hero-links">
            <Link href="/combined-all-subs" className="stripe-ui__hero-link">Combined All Subs</Link>
            <Link href="/tofu" className="stripe-ui__hero-link">ARR detail</Link>
            <button className="stripe-ui__hero-link gtm__link-button" type="button" onClick={downloadCsv} disabled={!data}>Download CSV</button>
          </div>
        </div>
      </section>

      <section className="stripe-ui__panel ui-reveal ui-reveal-1">
        <div className="stripe-ui__section-head">
          <div>
            <h2 className="stripe-ui__panel-title">Reporting period</h2>
            <p className="stripe-ui__panel-subtitle">Targets are never read from weekly tabs. They come only from the workbook’s Targets tab.</p>
          </div>
        </div>
        <div className="stripe-ui__control-grid gtm__controls">
          <label className="stripe-ui__field">
            <span className="stripe-ui__field-label">Month</span>
            <input className="stripe-ui__control" type="month" min="2026-04" max="2027-03" value={monthKey} onChange={(event) => updateMonth(event.target.value)} />
          </label>
          <label className="stripe-ui__field">
            <span className="stripe-ui__field-label">CRM actuals through</span>
            <input className="stripe-ui__control" type="date" min={`${monthKey}-01`} max={monthEnd(monthKey)} value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} />
          </label>
          <div className="stripe-ui__actions gtm__load-action">
            <button type="button" className="stripe-ui__btn stripe-ui__btn--primary" onClick={() => void run()} disabled={loading}>{loading ? "Loading…" : "Refresh scorecard"}</button>
          </div>
        </div>
        {data ? <p className="gtm__pacing-note">{data.businessDays.elapsed} of {data.businessDays.total} business days elapsed. Flow targets are paced to that share of the month; the ARR bridge uses the latest monthly BigQuery snapshot.</p> : null}
      </section>

      {error ? <section className="stripe-ui__panel"><div className="stripe-ui__error">{error}</div></section> : null}
      {loading && !data ? <section className="stripe-ui__panel stripe-ui__loading-panel" aria-busy="true">Building the GTM scorecard…</section> : null}

      {data ? (
        <>
          <section className="gtm__summary ui-reveal ui-reveal-2">
            <article className="gtm__summary-card gtm__summary-card--primary">
              <span>Net New ARR</span>
              <strong>{headline ? formatMetricValue(headline, data.targetCurrency) : "—"}</strong>
              <small>{headline?.target != null ? `${formatNumber((headline.achievement || 0) * 100, 1)}% of ${formatMoney(headline.target, data.targetCurrency)} target` : "No target"}</small>
            </article>
            <article className="gtm__summary-card">
              <span>New business ARR</span><strong>{formatMoney(newBusiness, data.targetCurrency)}</strong><small>All live motions</small>
            </article>
            <article className="gtm__summary-card">
              <span>Ending ARR</span><strong>{formatMoney(endingArr, data.targetCurrency)}</strong><small>As of {data.asOfDate}</small>
            </article>
            <article className="gtm__summary-card">
              <span>Pipeline coverage</span><strong>{pipelineCoverage ? formatMetricValue(pipelineCoverage, data.targetCurrency) : "—"}</strong><small>Targets-tab required: {pipelineCoverage?.target != null ? `${formatNumber(pipelineCoverage.target, 2)}×` : "—"}</small>
            </article>
            <article className="gtm__summary-card">
              <span>RAG summary</span><strong>{statusCounts.green || 0} green · {statusCounts.yellow || 0} yellow · {statusCounts.red || 0} red</strong><small>{statusCounts.unavailable || 0} source gaps shown below</small>
            </article>
          </section>

          <section className="stripe-ui__panel ui-reveal ui-reveal-2">
            <h2 className="stripe-ui__panel-title">ARR by motion</h2>
            <p className="stripe-ui__panel-subtitle">The bridge reads the combined CARR-by-motion model in BigQuery. No live HubSpot API call is made.</p>
            <div className="stripe-ui__table-wrap">
              <table className="stripe-ui__table gtm__table">
                <thead><tr><th>Motion</th><th className="stripe-ui__num">Beginning ARR</th><th className="stripe-ui__num">New</th><th className="stripe-ui__num">Expansion</th><th className="stripe-ui__num">Contraction</th><th className="stripe-ui__num">Churn</th><th className="stripe-ui__num">Ending ARR</th><th className="stripe-ui__num">Net New ARR</th></tr></thead>
                <tbody>{data.arrBridge.map((row) => <tr key={row.segment} className={row.segment === "total" ? "gtm__total-row" : ""}><td>{row.label}</td><td className="stripe-ui__num">{formatMoney(row.beginningArr, data.targetCurrency)}</td><td className="stripe-ui__num">{formatMoney(row.newArr, data.targetCurrency)}</td><td className="stripe-ui__num">{formatMoney(row.expansionArr, data.targetCurrency)}</td><td className="stripe-ui__num">{formatMoney(row.contractionArr, data.targetCurrency)}</td><td className="stripe-ui__num">{formatMoney(row.churnArr, data.targetCurrency)}</td><td className="stripe-ui__num">{formatMoney(row.endingArr, data.targetCurrency)}</td><td className="stripe-ui__num">{formatMoney(row.netNewArr, data.targetCurrency)}</td></tr>)}</tbody>
              </table>
            </div>
          </section>

          {data.workbookComparison.length ? (
            <section className="stripe-ui__panel gtm__comparison ui-reveal ui-reveal-3">
              <h2 className="stripe-ui__panel-title">August workbook sanity check</h2>
              <p className="stripe-ui__panel-subtitle">Automated August values compared with the monthly workbook tab. A match allows a 0.5% tolerance.</p>
              <div className="stripe-ui__table-wrap"><table className="stripe-ui__table gtm__table"><thead><tr><th>Metric</th><th className="stripe-ui__num">Workbook</th><th className="stripe-ui__num">Automated</th><th className="stripe-ui__num">Variance</th><th>Check</th></tr></thead><tbody>{data.workbookComparison.map((row) => <tr key={row.id}><td>{row.label}</td><td className="stripe-ui__num">{formatMoney(row.workbookValue, data.targetCurrency)}</td><td className="stripe-ui__num">{formatMoney(row.automatedValue, data.targetCurrency)}</td><td className="stripe-ui__num">{formatMoney(row.variance, data.targetCurrency)}</td><td><span className={`gtm__status gtm__status--${row.matches ? "green" : "red"}`}>{row.matches ? "Match" : "Review"}</span></td></tr>)}</tbody></table></div>
            </section>
          ) : null}

          <section className="stripe-ui__panel ui-reveal ui-reveal-3">
            <h2 className="stripe-ui__panel-title">Scorecard</h2>
            <p className="stripe-ui__panel-subtitle">Unavailable rows stay visible so missing integrations are obvious; no workbook actual is used as a live fallback.</p>
            <div className="stripe-ui__table-wrap">
              <table className="stripe-ui__table gtm__table gtm__scorecard">
                <thead><tr><th>Metric</th><th>Owner</th><th className="stripe-ui__num">Actual MTD</th><th className="stripe-ui__num">Prior month</th><th className="stripe-ui__num">Paced target</th><th className="stripe-ui__num">Monthly target</th><th className="stripe-ui__num">Achievement</th><th>Status</th><th>Source / note</th></tr></thead>
                <tbody>{sections.map(([section, rows]) => <React.Fragment key={section}><tr className="gtm__section-row"><td colSpan={9}>{section}</td></tr>{rows.map((metric) => <tr key={metric.id}><td>{metric.label}</td><td>{metric.owner}</td><td className="stripe-ui__num">{formatMetricValue(metric, data.targetCurrency)}</td><td className="stripe-ui__num">{formatByFormat(metric.priorValue, metric.format, data.targetCurrency)}</td><td className="stripe-ui__num">{formatByFormat(metric.pacedTarget, metric.format, data.targetCurrency)}</td><td className="stripe-ui__num">{formatByFormat(metric.target, metric.format, data.targetCurrency)}</td><td className="stripe-ui__num">{metric.achievement == null ? "—" : `${formatNumber(metric.achievement * 100, 1)}%`}</td><td><span className={`gtm__status gtm__status--${metric.status}`}>{metric.status === "unavailable" ? "Unavailable" : metric.status === "neutral" ? "No target" : metric.status}</span></td><td><strong>{metric.source}</strong>{metric.note ? <small className="gtm__source-note">{metric.note}</small> : null}</td></tr>)}</React.Fragment>)}</tbody>
              </table>
            </div>
          </section>

          <section className="stripe-ui__panel ui-reveal ui-reveal-4">
            <details className="gtm__details">
              <summary>View all Targets-tab values for {data.monthLabel}</summary>
              <p className="stripe-ui__panel-subtitle">Monthly and FY27 targets transcribed from the workbook’s Targets tab. Dashes remain blank.</p>
              <div className="stripe-ui__table-wrap"><table className="stripe-ui__table gtm__table"><thead><tr><th>Target section</th><th>Metric</th><th className="stripe-ui__num">{data.monthLabel}</th><th className="stripe-ui__num">FY27</th></tr></thead><tbody>{data.targetRows.map((row) => <tr key={row.id}><td>{row.section}</td><td>{row.label}</td><td className="stripe-ui__num">{formatByFormat(row.value, row.format, data.targetCurrency)}</td><td className="stripe-ui__num">{formatByFormat(row.fy27, row.format, data.targetCurrency)}</td></tr>)}</tbody></table></div>
            </details>
          </section>

          {data.warnings.length ? <section className="stripe-ui__panel"><h2 className="stripe-ui__panel-title">Data-source warnings</h2><ul className="gtm__warnings">{data.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></section> : null}
        </>
      ) : null}
    </div>
  );
}
