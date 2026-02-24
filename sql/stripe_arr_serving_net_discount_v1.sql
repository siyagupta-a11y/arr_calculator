-- Location: northamerica-northeast1
-- Purpose:
--   Build a Stripe ARR serving view that:
--   1) ignores "coupon attached but no money reduced" false positives, and
--   2) allocates realized invoice-level discount proportionally to recurring lines.
--
-- Output columns match the app's expected BigQuery schema:
--   customer_id, invoice_id, line_item_id, line_item_description,
--   amount_minor, currency, quantity, period_start_ts, period_end_ts, invoice_created_ts
--
-- Note:
--   In this project, source `invoice_lines_view.amount` is in cents, while the app's
--   expected `amount_minor` behaves like major currency units (same pattern as
--   `stripe.invoice_lines_helper.amount_minor`). This view outputs major units.

CREATE OR REPLACE VIEW `orbital-lantern-330119.stripe_views.stripe_arr_serving_net_discount_v1` AS
WITH recurring_lines AS (
  SELECT
    il.invoice_id,
    il.id AS line_item_id,
    COALESCE(NULLIF(TRIM(il.description), ''), il.id) AS line_item_description,
    SAFE_DIVIDE(CAST(il.amount AS NUMERIC), 100) AS gross_amount_major,
    il.currency,
    COALESCE(il.quantity, 1) AS quantity,
    il.discountable,
    il.period_start,
    il.period_end
  FROM `orbital-lantern-330119.stripe.invoice_lines_view` il
  WHERE il.type = 'subscription'
    AND il.amount > 0
    AND il.period_end > il.period_start
),
invoice_discount_base AS (
  SELECT
    rl.invoice_id,
    SUM(CASE WHEN rl.discountable THEN rl.gross_amount_major ELSE CAST(0 AS NUMERIC) END) AS discountable_gross_major
  FROM recurring_lines rl
  GROUP BY rl.invoice_id
),
net_lines AS (
  SELECT
    inv.customer_id,
    rl.invoice_id,
    rl.line_item_id,
    rl.line_item_description,
    inv.created AS invoice_created_at,
    rl.currency,
    rl.quantity,
    rl.period_start,
    rl.period_end,
    rl.gross_amount_major,
    GREATEST(
      SAFE_DIVIDE(
        CAST(COALESCE(inv.subtotal, 0) + COALESCE(inv.tax, 0) - COALESCE(inv.total, 0) AS NUMERIC),
        100
      ),
      0
    ) AS realized_invoice_discount_major,
    COALESCE(idb.discountable_gross_major, 0) AS discountable_gross_major,
    CASE
      WHEN rl.discountable
        AND GREATEST(
          SAFE_DIVIDE(
            CAST(COALESCE(inv.subtotal, 0) + COALESCE(inv.tax, 0) - COALESCE(inv.total, 0) AS NUMERIC),
            100
          ),
          0
        ) > 0
        AND COALESCE(idb.discountable_gross_major, 0) > 0
      THEN LEAST(
        rl.gross_amount_major,
        SAFE_DIVIDE(
          GREATEST(
            SAFE_DIVIDE(
              CAST(COALESCE(inv.subtotal, 0) + COALESCE(inv.tax, 0) - COALESCE(inv.total, 0) AS NUMERIC),
              100
            ),
            0
          ) * rl.gross_amount_major,
          idb.discountable_gross_major
        )
      )
      ELSE CAST(0 AS NUMERIC)
    END AS allocated_discount_major
  FROM recurring_lines rl
  JOIN `orbital-lantern-330119.stripe.invoices_view` inv
    ON inv.id = rl.invoice_id
  LEFT JOIN invoice_discount_base idb
    ON idb.invoice_id = rl.invoice_id
  WHERE inv.status = 'paid'
)
SELECT
  CAST(customer_id AS STRING) AS customer_id,
  CAST(invoice_id AS STRING) AS invoice_id,
  CAST(line_item_id AS STRING) AS line_item_id,
  CAST(line_item_description AS STRING) AS line_item_description,
  ROUND(CAST(gross_amount_major - allocated_discount_major AS FLOAT64), 6) AS amount_minor,
  LOWER(CAST(currency AS STRING)) AS currency,
  CAST(quantity AS FLOAT64) AS quantity,
  CAST(UNIX_MILLIS(period_start) AS INT64) AS period_start_ts,
  CAST(UNIX_MILLIS(period_end) AS INT64) AS period_end_ts,
  CAST(UNIX_MILLIS(invoice_created_at) AS INT64) AS invoice_created_ts,
  -- Optional debug columns:
  ROUND(CAST(gross_amount_major AS FLOAT64), 6) AS gross_amount_major,
  ROUND(CAST(allocated_discount_major AS FLOAT64), 6) AS allocated_discount_major,
  ROUND(CAST(realized_invoice_discount_major AS FLOAT64), 6) AS realized_invoice_discount_major
FROM net_lines;
