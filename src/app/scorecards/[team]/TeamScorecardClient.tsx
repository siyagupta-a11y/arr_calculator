"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  TEAM_SCORECARD_DEFINITIONS,
  type TeamScorecardKey,
} from "@/lib/teamScorecardDefinitions";
import type {
  TeamScorecardReportResponse,
  TeamScorecardValue,
} from "@/lib/teamScorecardReport";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function monthStart(value: string) {
  return `${value.slice(0, 7)}-01`;
}

function formatValue(value: TeamScorecardValue, currency: string) {
  if (value.format === "currency") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 0,
    }).format(Number(value.value || 0));
  }
  if (value.format === "percent") {
    return `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Number(value.value || 0) * 100)}%`;
  }
  if (value.format === "count") {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(value.value || 0));
  }
  return String(value.value || "");
}

function displayDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function responseError(payload: unknown, status: number) {
  if (payload && typeof payload === "object" && "error" in payload) {
    return String((payload as { error?: unknown }).error || `Scorecard request failed (${status})`);
  }
  return `Scorecard request failed (${status})`;
}

export default function TeamScorecardClient({ teamKey }: { teamKey: TeamScorecardKey }) {
  const today = useMemo(todayIso, []);
  const [startDate, setStartDate] = useState(() => monthStart(today));
  const [endDate, setEndDate] = useState(today);
  const [data, setData] = useState<TeamScorecardReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/team-scorecards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ team: teamKey, startDate, endDate }),
      });
      const text = await response.text();
      let payload: unknown = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(`Scorecard returned a non-JSON response (${response.status}).`);
      }
      if (!response.ok) throw new Error(responseError(payload, response.status));
      setData(payload as TeamScorecardReportResponse);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load scorecard");
    } finally {
      setLoading(false);
    }
  }, [teamKey, startDate, endDate]);

  useEffect(() => {
    void load();
  }, [load]);

  const definition = TEAM_SCORECARD_DEFINITIONS.find((team) => team.key === teamKey)!;
  const displayed = data?.teamKey === teamKey ? data : null;

  return (
    <div className="stripe-ui team-scorecards">
      <section className="stripe-ui__hero ui-reveal">
        <div className="stripe-ui__eyebrow">Team scorecard</div>
        <div className="stripe-ui__hero-row">
          <div>
            <h1 className="stripe-ui__title">{definition.name}</h1>
            <p className="stripe-ui__subtitle">{definition.description} Every V2 metric remains visible; unsupported actuals are intentionally blank.</p>
          </div>
          <div className="team-scorecards__hero-links">
            <Link href="/scorecards" className="stripe-ui__hero-link">All teams</Link>
            <Link href="/gtm" className="stripe-ui__hero-link">Open GTM</Link>
          </div>
        </div>
      </section>

      <nav className="team-scorecards__tabs" aria-label="Scorecard teams">
        {TEAM_SCORECARD_DEFINITIONS.map((team) => (
          <Link
            key={team.key}
            href={`/scorecards/${team.key}`}
            className={`team-scorecards__tab${team.key === teamKey ? " team-scorecards__tab--active" : ""}`}
            aria-current={team.key === teamKey ? "page" : undefined}
          >
            {team.name}
          </Link>
        ))}
      </nav>

      <section className="stripe-ui__panel ui-reveal ui-reveal-1">
        <div className="stripe-ui__section-head">
          <div>
            <h2 className="stripe-ui__panel-title">Reporting period</h2>
            <p className="stripe-ui__panel-subtitle">Daily CARR metrics use the exact range. Cadence-specific quota metrics are calculated as of the selected end date.</p>
          </div>
        </div>
        <div className="stripe-ui__control-grid team-scorecards__controls">
          <label className="stripe-ui__field">
            <span className="stripe-ui__field-label">Start date</span>
            <input className="stripe-ui__control" type="date" min="2022-08-01" max={endDate} value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          </label>
          <label className="stripe-ui__field">
            <span className="stripe-ui__field-label">End date</span>
            <input className="stripe-ui__control" type="date" min={startDate} max={today} value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          </label>
          <div className="stripe-ui__actions team-scorecards__load-action">
            <button type="button" className="stripe-ui__btn stripe-ui__btn--primary" onClick={() => void load()} disabled={loading}>
              {loading ? "Loading…" : "Refresh scorecard"}
            </button>
          </div>
        </div>
      </section>

      {error ? <section className="stripe-ui__panel"><div className="stripe-ui__error">{error}</div></section> : null}
      {loading && !displayed ? <section className="stripe-ui__panel team-scorecards__loading" aria-busy="true">Calculating {definition.name} metrics…</section> : null}

      {displayed ? (
        <>
          <section className="team-scorecards__summary ui-reveal ui-reveal-2">
            <article><span>Reporting range</span><strong>{displayDate(displayed.startDate)} – {displayDate(displayed.endDate)}</strong></article>
            <article><span>Metrics populated</span><strong>{displayed.populatedMetricCount} <small>/ {displayed.totalMetricCount}</small></strong></article>
            <article><span>Calculation source</span><strong>{displayed.populatedMetricCount ? "BigQuery" : "Awaiting integrations"}</strong></article>
          </section>

          <section className="stripe-ui__panel ui-reveal ui-reveal-3">
            <div className="stripe-ui__section-head">
              <div>
                <h2 className="stripe-ui__panel-title">{displayed.teamName} scorecard</h2>
                <p className="stripe-ui__panel-subtitle">Targets, owners, cadence, tracking notes, and metric names are preserved from the V2 tab. Blank actual cells are not treated as zero.</p>
              </div>
              <span className="team-scorecards__range-chip">{displayed.startDate} → {displayed.endDate}</span>
            </div>
            <div className="stripe-ui__table-wrap team-scorecards__table-wrap">
              <table className="stripe-ui__table team-scorecards__table">
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>Actual</th>
                    <th>Target</th>
                    <th>Owner</th>
                    <th>Frequency</th>
                    <th>Can finance track?</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {displayed.metrics.map((metric, index) => (
                    <tr key={metric.id}>
                      <td>
                        <span className="team-scorecards__metric-index">{String(index + 1).padStart(2, "0")}</span>
                        <strong>{metric.label}</strong>
                      </td>
                      <td className={`team-scorecards__actual${metric.values.length ? "" : " team-scorecards__actual--blank"}`}>
                        {metric.values.length ? (
                          <div className="team-scorecards__values">
                            {metric.values.map((value) => (
                              <div className="team-scorecards__value" key={`${metric.id}-${value.label}`}>
                                <span>{value.label}</span>
                                <strong>{formatValue(value, displayed.targetCurrency)}</strong>
                                {value.context ? <small>{value.context}</small> : null}
                              </div>
                            ))}
                            <details className="team-scorecards__method">
                              <summary>Calculation</summary>
                              <p>{metric.calculation}</p>
                              <span>{metric.source}</span>
                            </details>
                          </div>
                        ) : null}
                      </td>
                      <td>{metric.target}</td>
                      <td>{metric.owner}</td>
                      <td>{metric.frequency}</td>
                      <td>{metric.financeTracking}</td>
                      <td>{metric.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {displayed.warnings.length ? (
            <section className="stripe-ui__panel">
              <h2 className="stripe-ui__panel-title">Data-source warnings</h2>
              <ul className="team-scorecards__warnings">{displayed.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
