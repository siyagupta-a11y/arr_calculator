import { clearHubspotMemoryCache } from "@/lib/hubspot";
import { clearPersistentServerResponseCache, clearServerResponseCache } from "@/lib/serverResponseCache";
import { clearStripeReportMemoryCache } from "@/lib/stripeReport";
import { POST as combinedAllSubsPost } from "@/app/api/combined-all-subs-report/route";
import { POST as combinedBillingOverviewPost } from "@/app/api/combined-billing-overview-report/route";
import { POST as combinedLiveArrPost } from "@/app/api/combined-live-arr/route";
import { POST as hubspotViewModelPost } from "@/app/api/hubspot-view-model/route";
import { POST as stripeAiSpendPost } from "@/app/api/stripe-ai-spend-report/route";
import { POST as stripeBillingOverviewPost } from "@/app/api/stripe-billing-overview-report/route";
import { POST as stripeThroughMrrPost } from "@/app/api/stripe-through-mrr-report/route";
import { POST as tofuPost } from "@/app/api/tofu-report/route";

type SyncOptions = {
  warmup?: boolean;
};

export type CacheSyncTaskResult = {
  key: string;
  ok: boolean;
  status?: number;
  tookMs: number;
  error?: string;
};

export type CacheSyncResult = {
  startedAtUtc: string;
  finishedAtUtc: string;
  tookMs: number;
  warmup: boolean;
  cleared: {
    inMemory: ReturnType<typeof clearServerResponseCache>;
    persistent: Awaited<ReturnType<typeof clearPersistentServerResponseCache>>;
  };
  tasks: CacheSyncTaskResult[];
};

function toIsoDateOnlyUtc(d: Date) {
  return d.toISOString().slice(0, 10);
}

function dateAddUtc(base: Date, days: number) {
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days, 0, 0, 0, 0));
}

function defaultRanges() {
  const now = new Date();
  const oneYearAgoMonthStart = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1, 0, 0, 0, 0));
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const last30Start = dateAddUtc(now, -30);
  return {
    today: toIsoDateOnlyUtc(now),
    currentMonthStart: toIsoDateOnlyUtc(currentMonthStart),
    oneYearStart: toIsoDateOnlyUtc(oneYearAgoMonthStart),
    last30Start: toIsoDateOnlyUtc(last30Start),
  };
}

type RoutePostHandler = (req: any) => Promise<Response>;

async function invokeRoutePost(label: string, handler: RoutePostHandler, body: Record<string, unknown>) {
  const t0 = Date.now();
  try {
    const req = new Request("http://localhost/internal-precompute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await handler(req);
    if (res.ok) {
      return {
        key: label,
        ok: true,
        status: res.status,
        tookMs: Date.now() - t0,
      } as CacheSyncTaskResult;
    }

    const text = await res.text();
    return {
      key: label,
      ok: false,
      status: res.status,
      tookMs: Date.now() - t0,
      error: text.slice(0, 300),
    } as CacheSyncTaskResult;
  } catch (error: unknown) {
    return {
      key: label,
      ok: false,
      tookMs: Date.now() - t0,
      error: error instanceof Error ? error.message : String(error),
    } as CacheSyncTaskResult;
  }
}

async function runWarmupTasks() {
  const { today, currentMonthStart, oneYearStart, last30Start } = defaultRanges();
  const tasks: Promise<CacheSyncTaskResult>[] = [
    invokeRoutePost(
      "combined-all-subs:grouped:arr:monthly",
      combinedAllSubsPost,
      {
        startDate: currentMonthStart,
        endDate: today,
        combineMode: "grouped",
        displayMode: "arr",
        planGrain: "monthly",
      },
    ),
    invokeRoutePost(
      "combined-billing-overview:monthly",
      combinedBillingOverviewPost,
      {
        startDate: oneYearStart,
        endDate: today,
        grain: "monthly",
      },
    ),
    invokeRoutePost(
      "combined-billing-overview:daily",
      combinedBillingOverviewPost,
      {
        startDate: last30Start,
        endDate: today,
        grain: "daily",
      },
    ),
    invokeRoutePost(
      "hubspot-view-model:contracted:monthly",
      hubspotViewModelPost,
      {
        startDate: oneYearStart,
        endDate: today,
        mode: "contracted",
        grain: "monthly",
      },
    ),
    invokeRoutePost(
      "stripe-through-mrr:monthly:email",
      stripeThroughMrrPost,
      {
        startDate: oneYearStart,
        endDate: today,
        grain: "monthly",
        groupBy: "email",
        page: 1,
        pageSize: 1000,
      },
    ),
    invokeRoutePost(
      "stripe-billing-overview:monthly",
      stripeBillingOverviewPost,
      {
        startDate: oneYearStart,
        endDate: today,
        grain: "monthly",
        groupBy: "none",
      },
    ),
    invokeRoutePost(
      "stripe-ai-spend:current-month",
      stripeAiSpendPost,
      {
        startDate: currentMonthStart,
        endDate: today,
        grain: "monthly",
      },
    ),
    invokeRoutePost(
      "tofu:grouped:month",
      tofuPost,
      {
        startDate: oneYearStart,
        endDate: today,
        combineMode: "grouped",
        groupBy: "month",
      },
    ),
    invokeRoutePost(
      "combined-live-arr",
      combinedLiveArrPost,
      {},
    ),
  ];
  return Promise.all(tasks);
}

export async function syncWebsiteCache(options: SyncOptions = {}): Promise<CacheSyncResult> {
  const warmup = options.warmup !== false;
  const startedAt = Date.now();
  const startedAtUtc = new Date(startedAt).toISOString();

  const inMemory = clearServerResponseCache();
  const persistent = await clearPersistentServerResponseCache();
  clearHubspotMemoryCache();
  clearStripeReportMemoryCache();

  const tasks = warmup ? await runWarmupTasks() : [];
  const finishedAt = Date.now();
  return {
    startedAtUtc,
    finishedAtUtc: new Date(finishedAt).toISOString(),
    tookMs: finishedAt - startedAt,
    warmup,
    cleared: {
      inMemory,
      persistent,
    },
    tasks,
  };
}
