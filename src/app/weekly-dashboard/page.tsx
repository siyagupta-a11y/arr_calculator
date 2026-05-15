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
    signupsInMonth: AnalyticsBlock;
    newUsersInMonth: AnalyticsBlock;
    productionMessagesInMonth: AnalyticsBlock;
    highVolumeWorkspacesInMonth: AnalyticsBlock;
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

type ClosedWonAccountRow = {
  accountId: string;
  accountName: string;
  closedWonDealCount: number;
  arr: number;
  latestClosedDate: string;
};

type WeeklyClosedWonAccountsResponse = {
  startDate: string;
  endDate: string;
  accountCount: number;
  dealCount: number;
  totalArr: number;
  rows: ClosedWonAccountRow[];
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
  signupsInMonth: AnalyticsBlock;
  newUsersInMonth: AnalyticsBlock;
  productionMessagesInMonth: AnalyticsBlock;
  highVolumeWorkspacesInMonth: AnalyticsBlock;
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
  closedWonAccounts: WeeklyClosedWonAccountsResponse;
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

function formatCompactCount(value: number) {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value || 0);
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
    signupsInMonth: metrics?.signupsInMonth || EMPTY_ANALYTICS_BLOCK,
    newUsersInMonth: metrics?.newUsersInMonth || EMPTY_ANALYTICS_BLOCK,
    productionMessagesInMonth: metrics?.productionMessagesInMonth || EMPTY_ANALYTICS_BLOCK,
    highVolumeWorkspacesInMonth: metrics?.highVolumeWorkspacesInMonth || EMPTY_ANALYTICS_BLOCK,
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

function formatDeltaBadgeHtml(current: number, previous: number) {
  const delta = deltaLabel(current, previous);
  const className = delta.tone === "positive" ? "up" : delta.tone === "negative" ? "down" : "neutral";
  return `<span class="delta ${className}">${escapeHtml(delta.text)}</span>`;
}

function metricComparisonTextForHtml(current: AnalyticsBlock, previous: AnalyticsBlock) {
  if (current.status !== "ok" || current.value == null) return metricStatusLabel(current);
  if (previous.status !== "ok" || previous.value == null) return "No comparable value last week";
  return deltaLabel(current.value, previous.value).text;
}

function buildWeeklyDashboardHtmlExport(args: {
  data: DashboardData;
  totalCurrent: number;
  totalPrevious: number;
  usageBarMetrics: UsageBarMetric[];
  usageBarMax: number;
}) {
  const { data, totalCurrent, totalPrevious, usageBarMetrics, usageBarMax } = args;
  const generatedAt = new Date().toLocaleString();

  const arrCards = [
    {
      label: "Total ARR",
      value: formatMoney(totalCurrent, data.currency),
      deltaHtml: formatDeltaBadgeHtml(totalCurrent, totalPrevious),
    },
    {
      label: "Self-serve ARR",
      value: formatMoney(data.current.breakdown.selfserveArr, data.currency),
      deltaHtml: formatDeltaBadgeHtml(data.current.breakdown.selfserveArr, data.previous.breakdown.selfserveArr),
    },
    {
      label: "Sales-led ARR",
      value: formatMoney(data.current.breakdown.salesledArr, data.currency),
      deltaHtml: formatDeltaBadgeHtml(data.current.breakdown.salesledArr, data.previous.breakdown.salesledArr),
    },
    {
      label: "Sales assist ARR",
      value: formatMoney(data.current.breakdown.salesAssistArr, data.currency),
      deltaHtml: formatDeltaBadgeHtml(data.current.breakdown.salesAssistArr, data.previous.breakdown.salesAssistArr),
    },
    {
      label: "AI spend ARR",
      value: formatMoney(data.current.ops.aiSpendArr, data.currency),
      deltaHtml: formatDeltaBadgeHtml(data.current.ops.aiSpendArr, data.previous.ops.aiSpendArr),
    },
  ]
    .map(
      (card) => `
      <div class="card kpi">
        <div class="kpi-label">${escapeHtml(card.label)}</div>
        <div class="kpi-value">${escapeHtml(card.value)}</div>
        ${card.deltaHtml}
      </div>`,
    )
    .join("");

  const opsCards = [
    {
      label: "Sales cycle (days)",
      value: formatNumber(data.current.ops.salesCycleDays, 2),
      deltaHtml: formatDeltaBadgeHtml(data.current.ops.salesCycleDays, data.previous.ops.salesCycleDays),
    },
    {
      label: "LTV",
      value: formatMoney(data.current.ops.ltv, data.currency),
      deltaHtml: formatDeltaBadgeHtml(data.current.ops.ltv, data.previous.ops.ltv),
    },
    {
      label: "ARR/FTE",
      value: formatMoney(data.current.ops.arrPerFte, data.currency),
      deltaHtml: formatDeltaBadgeHtml(data.current.ops.arrPerFte, data.previous.ops.arrPerFte),
    },
    {
      label: "FTEs",
      value: formatNumber(data.current.ops.ftes, 0),
      deltaHtml: formatDeltaBadgeHtml(data.current.ops.ftes, data.previous.ops.ftes),
    },
  ]
    .map(
      (card) => `
      <div class="card kpi">
        <div class="kpi-label">${escapeHtml(card.label)}</div>
        <div class="kpi-value">${escapeHtml(card.value)}</div>
        ${card.deltaHtml}
      </div>`,
    )
    .join("");

  const usageCards = [
    {
      label: "DAU (last day)",
      value:
        data.current.usage.dauLastDay.value != null ? formatNumber(data.current.usage.dauLastDay.value, 0) : "—",
      deltaText: metricComparisonTextForHtml(data.current.usage.dauLastDay, data.previous.usage.dauLastDay),
    },
    {
      label: "WAU (last day)",
      value:
        data.current.usage.wauLastDay.value != null ? formatNumber(data.current.usage.wauLastDay.value, 0) : "—",
      deltaText: metricComparisonTextForHtml(data.current.usage.wauLastDay, data.previous.usage.wauLastDay),
    },
    {
      label: "Production messages (month)",
      value:
        data.current.usage.productionMessagesInMonth.value != null
          ? formatNumber(data.current.usage.productionMessagesInMonth.value, 0)
          : "—",
      deltaText: metricComparisonTextForHtml(
        data.current.usage.productionMessagesInMonth,
        data.previous.usage.productionMessagesInMonth,
      ),
    },
    {
      label: "Active builders (10 of 30 days)",
      value:
        data.current.usage.activeBuilders10of30.value != null
          ? formatNumber(data.current.usage.activeBuilders10of30.value, 0)
          : "—",
      deltaText: metricComparisonTextForHtml(
        data.current.usage.activeBuilders10of30,
        data.previous.usage.activeBuilders10of30,
      ),
    },
  ]
    .map((card) => {
      const className = card.deltaText.includes("increase")
        ? "up"
        : card.deltaText.includes("decrease")
          ? "down"
          : "neutral";
      return `
      <div class="card kpi">
        <div class="kpi-label">${escapeHtml(card.label)}</div>
        <div class="kpi-value">${escapeHtml(card.value)}</div>
        <span class="delta ${className}">${escapeHtml(card.deltaText)}</span>
      </div>`;
    })
    .join("");

  const usageBars = usageBarMetrics
    .map((metric) => {
      const value = metric.block.status === "ok" && metric.block.value != null ? metric.block.value : null;
      const widthPct = value == null ? 0 : value <= 0 ? 0 : Math.min(100, (value / usageBarMax) * 100);
      const statusText =
        value != null
          ? formatCompactCount(value)
          : metric.block.status === "not_configured"
            ? "Not configured"
            : "Unavailable";
      return `
      <div class="bar-row">
        <div class="bar-metric">
          <div class="bar-metric-label">${escapeHtml(metric.label)}</div>
          <div class="bar-metric-sub">${escapeHtml(metric.block.status === "ok" ? "Mixpanel" : metric.block.details || metric.block.status)}</div>
        </div>
        <div class="bar-wrap">
          <div class="bar-fill" style="width:${widthPct}%; background:${escapeHtml(metric.color)};"></div>
        </div>
        <div class="bar-value">${escapeHtml(statusText)}</div>
      </div>`;
    })
    .join("");

  const closedWonRows = data.closedWonAccounts.rows.length
    ? data.closedWonAccounts.rows
        .map(
          (row) => `
        <tr>
          <td>${escapeHtml(row.accountName || row.accountId || "(blank)")}</td>
          <td>${escapeHtml(String(row.closedWonDealCount))}</td>
          <td>${escapeHtml(row.latestClosedDate || "—")}</td>
          <td class="num">${escapeHtml(formatMoney(row.arr, data.currency))}</td>
        </tr>`,
        )
        .join("")
    : `
      <tr>
        <td colspan="4" class="empty">No closed won accounts were found in this window.</td>
      </tr>`;

  const churnRows = data.churnedAccounts.length
    ? data.churnedAccounts
        .map(
          (account) => `
        <tr>
          <td>${escapeHtml(account.accountName || account.accountId || "(blank)")}</td>
          <td class="num">${escapeHtml(formatMoney(account.arr, data.currency))}</td>
        </tr>`,
        )
        .join("")
    : `
      <tr>
        <td colspan="2" class="empty">No HubSpot accounts churned in this comparison window.</td>
      </tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Weekly Dashboard Snapshot — ${escapeHtml(data.current.date)}</title>
<style>
:root {
  color-scheme: light;
  --bg: #f7f8fb;
  --panel: #ffffff;
  --ink: #121826;
  --ink-2: #3f4a5f;
  --ink-3: #6b7690;
  --line: #e3e8f2;
  --line-2: #edf1f7;
  --brand: #284e8e;
  --green: #15803d;
  --red: #b91c1c;
  --shadow: 0 1px 2px rgba(10, 16, 28, 0.06), 0 0 0 1px rgba(10, 16, 28, 0.03);
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif; }
.topbar { padding: 14px 22px; border-bottom: 1px solid var(--line); background: var(--panel); display: flex; justify-content: space-between; gap: 12px; align-items: center; }
.brand-name { font-weight: 700; font-size: 16px; }
.brand-sub { color: var(--ink-3); font-size: 12px; margin-top: 3px; }
.page { padding: 20px; display: grid; gap: 16px; }
.section-title { margin: 0 0 10px; font-size: 13px; font-weight: 700; letter-spacing: .02em; color: var(--ink-2); text-transform: uppercase; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; box-shadow: var(--shadow); }
.kpi-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(175px, 1fr)); }
.kpi-label { font-size: 11px; font-weight: 600; color: var(--ink-3); text-transform: uppercase; letter-spacing: .05em; }
.kpi-value { margin-top: 6px; font-size: 22px; font-weight: 700; letter-spacing: -.01em; color: var(--ink); line-height: 1.15; }
.delta { margin-top: 8px; display: inline-block; font-size: 12px; font-weight: 600; color: var(--ink-3); }
.delta.up { color: var(--green); }
.delta.down { color: var(--red); }
.delta.neutral { color: var(--ink-3); }
.bar-panel { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); padding: 12px; }
.bar-scale { display: flex; justify-content: space-between; color: var(--ink-3); font-size: 11px; margin-bottom: 8px; }
.bar-list { display: grid; gap: 9px; }
.bar-row { display: grid; grid-template-columns: 200px minmax(0, 1fr) 95px; align-items: center; gap: 10px; }
.bar-metric-label { font-size: 13px; font-weight: 600; color: var(--ink); }
.bar-metric-sub { font-size: 11px; color: var(--ink-3); margin-top: 2px; }
.bar-wrap { position: relative; height: 20px; background: var(--line-2); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 6px; opacity: 0.9; }
.bar-value { text-align: right; font-variant-numeric: tabular-nums; font-size: 13px; color: var(--ink-2); }
.table-wrap { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); overflow: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line-2); color: var(--ink-2); }
th { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-3); background: #fbfcff; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr:last-child td { border-bottom: none; }
.empty { color: var(--ink-3); }
@media (max-width: 900px) {
  .bar-row { grid-template-columns: 1fr; }
  .bar-value { text-align: left; }
}
</style>
</head>
<body>
  <div class="topbar">
    <div>
      <div class="brand-name">Weekly Dashboard Snapshot</div>
      <div class="brand-sub">As of ${escapeHtml(data.current.date)} · Comparing ${escapeHtml(data.current.date)} vs ${escapeHtml(data.previous.date)}</div>
    </div>
    <div class="brand-sub">Generated ${escapeHtml(generatedAt)}</div>
  </div>
  <main class="page">
    <section>
      <h2 class="section-title">ARR Snapshot</h2>
      <div class="kpi-grid">${arrCards}</div>
    </section>
    <section>
      <h2 class="section-title">Operating Metrics Snapshot</h2>
      <div class="kpi-grid">${opsCards}</div>
    </section>
    <section>
      <h2 class="section-title">Usage Metrics Snapshot</h2>
      <div class="kpi-grid">${usageCards}</div>
      <div class="bar-panel" style="margin-top: 12px;">
        <div class="section-title" style="margin: 0 0 8px;">Mixpanel Activity Bars</div>
        <div class="bar-scale"><span>0</span><span>${escapeHtml(formatCompactCount(usageBarMax))}</span></div>
        <div class="bar-list">${usageBars}</div>
      </div>
    </section>
    <section>
      <h2 class="section-title">Pipeline and Churn</h2>
      <div class="kpi-grid">
        <div class="card kpi">
          <div class="kpi-label">Open pipeline ARR</div>
          <div class="kpi-value">${escapeHtml(formatMoney(data.openPipelineArr, data.currency))}</div>
          <span class="delta neutral">${escapeHtml(formatNumber(data.openPipelineDealCount, 0))} open deals, excluding closed won and closed lost</span>
        </div>
      </div>
      <h3 class="section-title" style="margin-top: 14px;">Closed won accounts this week</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Deals</th>
              <th>Latest closed</th>
              <th class="num">ARR</th>
            </tr>
          </thead>
          <tbody>${closedWonRows}</tbody>
        </table>
      </div>
      <h3 class="section-title" style="margin-top: 14px;">HubSpot accounts churned this week</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th class="num">ARR</th>
            </tr>
          </thead>
          <tbody>${churnRows}</tbody>
        </table>
      </div>
    </section>
  </main>
</body>
</html>`;
}

type UsageBarMetric = {
  key: string;
  label: string;
  block: AnalyticsBlock;
  color: string;
};

export default function WeeklyDashboardPage() {
  const initialDate = useMemo(() => defaultAsOfDate(), []);
  const [asOfDate, setAsOfDate] = useState(initialDate);
  const [loading, setLoading] = useState(false);
  const [refreshingCache, setRefreshingCache] = useState(false);
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

      const [currentSubs, previousSubs, currentOverview, previousOverview, openPipeline, closedWonAccounts] = await Promise.all([
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
        postJson<OpenPipelineResponse>(
          "/api/weekly-dashboard-open-pipeline",
          {},
          "Open pipeline request",
        ),
        postJson<WeeklyClosedWonAccountsResponse>(
          "/api/weekly-dashboard-new-deals",
          {
            startDate: addDays(previousDate, 1),
            endDate: asOfDate,
          },
          "Closed won accounts request",
        ),
      ]);

      const currentAnalytics = await postJson<AnalyticsResponse>(
        "/api/model-update-analytics",
        {
          startDate: asOfDate,
          endDate: asOfDate,
        },
        "Current usage metrics request",
      );
      const previousAnalytics = await postJson<AnalyticsResponse>(
        "/api/model-update-analytics",
        {
          startDate: previousDate,
          endDate: previousDate,
        },
        "Previous-week usage metrics request",
      );

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
        closedWonAccounts,
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

  const refreshCache = useCallback(async () => {
    if (loading || refreshingCache) return;
    setRefreshingCache(true);
    setError(null);
    try {
      const previousDate = addDays(asOfDate, -7);
      await postJson<AnalyticsResponse>(
        "/api/model-update-analytics",
        {
          startDate: asOfDate,
          endDate: asOfDate,
          forceRefreshPrecomputed: true,
        },
        "Refresh current usage metrics cache",
      );
      await postJson<AnalyticsResponse>(
        "/api/model-update-analytics",
        {
          startDate: previousDate,
          endDate: previousDate,
          forceRefreshPrecomputed: true,
        },
        "Refresh previous usage metrics cache",
      );
      await postJson<{ ok: boolean }>(
        "/api/cache/hard-refresh",
        {},
        "Clear server response cache",
      );
      await run();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setRefreshingCache(false);
    }
  }, [asOfDate, loading, refreshingCache, run]);

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

  const usageBarMetrics = useMemo<UsageBarMetric[]>(
    () =>
      data
        ? [
            {
              key: "signups",
              label: "Signups",
              block: data.current.usage.signupsInMonth,
              color: "#38bdf8",
            },
            {
              key: "new-users",
              label: "New users",
              block: data.current.usage.newUsersInMonth,
              color: "#a78bfa",
            },
            {
              key: "active-builders",
              label: "Active builders",
              block: data.current.usage.activeBuilders10of30,
              color: "#22c55e",
            },
            {
              key: "high-volume-workspaces",
              label: "High volume workspaces",
              block: data.current.usage.highVolumeWorkspacesInMonth,
              color: "#f59e0b",
            },
          ]
        : [],
    [data],
  );

  const usageBarMax = useMemo(() => {
    const values = usageBarMetrics.map((metric) => (metric.block.status === "ok" && metric.block.value != null ? metric.block.value : 0));
    return Math.max(1, ...values);
  }, [usageBarMetrics]);

  const downloadHtmlSnapshot = useCallback(() => {
    if (!data || loading) return;
    const html = buildWeeklyDashboardHtmlExport({
      data,
      totalCurrent,
      totalPrevious,
      usageBarMetrics,
      usageBarMax,
    });
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `weekly-dashboard-${data.current.date}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [data, loading, totalCurrent, totalPrevious, usageBarMetrics, usageBarMax]);

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
        <div className="stripe-ui__control-grid" style={{ gridTemplateColumns: "repeat(4, minmax(180px, 1fr))" }}>
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
          <div className="stripe-ui__field" style={{ alignSelf: "end" }}>
            <button
              className="stripe-ui__btn stripe-ui__btn--secondary"
              onClick={refreshCache}
              disabled={loading || refreshingCache}
            >
              {refreshingCache ? "Refreshing cache..." : "Refresh Mixpanel cache"}
            </button>
          </div>
          <div className="stripe-ui__field" style={{ alignSelf: "end" }}>
            <button
              className="stripe-ui__btn stripe-ui__btn--secondary"
              onClick={downloadHtmlSnapshot}
              disabled={loading || refreshingCache || !data}
            >
              Download HTML snapshot
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

            <div style={{ marginTop: "1.25rem" }}>
              <h3 className="stripe-ui__panel-title" style={{ marginBottom: "0.5rem" }}>
                Mixpanel activity bars
              </h3>
              <p className="stripe-ui__panel-subtitle" style={{ marginBottom: "0.9rem" }}>
                Current month as of {data.current.date}
              </p>
              <div
                style={{
                  border: "1px solid var(--stripe-border)",
                  background: "linear-gradient(180deg, rgba(13, 21, 39, 0.96) 0%, rgba(9, 15, 28, 0.98) 100%)",
                  padding: "1rem",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "1rem",
                    marginBottom: "0.8rem",
                    fontSize: "0.75rem",
                    color: "var(--stripe-subtle)",
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                  }}
                >
                  <span>0</span>
                  <span>{formatCompactCount(usageBarMax)}</span>
                </div>
                <div style={{ display: "grid", gap: "0.8rem" }}>
                {usageBarMetrics.map((metric) => {
                  const value = metric.block.status === "ok" && metric.block.value != null ? metric.block.value : null;
                  const widthPct = value == null ? 0 : value <= 0 ? 0 : Math.min(100, (value / usageBarMax) * 100);
                  const statusText =
                    value != null
                      ? formatCompactCount(value)
                      : metric.block.status === "not_configured"
                        ? "Not configured"
                        : "Unavailable";
                  return (
                    <div key={metric.key}>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "12.5rem minmax(0, 1fr) 5.5rem",
                          gap: "0.8rem",
                          alignItems: "center",
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div style={{ color: "var(--stripe-text)", fontSize: "0.9rem", fontWeight: 700, lineHeight: 1.2 }}>
                            {metric.label}
                          </div>
                          <div style={{ color: "var(--stripe-muted)", fontSize: "0.76rem", marginTop: "0.2rem" }}>
                            {metric.block.status === "ok" ? "Mixpanel" : metric.block.details || metric.block.status}
                          </div>
                        </div>
                        <div
                          aria-label={`${metric.label} bar`}
                          style={{
                            position: "relative",
                            height: "1.9rem",
                            border: "1px solid var(--stripe-border)",
                            background:
                              "repeating-linear-gradient(90deg, rgba(255,255,255,0.03) 0, rgba(255,255,255,0.03) calc(25% - 1px), rgba(90,122,174,0.22) calc(25% - 1px), rgba(90,122,174,0.22) 25%)",
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              position: "absolute",
                              inset: 0,
                              background:
                                "linear-gradient(90deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0) 100%)",
                              pointerEvents: "none",
                            }}
                          />
                          <div
                            style={{
                              position: "absolute",
                              left: 0,
                              top: 0,
                              bottom: 0,
                              width: `${widthPct}%`,
                              background: `linear-gradient(90deg, ${metric.color} 0%, rgba(255,255,255,0.32) 100%)`,
                              boxShadow: `inset 0 0 0 1px rgba(255,255,255,0.08), 0 0 18px ${metric.color}44`,
                              transition: "width 180ms ease",
                            }}
                          />
                          <div
                            style={{
                              position: "absolute",
                              top: 0,
                              bottom: 0,
                              left: "25%",
                              width: "1px",
                              background: "rgba(157, 181, 218, 0.28)",
                            }}
                          />
                          <div
                            style={{
                              position: "absolute",
                              top: 0,
                              bottom: 0,
                              left: "50%",
                              width: "1px",
                              background: "rgba(157, 181, 218, 0.28)",
                            }}
                          />
                          <div
                            style={{
                              position: "absolute",
                              top: 0,
                              bottom: 0,
                              left: "75%",
                              width: "1px",
                              background: "rgba(157, 181, 218, 0.28)",
                            }}
                          />
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ color: "var(--stripe-text)", fontSize: "1rem", fontWeight: 700, lineHeight: 1.1 }}>
                            {statusText}
                          </div>
                          <div style={{ color: "var(--stripe-muted)", fontSize: "0.75rem", marginTop: "0.18rem" }}>
                            {metric.block.status === "ok" ? "Current value" : "No data"}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                </div>
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
                Closed won accounts this week
              </h3>
              {data.closedWonAccounts.rows.length ? (
                <div className="stripe-ui__table-wrap">
                  <table className="stripe-ui__table" aria-label="Closed won accounts table">
                    <thead>
                      <tr>
                        <th>Account</th>
                        <th>Deals</th>
                        <th>Latest closed</th>
                        <th style={{ textAlign: "right" }}>ARR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.closedWonAccounts.rows.map((row) => (
                        <tr key={row.accountId}>
                          <td>{row.accountName || row.accountId || "(blank)"}</td>
                          <td>{row.closedWonDealCount}</td>
                          <td>{row.latestClosedDate || "—"}</td>
                          <td style={{ textAlign: "right" }}>{formatMoney(row.arr, data.currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="stripe-ui__panel-subtitle" style={{ margin: 0 }}>
                  No closed won accounts were found in this window.
                </p>
              )}
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
