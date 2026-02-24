## Stripe Upcoming Invoice Lines -> BigQuery (Daily Historical Snapshots)

This template creates a **daily snapshot** of Stripe upcoming invoice line items and stores it in BigQuery.

Behavior:
- Keeps historical data by date (`snapshot_date` partition).
- Is idempotent per day by default (`RUN_ID` defaults to `SNAPSHOT_DATE`).
- If rerun on the same day, it replaces that day's rows only.

### 1) Create BigQuery objects

Run these SQL files first:

- `sql/01_create_tables.sql`
- `sql/02_create_latest_view.sql`

### 2) Required environment variables

- `STRIPE_SECRET_KEY`
- `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`
- `BQ_PROJECT_ID` (optional override; default in this template: `orbital-lantern-330119`)
- `BQ_DATASET` (optional override; default in this template: `stripe`)

Optional:

- `BQ_SUBSCRIPTIONS_TABLE` (default `subscriptions`; accepts `table`, `dataset.table`, or `project.dataset.table`)
- `BQ_SNAPSHOT_TABLE` (default `upcoming_invoice_line_snapshots`)
- `BQ_RUNS_TABLE` (default `upcoming_invoice_sync_runs`)
- `BQ_LOCATION` (default `US`)
- `SNAPSHOT_DATE` (default current UTC date)
- `RUN_ID` (default `SNAPSHOT_DATE`)
- `STRIPE_MAX_CONCURRENCY` (default `8`)
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
  --set-env-vars "BQ_PROJECT_ID=orbital-lantern-330119,BQ_DATASET=stripe,BQ_LOCATION=US,BQ_SUBSCRIPTIONS_TABLE=orbital-lantern-330119.stripe.subscriptions" \
  --set-secrets "STRIPE_SECRET_KEY=STRIPE_SECRET_KEY:latest,GOOGLE_SERVICE_ACCOUNT_JSON=GOOGLE_SERVICE_ACCOUNT_JSON:latest"
```

Run once manually:

```bash
gcloud run jobs execute stripe-upcoming-line-sync --region REGION --wait
```

### 5) Schedule daily with Cloud Scheduler

Use an HTTP scheduler that calls the Cloud Run Jobs API:

```bash
gcloud scheduler jobs create http stripe-upcoming-line-sync-daily \
  --location REGION \
  --schedule "0 4 * * *" \
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
- Stripe preview line IDs can change between runs, so `line_fingerprint` is used for cross-day comparison.

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
