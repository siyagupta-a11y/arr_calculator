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
import { POST as ndrGdrPost } from "@/app/api/ndr-gdr-report/route";

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
  source?: "bigquery" | "hubspot" | "stripe_api" | "mixed";
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
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const monthlyHistoryStart = String(process.env.COMBINED_BILLING_OVERVIEW_MONTHLY_CACHE_START || "2023-01-01").trim();
  const monthlyHistoryStartIso = /^\d{4}-\d{2}-\d{2}$/.test(monthlyHistoryStart)
    ? monthlyHistoryStart
    : "2023-01-01";
  return {
    today: toIsoDateOnlyUtc(now),
    currentMonthStart: toIsoDateOnlyUtc(currentMonthStart),
    monthlyHistoryStart: monthlyHistoryStartIso,
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

async function invokeRoutePostWithRetry(task: WarmupTaskDefinition) {
  let attempt = 1;
  let result = await invokeRoutePost(task.key, task.handler, task.body);
  while (!result.ok && attempt < 3) {
    attempt += 1;
    await new Promise((resolve) => setTimeout(resolve, 250));
    result = await invokeRoutePost(task.key, task.handler, task.body);
  }
  if (!result.ok && attempt > 1) {
    return {
      ...result,
      error: `${result.error || "task failed"} (after ${attempt} attempts)`,
    };
  }
  return result;
}

function parseIsoDateOnlyUtc(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return parsed;
}

function addMonthsUtc(date: Date, deltaMonths: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + deltaMonths, 1));
}

function endOfMonthUtc(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

type WarmupRangeChunk = {
  startDate: string;
  endDate: string;
  label: string;
};

function buildMonthlyWarmupChunks(startDate: string, endDate: string, monthsPerChunk: number): WarmupRangeChunk[] {
  const start = parseIsoDateOnlyUtc(startDate);
  const end = parseIsoDateOnlyUtc(endDate);
  if (!start || !end || end.getTime() < start.getTime()) return [];
  const chunkMonths = Number.isFinite(monthsPerChunk) ? Math.max(1, Math.floor(monthsPerChunk)) : 2;
  const chunks: WarmupRangeChunk[] = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor.getTime() <= end.getTime()) {
    const chunkStart = cursor;
    const chunkEndCandidate = endOfMonthUtc(addMonthsUtc(chunkStart, chunkMonths - 1));
    const chunkEnd = chunkEndCandidate.getTime() > end.getTime() ? end : chunkEndCandidate;
    const chunkStartIso = toIsoDateOnlyUtc(chunkStart);
    const chunkEndIso = toIsoDateOnlyUtc(chunkEnd);
    chunks.push({
      startDate: chunkStartIso,
      endDate: chunkEndIso,
      label: `${chunkStartIso}..${chunkEndIso}`,
    });
    cursor = addMonthsUtc(chunkStart, chunkMonths);
  }
  return chunks;
}

export function buildWarmupTaskDefinitions(): WarmupTaskDefinition[] {
  const { today, currentMonthStart, monthlyHistoryStart } = defaultRanges();
  const chunkMonths = Number(process.env.CACHE_SYNC_MONTHLY_CHUNK_SIZE || 2);
  const chunks = buildMonthlyWarmupChunks(monthlyHistoryStart, today, chunkMonths);
  const tasks: WarmupTaskDefinition[] = [];

  for (const chunk of chunks) {
    tasks.push({
      key: `combined-all-subs:chunk:${chunk.label}`,
      handler: combinedAllSubsPost,
      source: "bigquery",
      body: {
        startDate: chunk.startDate,
        endDate: chunk.endDate,
        combineMode: "grouped",
        displayMode: "arr",
        planGrain: "monthly",
        precomputeRangeOnly: true,
      },
    });
    tasks.push({
      key: `combined-billing-overview:no-cac:chunk:${chunk.label}`,
      handler: combinedBillingOverviewPost,
      source: "bigquery",
      body: {
        startDate: chunk.startDate,
        endDate: chunk.endDate,
        grain: "monthly",
        includeCac: false,
        precomputeRangeOnly: true,
      },
    });
    tasks.push({
      key: `combined-billing-overview:cac:chunk:${chunk.label}`,
      handler: combinedBillingOverviewPost,
      source: "bigquery",
      body: {
        startDate: chunk.startDate,
        endDate: chunk.endDate,
        grain: "monthly",
        includeCac: true,
        precomputeRangeOnly: true,
      },
    });
    tasks.push({
      key: `tofu:chunk:${chunk.label}`,
      handler: tofuPost,
      source: "bigquery",
      body: {
        startDate: chunk.startDate,
        endDate: chunk.endDate,
        combineMode: "grouped",
        groupBy: "month",
        precomputeRangeOnly: true,
      },
    });
    tasks.push({
      key: `ndr-gdr:overall:chunk:${chunk.label}`,
      handler: ndrGdrPost,
      source: "bigquery",
      body: {
        startDate: chunk.startDate,
        endDate: chunk.endDate,
        combineMode: "grouped",
        groupBy: "overall",
        precomputeRangeOnly: true,
      },
    });
    tasks.push({
      key: `ndr-gdr:source:chunk:${chunk.label}`,
      handler: ndrGdrPost,
      source: "bigquery",
      body: {
        startDate: chunk.startDate,
        endDate: chunk.endDate,
        combineMode: "grouped",
        groupBy: "source",
        precomputeRangeOnly: true,
      },
    });
    tasks.push({
      key: `ndr-gdr:plan:chunk:${chunk.label}`,
      handler: ndrGdrPost,
      source: "bigquery",
      body: {
        startDate: chunk.startDate,
        endDate: chunk.endDate,
        combineMode: "grouped",
        groupBy: "plan",
        precomputeRangeOnly: true,
      },
    });
  }

  tasks.push(
    {
      key: "hubspot-view-model:contracted:monthly",
      handler: hubspotViewModelPost,
      source: "hubspot",
      body: {
        startDate: monthlyHistoryStart,
        endDate: today,
        mode: "contracted",
        grain: "monthly",
      },
    },
    {
      key: "stripe-through-mrr:monthly:email",
      handler: stripeThroughMrrPost,
      source: "bigquery",
      body: {
        startDate: monthlyHistoryStart,
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
      source: "bigquery",
      body: {
        startDate: monthlyHistoryStart,
        endDate: today,
        grain: "monthly",
        groupBy: "none",
      },
    },
    {
      key: "stripe-ai-spend:current-month",
      handler: stripeAiSpendPost,
      source: "bigquery",
      body: {
        startDate: currentMonthStart,
        endDate: today,
        grain: "monthly",
      },
    },
    {
      key: "combined-live-arr",
      handler: combinedLiveArrPost,
      source: "mixed",
      body: {},
    },
  );

  return tasks;
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

  const scheduled: Array<{ index: number; task: WarmupTaskDefinition }> = [];
  for (let i = safeStart; i < endExclusive; i += 1) {
    scheduled.push({ index: i, task: tasks[i] });
  }

  const orderedResults: Array<CacheSyncTaskResult | null> = Array.from(
    { length: scheduled.length },
    () => null,
  );

  let cursor = 0;
  while (cursor < scheduled.length) {
    const wave: Array<{ localIndex: number; task: WarmupTaskDefinition }> = [];
    const usedSources = new Set<string>();
    for (let j = cursor; j < scheduled.length; j += 1) {
      const localIndex = j;
      const task = scheduled[j].task;
      const source = String(task.source || "mixed");
      if (usedSources.has(source)) break;
      usedSources.add(source);
      wave.push({ localIndex, task });
    }

    const waveResults = await Promise.all(
      wave.map(async ({ localIndex, task }) => ({
        localIndex,
        result: await invokeRoutePostWithRetry(task),
      })),
    );

    for (const waveResult of waveResults) {
      orderedResults[waveResult.localIndex] = waveResult.result;
    }
    cursor += Math.max(1, wave.length);
  }

  const results = orderedResults.filter((value): value is CacheSyncTaskResult => Boolean(value));

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
