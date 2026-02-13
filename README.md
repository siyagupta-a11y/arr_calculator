This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Monthly ARR + C-ARR Email Bot

This project includes a scheduled bot endpoint:

- `GET /api/monthly-email`
- `GET /api/daily-sync`

It runs on the 1st of every month via `vercel.json`, calculates ARR and C-ARR for the month that just ended, builds an Excel-compatible attachment with two sheets (`ARR` and `C-ARR`), and emails it to your recipient list.

The daily sync endpoint updates each included HubSpot deal with:

- `current_arr` (or `HUBSPOT_CURRENT_ARR_PROP`)
- `current_carr` (or `HUBSPOT_CURRENT_CARR_PROP`)

using present-day ARR and C-ARR values.

### Required environment variables

- `HUBSPOT_PRIVATE_APP_TOKEN`
- `INCLUDED_DEALSTAGE`
- `FX_TARGET_CURRENCY`
- `MONTHLY_REPORT_RECIPIENTS` (comma-separated emails)
- `MONTHLY_REPORT_FROM_EMAIL` (verified sender)
- `RESEND_API_KEY`
- `CRON_SECRET` (recommended; protects the endpoint)
- `HUBSPOT_CURRENT_ARR_PROP` (optional; defaults to `current_arr`)
- `HUBSPOT_CURRENT_CARR_PROP` (optional; defaults to `current_carr`)

### Schedule

The cron schedule is in `vercel.json`:

- `0 9 1 * *` (09:00 UTC on day 1 of every month)
- `0 9 * * *` (09:00 UTC every day)

### Manual test

Use `POST /api/monthly-email` with:

```json
{
  "force": true,
  "recipients": ["you@example.com"]
}
```

If `recipients` is omitted, `MONTHLY_REPORT_RECIPIENTS` is used.
