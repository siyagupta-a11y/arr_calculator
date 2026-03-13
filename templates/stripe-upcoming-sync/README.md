## Stripe Upcoming Invoice Lines -> BigQuery (2-Hour Snapshots + Daily Close Retention)

This template captures Stripe upcoming invoice line items into BigQuery on a recurring cadence.

Behavior:
- Appends snapshots (keeps history by default).
- Intended to run every 2 hours.
- At `00:00` UTC, the run is treated as the close snapshot for the previous UTC day:
  all earlier snapshots for that day are deleted, and the close snapshot is retained.
- On the last calendar day of the month, `23:00` UTC is treated as midnight:
  all earlier snapshots for that day are deleted, and the `23:00` snapshot is retained.
- Pulls active/trialing/past_due/unpaid subscriptions from Stripe API directly.
- Targets invoices expected in the next calendar month by default.

### 1) Create BigQuery objects

Run these SQL files first:

- `sql/01_create_tables.sql`
- `sql/02_create_latest_view.sql`

### 2) Required environment variables

- `STRIPE_SECRET_KEY`
- `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`

Optional:

- `BQ_PROJECT_ID` (default `orbital-lantern-330119`)
- `BQ_DATASET` (default `stripe`)
- `BQ_SNAPSHOT_TABLE` (default `upcoming_invoice_line_snapshots`)
- `BQ_RUNS_TABLE` (default `upcoming_invoice_sync_runs`)
- `BQ_LOCATION` (default `northamerica-northeast1`; must match your BigQuery dataset location)
- `SNAPSHOT_TS` (default current UTC timestamp)
- `SNAPSHOT_DATE` (default date part of `SNAPSHOT_TS`)
- `RUN_ID` (optional override for run grouping; default uses `CLOUD_RUN_EXECUTION` or `SNAPSHOT_DATE+hour`)
- `TARGET_YEAR_MONTH` (optional override in `YYYY-MM`; default is next month from `SNAPSHOT_DATE`)
- `DAILY_CLOSE_HOUR_UTC` (default `0`)
- `MONTH_END_CLOSE_HOUR_UTC` (default `23`)
- `STRIPE_MAX_CONCURRENCY` (default `16`)
- `STRIPE_MAX_RETRIES` (default `4`)
- `STRIPE_API_VERSION` (optional)
- `BQ_INSERT_CHUNK_SIZE` (default `500`)

### 3) Local run (quick test)

From this folder:

```bash
node src/sync-upcoming-lines.mjs
```

### 4) Cloud Run Job deployment

Build and push image:

```bash
gcloud builds submit \
  --tag "REGION-docker.pkg.dev/PROJECT_ID/REPO/stripe-upcoming-line-sync:latest"
```

Create the job:

```bash
gcloud run jobs create stripe-upcoming-line-sync \
  --image "REGION-docker.pkg.dev/PROJECT_ID/REPO/stripe-upcoming-line-sync:latest" \
  --region REGION \
  --max-retries 1 \
  --task-timeout 3600 \
  --set-env-vars "BQ_PROJECT_ID=orbital-lantern-330119,BQ_DATASET=stripe,BQ_LOCATION=northamerica-northeast1,DAILY_CLOSE_HOUR_UTC=0,MONTH_END_CLOSE_HOUR_UTC=23" \
  --set-secrets "STRIPE_SECRET_KEY=STRIPE_SECRET_KEY:latest,GOOGLE_SERVICE_ACCOUNT_JSON=GOOGLE_SERVICE_ACCOUNT_JSON:latest"
```

Run once manually:

```bash
gcloud run jobs execute stripe-upcoming-line-sync --region REGION --wait
```

### 5) Schedule with Cloud Scheduler

Every 2 hours:

```bash
gcloud scheduler jobs create http stripe-upcoming-line-sync-2h \
  --location REGION \
  --schedule "0 */2 * * *" \
  --time-zone "Etc/UTC" \
  --uri "https://run.googleapis.com/v2/projects/PROJECT_ID/locations/REGION/jobs/stripe-upcoming-line-sync:run" \
  --http-method POST \
  --oauth-service-account-email "SCHEDULER_INVOKER_SA@PROJECT_ID.iam.gserviceaccount.com"
```

Month-end `23:00` close snapshot (for last-day close retention):

```bash
gcloud scheduler jobs create http stripe-upcoming-line-sync-month-end-23 \
  --location REGION \
  --schedule "0 23 28-31 * *" \
  --time-zone "Etc/UTC" \
  --uri "https://run.googleapis.com/v2/projects/PROJECT_ID/locations/REGION/jobs/stripe-upcoming-line-sync:run" \
  --http-method POST \
  --oauth-service-account-email "SCHEDULER_INVOKER_SA@PROJECT_ID.iam.gserviceaccount.com"
```

Grant the scheduler service account permission to run jobs (minimum needed in your setup):

```bash
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member "serviceAccount:SCHEDULER_INVOKER_SA@PROJECT_ID.iam.gserviceaccount.com" \
  --role "roles/run.developer"
```

### 6) Notes on Stripe behavior

- This sync reads from `GET /v1/invoices/upcoming/lines`.
- These are preview rows, not finalized invoice rows.
- It discovers candidate subscriptions from `GET /v1/subscriptions` and keeps only those whose
  `current_period_end` falls in the target month.
- Stripe preview line IDs can change between runs, so `line_fingerprint` is used for cross-snapshot comparison.

### 7) Useful queries

Rows loaded by day:

```sql
SELECT snapshot_date, COUNT(*) AS row_count
FROM `orbital-lantern-330119.stripe.upcoming_invoice_line_snapshots`
GROUP BY snapshot_date
ORDER BY snapshot_date DESC;
```

Latest predicted lines:

```sql
SELECT *
FROM `orbital-lantern-330119.stripe.latest_upcoming_invoice_line_snapshots`;
```

Run history:

```sql
SELECT *
FROM `orbital-lantern-330119.stripe.upcoming_invoice_sync_runs`
ORDER BY started_at DESC
LIMIT 100;
```
