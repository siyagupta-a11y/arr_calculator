-- Default target:
--   orbital-lantern-330119.stripe

CREATE TABLE IF NOT EXISTS `orbital-lantern-330119.stripe.upcoming_invoice_line_snapshots` (
  snapshot_date DATE NOT NULL,
  snapshot_ts TIMESTAMP NOT NULL,
  run_id STRING NOT NULL,
  customer_id STRING,
  subscription_id STRING,
  preview_currency STRING,
  line_fingerprint STRING NOT NULL,
  stripe_line_id STRING,
  price_id STRING,
  product_id STRING,
  description STRING,
  quantity NUMERIC,
  unit_amount_minor INT64,
  amount_minor INT64,
  currency STRING,
  period_start TIMESTAMP,
  period_end TIMESTAMP,
  raw_json STRING
)
PARTITION BY snapshot_date
CLUSTER BY customer_id, subscription_id, price_id;

CREATE TABLE IF NOT EXISTS `orbital-lantern-330119.stripe.upcoming_invoice_sync_runs` (
  run_id STRING NOT NULL,
  snapshot_date DATE NOT NULL,
  started_at TIMESTAMP NOT NULL,
  finished_at TIMESTAMP,
  status STRING NOT NULL,
  subscriptions_scanned INT64,
  lines_written INT64,
  error_message STRING
)
PARTITION BY snapshot_date
CLUSTER BY status;
