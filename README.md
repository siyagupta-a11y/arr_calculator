This is a Next.js ARR dashboard.

## Routes

- `/` HubSpot ARR report
- `/stripe` Stripe ARR report (POC window only)
- `POST /api/report` HubSpot report API
- `POST /api/stripe-report` Stripe report API
- `GET|POST /api/stripe-sync` Stripe sync API
- `GET /api/stripe-sync/status` Stripe sync health/status API

## Stripe POC Scope

This proof of concept is intentionally restricted to:

- `2025-11-01` through `2026-01-31`
- Months: November 2025, December 2025, January 2026

Requests outside this range are clamped or rejected.

## Automatic Stripe Sync

Vercel cron runs Stripe sync automatically every 5 minutes:

- `*/5 * * * *` (`/api/stripe-sync`)

`/api/stripe-sync` accepts:

```json
{
  "startDate": "2025-11-01",
  "endDate": "2026-01-31",
  "force": false,
  "iterations": 40,
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

To keep Blob as source (default), set:

- `STRIPE_DATA_SOURCE=blob`

Expected BigQuery columns (or aliases in a view):

- `customer_id`, `customer_name`, `invoice_id`
- `line_item_id`, `line_item_description`
- `amount_minor`, `currency`, `quantity`
- `period_start_ts`, `period_end_ts`, `invoice_created_ts`

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
