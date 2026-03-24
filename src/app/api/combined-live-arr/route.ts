import { NextResponse } from "next/server";
import { generateReport } from "@/lib/report";
import {
  queryStripeBillingOverviewFromBigQuery,
  queryStripeUpcomingCurrentMonthDescriptionAmountFromBigQuery,
  type StripeBillingOverviewResult,
} from "@/lib/stripeBigquery";
import type { ReportResponse, ReportRow } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

function round2(v: number) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

function toIsoDateOnlyUtc(d: Date) {
  return d.toISOString().slice(0, 10);
}

function isCloudDeploymentType(value: string) {
  return String(value || "").trim().toLowerCase() === "cloud";
}

function hasAnyNonZeroValue(valuesByPeriod: Record<string, number>) {
  return Object.values(valuesByPeriod || {}).some((value) => Math.abs(Number(value) || 0) > 1e-9);
}

function accountGroupingKey(rawAccountId: string) {
  const raw = String(rawAccountId || "").trim();
  if (!raw) return "";
  const numericToken =
    raw
      .split(/[,\s;|]+/)
      .map((part) => part.trim())
      .find((part) => /^\d+$/.test(part)) || "";
  if (numericToken) return numericToken;
  return raw.toLowerCase();
}

function pickTargetCurrency() {
  return (
    String(process.env.STRIPE_BILLING_OVERVIEW_TARGET_CURRENCY || "").trim() ||
    String(process.env.STRIPE_THROUGH_MRR_TARGET_CURRENCY || "").trim() ||
    String(process.env.STRIPE_ARR_CORRECT_TARGET_CURRENCY || "").trim() ||
    "USD"
  );
}

function mapHubRows(report: ReportResponse) {
  return (report.rows || []).map((row: ReportRow) => ({
    accountId: String(row.accountId || ""),
    deploymentType: String(row.deploymentType || ""),
    valuesByPeriod: row.valuesByPeriod || {},
  }));
}

function computeHubspotCurrentArr(report: ReportResponse) {
  const periodKey = String(report.periods?.[0]?.key || "");
  if (!periodKey) return 0;
  const rows = mapHubRows(report)
    .filter((row) => isCloudDeploymentType(row.deploymentType))
    .filter((row) => hasAnyNonZeroValue(row.valuesByPeriod));

  const totalsByAccount = new Map<string, number>();
  for (const row of rows) {
    const accountKey = accountGroupingKey(row.accountId);
    if (!accountKey) continue;
    const periodValue = Number(row.valuesByPeriod[periodKey] || 0);
    totalsByAccount.set(accountKey, round2((totalsByAccount.get(accountKey) || 0) + periodValue));
  }

  return round2(Array.from(totalsByAccount.values()).reduce((sum, value) => sum + value, 0));
}

function computeStripeCurrentArr(stripe: StripeBillingOverviewResult) {
  const hasStripeExactSeries =
    stripe.stripeExactPoints !== undefined || stripe.stripeExactHistoryPoints !== undefined;
  const points = hasStripeExactSeries ? stripe.stripeExactPoints || [] : stripe.points || [];
  if (!points.length) return round2(stripe.currentArr || 0);
  return round2(points[points.length - 1].arr);
}

async function buildLiveArrPayload() {
  const nowUtc = new Date();
  const monthStartUtc = new Date(
    Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  const nextMonthStartUtc = new Date(
    Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  );
  const monthEndUtc = new Date(
    Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth() + 1, 0, 0, 0, 0, 0),
  );

  const monthStartDate = toIsoDateOnlyUtc(monthStartUtc);
  const monthEndDate = toIsoDateOnlyUtc(monthEndUtc);
  const nextMonthStartDate = toIsoDateOnlyUtc(nextMonthStartUtc);
  const targetCurrency = pickTargetCurrency();

  const todayDate = toIsoDateOnlyUtc(nowUtc);

  const [hubspotTodayReport, stripeReport, aiSpendUpcoming] = await Promise.all([
    generateReport({
      startDate: todayDate,
      endDate: todayDate,
      mode: "contracted",
      grain: "daily",
    }),
    queryStripeBillingOverviewFromBigQuery(
      {
        startDate: monthStartDate,
        endDate: monthEndDate,
        grain: "monthly",
        groupBy: "none",
        targetCurrency,
      },
      { profile: "stripe_arr_correct" },
    ),
    queryStripeUpcomingCurrentMonthDescriptionAmountFromBigQuery(
      {
        monthStartDate,
        nextMonthStartDate,
        targetCurrency,
        productDescriptionIncludes: ["ai tokens", "web search and crawl"],
      },
      { profile: "stripe_arr_correct" },
    ),
  ]);

  const hubspotCurrentArr = computeHubspotCurrentArr(hubspotTodayReport);
  const stripeCurrentArr = computeStripeCurrentArr(stripeReport);
  const currentMonthArr = round2(hubspotCurrentArr + stripeCurrentArr);

  const monthDurationMs = Math.max(1, nextMonthStartUtc.getTime() - monthStartUtc.getTime());
  const elapsedMsRaw = nowUtc.getTime() - monthStartUtc.getTime();
  const elapsedMs = Math.max(1000, Math.min(monthDurationMs, elapsedMsRaw));
  const timeScale = monthDurationMs / elapsedMs;

  const aiSpendCurrentMonthAmount = round2(aiSpendUpcoming.amountMajorSum);
  const aiSpendAnnualizedProjection = round2(aiSpendCurrentMonthAmount * 12 * timeScale);
  const upcomingAnnualizedProjection = aiSpendAnnualizedProjection;
  const selfserveProjectedArr = round2((stripeReport.currentMonthProjection?.projectedEndMrr || 0) * 12);
  const salesledCurrentArr = round2(hubspotCurrentArr);
  const projectedArr = round2(aiSpendAnnualizedProjection + selfserveProjectedArr + salesledCurrentArr);
  const liveArr = round2(currentMonthArr + upcomingAnnualizedProjection);

  return {
    generatedAtUtc: nowUtc.toISOString(),
    monthStartDate,
    monthEndDate,
    nextMonthStartDate,
    targetCurrency: String(targetCurrency || "USD").toUpperCase(),
    hubspotCurrentArr,
    stripeCurrentArr,
    currentMonthArr,
    upcomingSnapshotDate: aiSpendUpcoming.snapshotDate,
    upcomingLineCount: aiSpendUpcoming.lineCount,
    upcomingMonthlyAmount: aiSpendCurrentMonthAmount,
    monthDurationDays: monthDurationMs / 86_400_000,
    elapsedDays: elapsedMs / 86_400_000,
    timestampScaleFactor: timeScale,
    upcomingAnnualizedProjection: aiSpendAnnualizedProjection,
    projectedSnapshotDate: aiSpendUpcoming.snapshotDate,
    projectedLineCount: aiSpendUpcoming.lineCount,
    projectedArr,
    projectedArrBreakdown: {
      aiSpendAnnualizedArr: aiSpendAnnualizedProjection,
      selfserveProjectedArr,
      salesledCurrentArr,
    },
    liveArr,
  };
}

export async function GET() {
  try {
    return NextResponse.json(await buildLiveArrPayload());
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST() {
  try {
    return NextResponse.json(await buildLiveArrPayload());
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
