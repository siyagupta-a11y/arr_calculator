import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { queryBambooHrFullTimeRosterByDate } from "@/lib/bamboohr";
import { assertAdmin } from "@/lib/precomputedFacts";
import { insertBigQueryRows, runBigQuerySqlRows } from "@/lib/stripeBigquery";

export const runtime = "nodejs";
export const maxDuration = 180;

const PRECOMPUTED_TABLE_PROJECT = String(process.env.PRECOMPUTED_TABLES_PROJECT || "botpress-stripe-data-pipeline")
  .trim() || "botpress-stripe-data-pipeline";
const PRECOMPUTED_TABLE_DATASET = String(process.env.PRECOMPUTED_TABLES_DATASET || "precomputed_tables")
  .trim() || "precomputed_tables";
const PRECOMPUTED_TABLE_COMBINED_BILLING = String(
  process.env.PRECOMPUTED_TABLE_COMBINED_BILLING_OVERVIEW_MONTHLY || "combined_billing_overview_monthly_cache",
).trim() || "combined_billing_overview_monthly_cache";

const RANGE_PREFIX = "api:combined-billing-overview:range:";
const CANONICAL_PREFIX = "api:combined-billing-overview:{";

type RequestBody = {
  startDate?: string;
  endDate?: string;
  includeRangeKeys?: boolean;
  includeCanonicalKeys?: boolean;
};

type CacheRow = {
  cache_key: string;
  include_cac: boolean;
  canonical_start_date: string;
  canonical_end_date: string;
  payload_json: string;
};

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function parseIsoDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month ||
    parsed.getUTCDate() !== day
  ) return null;
  return parsed;
}

function toIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function monthKeyFromDate(value: Date) {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthEndIso(monthKey: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) return "";
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  return toIsoDate(new Date(Date.UTC(year, month + 1, 0)));
}

function monthKeysBetween(startDate: string, endDate: string) {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (!start || !end || end.getTime() < start.getTime()) return [];
  const out: string[] = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endMonthStart = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor.getTime() <= endMonthStart.getTime()) {
    out.push(monthKeyFromDate(cursor));
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return out;
}

function monthKeyFromPoint(point: Record<string, unknown>) {
  const key = String(point.key || "").trim();
  if (/^\d{4}-\d{2}$/.test(key)) return key;
  const periodStart = String(point.periodStart || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) return periodStart.slice(0, 7);
  return "";
}

function round2(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function validateIdentifier(value: string, fallback: string) {
  const normalized = String(value || "").trim() || fallback;
  if (!/^[A-Za-z0-9_]+$/.test(normalized)) {
    throw new Error(`Invalid BigQuery identifier: ${normalized}`);
  }
  return normalized;
}

function tableParts() {
  const project = String(PRECOMPUTED_TABLE_PROJECT || "").trim() || "botpress-stripe-data-pipeline";
  if (!/^[A-Za-z0-9_-]+$/.test(project)) {
    throw new Error(`Invalid BigQuery project id: ${project}`);
  }
  const dataset = validateIdentifier(PRECOMPUTED_TABLE_DATASET, "precomputed_tables");
  const table = validateIdentifier(PRECOMPUTED_TABLE_COMBINED_BILLING, "combined_billing_overview_monthly_cache");
  return {
    project,
    dataset,
    table,
    tableRef: `\`${project}.${dataset}.${table}\``,
  };
}

async function listLatestCacheRows(args: {
  startDate: string;
  endDate: string;
  includeRangeKeys: boolean;
  includeCanonicalKeys: boolean;
}) {
  const { tableRef } = tableParts();
  const rows = await runBigQuerySqlRows(
    `
SELECT
  cache_key,
  include_cac,
  CAST(canonical_start_date AS STRING) AS canonical_start_date,
  CAST(canonical_end_date AS STRING) AS canonical_end_date,
  payload_json
FROM ${tableRef}
WHERE canonical_end_date >= DATE(@start_date)
  AND canonical_start_date <= DATE(@end_date)
  AND (
    (@include_range = 1 AND STARTS_WITH(cache_key, @range_prefix))
    OR
    (@include_canonical = 1 AND STARTS_WITH(cache_key, @canonical_prefix))
  )
QUALIFY ROW_NUMBER() OVER (PARTITION BY cache_key ORDER BY generated_at DESC) = 1
ORDER BY canonical_start_date ASC, canonical_end_date ASC
LIMIT 3000
`,
    [
      { name: "start_date", type: "STRING", value: args.startDate },
      { name: "end_date", type: "STRING", value: args.endDate },
      { name: "include_range", type: "INT64", value: args.includeRangeKeys ? "1" : "0" },
      { name: "include_canonical", type: "INT64", value: args.includeCanonicalKeys ? "1" : "0" },
      { name: "range_prefix", type: "STRING", value: RANGE_PREFIX },
      { name: "canonical_prefix", type: "STRING", value: CANONICAL_PREFIX },
    ],
    { profile: "stripe_arr_correct" },
  );
  return rows as CacheRow[];
}

type UpdateRowArgs = {
  cacheKey: string;
  includeCac: boolean;
  canonicalStartDate: string;
  canonicalEndDate: string;
  payloadJson: string;
};

async function rewriteCacheRows(rows: UpdateRowArgs[]) {
  if (!rows.length) return;
  const { project, dataset, table } = tableParts();
  await insertBigQueryRows({
    projectId: project,
    dataset,
    table,
    rows: rows.map((row) => ({
      cache_key: row.cacheKey,
      include_cac: row.includeCac,
      canonical_start_date: row.canonicalStartDate,
      canonical_end_date: row.canonicalEndDate,
      generated_at: new Date().toISOString(),
      payload_json: row.payloadJson,
    })),
    options: { profile: "stripe_arr_correct" },
  });
}

export async function POST(req: NextRequest) {
  try {
    await assertAdmin(req);
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as RequestBody;
    const startDate = String(body.startDate || "").trim();
    const endDate = String(body.endDate || "").trim();
    const includeRangeKeys = body.includeRangeKeys !== false;
    const includeCanonicalKeys = body.includeCanonicalKeys !== false;

    if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
      return NextResponse.json({ ok: false, error: "Invalid startDate/endDate" }, { status: 400 });
    }
    if (endDate < startDate) {
      return NextResponse.json({ ok: false, error: "endDate must be >= startDate" }, { status: 400 });
    }
    if (!includeRangeKeys && !includeCanonicalKeys) {
      return NextResponse.json({ ok: false, error: "At least one cache key type must be included" }, { status: 400 });
    }

    const targetMonths = new Set(monthKeysBetween(startDate, endDate));
    if (!targetMonths.size) {
      return NextResponse.json({ ok: true, scannedRows: 0, updatedRows: 0, touchedMonths: [] });
    }

    const latestRows = await listLatestCacheRows({
      startDate,
      endDate,
      includeRangeKeys,
      includeCanonicalKeys,
    });
    if (!latestRows.length) {
      return NextResponse.json({
        ok: true,
        scannedRows: 0,
        candidateRows: 0,
        updatedRows: 0,
        touchedMonths: Array.from(targetMonths),
        message: "No overlapping combined billing cache rows found.",
      });
    }

    const parsedRows = latestRows
      .map((row) => {
        try {
          const payload = JSON.parse(String(row.payload_json || "")) as Record<string, unknown>;
          const arrPerEmployeePoints = Array.isArray(payload.arrPerEmployeePoints) ? payload.arrPerEmployeePoints : [];
          return {
            row,
            payload,
            arrPerEmployeePoints: arrPerEmployeePoints as Array<Record<string, unknown>>,
          };
        } catch {
          return null;
        }
      })
      .filter((value): value is {
        row: CacheRow;
        payload: Record<string, unknown>;
        arrPerEmployeePoints: Array<Record<string, unknown>>;
      } => !!value);

    const snapshotDates = new Set<string>();
    for (const item of parsedRows) {
      for (const point of item.arrPerEmployeePoints) {
        const monthKey = monthKeyFromPoint(point);
        if (!monthKey || !targetMonths.has(monthKey)) continue;
        const snapshot = monthEndIso(monthKey);
        if (snapshot) snapshotDates.add(snapshot);
      }
    }

    if (!snapshotDates.size) {
      return NextResponse.json({
        ok: true,
        scannedRows: latestRows.length,
        candidateRows: parsedRows.length,
        updatedRows: 0,
        touchedMonths: Array.from(targetMonths),
        message: "No ARR/FTE monthly points found in selected range.",
      });
    }

    const rosterByDate = await queryBambooHrFullTimeRosterByDate(Array.from(snapshotDates).sort());
    const rewriteRows: UpdateRowArgs[] = [];
    let updatedRows = 0;

    for (const item of parsedRows) {
      let touchedPoint = false;
      const nextPoints = item.arrPerEmployeePoints.map((point) => {
        const monthKey = monthKeyFromPoint(point);
        if (!monthKey || !targetMonths.has(monthKey)) return point;
        const snapshot = monthEndIso(monthKey);
        const roster = rosterByDate.get(snapshot);
        const fullTimeEmployees = Math.max(0, Math.round(Number(roster?.count || 0)));
        const arr = round2(Number(point.arr || 0));
        const nextPoint: Record<string, unknown> = {
          ...point,
          arr,
          fullTimeEmployees,
          arrPerEmployee: fullTimeEmployees > 0 ? round2(arr / fullTimeEmployees) : 0,
          employeeNames: roster?.employeeNames || [],
        };
        touchedPoint = true;
        return nextPoint;
      });
      if (!touchedPoint) continue;

      item.payload.arrPerEmployeePoints = nextPoints;
      const anyPositive = nextPoints.some((point) => Math.max(0, Math.round(Number(point.fullTimeEmployees || 0))) > 0);
      item.payload.arrPerEmployeeNotice = anyPositive
        ? null
        : "BambooHR returned no full-time employee counts for this range.";

      rewriteRows.push({
        cacheKey: item.row.cache_key,
        includeCac: Boolean(item.row.include_cac),
        canonicalStartDate: item.row.canonical_start_date,
        canonicalEndDate: item.row.canonical_end_date,
        payloadJson: JSON.stringify(item.payload),
      });
      updatedRows += 1;
    }

    await rewriteCacheRows(rewriteRows);

    return NextResponse.json({
      ok: true,
      scannedRows: latestRows.length,
      candidateRows: parsedRows.length,
      updatedRows,
      rewrittenRows: rewriteRows.length,
      touchedMonths: Array.from(targetMonths).sort(),
      snapshotDatesQueried: Array.from(snapshotDates).sort(),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
