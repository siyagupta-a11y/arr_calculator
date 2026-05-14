"use client";

import Link from "next/link";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

type CombinedAllSubsRow = {
  id?: string;
  source: "hubspot_account" | "stripe_only_customer";
  customerLabel?: string;
  accountId?: string;
  accountName?: string;
  salesAssist: "yes" | "no";
  salesAssistByPeriod?: Record<string, "yes" | "no">;
  valuesByPeriod: Record<string, number>;
};

type CombinedAllSubsResponse = {
  targetCurrency: string;
  periods: Array<{ key: string; label: string }>;
  rows: CombinedAllSubsRow[];
};

type CombinedPoint = {
  periodStart: string;
  periodEnd: string;
  arr: number;
};

type SalesCyclePoint = {
  periodStart: string;
  periodEnd: string;
  avgSalesCycleDays: number;
};

type LtvPoint = {
  periodStart: string;
  periodEnd: string;
  ltv: number;
};

type ArrPerEmployeePoint = {
  periodStart: string;
  periodEnd: string;
  arrPerEmployee: number;
  fullTimeEmployees: number;
};

type AnalyticsBlock = {
  status: "ok" | "not_configured" | "error";
  value: number | null;
  details?: string;
};

type AnalyticsResponse = {
  mixpanelMetrics: {
    dauLastDay: AnalyticsBlock;
    wauLastDay: AnalyticsBlock;
    mauLastDay: AnalyticsBlock;
    productionMessagesInMonth: AnalyticsBlock;
    activeBuilders10of30: AnalyticsBlock;
  };
};

type CombinedBillingOverviewResponse = {
  targetCurrency: string;
  lineSourcePoints?: {
    aiSpend?: CombinedPoint[];
  };
  salesCyclePoints?: SalesCyclePoint[];
  ltvPoints?: LtvPoint[];
  arrPerEmployeePoints?: ArrPerEmployeePoint[];
};

type OpenPipelineResponse = {
  asOfDate: string;
  openPipelineArr: number;
  openDealCount: number;
  includedStageCount: number;
};

type ArrBreakdown = {
  selfserveArr: number;
  salesledArr: number;
  salesAssistArr: number;
};

type OpsSnapshot = {
  aiSpendArr: number;
  salesCycleDays: number;
  ltv: number;
  arrPerFte: number;
  ftes: number;
};

type UsageSnapshot = {
  dauLastDay: AnalyticsBlock;
  wauLastDay: AnalyticsBlock;
  mauLastDay: AnalyticsBlock;
  productionMessagesInMonth: AnalyticsBlock;
  activeBuilders10of30: AnalyticsBlock;
};

type Snapshot = {
  date: string;
  breakdown: ArrBreakdown;
  ops: OpsSnapshot;
  usage: UsageSnapshot;
};

type DashboardData = {
  currency: string;
  openPipelineArr: number;
  openPipelineDealCount: number;
  churnedAccounts: ChurnedAccount[];
  current: Snapshot;
  previous: Snapshot;
};

type ChurnedAccount = {
  accountId: string;
  accountName: string;
  arr: number;
};

function round2(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function toIsoDateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function defaultAsOfDate() {
  return toIsoDateOnly(new Date());
}

function addDays(isoDate: string, deltaDays: number) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return toIsoDateOnly(date);
}

function startOfMonth(isoDate: string) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  return toIsoDateOnly(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)));
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

function formatNumber(value: number, digits = 2) {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value || 0);
}

function parseJsonResponseText(text: string, status: number, context: string) {
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    const isHtml = /<!doctype html|<html/i.test(String(text || ""));
    const snippet = String(text || "").replace(/\s+/g, " ").trim().slice(0, 180);
    const reason = isHtml
      ? "Received HTML instead of JSON (likely auth redirect or server error page)."
      : "Received non-JSON response.";
    throw new Error(`${context} failed (${status}). ${reason}${snippet ? ` Response: ${snippet}` : ""}`);
  }
}

async function postJson<T>(url: string, payload: unknown, context: string): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  const json = parseJsonResponseText(text, res.status, context);
  if (!res.ok) {
    if (json && typeof json === "object" && "error" in json) {
      throw new Error(String((json as { error?: unknown }).error || "Request failed"));
    }
    throw new Error(text || `${context} failed (${res.status})`);
  }
  if (!json || typeof json !== "object") throw new Error(`${context} returned invalid payload`);
  return json as T;
}

function computeBreakdown(data: CombinedAllSubsResponse, periodKey: string): ArrBreakdown {
  let selfserveArr = 0;
  let salesledArr = 0;
  let salesAssistArr = 0;

  for (const row of data.rows || []) {
    const value = round2(Number(row.valuesByPeriod?.[periodKey] || 0));
    if (Math.abs(value) < 1e-9) continue;

    if (row.source === "hubspot_account") {
      salesledArr = round2(salesledArr + value);
      continue;
    }

    const isSalesAssist = (row.salesAssistByPeriod?.[periodKey] || row.salesAssist || "no") === "yes";
    if (isSalesAssist) salesAssistArr = round2(salesAssistArr + value);
    else selfserveArr = round2(selfserveArr + value);
  }

  return { selfserveArr, salesledArr, salesAssistArr };
}

function accountKeyForRow(row: CombinedAllSubsRow) {
  return String(row.accountId || row.accountName || row.customerLabel || row.id || "").trim();
}

function accountLabelForRow(row: CombinedAllSubsRow) {
  const name = String(row.accountName || "").trim();
  const accountId = String(row.accountId || "").trim();
  const customerLabel = String(row.customerLabel || "").trim();
  if (name && accountId) return `${name} (${accountId})`;
  if (name) return name;
  if (customerLabel) return customerLabel;
  if (accountId) return accountId;
  return "(blank)";
}

function computeChurnedAccounts(current: CombinedAllSubsResponse, previous: CombinedAllSubsResponse): ChurnedAccount[] {
  const currentPeriodKey = String(current.periods?.[current.periods.length - 1]?.key || "");
  const previousPeriodKey = String(previous.periods?.[previous.periods.length - 1]?.key || "");
  if (!currentPeriodKey || !previousPeriodKey) return [];

  const currentByAccount = new Map<string, number>();
  for (const row of current.rows || []) {
    if (row.source !== "hubspot_account") continue;
    const key = accountKeyForRow(row);
    if (!key) continue;
    const value = round2(Number(row.valuesByPeriod?.[currentPeriodKey] || 0));
    currentByAccount.set(key, round2((currentByAccount.get(key) || 0) + value));
  }

  const churned = new Map<string, ChurnedAccount>();
  for (const row of previous.rows || []) {
    if (row.source !== "hubspot_account") continue;
    const key = accountKeyForRow(row);
    if (!key) continue;
    const previousValue = round2(Number(row.valuesByPeriod?.[previousPeriodKey] || 0));
    const currentValue = round2(currentByAccount.get(key) || 0);
    if (previousValue <= 1e-9 || currentValue > 1e-9) continue;
    churned.set(key, {
      accountId: String(row.accountId || "").trim(),
      accountName: accountLabelForRow(row),
      arr: previousValue,
    });
  }

  return Array.from(churned.values()).sort((a, b) => b.arr - a.arr || a.accountName.localeCompare(b.accountName));
}

function latestPointByAsOfDate<T extends { periodEnd: string }>(points: T[] | undefined, asOfDate: string) {
  if (!points?.length) return null;
  const inRange = points
    .filter((point) => String(point.periodEnd || "") <= asOfDate)
    .sort((a, b) => String(a.periodEnd || "").localeCompare(String(b.periodEnd || "")));
  if (inRange.length) return inRange[inRange.length - 1];
  const sorted = [...points].sort((a, b) => String(a.periodEnd || "").localeCompare(String(b.periodEnd || "")));
  return sorted.length ? sorted[sorted.length - 1] : null;
}

function computeOpsSnapshot(data: CombinedBillingOverviewResponse, asOfDate: string): OpsSnapshot {
  const aiPoint = latestPointByAsOfDate(data.lineSourcePoints?.aiSpend || [], asOfDate);
  const salesCyclePoint = latestPointByAsOfDate(data.salesCyclePoints || [], asOfDate);
  const ltvPoint = latestPointByAsOfDate(data.ltvPoints || [], asOfDate);
  const arrPerFtePoint = latestPointByAsOfDate(data.arrPerEmployeePoints || [], asOfDate);

  return {
    aiSpendArr: round2(Number(aiPoint?.arr || 0)),
    salesCycleDays: round2(Number(salesCyclePoint?.avgSalesCycleDays || 0)),
    ltv: round2(Number(ltvPoint?.ltv || 0)),
    arrPerFte: round2(Number(arrPerFtePoint?.arrPerEmployee || 0)),
    ftes: round2(Number(arrPerFtePoint?.fullTimeEmployees || 0)),
  };
}

const EMPTY_ANALYTICS_BLOCK: AnalyticsBlock = {
  status: "error",
  value: null,
  details: "Metric unavailable",
};

function computeUsageSnapshot(data: AnalyticsResponse | null): UsageSnapshot {
  const metrics = data?.mixpanelMetrics;
  return {
    dauLastDay: metrics?.dauLastDay || EMPTY_ANALYTICS_BLOCK,
    wauLastDay: metrics?.wauLastDay || EMPTY_ANALYTICS_BLOCK,
    mauLastDay: metrics?.mauLastDay || EMPTY_ANALYTICS_BLOCK,
    productionMessagesInMonth: metrics?.productionMessagesInMonth || EMPTY_ANALYTICS_BLOCK,
    activeBuilders10of30: metrics?.activeBuilders10of30 || EMPTY_ANALYTICS_BLOCK,
  };
}

function pctDelta(current: number, previous: number) {
  const prev = Number(previous || 0);
  const curr = Number(current || 0);
  if (Math.abs(prev) < 1e-9) {
    if (Math.abs(curr) < 1e-9) return 0;
    return null;
  }
  return round2(((curr - prev) / Math.abs(prev)) * 100);
}

function deltaLabel(current: number, previous: number) {
  const delta = pctDelta(current, previous);
  if (delta === null) return { text: "No comparable value last week", tone: "neutral" as const };
  if (Math.abs(delta) < 1e-9) return { text: "0.00% vs last week", tone: "neutral" as const };
  return delta > 0
    ? { text: `${formatNumber(delta, 2)}% increase vs last week`, tone: "positive" as const }
    : { text: `${formatNumber(Math.abs(delta), 2)}% decrease vs last week`, tone: "negative" as const };
}

function metricStatusLabel(metric: AnalyticsBlock) {
  const details = metric.details ? `: ${metric.details}` : "";
  return `${metric.status}${details}`;
}

function renderDeltaLabel(current: number, previous: number) {
  const delta = deltaLabel(current, previous);
  return <span style={deltaStyle(delta.tone)}>{delta.text}</span>;
}

function metricComparisonLabel(current: AnalyticsBlock, previous: AnalyticsBlock) {
  const currentValue = current.value;
  if (current.status !== "ok" || currentValue == null) return metricStatusLabel(current);
  if (previous.status !== "ok" || previous.value == null) return "No comparable value last week";
  return renderDeltaLabel(currentValue, previous.value);
}

function deltaStyle(tone: "positive" | "negative" | "neutral") {
  if (tone === "positive") return { color: "#16a34a" };
  if (tone === "negative") return { color: "#dc2626" };
  return {};
}

export default function WeeklyDashboardPage() {
  const initialDate = useMemo(() => defaultAsOfDate(), []);
  const [asOfDate, setAsOfDate] = useState(initialDate);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const hasAutoRun = useRef(false);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const previousDate = addDays(asOfDate, -7);
      const currentMonthStart = startOfMonth(asOfDate);
      const previousMonthStart = startOfMonth(previousDate);

      const [currentSubs, previousSubs, currentOverview, previousOverview, currentAnalytics, previousAnalytics, openPipeline] = await Promise.all([
        postJson<CombinedAllSubsResponse>(
          "/api/combined-all-subs-report",
          {
            startDate: asOfDate,
            endDate: asOfDate,
            combineMode: "simple",
            displayMode: "arr",
            planGrain: "daily",
            includeSalesAssist: true,
          },
          "Current ARR breakdown request",
        ),
        postJson<CombinedAllSubsResponse>(
          "/api/combined-all-subs-report",
          {
            startDate: previousDate,
            endDate: previousDate,
            combineMode: "simple",
            displayMode: "arr",
            planGrain: "daily",
            includeSalesAssist: true,
          },
          "Previous-week ARR breakdown request",
        ),
        postJson<CombinedBillingOverviewResponse>(
          "/api/combined-billing-overview-report",
          {
            startDate: currentMonthStart,
            endDate: asOfDate,
            grain: "monthly",
            includeCac: false,
          },
          "Current monthly metrics request",
        ),
        postJson<CombinedBillingOverviewResponse>(
          "/api/combined-billing-overview-report",
          {
            startDate: previousMonthStart,
            endDate: previousDate,
            grain: "monthly",
            includeCac: false,
          },
          "Previous-week monthly metrics request",
        ),
        postJson<AnalyticsResponse>(
          "/api/model-update-analytics",
          {
            startDate: currentMonthStart,
            endDate: asOfDate,
          },
          "Current usage metrics request",
        ),
        postJson<AnalyticsResponse>(
          "/api/model-update-analytics",
          {
            startDate: previousMonthStart,
            endDate: previousDate,
          },
          "Previous-week usage metrics request",
        ),
        postJson<OpenPipelineResponse>(
          "/api/weekly-dashboard-open-pipeline",
          {},
          "Open pipeline request",
        ),
      ]);

      const currentBreakdown = computeBreakdown(currentSubs, asOfDate);
      const previousBreakdown = computeBreakdown(previousSubs, previousDate);
      const currentOps = computeOpsSnapshot(currentOverview, asOfDate);
      const previousOps = computeOpsSnapshot(previousOverview, previousDate);
      const currentUsage = computeUsageSnapshot(currentAnalytics);
      const previousUsage = computeUsageSnapshot(previousAnalytics);
      const churnedAccounts = computeChurnedAccounts(currentSubs, previousSubs);
      const currency = String(
        currentOverview.targetCurrency || currentSubs.targetCurrency || previousOverview.targetCurrency || "USD",
      ).toUpperCase();

      setData({
        currency,
        openPipelineArr: round2(Number(openPipeline.openPipelineArr || 0)),
        openPipelineDealCount: Math.max(0, Math.floor(Number(openPipeline.openDealCount || 0))),
        churnedAccounts,
        current: {
          date: asOfDate,
          breakdown: currentBreakdown,
          ops: currentOps,
          usage: currentUsage,
        },
        previous: {
          date: previousDate,
          breakdown: previousBreakdown,
          ops: previousOps,
          usage: previousUsage,
        },
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [asOfDate]);

  useEffect(() => {
    if (hasAutoRun.current) return;
    hasAutoRun.current = true;
    void run();
  }, [run]);

  const totalCurrent = useMemo(() => {
    if (!data) return 0;
    return round2(
      data.current.breakdown.selfserveArr
      + data.current.breakdown.salesledArr
      + data.current.breakdown.salesAssistArr
      + data.current.ops.aiSpendArr,
    );
  }, [data]);

  const totalPrevious = useMemo(() => {
    if (!data) return 0;
    return round2(
      data.previous.breakdown.selfserveArr
      + data.previous.breakdown.salesledArr
      + data.previous.breakdown.salesAssistArr
      + data.previous.ops.aiSpendArr,
    );
  }, [data]);

  return (
    <div className="stripe-ui">
      <section className="stripe-ui__hero ui-reveal">
        <div className="stripe-ui__eyebrow">Revenue intelligence</div>
        <div className="stripe-ui__hero-row">
          <div>
            <h1 className="stripe-ui__title">Weekly Dashboard</h1>
            <p className="stripe-ui__subtitle">
              Snapshot by date with week-over-week comparisons for ARR mix and operating metrics.
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <Link href="/combined-billing-overview" className="stripe-ui__hero-link">
              Open Combined Billing Overview
            </Link>
            <Link href="/combined-all-subs" className="stripe-ui__hero-link">
              Open Combined All Subs
            </Link>
            <Link href="/salesled" className="stripe-ui__hero-link">
              Open Sales-led
            </Link>
            <Link href="/selfserve" className="stripe-ui__hero-link">
              Open Self Serve
            </Link>
          </div>
        </div>
      </section>

      <section className="stripe-ui__panel ui-reveal ui-reveal-1">
        <h2 className="stripe-ui__panel-title">Controls</h2>
        <p className="stripe-ui__panel-subtitle">Defaults to today. Change date to see the snapshot on that date.</p>
        <div className="stripe-ui__control-grid" style={{ gridTemplateColumns: "repeat(3, minmax(180px, 1fr))" }}>
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="weekly-dashboard-date">
              As-of date
            </label>
            <input
              id="weekly-dashboard-date"
              className="stripe-ui__control"
              type="date"
              value={asOfDate}
              onChange={(event) => setAsOfDate(event.target.value)}
            />
          </div>
          <div className="stripe-ui__field" style={{ alignSelf: "end" }}>
            <button className="stripe-ui__btn stripe-ui__btn--primary" onClick={run} disabled={loading}>
              {loading ? "Loading..." : "Refresh dashboard"}
            </button>
          </div>
          {data ? (
            <div className="stripe-ui__field" style={{ alignSelf: "end" }}>
              <p className="stripe-ui__panel-subtitle" style={{ margin: 0 }}>
                Comparing {data.current.date} vs {data.previous.date}
              </p>
            </div>
          ) : null}
        </div>
      </section>

      {loading ? (
        <section className="stripe-ui__panel stripe-ui__loading-panel ui-reveal ui-reveal-2" aria-live="polite" aria-busy="true">
          <h2 className="stripe-ui__panel-title">Loading dashboard...</h2>
          <p className="stripe-ui__panel-subtitle">Pulling ARR breakdown, operating metrics, and usage metrics.</p>
        </section>
      ) : null}

      {!loading && error ? (
        <section className="stripe-ui__panel ui-reveal ui-reveal-2">
          <p className="stripe-ui__error" style={{ margin: 0 }}>
            {error}
          </p>
        </section>
      ) : null}

      {!loading && !error && data ? (
        <>
          <section className="stripe-ui__panel ui-reveal ui-reveal-2">
            <h2 className="stripe-ui__panel-title">ARR Snapshot</h2>
            <div className="stripe-ui__stats">
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Total ARR</p>
                <p className="stripe-ui__stat-value">{formatMoney(totalCurrent, data.currency)}</p>
                <p className="stripe-ui__panel-subtitle" style={{ margin: "0.35rem 0 0 0" }}>
                  {renderDeltaLabel(totalCurrent, totalPrevious)}
                </p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Self-serve ARR</p>
                <p className="stripe-ui__stat-value">{formatMoney(data.current.breakdown.selfserveArr, data.currency)}</p>
                <p className="stripe-ui__panel-subtitle" style={{ margin: "0.35rem 0 0 0" }}>
                  {renderDeltaLabel(data.current.breakdown.selfserveArr, data.previous.breakdown.selfserveArr)}
                </p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Sales-led ARR</p>
                <p className="stripe-ui__stat-value">{formatMoney(data.current.breakdown.salesledArr, data.currency)}</p>
                <p className="stripe-ui__panel-subtitle" style={{ margin: "0.35rem 0 0 0" }}>
                  {renderDeltaLabel(data.current.breakdown.salesledArr, data.previous.breakdown.salesledArr)}
                </p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Sales assist ARR</p>
                <p className="stripe-ui__stat-value">{formatMoney(data.current.breakdown.salesAssistArr, data.currency)}</p>
                <p className="stripe-ui__panel-subtitle" style={{ margin: "0.35rem 0 0 0" }}>
                  {renderDeltaLabel(data.current.breakdown.salesAssistArr, data.previous.breakdown.salesAssistArr)}
                </p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">AI spend ARR</p>
                <p className="stripe-ui__stat-value">{formatMoney(data.current.ops.aiSpendArr, data.currency)}</p>
                <p className="stripe-ui__panel-subtitle" style={{ margin: "0.35rem 0 0 0" }}>
                  {renderDeltaLabel(data.current.ops.aiSpendArr, data.previous.ops.aiSpendArr)}
                </p>
              </div>
            </div>
          </section>

          <section className="stripe-ui__panel ui-reveal ui-reveal-3">
            <h2 className="stripe-ui__panel-title">Operating Metrics Snapshot</h2>
            <div className="stripe-ui__stats">
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Sales cycle (days)</p>
                <p className="stripe-ui__stat-value">{formatNumber(data.current.ops.salesCycleDays, 2)}</p>
                <p className="stripe-ui__panel-subtitle" style={{ margin: "0.35rem 0 0 0" }}>
                  {renderDeltaLabel(data.current.ops.salesCycleDays, data.previous.ops.salesCycleDays)}
                </p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">LTV</p>
                <p className="stripe-ui__stat-value">{formatMoney(data.current.ops.ltv, data.currency)}</p>
                <p className="stripe-ui__panel-subtitle" style={{ margin: "0.35rem 0 0 0" }}>
                  {renderDeltaLabel(data.current.ops.ltv, data.previous.ops.ltv)}
                </p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">ARR/FTE</p>
                <p className="stripe-ui__stat-value">{formatMoney(data.current.ops.arrPerFte, data.currency)}</p>
                <p className="stripe-ui__panel-subtitle" style={{ margin: "0.35rem 0 0 0" }}>
                  {renderDeltaLabel(data.current.ops.arrPerFte, data.previous.ops.arrPerFte)}
                </p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">FTEs</p>
                <p className="stripe-ui__stat-value">{formatNumber(data.current.ops.ftes, 0)}</p>
                <p className="stripe-ui__panel-subtitle" style={{ margin: "0.35rem 0 0 0" }}>
                  {renderDeltaLabel(data.current.ops.ftes, data.previous.ops.ftes)}
                </p>
              </div>
            </div>
          </section>

          <section className="stripe-ui__panel ui-reveal ui-reveal-3">
            <h2 className="stripe-ui__panel-title">Usage Metrics Snapshot</h2>
            <div className="stripe-ui__stats">
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">DAU (last day)</p>
                <p className="stripe-ui__stat-value">
                  {data.current.usage.dauLastDay.value != null ? formatNumber(data.current.usage.dauLastDay.value, 0) : "—"}
                </p>
                <p className="stripe-ui__panel-subtitle" style={{ margin: "0.35rem 0 0 0" }}>
                  {metricComparisonLabel(data.current.usage.dauLastDay, data.previous.usage.dauLastDay)}
                </p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">WAU (last day)</p>
                <p className="stripe-ui__stat-value">
                  {data.current.usage.wauLastDay.value != null ? formatNumber(data.current.usage.wauLastDay.value, 0) : "—"}
                </p>
                <p className="stripe-ui__panel-subtitle" style={{ margin: "0.35rem 0 0 0" }}>
                  {metricComparisonLabel(data.current.usage.wauLastDay, data.previous.usage.wauLastDay)}
                </p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">MAU (last day)</p>
                <p className="stripe-ui__stat-value">
                  {data.current.usage.mauLastDay.value != null ? formatNumber(data.current.usage.mauLastDay.value, 0) : "—"}
                </p>
                <p className="stripe-ui__panel-subtitle" style={{ margin: "0.35rem 0 0 0" }}>
                  {metricComparisonLabel(data.current.usage.mauLastDay, data.previous.usage.mauLastDay)}
                </p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Production messages (month)</p>
                <p className="stripe-ui__stat-value">
                  {data.current.usage.productionMessagesInMonth.value != null
                    ? formatNumber(data.current.usage.productionMessagesInMonth.value, 0)
                    : "—"}
                </p>
                <p className="stripe-ui__panel-subtitle" style={{ margin: "0.35rem 0 0 0" }}>
                  {metricComparisonLabel(
                    data.current.usage.productionMessagesInMonth,
                    data.previous.usage.productionMessagesInMonth,
                  )}
                </p>
              </div>
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Active builders (10 of 30 days)</p>
                <p className="stripe-ui__stat-value">
                  {data.current.usage.activeBuilders10of30.value != null
                    ? formatNumber(data.current.usage.activeBuilders10of30.value, 0)
                    : "—"}
                </p>
                <p className="stripe-ui__panel-subtitle" style={{ margin: "0.35rem 0 0 0" }}>
                  {metricComparisonLabel(
                    data.current.usage.activeBuilders10of30,
                    data.previous.usage.activeBuilders10of30,
                  )}
                </p>
              </div>
            </div>
          </section>

          <section className="stripe-ui__panel ui-reveal ui-reveal-4">
            <h2 className="stripe-ui__panel-title">Pipeline and Churn</h2>
            <div className="stripe-ui__stats">
              <div className="stripe-ui__stat">
                <p className="stripe-ui__stat-label">Open pipeline ARR</p>
                <p className="stripe-ui__stat-value">{formatMoney(data.openPipelineArr, data.currency)}</p>
                <p className="stripe-ui__panel-subtitle" style={{ margin: "0.35rem 0 0 0" }}>
                  {formatNumber(data.openPipelineDealCount, 0)} open deals, excluding closed won and closed lost
                </p>
              </div>
            </div>

            <div style={{ marginTop: "1.25rem" }}>
              <h3 className="stripe-ui__panel-title" style={{ marginBottom: "0.5rem" }}>
                HubSpot accounts churned this week
              </h3>
              {data.churnedAccounts.length ? (
                <div className="stripe-ui__table-wrap">
                  <table className="stripe-ui__table">
                    <thead>
                      <tr>
                        <th>Account</th>
                        <th style={{ textAlign: "right" }}>ARR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.churnedAccounts.map((account) => (
                        <tr key={`${account.accountId || account.accountName}-${account.arr}`}>
                          <td>{account.accountName || account.accountId || "(blank)"}</td>
                          <td style={{ textAlign: "right" }}>{formatMoney(account.arr, data.currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="stripe-ui__panel-subtitle" style={{ margin: 0 }}>
                  No HubSpot accounts churned in this comparison window.
                </p>
              )}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
