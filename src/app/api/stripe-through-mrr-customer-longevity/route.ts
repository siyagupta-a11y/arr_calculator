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

async function computeNewAndStillCustomersCount(startDate: string, endDate: string) {
  const table = mrrChangeTable();
  const rows = await runBigQuerySqlRows(
    `
WITH bounds AS (
  SELECT
    DATE(@start_date) AS start_date,
    DATE(@end_date) AS end_date,
    DATE_TRUNC(DATE(@start_date), MONTH) AS start_month,
    DATE_TRUNC(DATE(@end_date), MONTH) AS end_month
),
months AS (
  SELECT month_start
  FROM bounds,
  UNNEST(GENERATE_DATE_ARRAY(start_month, end_month, INTERVAL 1 MONTH)) AS month_start
),
customer_month_changes AS (
  SELECT
    DATE_TRUNC(DATE(event_timestamp), MONTH) AS month_start,
    TRIM(CAST(customer_id AS STRING)) AS customer_id,
    SUM(COALESCE(CAST(mrr_change AS FLOAT64), 0)) AS net_change
  FROM \`${table}\`, bounds
  WHERE DATE(event_timestamp) <= bounds.end_date
    AND customer_id IS NOT NULL
    AND TRIM(CAST(customer_id AS STRING)) != ''
  GROUP BY 1, 2
),
customers AS (
  SELECT DISTINCT customer_id
  FROM customer_month_changes
),
baseline AS (
  SELECT
    c.customer_id,
    COALESCE(SUM(IF(cm.month_start < bounds.start_month, cm.net_change, 0)), 0) AS baseline_mrr
  FROM customers c
  CROSS JOIN bounds
  LEFT JOIN customer_month_changes cm
    ON cm.customer_id = c.customer_id
  GROUP BY 1
),
grid AS (
  SELECT
    c.customer_id,
    m.month_start
  FROM customers c
  CROSS JOIN months m
),
month_grid AS (
  SELECT
    g.customer_id,
    g.month_start,
    COALESCE(cm.net_change, 0) AS net_change,
    b.baseline_mrr
  FROM grid g
  LEFT JOIN customer_month_changes cm
    ON cm.customer_id = g.customer_id
   AND cm.month_start = g.month_start
  JOIN baseline b
    ON b.customer_id = g.customer_id
),
mrr_by_month AS (
  SELECT
    customer_id,
    month_start,
    baseline_mrr + SUM(net_change) OVER (
      PARTITION BY customer_id
      ORDER BY month_start
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS month_end_mrr,
    baseline_mrr + COALESCE(SUM(net_change) OVER (
      PARTITION BY customer_id
      ORDER BY month_start
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ), 0) AS prev_month_end_mrr
  FROM month_grid
),
first_new_month AS (
  SELECT
    customer_id,
    MIN(month_start) AS first_new_month
  FROM mrr_by_month
  WHERE prev_month_end_mrr <= 0
    AND month_end_mrr > 0
  GROUP BY 1
),
continuous_since_new AS (
  SELECT
    f.customer_id
  FROM first_new_month f
  JOIN mrr_by_month m
    ON m.customer_id = f.customer_id
   AND m.month_start >= f.first_new_month
  GROUP BY 1
  HAVING MIN(m.month_end_mrr) > 0
)
SELECT COUNT(*) AS customer_count
FROM continuous_since_new
`,
    [
      { name: "start_date", type: "STRING", value: startDate },
      { name: "end_date", type: "STRING", value: endDate },
    ],
    STRIPE_THROUGH_MRR_OPTIONS,
  );
  return Number(rows[0]?.customer_count || 0);
}

async function validateAndRun(body: Partial<ApiBody>) {
  const startDate = String(body.startDate || "").trim();
  const endDate = String(body.endDate || "").trim();
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    throw new Error("Invalid startDate/endDate");
  }
  if (endDate < startDate) {
    throw new Error("endDate must be >= startDate");
  }
  const key = `api:stripe-through-mrr-customer-longevity:${stableStringify({ startDate, endDate })}`;
  const newAndStillCustomerCount = await getOrSetCache(key, CACHE_TTL_MS, () =>
    computeNewAndStillCustomersCount(startDate, endDate),
  );
  return {
    startDate,
    endDate,
    newAndStillCustomerCount,
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
