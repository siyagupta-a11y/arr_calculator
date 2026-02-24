-- Default target:
--   orbital-lantern-330119.stripe

CREATE OR REPLACE VIEW `orbital-lantern-330119.stripe.latest_upcoming_invoice_line_snapshots` AS
SELECT
  snapshot_date,
  snapshot_ts,
  run_id,
  customer_id,
  subscription_id,
  preview_currency,
  line_fingerprint,
  stripe_line_id,
  price_id,
  product_id,
  description,
  quantity,
  unit_amount_minor,
  amount_minor,
  currency,
  period_start,
  period_end,
  raw_json
FROM (
  SELECT
    s.*,
    ROW_NUMBER() OVER (
      PARTITION BY s.customer_id, s.subscription_id, s.line_fingerprint
      ORDER BY s.snapshot_ts DESC
    ) AS rn
  FROM `orbital-lantern-330119.stripe.upcoming_invoice_line_snapshots` s
)
WHERE rn = 1;
