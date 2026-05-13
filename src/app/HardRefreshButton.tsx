"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

function shouldHide(pathname: string) {
  return pathname === "/login" || pathname === "/privacy-policy" || pathname === "/eula";
}

function formatMontrealTime(isoUtc: string) {
  const dt = new Date(isoUtc);
  if (Number.isNaN(dt.getTime())) return isoUtc;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(dt);
}

function toIsoDateUtc(date: Date) {
  return date.toISOString().slice(0, 10);
}

function defaultDebugStartDateUtc() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return toIsoDateUtc(start);
}

function defaultDebugEndDateUtc() {
  return toIsoDateUtc(new Date());
}

function monthKeyFromIsoDate(value: string) {
  return String(value || "").slice(0, 7);
}

type DebugBackfillStep = {
  step?: string;
  ok?: boolean;
  tookMs?: number;
  error?: string;
};

type DebugBackfillResult = {
  ok: boolean;
  status: number;
  error?: string;
  startedAtUtc?: string;
  finishedAtUtc?: string;
  tookMs?: number;
  syncRunId?: string;
  steps?: DebugBackfillStep[];
};

type PageBackfillTarget =
  | "combined_billing_overview"
  | "ndr_gdr"
  | "tofu"
  | "combined_all_subs"
  | "stripe_billing_overview"
  | "stripe_through_mrr"
  | "hubspot_view_model"
  | "all";

type PageBackfillSingleTarget = Exclude<PageBackfillTarget, "all">;

type PageBackfillJob = {
  label: string;
  endpoint: string;
  body: Record<string, unknown>;
};

const PAGE_BACKFILL_TARGET_OPTIONS: Array<{ value: PageBackfillTarget; label: string }> = [
  { value: "combined_billing_overview", label: "Combined Billing Overview" },
  { value: "ndr_gdr", label: "NDR/GDR" },
  { value: "tofu", label: "TOFU" },
  { value: "combined_all_subs", label: "Combined All Subs" },
  { value: "stripe_billing_overview", label: "Stripe Billing Overview" },
  { value: "stripe_through_mrr", label: "Stripe Through MRR" },
  { value: "hubspot_view_model", label: "HubSpot View Model" },
  { value: "all", label: "All page targets" },
];

const PAGE_BACKFILL_SINGLE_TARGET_OPTIONS: Array<{ value: PageBackfillSingleTarget; label: string }> = [
  { value: "combined_billing_overview", label: "Combined Billing Overview" },
  { value: "ndr_gdr", label: "NDR/GDR" },
  { value: "tofu", label: "TOFU" },
  { value: "combined_all_subs", label: "Combined All Subs" },
  { value: "stripe_billing_overview", label: "Stripe Billing Overview" },
  { value: "stripe_through_mrr", label: "Stripe Through MRR" },
  { value: "hubspot_view_model", label: "HubSpot View Model" },
];

export default function HardRefreshButton() {
  const pathname = usePathname();
  const [loading, setLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [backfillLoading, setBackfillLoading] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [lastSyncAtUtc, setLastSyncAtUtc] = useState("");
  const [lastSyncSummary, setLastSyncSummary] = useState("");
  const [syncProgress, setSyncProgress] = useState("");
  const [message, setMessage] = useState("");
  const [debugPanelOpen, setDebugPanelOpen] = useState(false);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugStartDate, setDebugStartDate] = useState(defaultDebugStartDateUtc);
  const [debugEndDate, setDebugEndDate] = useState(defaultDebugEndDateUtc);
  const [debugIncludeDaily, setDebugIncludeDaily] = useState(true);
  const [debugIncludeMonthly, setDebugIncludeMonthly] = useState(true);
  const [debugResult, setDebugResult] = useState<DebugBackfillResult | null>(null);
  const [pageBackfillLoading, setPageBackfillLoading] = useState(false);
  const [pageBackfillTarget, setPageBackfillTarget] = useState<PageBackfillTarget>("combined_billing_overview");
  const [pageBackfillChunkMonths, setPageBackfillChunkMonths] = useState(1);
  const [matchMetadataBackfillLoading, setMatchMetadataBackfillLoading] = useState(false);
  const [matchMetadataChunkMonths, setMatchMetadataChunkMonths] = useState(1);
  const [aiSpendDailyBackfillLoading, setAiSpendDailyBackfillLoading] = useState(false);
  const [aiSpendDailyChunkMonths, setAiSpendDailyChunkMonths] = useState(1);

  useEffect(() => {
    let active = true;
    const loadSession = async () => {
      try {
        const res = await fetch("/api/auth/session", { cache: "no-store" });
        if (!res.ok) return;
        const payload = (await res.json()) as { user?: { role?: string } };
        if (!active) return;
        setIsAdmin(String(payload?.user?.role || "").trim().toLowerCase() === "admin");
      } catch {
        if (!active) return;
        setIsAdmin(false);
      }
    };
    void loadSession();
    const loadCacheStatus = async () => {
      try {
        const res = await fetch("/api/cache/status", { cache: "no-store" });
        if (!res.ok) return;
        const payload = (await res.json()) as {
          lastSync?: {
            finishedAtUtc?: string;
            okTaskCount?: number;
            failedTaskCount?: number;
            totalTaskCount?: number;
          } | null;
        };
        if (!active) return;
        const finishedAtUtc = String(payload?.lastSync?.finishedAtUtc || "").trim();
        if (finishedAtUtc) {
          setLastSyncAtUtc(finishedAtUtc);
          const ok = Number(payload?.lastSync?.okTaskCount || 0);
          const total = Number(payload?.lastSync?.totalTaskCount || 0);
          if (total > 0) {
            setLastSyncSummary(`${ok}/${total} tasks`);
          }
        }
      } catch {
        if (!active) return;
      }
    };
    void loadCacheStatus();
    return () => {
      active = false;
    };
  }, []);

  if (shouldHide(pathname)) return null;

  async function hardRefresh() {
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch("/api/cache/hard-refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }

      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set("_hard_refresh", String(Date.now()));
      window.location.replace(nextUrl.toString());
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "Hard refresh failed");
      setLoading(false);
    }
  }

  async function syncNow(syncMode: "fast" | "full") {
    setSyncLoading(true);
    setMessage("");
    setSyncProgress("");
    try {
      const startRes = await fetch("/api/cache/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ action: "start", warmup: true, syncMode }),
      });
      if (!startRes.ok) {
        const text = await startRes.text();
        const snippet = text.replace(/\s+/g, " ").slice(0, 220);
        throw new Error(`Sync start failed (${startRes.status}). ${snippet}`);
      }

      const startPayload = (await startRes.json()) as {
        startedAtUtc?: string;
        totalTasks?: number;
        taskKeys?: string[];
        nextTaskIndex?: number;
        done?: boolean;
        resumed?: boolean;
        syncMode?: "fast" | "full";
        okTaskCount?: number;
        failedTaskCount?: number;
      };
      const startedAtUtc = String(startPayload?.startedAtUtc || "").trim() || new Date().toISOString();
      const totalTasks = Math.max(0, Number(startPayload?.totalTasks || 0));
      const taskKeys = Array.isArray(startPayload?.taskKeys)
        ? startPayload.taskKeys.map((value) => String(value || ""))
        : [];
      let nextTaskIndex = Math.max(0, Number(startPayload?.nextTaskIndex || 0));
      let done = Boolean(startPayload?.done) || totalTasks === 0;
      let okTaskCount = Math.max(0, Number(startPayload?.okTaskCount || 0));
      let failedTaskCount = Math.max(0, Number(startPayload?.failedTaskCount || 0));
      const failedTaskReasons = new Map<number, string>();
      const transportFailureIndexes = new Set<number>();
      let transportFailedTaskCount = 0;

      const stepBatchSize = syncMode === "full" ? 1 : 2;
      while (!done) {
        const stepEnd = Math.min(totalTasks, nextTaskIndex + stepBatchSize);
        setSyncProgress(`Running cache warmup tasks ${nextTaskIndex + 1}-${stepEnd}/${totalTasks}...`);
        const currentTaskIndex = nextTaskIndex;
        let stepProcessed = false;
        for (let attempt = 1; attempt <= 2 && !stepProcessed; attempt += 1) {
          let stepRes: Response | null = null;
          let fetchThrown: unknown = null;
          try {
            stepRes = await fetch("/api/cache/sync", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              cache: "no-store",
              body: JSON.stringify({
                action: "step",
                taskIndex: nextTaskIndex,
                batchSize: stepBatchSize,
                syncMode,
              }),
            });
          } catch (error: unknown) {
            fetchThrown = error;
          }
          if (fetchThrown) {
            if (attempt < 2) {
              setSyncProgress(`Retrying task ${nextTaskIndex + 1}/${totalTasks} after transient network error...`);
              continue;
            }
            transportFailedTaskCount += 1;
            failedTaskCount += 1;
            transportFailureIndexes.add(currentTaskIndex);
            const label = taskKeys[currentTaskIndex] || `task ${currentTaskIndex + 1}`;
            const reason = fetchThrown instanceof Error ? fetchThrown.message : "Fetch failed";
            failedTaskReasons.set(currentTaskIndex, `${label}: ${reason}`);
            nextTaskIndex += 1;
            done = nextTaskIndex >= totalTasks;
            setLastSyncSummary(`${okTaskCount}/${okTaskCount + failedTaskCount} tasks`);
            stepProcessed = true;
            continue;
          }
          if (!stepRes) {
            if (attempt < 2) {
              setSyncProgress(`Retrying task ${nextTaskIndex + 1}/${totalTasks} after transient network error...`);
              continue;
            }
            transportFailedTaskCount += 1;
            failedTaskCount += 1;
            transportFailureIndexes.add(currentTaskIndex);
            const label = taskKeys[currentTaskIndex] || `task ${currentTaskIndex + 1}`;
            failedTaskReasons.set(currentTaskIndex, `${label}: No response from sync endpoint.`);
            nextTaskIndex += 1;
            done = nextTaskIndex >= totalTasks;
            setLastSyncSummary(`${okTaskCount}/${okTaskCount + failedTaskCount} tasks`);
            stepProcessed = true;
            continue;
          }
          if (!stepRes.ok) {
            const text = await stepRes.text();
            const snippet = text.replace(/\s+/g, " ").slice(0, 220);
            const looksLikeHtml = snippet.toLowerCase().includes("<!doctype html");
            if (attempt < 2) {
              setSyncProgress(`Retrying task ${nextTaskIndex + 1}/${totalTasks} after transient error...`);
              continue;
            }
            transportFailedTaskCount += 1;
            failedTaskCount += 1;
            transportFailureIndexes.add(currentTaskIndex);
            const label = taskKeys[currentTaskIndex] || `task ${currentTaskIndex + 1}`;
            const reason = looksLikeHtml
              ? "Server returned HTML error page (usually timeout or runtime crash)."
              : snippet;
            failedTaskReasons.set(currentTaskIndex, `${label}: ${reason}`);
            nextTaskIndex += 1;
            done = nextTaskIndex >= totalTasks;
            setLastSyncSummary(`${okTaskCount}/${okTaskCount + failedTaskCount} tasks`);
            stepProcessed = true;
            continue;
          }
          const stepPayload = (await stepRes.json()) as {
            nextIndex?: number;
            done?: boolean;
            okTaskCount?: number;
            failedTaskCount?: number;
            results?: Array<{ ok?: boolean; key?: string; error?: string; status?: number }>;
          };
          const stepResults = Array.isArray(stepPayload?.results) ? stepPayload.results : [];
          for (let idx = 0; idx < stepResults.length; idx += 1) {
            const taskIdx = currentTaskIndex + idx;
            const item = stepResults[idx];
            if (item?.ok) {
              okTaskCount += 1;
              failedTaskReasons.delete(taskIdx);
              if (transportFailureIndexes.delete(taskIdx)) {
                transportFailedTaskCount = Math.max(0, transportFailedTaskCount - 1);
              }
            } else {
              failedTaskCount += 1;
              const label = String(item?.key || taskKeys[taskIdx] || `task ${taskIdx + 1}`);
              const detail = String(item?.error || (item?.status ? `HTTP ${item.status}` : "task failed"));
              failedTaskReasons.set(taskIdx, `${label}: ${detail}`);
            }
          }
          const processedCount = Math.max(1, stepResults.length);
          nextTaskIndex = Math.max(
            currentTaskIndex + processedCount,
            Number(stepPayload?.nextIndex || currentTaskIndex + processedCount),
          );
          done = Boolean(stepPayload?.done) || nextTaskIndex >= totalTasks;
          if (Number.isFinite(Number(stepPayload.okTaskCount)) && Number.isFinite(Number(stepPayload.failedTaskCount))) {
            okTaskCount = Math.max(okTaskCount, Number(stepPayload.okTaskCount || 0));
            failedTaskCount = Math.max(failedTaskCount, Number(stepPayload.failedTaskCount || 0));
          }
          setLastSyncSummary(`${okTaskCount}/${okTaskCount + failedTaskCount} tasks`);
          stepProcessed = true;
        }
      }

      if (failedTaskReasons.size > 0) {
        const retryIndexes = Array.from(failedTaskReasons.keys()).sort((a, b) => a - b);
        for (const index of retryIndexes) {
          setSyncProgress(`Retrying failed task ${index + 1}/${totalTasks}...`);
          let retryRes: Response | null = null;
          try {
            retryRes = await fetch("/api/cache/sync", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              cache: "no-store",
              body: JSON.stringify({
                action: "step",
                taskIndex: index,
                batchSize: 1,
                syncMode,
              }),
            });
          } catch {
            continue;
          }
          if (!retryRes.ok) continue;
          const retryPayload = (await retryRes.json()) as {
            results?: Array<{ ok?: boolean; key?: string; error?: string; status?: number }>;
          };
          const retryItem = Array.isArray(retryPayload?.results) ? retryPayload.results[0] : null;
          if (retryItem?.ok) {
            okTaskCount += 1;
            failedTaskCount = Math.max(0, failedTaskCount - 1);
            failedTaskReasons.delete(index);
            if (transportFailureIndexes.delete(index)) {
              transportFailedTaskCount = Math.max(0, transportFailedTaskCount - 1);
            }
          }
        }
      }

      await fetch("/api/cache/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          action: "complete",
          warmup: true,
          syncMode,
          startedAtUtc,
          okTaskCount,
          failedTaskCount,
          totalTaskCount: okTaskCount + failedTaskCount,
        }),
      });

      setLastSyncAtUtc(new Date().toISOString());
      setLastSyncSummary(`${okTaskCount}/${okTaskCount + failedTaskCount} tasks`);
      if (failedTaskCount > 0) {
        const failedTaskList = Array.from(failedTaskReasons.values()).slice(0, 3).join(" | ");
        const extra = transportFailedTaskCount > 0 ? ` (${transportFailedTaskCount} transport timeout/crash)` : "";
        const detail = failedTaskList ? ` Failed: ${failedTaskList}` : "";
        setMessage(`Sync completed with ${failedTaskCount} failed task(s)${extra}.${detail}`);
      } else {
        setMessage("Sync completed.");
      }
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "Sync failed");
    } finally {
      setSyncProgress("");
      setSyncLoading(false);
    }
  }

  function addMonthsUtc(date: Date, months: number) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  }

  function endOfMonthUtc(date: Date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  }

  function buildMonthChunks(startDateIso: string, endDateIso: string, monthsPerChunk: number) {
    const start = new Date(`${startDateIso}T00:00:00.000Z`);
    const end = new Date(`${endDateIso}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() < start.getTime()) return [];
    const chunks: Array<{ startDate: string; endDate: string; label: string }> = [];
    const chunkMonths = Math.max(1, Math.floor(monthsPerChunk));
    let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    while (cursor.getTime() <= end.getTime()) {
      const chunkStart = cursor;
      const chunkEndCandidate = endOfMonthUtc(addMonthsUtc(chunkStart, chunkMonths - 1));
      const chunkEnd = chunkEndCandidate.getTime() > end.getTime() ? end : chunkEndCandidate;
      const startDate = toIsoDateUtc(chunkStart);
      const endDate = toIsoDateUtc(chunkEnd);
      chunks.push({ startDate, endDate, label: `${startDate}..${endDate}` });
      cursor = addMonthsUtc(chunkStart, chunkMonths);
    }
    return chunks;
  }

  function buildDayChunks(startDateIso: string, endDateIso: string, daysPerChunk: number) {
    const start = new Date(`${startDateIso}T00:00:00.000Z`);
    const end = new Date(`${endDateIso}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() < start.getTime()) return [];
    const DAY_MS = 24 * 60 * 60 * 1000;
    const chunkDays = Math.max(1, Math.floor(daysPerChunk));
    const chunks: Array<{ startDate: string; endDate: string; label: string }> = [];
    let cursorMs = start.getTime();
    const endMs = end.getTime();
    while (cursorMs <= endMs) {
      const chunkStart = new Date(cursorMs);
      const chunkEndMs = Math.min(endMs, cursorMs + (chunkDays - 1) * DAY_MS);
      const chunkEnd = new Date(chunkEndMs);
      const chunkStartIso = toIsoDateUtc(chunkStart);
      const chunkEndIso = toIsoDateUtc(chunkEnd);
      chunks.push({
        startDate: chunkStartIso,
        endDate: chunkEndIso,
        label: `${chunkStartIso}..${chunkEndIso}`,
      });
      cursorMs = chunkEndMs + DAY_MS;
    }
    return chunks;
  }

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function buildJobsForTarget(
    target: PageBackfillSingleTarget,
    chunk: { startDate: string; endDate: string; label: string },
  ): PageBackfillJob[] {
    const detailStartMonth = monthKeyFromIsoDate(chunk.startDate);
    const detailEndMonth = monthKeyFromIsoDate(chunk.endDate);

    if (target === "combined_billing_overview") {
      return [
        {
          label: `Combined Billing (no CAC) ${chunk.label}`,
          endpoint: "/api/combined-billing-overview-report",
          body: {
            startDate: chunk.startDate,
            endDate: chunk.endDate,
            grain: "monthly",
            includeCac: false,
            precomputeRangeOnly: true,
            forceRefreshPrecomputed: true,
          },
        },
        {
          label: `Combined Billing (with CAC) ${chunk.label}`,
          endpoint: "/api/combined-billing-overview-report",
          body: {
            startDate: chunk.startDate,
            endDate: chunk.endDate,
            grain: "monthly",
            includeCac: true,
            precomputeRangeOnly: true,
            forceRefreshPrecomputed: true,
          },
        },
      ];
    }

    if (target === "ndr_gdr") {
      return [
        {
          label: `NDR/GDR overall ${chunk.label}`,
          endpoint: "/api/ndr-gdr-report",
          body: {
            startDate: chunk.startDate,
            endDate: chunk.endDate,
            combineMode: "grouped",
            groupBy: "overall",
            precomputeRangeOnly: true,
            forceRefreshPrecomputed: true,
          },
        },
        {
          label: `NDR/GDR source ${chunk.label}`,
          endpoint: "/api/ndr-gdr-report",
          body: {
            startDate: chunk.startDate,
            endDate: chunk.endDate,
            combineMode: "grouped",
            groupBy: "source",
            precomputeRangeOnly: true,
            forceRefreshPrecomputed: true,
          },
        },
        {
          label: `NDR/GDR plan ${chunk.label}`,
          endpoint: "/api/ndr-gdr-report",
          body: {
            startDate: chunk.startDate,
            endDate: chunk.endDate,
            combineMode: "grouped",
            groupBy: "plan",
            precomputeRangeOnly: true,
            forceRefreshPrecomputed: true,
          },
        },
      ];
    }

    if (target === "tofu") {
      return [
        {
          label: `TOFU month ${chunk.label}`,
          endpoint: "/api/tofu-report",
          body: {
            startDate: chunk.startDate,
            endDate: chunk.endDate,
            combineMode: "grouped",
            groupBy: "month",
            precomputeRangeOnly: true,
            forceRefreshPrecomputed: true,
          },
        },
        {
          label: `TOFU segment ${chunk.label}`,
          endpoint: "/api/tofu-report",
          body: {
            startDate: chunk.startDate,
            endDate: chunk.endDate,
            combineMode: "grouped",
            groupBy: "segment",
            precomputeRangeOnly: true,
            forceRefreshPrecomputed: true,
          },
        },
        {
          label: `TOFU plan ${chunk.label}`,
          endpoint: "/api/tofu-report",
          body: {
            startDate: chunk.startDate,
            endDate: chunk.endDate,
            combineMode: "grouped",
            groupBy: "plan",
            precomputeRangeOnly: true,
            forceRefreshPrecomputed: true,
          },
        },
      ];
    }

    if (target === "combined_all_subs") {
      return [
        {
          label: `Combined All Subs simple ARR ${chunk.label}`,
          endpoint: "/api/combined-all-subs-report",
          body: {
            startDate: chunk.startDate,
            endDate: chunk.endDate,
            combineMode: "simple",
            displayMode: "arr",
            planGrain: "monthly",
            precomputeRangeOnly: true,
            forceRefreshPrecomputed: true,
          },
        },
        {
          label: `Combined All Subs grouped ARR ${chunk.label}`,
          endpoint: "/api/combined-all-subs-report",
          body: {
            startDate: chunk.startDate,
            endDate: chunk.endDate,
            combineMode: "grouped",
            displayMode: "arr",
            planGrain: "monthly",
            precomputeRangeOnly: true,
            forceRefreshPrecomputed: true,
            groupedMatchStrategy: "full",
            includeSalesAssist: true,
          },
        },
      ];
    }

    if (target === "stripe_billing_overview") {
      return [
        {
          label: `Stripe Billing monthly ${chunk.label}`,
          endpoint: "/api/stripe-billing-overview-report",
          body: {
            startDate: chunk.startDate,
            endDate: chunk.endDate,
            grain: "monthly",
            groupBy: "none",
            includeCustomerArrRows: true,
            includeCurrentMonthProjection: true,
          },
        },
      ];
    }

    if (target === "stripe_through_mrr") {
      return [
        {
          label: `Stripe Through MRR monthly none ${chunk.label}`,
          endpoint: "/api/stripe-through-mrr-report",
          body: {
            startDate: chunk.startDate,
            endDate: chunk.endDate,
            detailStartMonth,
            detailEndMonth,
            grain: "monthly",
            groupBy: "none",
            page: 1,
            pageSize: 500,
          },
        },
        {
          label: `Stripe Through MRR monthly email ${chunk.label}`,
          endpoint: "/api/stripe-through-mrr-report",
          body: {
            startDate: chunk.startDate,
            endDate: chunk.endDate,
            detailStartMonth,
            detailEndMonth,
            grain: "monthly",
            groupBy: "email",
            page: 1,
            pageSize: 500,
          },
        },
      ];
    }

    return [
      {
        label: `HubSpot View Model monthly ${chunk.label}`,
        endpoint: "/api/hubspot-view-model",
        body: {
          startDate: chunk.startDate,
          endDate: chunk.endDate,
          mode: "contracted",
          grain: "monthly",
        },
      },
    ];
  }

  async function runPageBackfillTargets(targets: PageBackfillSingleTarget[], customPrefix?: string) {
    if (!debugStartDate || !debugEndDate) {
      setMessage("Select start and end dates for page backfill.");
      return;
    }
    if (debugEndDate < debugStartDate) {
      setMessage("Page backfill end date must be on or after start date.");
      return;
    }

    const chunkMonths = Math.max(1, Math.min(12, Math.floor(Number(pageBackfillChunkMonths) || 1)));
    const chunks = buildMonthChunks(debugStartDate, debugEndDate, chunkMonths);
    if (!chunks.length) {
      setMessage("No monthly chunks generated for page backfill.");
      return;
    }

    const jobs: PageBackfillJob[] = [];
    for (const chunk of chunks) {
      for (const target of targets) jobs.push(...buildJobsForTarget(target, chunk));
    }

    if (!jobs.length) {
      setMessage("No page backfill jobs were created.");
      return;
    }

    setPageBackfillLoading(true);
    setSyncProgress("");
    setMessage("");
    let okCount = 0;
    let failedCount = 0;
    const failedDetails: string[] = [];

    try {
      for (let i = 0; i < jobs.length; i += 1) {
        const job = jobs[i];
        const prefix = customPrefix || "Page backfill";
        setSyncProgress(`${prefix} ${i + 1}/${jobs.length}: ${job.label}`);

        let succeeded = false;
        let lastError = "";
        for (let attempt = 1; attempt <= 3 && !succeeded; attempt += 1) {
          try {
            const res = await fetch(job.endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              cache: "no-store",
              body: JSON.stringify(job.body),
            });
            if (!res.ok) {
              const text = await res.text();
              const snippet = text.replace(/\s+/g, " ").slice(0, 220);
              const looksHtml = snippet.toLowerCase().includes("<!doctype html");
              throw new Error(
                looksHtml
                  ? "Server returned HTML error page (likely timeout/runtime crash)."
                  : snippet || `HTTP ${res.status}`,
              );
            }
            succeeded = true;
            okCount += 1;
          } catch (error: unknown) {
            lastError = error instanceof Error ? error.message : "Unknown error";
            if (attempt < 3) await sleep(Math.min(10_000, 1_000 * 2 ** (attempt - 1)));
          }
        }

        if (!succeeded) {
          failedCount += 1;
          failedDetails.push(`${job.label}: ${lastError || "Unknown error"}`);
        }
        await sleep(250);
      }

      if (failedCount > 0) {
        setMessage(
          `Page backfill finished with ${failedCount} failed job(s). ` +
            `Succeeded: ${okCount}. ` +
            `Failed: ${failedDetails.slice(0, 3).join(" | ")}`,
        );
      } else {
        setMessage(`Page backfill completed successfully (${okCount} jobs).`);
      }
    } finally {
      setSyncProgress("");
      setPageBackfillLoading(false);
    }
  }

  async function runPageBackfill() {
    const targets: PageBackfillSingleTarget[] = pageBackfillTarget === "all"
      ? [
          "combined_billing_overview",
          "ndr_gdr",
          "tofu",
          "combined_all_subs",
          "stripe_billing_overview",
          "stripe_through_mrr",
          "hubspot_view_model",
        ]
      : [pageBackfillTarget];
    await runPageBackfillTargets(targets, "Page backfill");
  }

  async function backfillFacts() {
    setBackfillLoading(true);
    setMessage("");
    setSyncProgress("");
    try {
      const fullHistoryStart = "2023-01-01";
      const endDate = toIsoDateUtc(new Date());
      const monthChunks = buildMonthChunks(fullHistoryStart, endDate, 1);
      if (!monthChunks.length) {
        setMessage("No backfill chunks to run.");
        return;
      }

      const dailyChunkDays = 15;
      let okRuns = 0;
      let failedRuns = 0;
      const failedDetails: string[] = [];
      const DAY_MS = 24 * 60 * 60 * 1000;

      const splitChunk = (chunk: { startDate: string; endDate: string; label: string }, minDays = 1) => {
        const start = new Date(`${chunk.startDate}T00:00:00.000Z`);
        const end = new Date(`${chunk.endDate}T00:00:00.000Z`);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() < start.getTime()) return null;
        const spanDays = Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1;
        if (spanDays <= Math.max(2, minDays)) return null;

        const firstSpanDays = Math.floor(spanDays / 2);
        if (firstSpanDays <= 0 || firstSpanDays >= spanDays) return null;
        const firstEnd = new Date(start.getTime() + (firstSpanDays - 1) * DAY_MS);
        const secondStart = new Date(firstEnd.getTime() + DAY_MS);
        const secondEnd = end;

        const first = {
          startDate: toIsoDateUtc(start),
          endDate: toIsoDateUtc(firstEnd),
          label: `${toIsoDateUtc(start)}..${toIsoDateUtc(firstEnd)}`,
        };
        const second = {
          startDate: toIsoDateUtc(secondStart),
          endDate: toIsoDateUtc(secondEnd),
          label: `${toIsoDateUtc(secondStart)}..${toIsoDateUtc(secondEnd)}`,
        };
        return [first, second];
      };

      const runPhase = async (
        phase: "daily" | "monthly",
        chunk: { startDate: string; endDate: string; label: string },
        attempt: number,
      ) => {
        const res = await fetch("/api/precomputed-facts/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({
            mode: "full",
            startDate: chunk.startDate,
            endDate: chunk.endDate,
            includeDaily: phase === "daily",
            includeMonthly: phase === "monthly",
          }),
        });
        const text = await res.text();
        let payload: unknown = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          payload = null;
        }
        if (!res.ok) {
          const snippet = text.replace(/\s+/g, " ").slice(0, 220);
          const looksLikeHtml = snippet.toLowerCase().includes("<!doctype html");
          const errorMessage =
            payload && typeof payload === "object" && "error" in payload
              ? String((payload as { error?: unknown }).error || "")
              : looksLikeHtml
                ? "Server returned HTML error page (usually timeout/runtime crash)."
                : snippet;
          throw new Error(errorMessage || `HTTP ${res.status}`);
        }
        const ok = Boolean(payload && typeof payload === "object" && "ok" in payload ? (payload as { ok?: unknown }).ok : true);
        if (!ok) {
          const errorMessage =
            payload && typeof payload === "object" && "error" in payload
              ? String((payload as { error?: unknown }).error || "")
              : "";
          throw new Error(errorMessage || `${phase} phase failed`);
        }
        if (attempt > 1) {
          setSyncProgress(`${phase.toUpperCase()} succeeded after retry: ${chunk.label}`);
        }
      };

      for (let monthIndex = 0; monthIndex < monthChunks.length; monthIndex += 1) {
        const monthChunk = monthChunks[monthIndex];
        const dailyBaseChunks = buildDayChunks(monthChunk.startDate, monthChunk.endDate, dailyChunkDays);
        const dailyPendingChunks = [...dailyBaseChunks];

        while (dailyPendingChunks.length > 0) {
          const chunk = dailyPendingChunks.shift()!;
          setSyncProgress(
            `Backfill daily (${monthIndex + 1}/${monthChunks.length} month): ${chunk.label}`,
          );
          let lastError = "";
          let completed = false;
          for (let attempt = 1; attempt <= 3 && !completed; attempt += 1) {
            try {
              await runPhase("daily", chunk, attempt);
              completed = true;
              okRuns += 1;
            } catch (error: unknown) {
              lastError = error instanceof Error ? error.message : "Unknown error";
              if (attempt < 3) {
                await sleep(Math.min(10_000, 1_000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 400)));
              }
            }
          }
          if (!completed) {
            const split = splitChunk(chunk, 2);
            if (split) {
              dailyPendingChunks.unshift(split[1], split[0]);
              setSyncProgress(`Split daily chunk ${chunk.label} into smaller windows...`);
              await sleep(250);
              continue;
            }
            failedRuns += 1;
            failedDetails.push(`daily ${chunk.label}: ${lastError || "Unknown error"}`);
          }
          await sleep(250);
        }

        setSyncProgress(`Backfill monthly (${monthIndex + 1}/${monthChunks.length} month): ${monthChunk.label}`);
        let lastError = "";
        let completed = false;
        for (let attempt = 1; attempt <= 3 && !completed; attempt += 1) {
          try {
            await runPhase("monthly", monthChunk, attempt);
            completed = true;
            okRuns += 1;
          } catch (error: unknown) {
            lastError = error instanceof Error ? error.message : "Unknown error";
            if (attempt < 3) {
              await sleep(Math.min(10_000, 1_000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 400)));
            }
          }
        }
        if (!completed) {
          const split = splitChunk(monthChunk, 7);
          if (split) {
            monthChunks.splice(monthIndex + 1, 0, split[0], split[1]);
            setSyncProgress(`Split monthly chunk ${monthChunk.label} into smaller windows...`);
          } else {
            failedRuns += 1;
            failedDetails.push(`monthly ${monthChunk.label}: ${lastError || "Unknown error"}`);
          }
        }
        await sleep(350);
      }

      if (failedRuns > 0) {
        setMessage(
          `Fact backfill finished with ${failedRuns} failed run(s). ` +
            `Succeeded: ${okRuns}. ` +
            `Failed: ${failedDetails.slice(0, 3).join(" | ")}`,
        );
      } else {
        setMessage(`Fact backfill completed successfully (${okRuns} runs).`);
      }
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "Fact backfill failed");
    } finally {
      setSyncProgress("");
      setBackfillLoading(false);
    }
  }

  async function runDebugBackfill() {
    if (!debugIncludeDaily && !debugIncludeMonthly) {
      setDebugResult({
        ok: false,
        status: 400,
        error: "Select at least one phase: Daily or Monthly.",
      });
      return;
    }
    if (!debugStartDate || !debugEndDate) {
      setDebugResult({
        ok: false,
        status: 400,
        error: "Start date and end date are required.",
      });
      return;
    }
    if (debugEndDate < debugStartDate) {
      setDebugResult({
        ok: false,
        status: 400,
        error: "End date must be on or after start date.",
      });
      return;
    }

    setDebugLoading(true);
    setDebugResult(null);

    try {
      const res = await fetch("/api/precomputed-facts/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          mode: "full",
          startDate: debugStartDate,
          endDate: debugEndDate,
          includeDaily: debugIncludeDaily,
          includeMonthly: debugIncludeMonthly,
        }),
      });

      const text = await res.text();
      let payload: unknown = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }

      if (!res.ok) {
        const snippet = text.replace(/\s+/g, " ").slice(0, 260);
        const looksLikeHtml = snippet.toLowerCase().includes("<!doctype html");
        const payloadError =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error?: unknown }).error || "")
            : "";
        setDebugResult({
          ok: false,
          status: res.status,
          error:
            payloadError ||
            (looksLikeHtml ? "Server returned HTML error page (likely timeout/runtime crash)." : snippet) ||
            `HTTP ${res.status}`,
        });
        return;
      }

      const ok = Boolean(payload && typeof payload === "object" && "ok" in payload ? (payload as { ok?: unknown }).ok : true);
      const shaped = (payload && typeof payload === "object" ? payload : {}) as {
        startedAtUtc?: unknown;
        finishedAtUtc?: unknown;
        tookMs?: unknown;
        syncRunId?: unknown;
        steps?: unknown;
        error?: unknown;
      };
      const steps = Array.isArray(shaped.steps) ? (shaped.steps as DebugBackfillStep[]) : [];
      setDebugResult({
        ok,
        status: res.status,
        error: ok ? undefined : String(shaped.error || "Sync reported failure."),
        startedAtUtc: String(shaped.startedAtUtc || ""),
        finishedAtUtc: String(shaped.finishedAtUtc || ""),
        tookMs: Number.isFinite(Number(shaped.tookMs)) ? Number(shaped.tookMs) : undefined,
        syncRunId: String(shaped.syncRunId || ""),
        steps,
      });
    } catch (error: unknown) {
      setDebugResult({
        ok: false,
        status: 0,
        error: error instanceof Error ? error.message : "Request failed",
      });
    } finally {
      setDebugLoading(false);
    }
  }

  async function backfillStripeMatchMetadata() {
    if (!debugStartDate || !debugEndDate) {
      setMessage("Select start and end dates for Stripe match metadata backfill.");
      return;
    }
    if (debugEndDate < debugStartDate) {
      setMessage("Stripe match metadata end date must be on or after start date.");
      return;
    }

    setMatchMetadataBackfillLoading(true);
    setMessage("");
    setSyncProgress("");
    try {
      const chunkMonths = Math.max(1, Math.min(12, Math.floor(matchMetadataChunkMonths || 1)));
      const chunks = buildMonthChunks(debugStartDate, debugEndDate, chunkMonths);
      if (!chunks.length) {
        setMessage("No monthly chunks generated for Stripe match metadata backfill.");
        return;
      }

      let okRuns = 0;
      let failedRuns = 0;
      const failedDetails: string[] = [];

      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        setSyncProgress(`Stripe match metadata ${i + 1}/${chunks.length}: ${chunk.label}`);
        let succeeded = false;
        let lastError = "";

        for (let attempt = 1; attempt <= 3 && !succeeded; attempt += 1) {
          try {
            const res = await fetch("/api/precomputed-facts/sync", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              cache: "no-store",
              body: JSON.stringify({
                mode: "full",
                startDate: chunk.startDate,
                endDate: chunk.endDate,
                includeDaily: false,
                includeMonthly: true,
              }),
            });
            const text = await res.text();
            let payload: unknown = null;
            try {
              payload = text ? JSON.parse(text) : null;
            } catch {
              payload = null;
            }
            if (!res.ok) {
              const snippet = text.replace(/\s+/g, " ").slice(0, 220);
              const looksLikeHtml = snippet.toLowerCase().includes("<!doctype html");
              const payloadError =
                payload && typeof payload === "object" && "error" in payload
                  ? String((payload as { error?: unknown }).error || "")
                  : "";
              throw new Error(
                payloadError ||
                  (looksLikeHtml ? "Server returned HTML error page (likely timeout/runtime crash)." : snippet) ||
                  `HTTP ${res.status}`,
              );
            }
            const ok = Boolean(
              payload && typeof payload === "object" && "ok" in payload
                ? (payload as { ok?: unknown }).ok
                : true,
            );
            if (!ok) {
              const payloadError =
                payload && typeof payload === "object" && "error" in payload
                  ? String((payload as { error?: unknown }).error || "")
                  : "";
              throw new Error(payloadError || "Sync reported failure");
            }
            succeeded = true;
            okRuns += 1;
          } catch (error: unknown) {
            lastError = error instanceof Error ? error.message : "Unknown error";
            if (attempt < 3) {
              await sleep(Math.min(10_000, 1_000 * 2 ** (attempt - 1)));
            }
          }
        }

        if (!succeeded) {
          failedRuns += 1;
          failedDetails.push(`${chunk.label}: ${lastError || "Unknown error"}`);
        }
        await sleep(250);
      }

      if (failedRuns > 0) {
        setMessage(
          `Stripe match metadata backfill finished with ${failedRuns} failed run(s). ` +
            `Succeeded: ${okRuns}. ` +
            `Failed: ${failedDetails.slice(0, 3).join(" | ")}`,
        );
      } else {
        setMessage(`Stripe match metadata backfill completed successfully (${okRuns} runs).`);
      }
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "Stripe match metadata backfill failed");
    } finally {
      setSyncProgress("");
      setMatchMetadataBackfillLoading(false);
    }
  }

  async function backfillAiSpendDailyFacts() {
    if (!debugStartDate || !debugEndDate) {
      setMessage("Select start and end dates for AI spend daily backfill.");
      return;
    }
    if (debugEndDate < debugStartDate) {
      setMessage("AI spend daily backfill end date must be on or after start date.");
      return;
    }

    setAiSpendDailyBackfillLoading(true);
    setMessage("");
    setSyncProgress("");
    try {
      const chunkMonths = Math.max(1, Math.min(12, Math.floor(aiSpendDailyChunkMonths || 1)));
      const chunks = buildMonthChunks(debugStartDate, debugEndDate, chunkMonths);
      if (!chunks.length) {
        setMessage("No monthly chunks generated for AI spend daily backfill.");
        return;
      }

      let okRuns = 0;
      let failedRuns = 0;
      const failedDetails: string[] = [];

      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        setSyncProgress(`AI spend daily ${i + 1}/${chunks.length}: ${chunk.label}`);
        let succeeded = false;
        let lastError = "";

        for (let attempt = 1; attempt <= 3 && !succeeded; attempt += 1) {
          try {
            const res = await fetch("/api/precomputed-facts/sync", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              cache: "no-store",
              body: JSON.stringify({
                mode: "full",
                startDate: chunk.startDate,
                endDate: chunk.endDate,
                includeDaily: true,
                includeMonthly: false,
              }),
            });
            const text = await res.text();
            let payload: unknown = null;
            try {
              payload = text ? JSON.parse(text) : null;
            } catch {
              payload = null;
            }
            if (!res.ok) {
              const snippet = text.replace(/\s+/g, " ").slice(0, 220);
              const looksLikeHtml = snippet.toLowerCase().includes("<!doctype html");
              const payloadError =
                payload && typeof payload === "object" && "error" in payload
                  ? String((payload as { error?: unknown }).error || "")
                  : "";
              throw new Error(
                payloadError ||
                  (looksLikeHtml ? "Server returned HTML error page (likely timeout/runtime crash)." : snippet) ||
                  `HTTP ${res.status}`,
              );
            }
            const ok = Boolean(
              payload && typeof payload === "object" && "ok" in payload
                ? (payload as { ok?: unknown }).ok
                : true,
            );
            if (!ok) {
              const payloadError =
                payload && typeof payload === "object" && "error" in payload
                  ? String((payload as { error?: unknown }).error || "")
                  : "";
              throw new Error(payloadError || "Sync reported failure");
            }
            succeeded = true;
            okRuns += 1;
          } catch (error: unknown) {
            lastError = error instanceof Error ? error.message : "Unknown error";
            if (attempt < 3) {
              await sleep(Math.min(10_000, 1_000 * 2 ** (attempt - 1)));
            }
          }
        }

        if (!succeeded) {
          failedRuns += 1;
          failedDetails.push(`${chunk.label}: ${lastError || "Unknown error"}`);
        }
        await sleep(250);
      }

      if (failedRuns > 0) {
        setMessage(
          `AI spend daily backfill finished with ${failedRuns} failed run(s). ` +
            `Succeeded: ${okRuns}. ` +
            `Failed: ${failedDetails.slice(0, 3).join(" | ")}`,
        );
      } else {
        setMessage(`AI spend daily backfill completed successfully (${okRuns} runs).`);
      }
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "AI spend daily backfill failed");
    } finally {
      setSyncProgress("");
      setAiSpendDailyBackfillLoading(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        right: 12,
        bottom: 12,
        zIndex: 60,
        display: "grid",
        gap: 6,
        justifyItems: "end",
      }}
    >
      {message ? (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#b91c1c",
            borderRadius: 8,
            padding: "8px 10px",
            maxWidth: 360,
            fontSize: 12,
          }}
        >
          {message}
        </div>
      ) : null}
      {syncProgress ? (
        <div
          style={{
            background: "#eff6ff",
            border: "1px solid #bfdbfe",
            color: "#1e3a8a",
            borderRadius: 8,
            padding: "8px 10px",
            maxWidth: 360,
            fontSize: 12,
          }}
        >
          {syncProgress}
        </div>
      ) : null}
      {isAdmin && debugPanelOpen ? (
        <div
          style={{
            background: "#f8fafc",
            border: "1px solid #cbd5e1",
            color: "#0f172a",
            borderRadius: 10,
            padding: "10px 12px",
            width: 430,
            maxWidth: "calc(100vw - 24px)",
            boxShadow: "0 4px 16px rgba(15,23,42,0.08)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Debug backfill</div>
            <button
              type="button"
              onClick={() => setDebugPanelOpen(false)}
              style={{
                borderRadius: 8,
                border: "1px solid #94a3b8",
                background: "#ffffff",
                color: "#334155",
                padding: "4px 8px",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              Close
            </button>
          </div>
          <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <label style={{ display: "grid", gap: 4, fontSize: 11 }}>
              <span>Start date</span>
              <input
                type="date"
                value={debugStartDate}
                onChange={(e) => setDebugStartDate(e.target.value)}
                style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "6px 8px", fontSize: 12 }}
              />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 11 }}>
              <span>End date</span>
              <input
                type="date"
                value={debugEndDate}
                onChange={(e) => setDebugEndDate(e.target.value)}
                style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "6px 8px", fontSize: 12 }}
              />
            </label>
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, textTransform: "none", letterSpacing: 0 }}>
              <input
                type="checkbox"
                checked={debugIncludeDaily}
                onChange={(e) => setDebugIncludeDaily(e.target.checked)}
              />
              Daily
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, textTransform: "none", letterSpacing: 0 }}>
              <input
                type="checkbox"
                checked={debugIncludeMonthly}
                onChange={(e) => setDebugIncludeMonthly(e.target.checked)}
              />
              Monthly
            </label>
            <button
              type="button"
              onClick={() => void runDebugBackfill()}
              disabled={debugLoading || pageBackfillLoading || loading || syncLoading || backfillLoading || matchMetadataBackfillLoading || aiSpendDailyBackfillLoading}
              style={{
                marginLeft: "auto",
                borderRadius: 8,
                border: "1px solid #0369a1",
                background: debugLoading ? "#0369a1" : "#0284c7",
                color: "#ffffff",
                padding: "6px 10px",
                fontSize: 12,
                fontWeight: 700,
                cursor: debugLoading || pageBackfillLoading || loading || syncLoading || backfillLoading || matchMetadataBackfillLoading || aiSpendDailyBackfillLoading ? "wait" : "pointer",
              }}
            >
              {debugLoading ? "Running..." : "Run debug"}
            </button>
          </div>
          <div style={{ marginTop: 10, borderTop: "1px solid #cbd5e1", paddingTop: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Page-by-page cache backfill</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 8 }}>
              <label style={{ display: "grid", gap: 4, fontSize: 11 }}>
                <span>Page target</span>
                <select
                  value={pageBackfillTarget}
                  onChange={(e) => setPageBackfillTarget(e.target.value as PageBackfillTarget)}
                  style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "6px 8px", fontSize: 12 }}
                >
                  {PAGE_BACKFILL_TARGET_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: "grid", gap: 4, fontSize: 11 }}>
                <span>Chunk size</span>
                <input
                  type="number"
                  min={1}
                  max={12}
                  step={1}
                  value={String(pageBackfillChunkMonths)}
                  onChange={(e) => setPageBackfillChunkMonths(Number(e.target.value || 1))}
                  style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "6px 8px", fontSize: 12 }}
                />
              </label>
            </div>
            <div style={{ marginTop: 8, display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => void runPageBackfill()}
                disabled={
                  pageBackfillLoading ||
                  debugLoading ||
                  loading ||
                  syncLoading ||
                  backfillLoading ||
                  matchMetadataBackfillLoading ||
                  aiSpendDailyBackfillLoading
                }
                style={{
                  borderRadius: 8,
                  border: "1px solid #166534",
                  background: pageBackfillLoading ? "#166534" : "#16a34a",
                  color: "#ffffff",
                  padding: "6px 10px",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor:
                    pageBackfillLoading ||
                    debugLoading ||
                    loading ||
                    syncLoading ||
                    backfillLoading ||
                    matchMetadataBackfillLoading ||
                    aiSpendDailyBackfillLoading
                      ? "wait"
                      : "pointer",
                }}
              >
                {pageBackfillLoading ? "Backfilling..." : "Run page backfill"}
              </button>
            </div>
            <div style={{ marginTop: 10, borderTop: "1px dashed #cbd5e1", paddingTop: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
                One-click page backfill buttons
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                {PAGE_BACKFILL_SINGLE_TARGET_OPTIONS.map((targetOption) => (
                  <button
                    key={targetOption.value}
                    type="button"
                    onClick={() => void runPageBackfillTargets([targetOption.value], `${targetOption.label} backfill`)}
                    disabled={
                      pageBackfillLoading ||
                      debugLoading ||
                      loading ||
                      syncLoading ||
                      backfillLoading ||
                      matchMetadataBackfillLoading ||
                      aiSpendDailyBackfillLoading
                    }
                    style={{
                      borderRadius: 8,
                      border: "1px solid #334155",
                      background: "#ffffff",
                      color: "#0f172a",
                      padding: "6px 8px",
                      fontSize: 11,
                      fontWeight: 700,
                      textAlign: "left",
                      cursor:
                        pageBackfillLoading ||
                        debugLoading ||
                        loading ||
                        syncLoading ||
                        backfillLoading ||
                        matchMetadataBackfillLoading ||
                        aiSpendDailyBackfillLoading
                          ? "wait"
                          : "pointer",
                      opacity:
                        pageBackfillLoading ||
                        debugLoading ||
                        loading ||
                        syncLoading ||
                        backfillLoading ||
                        matchMetadataBackfillLoading ||
                        aiSpendDailyBackfillLoading
                          ? 0.7
                          : 1,
                    }}
                  >
                    {targetOption.label}
                  </button>
                ))}
              </div>
              <div style={{ marginTop: 6, fontSize: 11, color: "#475569", lineHeight: 1.4 }}>
                Uses the selected start/end dates and chunk size above.
              </div>
            </div>
          </div>
          <div style={{ marginTop: 10, borderTop: "1px solid #cbd5e1", paddingTop: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
              Temporary: Stripe match metadata backfill
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 8 }}>
              <div style={{ fontSize: 11, color: "#334155", lineHeight: 1.4 }}>
                Uses the selected start/end dates above and runs monthly-only fact sync in chunks.
              </div>
              <label style={{ display: "grid", gap: 4, fontSize: 11 }}>
                <span>Chunk size</span>
                <input
                  type="number"
                  min={1}
                  max={12}
                  step={1}
                  value={String(matchMetadataChunkMonths)}
                  onChange={(e) => setMatchMetadataChunkMonths(Number(e.target.value || 1))}
                  style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "6px 8px", fontSize: 12 }}
                />
              </label>
            </div>
            <div style={{ marginTop: 8, display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => void backfillStripeMatchMetadata()}
                disabled={
                  matchMetadataBackfillLoading ||
                  aiSpendDailyBackfillLoading ||
                  debugLoading ||
                  pageBackfillLoading ||
                  loading ||
                  syncLoading ||
                  backfillLoading
                }
                style={{
                  borderRadius: 8,
                  border: "1px solid #7c3aed",
                  background: matchMetadataBackfillLoading ? "#6d28d9" : "#8b5cf6",
                  color: "#ffffff",
                  padding: "6px 10px",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor:
                    matchMetadataBackfillLoading ||
                    aiSpendDailyBackfillLoading ||
                    debugLoading ||
                    pageBackfillLoading ||
                    loading ||
                    syncLoading ||
                    backfillLoading
                      ? "wait"
                      : "pointer",
                }}
              >
                {matchMetadataBackfillLoading ? "Backfilling..." : "Backfill stripe match metadata"}
              </button>
            </div>
          </div>
          <div style={{ marginTop: 10, borderTop: "1px solid #cbd5e1", paddingTop: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
              Temporary: AI spend daily fact backfill
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 8 }}>
              <div style={{ fontSize: 11, color: "#334155", lineHeight: 1.4 }}>
                Uses the selected start/end dates above and runs daily-only fact sync in chunks.
              </div>
              <label style={{ display: "grid", gap: 4, fontSize: 11 }}>
                <span>Chunk size</span>
                <input
                  type="number"
                  min={1}
                  max={12}
                  step={1}
                  value={String(aiSpendDailyChunkMonths)}
                  onChange={(e) => setAiSpendDailyChunkMonths(Number(e.target.value || 1))}
                  style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "6px 8px", fontSize: 12 }}
                />
              </label>
            </div>
            <div style={{ marginTop: 8, display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => void backfillAiSpendDailyFacts()}
                disabled={
                  aiSpendDailyBackfillLoading ||
                  matchMetadataBackfillLoading ||
                  debugLoading ||
                  pageBackfillLoading ||
                  loading ||
                  syncLoading ||
                  backfillLoading
                }
                style={{
                  borderRadius: 8,
                  border: "1px solid #b45309",
                  background: aiSpendDailyBackfillLoading ? "#b45309" : "#d97706",
                  color: "#ffffff",
                  padding: "6px 10px",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor:
                    aiSpendDailyBackfillLoading ||
                    matchMetadataBackfillLoading ||
                    debugLoading ||
                    pageBackfillLoading ||
                    loading ||
                    syncLoading ||
                    backfillLoading
                      ? "wait"
                      : "pointer",
                }}
              >
                {aiSpendDailyBackfillLoading ? "Backfilling..." : "Backfill AI spend daily facts"}
              </button>
            </div>
          </div>
          {debugResult ? (
            <div
              style={{
                marginTop: 10,
                border: `1px solid ${debugResult.ok ? "#86efac" : "#fecaca"}`,
                background: debugResult.ok ? "#f0fdf4" : "#fef2f2",
                borderRadius: 8,
                padding: 8,
                fontSize: 12,
                color: debugResult.ok ? "#166534" : "#b91c1c",
                maxHeight: 250,
                overflow: "auto",
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {debugResult.ok ? "Success" : "Failed"} (status: {debugResult.status})
              </div>
              {debugResult.error ? <div style={{ marginBottom: 6 }}>{debugResult.error}</div> : null}
              {debugResult.startedAtUtc ? <div>Started: {formatMontrealTime(debugResult.startedAtUtc)} ET</div> : null}
              {debugResult.finishedAtUtc ? <div>Finished: {formatMontrealTime(debugResult.finishedAtUtc)} ET</div> : null}
              {typeof debugResult.tookMs === "number" ? <div>Took: {debugResult.tookMs}ms</div> : null}
              {debugResult.syncRunId ? <div>Run ID: {debugResult.syncRunId}</div> : null}
              {debugResult.steps && debugResult.steps.length > 0 ? (
                <div style={{ marginTop: 8 }}>
                  {debugResult.steps.map((step, idx) => (
                    <div key={`${step.step || "step"}-${idx}`} style={{ marginBottom: 4 }}>
                      [{step.ok ? "OK" : "FAIL"}] {step.step || `step-${idx + 1}`}
                      {typeof step.tookMs === "number" ? ` (${step.tookMs}ms)` : ""}
                      {step.error ? ` - ${step.error}` : ""}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 8 }}>
        {isAdmin ? (
          <>
            <button
              type="button"
              onClick={() => void syncNow("fast")}
              disabled={syncLoading || backfillLoading || pageBackfillLoading || matchMetadataBackfillLoading || aiSpendDailyBackfillLoading || loading}
              style={{
                borderRadius: 10,
                border: "1px solid #1d4ed8",
                background: syncLoading ? "#1e3a8a" : "#2563eb",
                color: "#ffffff",
                padding: "10px 12px",
                fontSize: 13,
                fontWeight: 700,
                cursor: syncLoading || backfillLoading || pageBackfillLoading || matchMetadataBackfillLoading || aiSpendDailyBackfillLoading || loading ? "wait" : "pointer",
              }}
              title="Sync dirty changes only (fast incremental)"
            >
              {syncLoading ? "Syncing..." : "Sync now (dirty)"}
            </button>
            <button
              type="button"
              onClick={() => void syncNow("full")}
              disabled={syncLoading || backfillLoading || pageBackfillLoading || matchMetadataBackfillLoading || aiSpendDailyBackfillLoading || loading}
              style={{
                borderRadius: 10,
                border: "1px solid #475569",
                background: syncLoading ? "#334155" : "#64748b",
                color: "#ffffff",
                padding: "10px 12px",
                fontSize: 13,
                fontWeight: 700,
                cursor: syncLoading || backfillLoading || pageBackfillLoading || matchMetadataBackfillLoading || aiSpendDailyBackfillLoading || loading ? "wait" : "pointer",
              }}
              title="Full historical sync"
            >
              {syncLoading ? "Syncing..." : "Full sync"}
            </button>
            <button
              type="button"
              onClick={() => setDebugPanelOpen((prev) => !prev)}
              disabled={syncLoading || backfillLoading || pageBackfillLoading || matchMetadataBackfillLoading || aiSpendDailyBackfillLoading || loading || debugLoading}
              style={{
                borderRadius: 10,
                border: "1px solid #0369a1",
                background: debugPanelOpen ? "#075985" : "#0ea5e9",
                color: "#ffffff",
                padding: "10px 12px",
                fontSize: 13,
                fontWeight: 700,
                cursor: syncLoading || backfillLoading || pageBackfillLoading || matchMetadataBackfillLoading || aiSpendDailyBackfillLoading || loading || debugLoading ? "wait" : "pointer",
              }}
              title="Run targeted date-range fact sync and view step-level output"
            >
              {debugPanelOpen ? "Hide debug" : "Debug backfill"}
            </button>
            <button
              type="button"
              onClick={() => void backfillFacts()}
              disabled={backfillLoading || syncLoading || pageBackfillLoading || matchMetadataBackfillLoading || aiSpendDailyBackfillLoading || loading || debugLoading}
              style={{
                borderRadius: 10,
                border: "1px solid #065f46",
                background: backfillLoading ? "#065f46" : "#0f766e",
                color: "#ffffff",
                padding: "10px 12px",
                fontSize: 13,
                fontWeight: 700,
                cursor: backfillLoading || syncLoading || pageBackfillLoading || matchMetadataBackfillLoading || aiSpendDailyBackfillLoading || loading ? "wait" : "pointer",
              }}
              title="Chunked full backfill into fact tables (safe retries)"
            >
              {backfillLoading ? "Backfilling..." : "Backfill facts"}
            </button>
          </>
        ) : null}
        <button
          type="button"
          onClick={() => void hardRefresh()}
          disabled={loading || syncLoading || backfillLoading || pageBackfillLoading || matchMetadataBackfillLoading || aiSpendDailyBackfillLoading}
          style={{
            borderRadius: 10,
            border: "1px solid #0f172a",
            background: loading ? "#1f2937" : "#111827",
            color: "#ffffff",
            padding: "10px 12px",
            fontSize: 13,
            fontWeight: 700,
            cursor: loading || syncLoading || backfillLoading || pageBackfillLoading || matchMetadataBackfillLoading || aiSpendDailyBackfillLoading ? "wait" : "pointer",
          }}
          title="Clear server caches and reload all data from scratch"
        >
          {loading ? "Refreshing..." : "Hard refresh"}
        </button>
      </div>
      {lastSyncAtUtc ? (
        <div
          style={{
            background: "#ecfdf5",
            border: "1px solid #a7f3d0",
            color: "#065f46",
            borderRadius: 8,
            padding: "6px 10px",
            maxWidth: 420,
            fontSize: 12,
          }}
        >
          Last sync: {formatMontrealTime(lastSyncAtUtc)} ET
          {lastSyncSummary ? ` (${lastSyncSummary})` : ""}
        </div>
      ) : null}
    </div>
  );
}
