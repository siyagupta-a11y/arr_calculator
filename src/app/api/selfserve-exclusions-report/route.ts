import { NextResponse } from "next/server";
import { generateCombinedAllSubsReport } from "@/lib/combinedAllSubsReport";
import {
  queryStripeThroughMrrCustomerArrFromBigQuery,
  type StripeBigQueryProfile,
  type StripeThroughMrrCustomerArrRow,
} from "@/lib/stripeBigquery";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 300;
const CACHE_TTL_MS = readTtlMs("API_SELFSERVE_EXCLUSIONS_CACHE_TTL_MS", 60_000);
const EPSILON = 1e-9;

const STRIPE_QUERY_OPTIONS: { profile: StripeBigQueryProfile } = {
  profile: "stripe_arr_correct",
};

type ApiBody = {
  startDate?: string;
  endDate?: string;
};

type SelfserveExclusionsRequest = {
  startDate: string;
  endDate: string;
};

type SelfserveExclusionsEmailRow = {
  email: string;
  valuesByPeriod: Record<string, number>;
  totalMrr: number;
  totalArr: number;
};

type SelfserveExclusionsResponse = {
  startDate: string;
  endDate: string;
  targetCurrency: string;
  warnings: string[];
  periods: Array<{
    key: string;
    label: string;
    totalMrr: number;
    totalMrrChange: number;
    totalArr: number;
    emailCount: number;
  }>;
  emailRows: SelfserveExclusionsEmailRow[];
  summary: {
    matchedEmailCount: number;
    emailsWithAnyMrr: number;
  };
};

function parseIsoDateOnly(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function normalizeEmail(value: string) {
  return String(value || "").trim().toLowerCase();
}

function round2(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function toIsoDateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function previousMonthStartIso(dateText: string) {
  const parsed = parseIsoDateOnly(dateText);
  if (!parsed) return dateText;
  const prevMonthStart = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() - 1, 1, 0, 0, 0, 0));
  return toIsoDateOnly(prevMonthStart);
}

function previousIsoMonth(monthKey: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(monthKey || "").trim());
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return "";
  const d = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

function parsePayload(raw: Partial<ApiBody>): SelfserveExclusionsRequest {
  const startDate = String(raw.startDate || "").trim();
  const endDate = String(raw.endDate || "").trim();
  const start = parseIsoDateOnly(startDate);
  const end = parseIsoDateOnly(endDate);
  if (!start || !end) throw new Error("Invalid startDate/endDate");
  if (end.getTime() < start.getTime()) throw new Error("endDate must be >= startDate");
  return { startDate, endDate };
}

function summarizeErrorMessage(error: unknown) {
  if (error instanceof Error) return String(error.message || "Unknown error");
  return "Unknown error";
}

function periodMapFromRows(
  periods: Array<{ key: string }>,
  emailRows: SelfserveExclusionsEmailRow[],
  totalMrrChangeByPeriod: Record<string, number>,
) {
  return periods.map((period) => {
    const totalMrr = round2(
      emailRows.reduce((sum, row) => sum + Number(row.valuesByPeriod[period.key] || 0), 0),
    );
    const emailCount = emailRows.filter((row) => Math.abs(Number(row.valuesByPeriod[period.key] || 0)) > EPSILON).length;
    return {
      key: period.key,
      totalMrr,
      totalMrrChange: round2(Number(totalMrrChangeByPeriod[period.key] || 0)),
      totalArr: round2(totalMrr * 12),
      emailCount,
    };
  });
}

async function buildReport(payload: SelfserveExclusionsRequest): Promise<SelfserveExclusionsResponse> {
  const combined = await generateCombinedAllSubsReport({
    startDate: payload.startDate,
    endDate: payload.endDate,
    combineMode: "grouped",
    displayMode: "arr",
    planGrain: "monthly",
    includePlanData: false,
    includeSalesAssist: false,
    groupedMatchStrategy: "full",
  });

  const warnings = [...(combined.warnings || [])];
  const periods = (combined.periods || []).map((period) => ({
    key: String(period.key || ""),
    label: String(period.label || period.key || ""),
  }));
  const periodKeys = periods.map((period) => period.key);

  const matchedEmails = new Set<string>();
  const eligibleEmailsByPeriod = new Map<string, Set<string>>();
  for (const periodKey of periodKeys) {
    eligibleEmailsByPeriod.set(periodKey, new Set<string>());
  }
  for (const row of combined.rows || []) {
    if (row.source !== "hubspot_account") continue;
    for (const key of row.matchedStripeKeys || []) {
      const email = normalizeEmail(key);
      if (!email.includes("@")) continue;
      matchedEmails.add(email);
      for (const periodKey of periodKeys) {
        const hubspotArr = Number(row.hubspotValuesByPeriod?.[periodKey] || 0);
        if (hubspotArr > EPSILON) {
          eligibleEmailsByPeriod.get(periodKey)?.add(email);
        }
      }
    }
  }
  const eligibleMatchedEmails = new Set<string>();
  for (const set of eligibleEmailsByPeriod.values()) {
    for (const email of set) eligibleMatchedEmails.add(email);
  }

  const targetCurrency = String(combined.targetCurrency || "USD").toUpperCase();
  let stripeRows: StripeThroughMrrCustomerArrRow[] = [];
  if (eligibleMatchedEmails.size > 0) {
    try {
      const stripe = await queryStripeThroughMrrCustomerArrFromBigQuery(
        {
          startDate: previousMonthStartIso(payload.startDate),
          endDate: payload.endDate,
          targetCurrency,
          grain: "monthly",
        },
        STRIPE_QUERY_OPTIONS,
      );
      stripeRows = stripe.rows || [];
    } catch (error: unknown) {
      warnings.push(`Stripe customer MRR fetch failed: ${summarizeErrorMessage(error)}`);
    }
  }

  const valuesByEmail = new Map<string, Record<string, number>>();
  for (const email of eligibleMatchedEmails) {
    valuesByEmail.set(email, Object.fromEntries(periodKeys.map((key) => [key, 0])));
  }
  const allMonthlyMrrByEmail = new Map<string, Record<string, number>>();
  for (const email of eligibleMatchedEmails) {
    allMonthlyMrrByEmail.set(email, {});
  }

  for (const row of stripeRows) {
    const email = normalizeEmail(row.customerKey);
    if (!allMonthlyMrrByEmail.has(email)) continue;
    const periodKey = String(row.periodKey || "");
    if (!periodKey) continue;
    const periodMrr = round2(Number(row.arr || 0) / 12);
    const monthly = allMonthlyMrrByEmail.get(email)!;
    monthly[periodKey] = round2((monthly[periodKey] || 0) + periodMrr);
  }

  const totalMrrChangeByPeriod: Record<string, number> = Object.fromEntries(periodKeys.map((key) => [key, 0]));
  for (const email of eligibleMatchedEmails) {
    const monthly = allMonthlyMrrByEmail.get(email) || {};
    const bucket = valuesByEmail.get(email)!;
    for (const periodKey of periodKeys) {
      if (!eligibleEmailsByPeriod.get(periodKey)?.has(email)) continue;
      const currentMrr = round2(Number(monthly[periodKey] || 0));
      const prevMrr = round2(Number(monthly[previousIsoMonth(periodKey)] || 0));
      bucket[periodKey] = currentMrr;
      totalMrrChangeByPeriod[periodKey] = round2(
        Number(totalMrrChangeByPeriod[periodKey] || 0) + (currentMrr - prevMrr),
      );
    }
  }

  const emailRows: SelfserveExclusionsEmailRow[] = Array.from(valuesByEmail.entries())
    .map(([email, valuesByPeriod]) => {
      const totalMrr = round2(periodKeys.reduce((sum, key) => sum + Number(valuesByPeriod[key] || 0), 0));
      return {
        email,
        valuesByPeriod,
        totalMrr,
        totalArr: round2(totalMrr * 12),
      };
    })
    .sort((a, b) => {
      const diff = b.totalMrr - a.totalMrr;
      if (Math.abs(diff) > EPSILON) return diff;
      return a.email.localeCompare(b.email);
    });

  const periodSummary = periodMapFromRows(periods, emailRows, totalMrrChangeByPeriod);
  const periodsOut = periods.map((period) => {
    const summary = periodSummary.find((item) => item.key === period.key);
    return {
      key: period.key,
      label: period.label,
      totalMrr: summary?.totalMrr || 0,
      totalMrrChange: summary?.totalMrrChange || 0,
      totalArr: summary?.totalArr || 0,
      emailCount: summary?.emailCount || 0,
    };
  });

  return {
    startDate: payload.startDate,
    endDate: payload.endDate,
    targetCurrency,
    warnings,
    periods: periodsOut,
    emailRows,
    summary: {
      matchedEmailCount: eligibleMatchedEmails.size,
      emailsWithAnyMrr: emailRows.filter((row) => Math.abs(row.totalMrr) > EPSILON).length,
    },
  };
}

async function validateAndRun(body: Partial<ApiBody>) {
  const payload = parsePayload(body);
  const key = `api:selfserve-exclusions:${stableStringify(payload)}`;
  return getOrSetCache(key, CACHE_TTL_MS, () => buildReport(payload));
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Partial<ApiBody>;
    const report = await validateAndRun(body);
    return NextResponse.json(report);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") ||
      message.includes("endDate must be >= startDate")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const report = await validateAndRun({
      startDate: searchParams.get("startDate") || "",
      endDate: searchParams.get("endDate") || "",
    });
    return NextResponse.json(report);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") ||
      message.includes("endDate must be >= startDate")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
