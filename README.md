This is a Next.js ARR dashboard.

## Routes

- `/` HubSpot ARR report
- `/stripe` Stripe ARR report
- `/stripe-arr-correct` Stripe ARR (Correct) report
- `POST /api/report` HubSpot report API
- `GET|POST /api/stripe-report` Stripe report API
- `GET /api/stripe-report/export` Stripe full CSV export API (all filtered/grouped rows)
- `GET|POST /api/stripe-arr-correct-report` Stripe ARR (Correct) API (BigQuery profile)
- `GET /api/stripe-arr-correct-report/export` Stripe ARR (Correct) CSV export API
- `GET|POST /api/stripe-sync` Stripe sync API
- `GET /api/stripe-sync/status` Stripe sync health/status API

## Automatic Stripe Sync

Vercel cron runs Stripe sync automatically every 5 minutes:

- `*/5 * * * *` (`/api/stripe-sync`)

`/api/stripe-sync` accepts:

```json
{
  "startDate": "2025-01-01",
  "endDate": "2026-01-31",
  "force": false,
  "iterations": 12,
  "reset": false
}
```

`reset: true` clears existing sync state before backfilling again.

Use `/api/stripe-sync/status` to verify live progress. It returns:

- `stats.storage` (`vercel_blob` or `local_tmp`)
- `stats.itemCount`
- `stats.rangeExhausted`
- `secondsSinceUpdate`
- `healthy`

## Persistence Across Redeployments

Stripe sync state is persisted in Vercel Blob when configured.

Required for persistent shared storage:

- `BLOB_READ_WRITE_TOKEN`

Optional blob key path:

- `STRIPE_SYNC_BLOB_PATH` (default `arr/stripe-sync-store-v1.json`)

If blob token is missing, local `/tmp` fallback is used (not persistent across redeploys/instances).

## BigQuery Source (Optional)

You can read Stripe line items directly from BigQuery without removing blob sync.
Blob persistence code remains in place and can be switched back at any time.

Set:

- `STRIPE_DATA_SOURCE=bigquery`
- `GOOGLE_SERVICE_ACCOUNT_JSON` (or `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`)
- `BIGQUERY_PROJECT_ID` (optional if present in service account JSON)
- `BIGQUERY_STRIPE_TABLE` (full table id: `project.dataset.table`)
- `BIGQUERY_LOCATION` (optional, default `US`)
- `BIGQUERY_TS_UNIT` (`milliseconds` default, or `seconds`)
- `BIGQUERY_SCHEMA_MODE` (`int_ts` default, use `timestamp` for tables with TIMESTAMP columns like `period_start`/`period_end`)
- `BIGQUERY_STRIPE_SERVING_TABLE` (optional but recommended for speed; full table id with standardized int timestamp columns)
- `BIGQUERY_SERVING_TS_UNIT` (`milliseconds` default, or `seconds`; used only with `BIGQUERY_STRIPE_SERVING_TABLE`)

To keep Blob as source (default), set:

- `STRIPE_DATA_SOURCE=blob`

### Stripe ARR (Correct) BigQuery Profile

`/stripe-arr-correct` is pinned to BigQuery and uses profile-specific env vars when present.
Defaults are pinned to avoid inheriting old Stripe settings:

- table: `botpress-stripe-data-pipeline.stripe.invoice_lines_helper`
- schema mode: `int_ts`
- ts unit: `milliseconds`
- target currency: `USD`
- serving table: disabled unless `BIGQUERY_STRIPE_ARR_CORRECT_SERVING_TABLE` is explicitly set

Set these for the corrected source:

- `BIGQUERY_STRIPE_ARR_CORRECT_PROJECT_ID`
- `BIGQUERY_STRIPE_ARR_CORRECT_LOCATION` (optional, default fallback `BIGQUERY_LOCATION` then `US`)
- `BIGQUERY_STRIPE_ARR_CORRECT_TABLE` (full table id: `project.dataset.table`)
- `BIGQUERY_STRIPE_ARR_CORRECT_SERVING_TABLE` (optional)
- `BIGQUERY_STRIPE_ARR_CORRECT_SCHEMA_MODE` (optional; default fallback `BIGQUERY_SCHEMA_MODE`)
- `BIGQUERY_STRIPE_ARR_CORRECT_TS_UNIT` (optional; default fallback `BIGQUERY_TS_UNIT`)
- `BIGQUERY_STRIPE_ARR_CORRECT_SERVING_SCHEMA_MODE` (optional; default fallback `BIGQUERY_SERVING_SCHEMA_MODE`)
- `BIGQUERY_STRIPE_ARR_CORRECT_SERVING_TS_UNIT` (optional; default fallback `BIGQUERY_SERVING_TS_UNIT`)

Optional profile-specific credential and currency overrides:

- `GOOGLE_SERVICE_ACCOUNT_JSON_STRIPE_ARR_CORRECT` (or `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64_STRIPE_ARR_CORRECT`)
- `STRIPE_ARR_CORRECT_TARGET_CURRENCY`
- `STRIPE_ARR_CORRECT_DATA_SOURCE` (`bigquery` or `blob`; route currently forces BigQuery)

Expected BigQuery columns (or aliases in a view):

- `customer_id`, `invoice_id`
- `line_item_id`, `line_item_description`
- `amount_minor`, `currency`, `quantity`
- `period_start_ts`, `period_end_ts`, `invoice_created_ts`

If using raw TIMESTAMP columns (`amount`, `id`, `description`, `period_start`, `period_end`, `invoice_id`, `currency`, `quantity`), set:

- `BIGQUERY_SCHEMA_MODE=timestamp`

For fastest performance and to avoid timeout on large ranges, use a serving table (`BIGQUERY_STRIPE_SERVING_TABLE`) that already contains the standardized columns above.

### Create One Stripe Table Per `livemode` Folder

If your Stripe lake is in GCS (for example `gs://YOUR_BUCKET/livemode/<folder>/...`) and you want one BigQuery table per folder in `project.stripe`, run:

```bash
cd arr_calculator
GCS_BUCKET=YOUR_BUCKET \
BQ_PROJECT_ID=YOUR_PROJECT_ID \
BQ_DATASET=stripe \
BQ_LOCATION=US \
SOURCE_FORMAT=PARQUET \
GOOGLE_SERVICE_ACCOUNT_JSON="$(cat /path/to/service-account.json)" \
node scripts/create-livemode-folder-tables.mjs
```

Optional env vars:

- `LIVEMODE_PREFIX` (default `livemode/`)
- `GCS_FILE_GLOB` (default `*`; example `*.parquet`)
- `DRY_RUN=true` (prints SQL without creating tables)

This script creates/replaces **external tables** named from each immediate child folder under `livemode/`.

### Stripe Discount Handling (BigQuery)

If invoice discounts are stored at invoice level (not per line), use a serving view that:

- computes *realized* invoice discount from `invoices_view` totals (`subtotal + tax - total`)
- ignores discount codes that did not reduce money (`realized_discount = 0`)
- allocates realized discount proportionally across recurring discountable lines

SQL script (for this project):

- `sql/stripe_arr_serving_net_discount_v1.sql`

Recommended env values:

- `BIGQUERY_LOCATION=northamerica-northeast1`
- `BIGQUERY_STRIPE_TABLE=orbital-lantern-330119.stripe_views.stripe_arr_serving_net_discount_v1`
- `BIGQUERY_SCHEMA_MODE=int_ts`
- `BIGQUERY_TS_UNIT=milliseconds`

## Required Environment Variables

HubSpot:

- `HUBSPOT_PRIVATE_APP_TOKEN`
- `INCLUDED_DEALSTAGE`
- `FX_TARGET_CURRENCY`

Stripe:

- `STRIPE_SECRET_KEY`
- `STRIPE_INVOICE_STATUS` (optional, default `paid`)
- `STRIPE_TARGET_CURRENCY` (optional, default `USD`)
- `BLOB_READ_WRITE_TOKEN` (required for persistent sync store)

## Optional Tuning

- `CRON_SECRET` (recommended)
- `STRIPE_LINE_FETCH_CONCURRENCY` (default `8`)
- `STRIPE_REPORT_CACHE_TTL_MS` (default `300000`)
- `STRIPE_REPORT_AUTO_SYNC` (default `false`)
- `STRIPE_SYNC_FRESHNESS_MS` (default `900000`)
- `STRIPE_SYNC_MAX_HISTORY_DAYS` (default `800`)
- `STRIPE_SYNC_MAX_INVOICES_PER_RUN` (default `120`)
- `STRIPE_SYNC_CRON_ITERATIONS` (default `12`)
- `STRIPE_SYNC_MAX_RUNTIME_MS` (default `40000`)
- `STRIPE_SYNC_STORE_PATH` (local fallback path, default `/tmp/arr-stripe-sync-store.json`)
