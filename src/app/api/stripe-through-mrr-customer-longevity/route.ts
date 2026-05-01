import { NextResponse } from "next/server";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";
import { runBigQuerySqlRows, type StripeBigQueryProfile } from "@/lib/stripeBigquery";

export const runtime = "nodejs";
export const maxDuration = 180;

const CACHE_TTL_MS = readTtlMs("API_STRIPE_THROUGH_MRR_CUSTOMER_LONGEVITY_CACHE_TTL_MS", 10 * 60 * 1000);
const METRIC_VERSION = "v2_email_grouped";
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

function invoiceLinesHelperTable() {
  const configured = String(process.env.BIGQUERY_STRIPE_ARR_CORRECT_TABLE || "").trim();
  const fallback = "botpress-stripe-data-pipeline.stripe.invoice_lines_helper";
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
  const lineItemsTable = invoiceLinesHelperTable();
  const customerTable = customersTable();
  const rows = await runBigQuerySqlRows(
    `
WITH bounds AS (
  SELECT
    DATE(@start_date) AS start_date,
    DATE(@end_date) AS end_date
),
customer_created_raw AS (
  SELECT
    TRIM(CAST(c.id AS STRING)) AS customer_id,
    NULLIF(LOWER(TRIM(CAST(c.email AS STRING))), '') AS email,
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
customer_profile AS (
  SELECT
    customer_id,
    COALESCE(ARRAY_AGG(email IGNORE NULLS ORDER BY created_date ASC LIMIT 1)[OFFSET(0)], '') AS email,
    MIN(created_date) AS created_date
  FROM customer_created_raw
  WHERE customer_id IS NOT NULL
    AND customer_id != ''
    AND created_date IS NOT NULL
  GROUP BY customer_id
),
email_created AS (
  SELECT
    email,
    MIN(created_date) AS earliest_created_date,
    DATE_TRUNC(MIN(created_date), MONTH) AS earliest_created_month,
    ARRAY_AGG(customer_id ORDER BY created_date ASC LIMIT 1)[OFFSET(0)] AS earliest_customer_id
  FROM customer_profile
  WHERE email IS NOT NULL
    AND email != ''
  GROUP BY email
),
email_line_item_months AS (
  SELECT
    cp.email AS email,
    DATE_TRUNC(
      DATE(
        COALESCE(
          SAFE_CAST(il.period_start_at AS TIMESTAMP),
          TIMESTAMP_MILLIS(SAFE_CAST(il.period_start_ts AS INT64))
        )
      ),
      MONTH
    ) AS line_item_month
  FROM \`${lineItemsTable}\` il
  JOIN customer_profile cp
    ON cp.customer_id = TRIM(CAST(il.customer_id AS STRING))
  WHERE cp.email IS NOT NULL
    AND cp.email != ''
    AND COALESCE(CAST(il.amount_minor AS FLOAT64), 0) > 0
),
email_earliest_line_item_month AS (
  SELECT
    email,
    MIN(line_item_month) AS earliest_line_item_month
  FROM email_line_item_months
  WHERE line_item_month IS NOT NULL
  GROUP BY email
),
matched AS (
  SELECT
    ec.earliest_customer_id AS customer_id,
    ec.email AS email
  FROM email_created ec
  JOIN email_earliest_line_item_month ep
    ON ep.email = ec.email
  CROSS JOIN bounds b
  WHERE ec.earliest_created_date BETWEEN b.start_date AND b.end_date
    AND ep.earliest_line_item_month = ec.earliest_created_month
)
SELECT
  customer_id,
  email
FROM matched
ORDER BY email
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
  const key = `api:stripe-through-mrr-customer-longevity:${stableStringify({ version: METRIC_VERSION, startDate, endDate })}`;
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
