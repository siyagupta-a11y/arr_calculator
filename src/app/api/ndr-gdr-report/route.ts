import { NextResponse } from "next/server";
import {
  generateCombinedAllSubsReport,
  type CombinedAllSubsCombineMode,
  type CombinedAllSubsRequest,
} from "@/lib/combinedAllSubsReport";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 300;

const CACHE_TTL_MS = readTtlMs("API_NDR_GDR_CACHE_TTL_MS", 60_000);

type RequestBody = {
  startDate?: string;
  endDate?: string;
  combineMode?: string;
};

type CohortRow = {
  cohortKey: string;
  cohortLabel: string;
  cohortCustomerCount: number;
  cohortArr: number;
  ndrByPeriod: Record<string, number | null>;
  gdrByPeriod: Record<string, number | null>;
};

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeCombineMode(value: string | undefined): CombinedAllSubsCombineMode {
  return String(value || "").trim().toLowerCase() === "simple" ? "simple" : "grouped";
}

function round2(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

async function buildNdrGdrReport(payload: {
  startDate: string;
  endDate: string;
  combineMode: CombinedAllSubsCombineMode;
}) {
  const combinedRequest: CombinedAllSubsRequest = {
    startDate: payload.startDate,
    endDate: payload.endDate,
    combineMode: payload.combineMode,
    displayMode: "arr",
    planGrain: "monthly",
    includeSalesAssist: false,
  };
  const combined = await generateCombinedAllSubsReport(combinedRequest);
  const periods = (combined.periods || []).map((period) => ({
    key: String(period.key || ""),
    label: String(period.label || period.key || ""),
  }));
  const periodKeys = periods.map((period) => period.key);
  const cohortAgg = periods.map((period, idx) => ({
    cohortKey: period.key,
    cohortLabel: period.label,
    cohortIndex: idx,
    cohortCustomerCount: 0,
    cohortArr: 0,
    ndrNumeratorByPeriod: new Map<string, number>(),
    gdrNumeratorByPeriod: new Map<string, number>(),
  }));

  for (const row of combined.rows || []) {
    const values = row.valuesByPeriod || {};
    for (let cohortIdx = 0; cohortIdx < periodKeys.length; cohortIdx += 1) {
      const cohortKey = periodKeys[cohortIdx];
      const cohortArrForCustomer = Math.max(0, Number(values[cohortKey] || 0));
      if (cohortArrForCustomer <= 0) continue;

      const agg = cohortAgg[cohortIdx];
      agg.cohortCustomerCount += 1;
      agg.cohortArr = round2(agg.cohortArr + cohortArrForCustomer);

      for (let observedIdx = cohortIdx; observedIdx < periodKeys.length; observedIdx += 1) {
        const observedKey = periodKeys[observedIdx];
        const observedArrForCustomer = Math.max(0, Number(values[observedKey] || 0));

        agg.ndrNumeratorByPeriod.set(
          observedKey,
          round2((agg.ndrNumeratorByPeriod.get(observedKey) || 0) + observedArrForCustomer),
        );
        agg.gdrNumeratorByPeriod.set(
          observedKey,
          round2((agg.gdrNumeratorByPeriod.get(observedKey) || 0) + Math.min(observedArrForCustomer, cohortArrForCustomer)),
        );
      }
    }
  }

  const cohorts: CohortRow[] = cohortAgg.map((agg) => {
    const ndrByPeriod: Record<string, number | null> = {};
    const gdrByPeriod: Record<string, number | null> = {};
    for (let observedIdx = 0; observedIdx < periodKeys.length; observedIdx += 1) {
      const observedKey = periodKeys[observedIdx];
      if (observedIdx < agg.cohortIndex) {
        ndrByPeriod[observedKey] = null;
        gdrByPeriod[observedKey] = null;
        continue;
      }
      if (agg.cohortArr <= 0) {
        ndrByPeriod[observedKey] = 0;
        gdrByPeriod[observedKey] = 0;
        continue;
      }
      const ndrNumerator = Number(agg.ndrNumeratorByPeriod.get(observedKey) || 0);
      const gdrNumerator = Number(agg.gdrNumeratorByPeriod.get(observedKey) || 0);
      ndrByPeriod[observedKey] = round2((ndrNumerator / agg.cohortArr) * 100);
      gdrByPeriod[observedKey] = round2((gdrNumerator / agg.cohortArr) * 100);
    }

    return {
      cohortKey: agg.cohortKey,
      cohortLabel: agg.cohortLabel,
      cohortCustomerCount: agg.cohortCustomerCount,
      cohortArr: round2(agg.cohortArr),
      ndrByPeriod,
      gdrByPeriod,
    };
  });

  return {
    startDate: combined.startDate,
    endDate: combined.endDate,
    combineMode: combined.combineMode,
    targetCurrency: combined.targetCurrency,
    warnings: combined.warnings || [],
    periods,
    cohorts,
  };
}

async function validateAndRun(body: Partial<RequestBody>) {
  const startDate = String(body.startDate || "").trim();
  const endDate = String(body.endDate || "").trim();
  const combineMode = normalizeCombineMode(body.combineMode);
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    throw new Error("Invalid startDate/endDate");
  }
  if (endDate < startDate) {
    throw new Error("endDate must be >= startDate");
  }

  const key = `api:ndr-gdr:${stableStringify({ startDate, endDate, combineMode })}`;
  return getOrSetCache(key, CACHE_TTL_MS, () => buildNdrGdrReport({ startDate, endDate, combineMode }));
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Partial<RequestBody>;
    const report = await validateAndRun(body);
    return NextResponse.json(report);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") || message.includes("endDate must be >= startDate") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const report = await validateAndRun({
      startDate: searchParams.get("startDate") || "",
      endDate: searchParams.get("endDate") || "",
      combineMode: searchParams.get("combineMode") || "grouped",
    });
    return NextResponse.json(report);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") || message.includes("endDate must be >= startDate") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
