import { clearHubspotMemoryCache } from "@/lib/hubspot";
import {
  clearPersistentServerResponseCache,
  clearServerResponseCache,
  writeServerCacheSyncStatus,
} from "@/lib/serverResponseCache";
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

type RoutePostHandler = (req: never) => Promise<Response>;

type WarmupTaskDefinition = {
  key: string;
  handler: RoutePostHandler;
  body: Record<string, unknown>;
};

export type CacheSyncClearResult = {
  inMemory: ReturnType<typeof clearServerResponseCache>;
  persistent: Awaited<ReturnType<typeof clearPersistentServerResponseCache>>;
};

export type CacheSyncBatchResult = {
  totalTasks: number;
  startIndex: number;
  nextIndex: number;
  done: boolean;
  results: CacheSyncTaskResult[];
};

function toIsoDateOnlyUtc(d: Date) {
  return d.toISOString().slice(0, 10);
}

function defaultRanges() {
  const now = new Date();
  const oneYearAgoMonthStart = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1, 0, 0, 0, 0));
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  return {
    today: toIsoDateOnlyUtc(now),
    currentMonthStart: toIsoDateOnlyUtc(currentMonthStart),
    oneYearStart: toIsoDateOnlyUtc(oneYearAgoMonthStart),
  };
}

async function invokeRoutePost(label: string, handler: RoutePostHandler, body: Record<string, unknown>) {
  const t0 = Date.now();
  try {
    const req = new Request("http://localhost/internal-precompute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await handler(req as never);
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

export function buildWarmupTaskDefinitions(): WarmupTaskDefinition[] {
  const { today, currentMonthStart, oneYearStart } = defaultRanges();
  return [
    {
      key: "combined-all-subs:grouped:arr:monthly",
      handler: combinedAllSubsPost,
      body: {
        startDate: currentMonthStart,
        endDate: today,
        combineMode: "grouped",
        displayMode: "arr",
        planGrain: "monthly",
      },
    },
    {
      key: "combined-billing-overview:monthly",
      handler: combinedBillingOverviewPost,
      body: {
        startDate: oneYearStart,
        endDate: today,
        grain: "monthly",
        includeCac: false,
      },
    },
    {
      key: "hubspot-view-model:contracted:monthly",
      handler: hubspotViewModelPost,
      body: {
        startDate: oneYearStart,
        endDate: today,
        mode: "contracted",
        grain: "monthly",
      },
    },
    {
      key: "stripe-through-mrr:monthly:email",
      handler: stripeThroughMrrPost,
      body: {
        startDate: oneYearStart,
        endDate: today,
        grain: "monthly",
        groupBy: "email",
        page: 1,
        pageSize: 250,
      },
    },
    {
      key: "stripe-billing-overview:monthly",
      handler: stripeBillingOverviewPost,
      body: {
        startDate: oneYearStart,
        endDate: today,
        grain: "monthly",
        groupBy: "none",
      },
    },
    {
      key: "stripe-ai-spend:current-month",
      handler: stripeAiSpendPost,
      body: {
        startDate: currentMonthStart,
        endDate: today,
        grain: "monthly",
      },
    },
    {
      key: "tofu:grouped:month",
      handler: tofuPost,
      body: {
        startDate: oneYearStart,
        endDate: today,
        combineMode: "grouped",
        groupBy: "month",
      },
    },
    {
      key: "combined-live-arr",
      handler: combinedLiveArrPost,
      body: {},
    },
  ];
}

export async function clearWebsiteCaches(): Promise<CacheSyncClearResult> {
  const inMemory = clearServerResponseCache();
  const persistent = await clearPersistentServerResponseCache();
  clearHubspotMemoryCache();
  clearStripeReportMemoryCache();
  return { inMemory, persistent };
}

export async function runWarmupTaskBatch(startIndex: number, batchSize: number): Promise<CacheSyncBatchResult> {
  const tasks = buildWarmupTaskDefinitions();
  const totalTasks = tasks.length;
  const safeStart = Number.isFinite(startIndex) ? Math.max(0, Math.floor(startIndex)) : 0;
  const safeBatchSize = Number.isFinite(batchSize) ? Math.max(1, Math.min(3, Math.floor(batchSize))) : 1;
  const endExclusive = Math.min(totalTasks, safeStart + safeBatchSize);

  const results: CacheSyncTaskResult[] = [];
  for (let i = safeStart; i < endExclusive; i += 1) {
    const task = tasks[i];
    results.push(await invokeRoutePost(task.key, task.handler, task.body));
  }

  return {
    totalTasks,
    startIndex: safeStart,
    nextIndex: endExclusive,
    done: endExclusive >= totalTasks,
    results,
  };
}

export async function writeFinalSyncStatusFromResults(
  startedAtUtc: string,
  warmup: boolean,
  results: CacheSyncTaskResult[],
) {
  const finishedAtUtc = new Date().toISOString();
  const startedAtMs = Date.parse(startedAtUtc);
  const finishedAtMs = Date.parse(finishedAtUtc);
  const tookMs = Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)
    ? Math.max(0, finishedAtMs - startedAtMs)
    : results.reduce((sum, result) => sum + Math.max(0, Number(result.tookMs || 0)), 0);
  const okTaskCount = results.filter((task) => task.ok).length;
  const failedTaskCount = results.length - okTaskCount;
  await writeServerCacheSyncStatus({
    startedAtUtc,
    finishedAtUtc,
    tookMs,
    warmup,
    okTaskCount,
    failedTaskCount,
    totalTaskCount: results.length,
  });
}

export async function writeFinalSyncStatusCounts(
  startedAtUtc: string,
  warmup: boolean,
  okTaskCount: number,
  failedTaskCount: number,
  totalTaskCount: number,
) {
  const finishedAtUtc = new Date().toISOString();
  const startedAtMs = Date.parse(startedAtUtc);
  const finishedAtMs = Date.parse(finishedAtUtc);
  const tookMs = Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)
    ? Math.max(0, finishedAtMs - startedAtMs)
    : 0;
  await writeServerCacheSyncStatus({
    startedAtUtc,
    finishedAtUtc,
    tookMs,
    warmup,
    okTaskCount: Math.max(0, Math.floor(okTaskCount || 0)),
    failedTaskCount: Math.max(0, Math.floor(failedTaskCount || 0)),
    totalTaskCount: Math.max(0, Math.floor(totalTaskCount || 0)),
  });
}

export async function syncWebsiteCache(options: SyncOptions = {}): Promise<CacheSyncResult> {
  const warmup = options.warmup !== false;
  const startedAt = Date.now();
  const startedAtUtc = new Date(startedAt).toISOString();
  const cleared = await clearWebsiteCaches();
  const tasks: CacheSyncTaskResult[] = [];

  if (warmup) {
    let cursor = 0;
    while (true) {
      const batch = await runWarmupTaskBatch(cursor, 1);
      tasks.push(...batch.results);
      cursor = batch.nextIndex;
      if (batch.done) break;
    }
  }

  await writeFinalSyncStatusFromResults(startedAtUtc, warmup, tasks);
  const finishedAt = Date.now();
  return {
    startedAtUtc,
    finishedAtUtc: new Date(finishedAt).toISOString(),
    tookMs: finishedAt - startedAt,
    warmup,
    cleared,
    tasks,
  };
}
