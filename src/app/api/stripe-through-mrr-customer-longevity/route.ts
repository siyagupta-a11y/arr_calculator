import { NextResponse } from "next/server";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";
import { runBigQuerySqlRows, type StripeBigQueryProfile } from "@/lib/stripeBigquery";

export const runtime = "nodejs";
export const maxDuration = 180;

const CACHE_TTL_MS = readTtlMs("API_STRIPE_THROUGH_MRR_CUSTOMER_LONGEVITY_CACHE_TTL_MS", 10 * 60 * 1000);
const STRIPE_THROUGH_MRR_OPTIONS: { profile: StripeBigQueryProfile } = {
  profile: "stripe_arr_correct",
};

type ApiBody = {
  startDate?: string;
  endDate?: string;
  includeDetails?: boolean;
};

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function mrrChangeTable() {
  const configured = String(process.env.BIGQUERY_STRIPE_ARR_CORRECT_MRR_CHANGE_TABLE || "").trim();
  const fallback = "botpress-stripe-data-pipeline.stripe.subscription_item_change_events_v2_beta";
  const table = configured || fallback;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(table)) {
    throw new Error(`Invalid BigQuery table identifier: ${table}`);
  }
  return table;
}

function customersTable() {
  const configured = String(process.env.BIGQUERY_STRIPE_CUSTOMERS_TABLE || "").trim();
  const fallback = "botpress-stripe-data-pipeline.stripe.customers";
  const table = configured || fallback;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(table)) {
    throw new Error(`Invalid BigQuery table identifier: ${table}`);
  }
  return table;
}

type CreatedCustomerMatchRow = {
  customerId: string;
  email: string;
};

async function computeCreatedCustomersWithSameMonthMrr(
  startDate: string,
  endDate: string,
  includeDetails: boolean,
) {
  const mrrTable = mrrChangeTable();
  const customerTable = customersTable();
  const rows = await runBigQuerySqlRows(
    `
WITH bounds AS (
  SELECT
    DATE(@start_date) AS start_date,
    DATE(@end_date) AS end_date,
    DATE_TRUNC(DATE(@end_date), MONTH) AS end_month
),
customer_month_changes AS (
  SELECT
    DATE_TRUNC(DATE(event_timestamp), MONTH) AS month_start,
    TRIM(CAST(customer_id AS STRING)) AS customer_id,
    SUM(COALESCE(CAST(mrr_change AS FLOAT64), 0)) AS net_change
  FROM \`${mrrTable}\`, bounds
  WHERE DATE(event_timestamp) <= bounds.end_date
    AND customer_id IS NOT NULL
    AND TRIM(CAST(customer_id AS STRING)) != ''
  GROUP BY 1, 2
),
customer_month_mrr AS (
  SELECT
    customer_id,
    month_start,
    SUM(net_change) OVER (
      PARTITION BY customer_id
      ORDER BY month_start
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS month_end_mrr
  FROM customer_month_changes
),
customer_created_raw AS (
  SELECT
    TRIM(CAST(c.id AS STRING)) AS customer_id,
    NULLIF(TRIM(CAST(c.email AS STRING)), '') AS email,
    DATE(
      COALESCE(
        SAFE_CAST(NULLIF(TRIM(CAST(c.created AS STRING)), '') AS TIMESTAMP),
        CASE
          WHEN REGEXP_CONTAINS(NULLIF(TRIM(CAST(c.created AS STRING)), ''), r'^\\d{13,}$')
            THEN TIMESTAMP_MILLIS(SAFE_CAST(TRIM(CAST(c.created AS STRING)) AS INT64))
          WHEN REGEXP_CONTAINS(NULLIF(TRIM(CAST(c.created AS STRING)), ''), r'^\\d{10}$')
            THEN TIMESTAMP_SECONDS(SAFE_CAST(TRIM(CAST(c.created AS STRING)) AS INT64))
          ELSE NULL
        END
      )
    ) AS created_date
  FROM \`${customerTable}\` c
),
customer_created AS (
  SELECT
    customer_id,
    COALESCE(ARRAY_AGG(email IGNORE NULLS LIMIT 1)[OFFSET(0)], '') AS email,
    MIN(created_date) AS created_date,
    DATE_TRUNC(MIN(created_date), MONTH) AS created_month
  FROM customer_created_raw
  WHERE customer_id IS NOT NULL
    AND customer_id != ''
    AND created_date IS NOT NULL
  GROUP BY customer_id
),
created_in_range AS (
  SELECT
    c.customer_id,
    c.email,
    c.created_month
  FROM customer_created c, bounds b
  WHERE c.created_date BETWEEN b.start_date AND b.end_date
),
matched AS (
  SELECT
    r.customer_id,
    COALESCE(r.email, '') AS email
  FROM created_in_range r
  LEFT JOIN customer_month_mrr m
    ON m.customer_id = r.customer_id
   AND m.month_start = r.created_month
  WHERE COALESCE(m.month_end_mrr, 0) > 0
)
SELECT
  customer_id,
  email
FROM matched
ORDER BY customer_id
`,
    [
      { name: "start_date", type: "STRING", value: startDate },
      { name: "end_date", type: "STRING", value: endDate },
    ],
    STRIPE_THROUGH_MRR_OPTIONS,
  );
  const detailRows: CreatedCustomerMatchRow[] = rows.map((row) => ({
    customerId: String(row.customer_id || "").trim(),
    email: String(row.email || "").trim(),
  })).filter((row) => row.customerId);
  return {
    count: detailRows.length,
    rows: includeDetails ? detailRows : [],
  };
}

async function validateAndRun(body: Partial<ApiBody>) {
  const startDate = String(body.startDate || "").trim();
  const endDate = String(body.endDate || "").trim();
  const includeDetails = body.includeDetails === true;
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    throw new Error("Invalid startDate/endDate");
  }
  if (endDate < startDate) {
    throw new Error("endDate must be >= startDate");
  }
  const key = `api:stripe-through-mrr-customer-longevity:${stableStringify({ startDate, endDate })}`;
  const payload = await getOrSetCache(key, CACHE_TTL_MS, () =>
    computeCreatedCustomersWithSameMonthMrr(startDate, endDate, true),
  );
  return {
    startDate,
    endDate,
    createdCustomersWithSameMonthMrrCount: Number(payload.count || 0),
    rows: includeDetails ? payload.rows : [],
  };
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Partial<ApiBody>;
    const report = await validateAndRun(body);
    return NextResponse.json(report);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
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
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") ||
      message.includes("endDate must be >= startDate")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
