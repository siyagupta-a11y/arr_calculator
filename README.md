This is a [Next.js](https://nextjs.org) project.

## Getting Started

Run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## App Routes

- `/` HubSpot ARR report page
- `/stripe` Stripe ARR report page
- `POST /api/report` HubSpot report API
- `POST /api/stripe-report` Stripe report API
- `GET|POST /api/stripe-sync` Stripe sync API

## Stripe Auto Sync

Stripe sync is automated by Vercel cron:

- `0 * * * *` (hourly)

Defined in `/vercel.json`.

`/api/stripe-sync` supports `POST` body:

```json
{
  "startDate": "2025-01-01",
  "endDate": "2026-12-31",
  "force": false,
  "iterations": 8
}
```

If body is omitted, the endpoint uses the default lookback window and `STRIPE_SYNC_CRON_ITERATIONS`.

## Persistence Across Redeploys

Stripe sync state is persisted in Vercel KV when these env vars are set:

- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

Without KV env vars, the app falls back to local `/tmp` storage (not persistent across redeploys/instances).

## Required Environment Variables

HubSpot report:

- `HUBSPOT_PRIVATE_APP_TOKEN`
- `INCLUDED_DEALSTAGE`
- `FX_TARGET_CURRENCY`

Stripe report/sync:

- `STRIPE_SECRET_KEY`
- `STRIPE_INVOICE_STATUS` (optional, default `paid`)
- `STRIPE_TARGET_CURRENCY` (optional, default `USD`)
- `STRIPE_SYNC_STORE_KEY` (optional, default `arr:stripe_sync_store:v1`)

Optional auth and tuning:

- `CRON_SECRET` (recommended; protects cron endpoints)
- `STRIPE_LINE_FETCH_CONCURRENCY` (default `12`)
- `STRIPE_REPORT_CACHE_TTL_MS` (default `300000`)
- `STRIPE_REPORT_AUTO_SYNC` (default `true`)
- `STRIPE_SYNC_FRESHNESS_MS` (default `900000`)
- `STRIPE_SYNC_MAX_HISTORY_DAYS` (default `800`)
- `STRIPE_SYNC_DEFAULT_LOOKBACK_DAYS` (default `730`)
- `STRIPE_SYNC_MAX_INVOICES_PER_RUN` (default `120`)
- `STRIPE_SYNC_CRON_ITERATIONS` (default `8`)
