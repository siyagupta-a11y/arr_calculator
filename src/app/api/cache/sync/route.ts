import { getToken } from "next-auth/jwt";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  buildWarmupTaskDefinitions,
  clearWebsiteCaches,
  getSyncRunState,
  initializeSyncRunState,
  runWarmupTaskBatch,
  syncWebsiteCache,
  type SyncMode,
  updateSyncRunStateAfterBatch,
  writeFinalSyncStatusCounts,
} from "@/lib/siteCacheSync";
import { detectDirtyMonthSyncPlan, resolveDirtyMonthKeys } from "@/lib/dirtyDateSync";

export const runtime = "nodejs";
export const maxDuration = 800;

type Body = {
  action?: "start" | "step" | "complete" | "run";
  warmup?: boolean;
  syncMode?: "fast" | "full";
  taskIndex?: number;
  batchSize?: number;
  startedAtUtc?: string;
  okTaskCount?: number;
  failedTaskCount?: number;
  totalTaskCount?: number;
};

function parseBool(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "y";
}

function parseSyncMode(value: unknown): SyncMode {
  return String(value || "").trim().toLowerCase() === "full" ? "full" : "fast";
}

export async function POST(req: NextRequest) {
  try {
    const token = await getToken({
      req,
      secret: process.env.AUTH_SECRET,
    });
    const isAdmin = String(token?.role || "viewer").trim().toLowerCase() === "admin";
    if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    let body: Body = {};
    try {
      body = (await req.json()) as Body;
    } catch {
      body = {};
    }
    const action = String(body.action || "start").trim().toLowerCase();
    const warmup = parseBool(body.warmup, true);
    const syncMode = parseSyncMode(body.syncMode);

    if (action === "run") {
      const result = await syncWebsiteCache({ warmup, syncMode });
      return NextResponse.json({ ok: true, mode: "run", ...result });
    }

    if (action === "start") {
      const existing = await getSyncRunState().catch(() => null);
      if (warmup && existing && !existing.done && existing.syncMode === syncMode) {
        return NextResponse.json({
          ok: true,
          mode: "start",
          warmup: existing.warmup,
          syncMode: existing.syncMode,
          resumed: true,
          startedAtUtc: existing.startedAtUtc,
          totalTasks: existing.totalTasks,
          taskKeys: existing.taskKeys || [],
          nextTaskIndex: existing.nextTaskIndex,
          done: Boolean(existing.done),
          okTaskCount: existing.okTaskCount,
          failedTaskCount: existing.failedTaskCount,
        });
      }
      const startedAtUtc = new Date().toISOString();
      const cleared = await clearWebsiteCaches();
      const dirtyPlan = warmup ? await detectDirtyMonthSyncPlan(syncMode).catch(() => null) : null;
      const dirtyMode = Boolean(dirtyPlan?.useDirtyMonths);
      const dirtyMonthKeys = dirtyMode ? (dirtyPlan?.dirtyMonthKeys || []) : [];
      const taskDefinitions = warmup ? buildWarmupTaskDefinitions(syncMode, { dirtyMonthKeys }) : [];
      const totalTasks = taskDefinitions.length;
      const taskKeys = taskDefinitions.map((task) => task.key);
      if (warmup) {
        await initializeSyncRunState({
          warmup: true,
          syncMode,
          dirtyMode,
          dirtyMonthKeys,
          startedAtUtc,
          totalTasks,
          taskKeys,
        });
      }
      if (!warmup) {
        await writeFinalSyncStatusCounts(startedAtUtc, false, 0, 0, 0);
      }
      return NextResponse.json({
        ok: true,
        mode: "start",
        warmup,
        syncMode,
        dirtyMode,
        dirtyMonthKeys,
        dirtyFallbackReason: dirtyPlan?.fallbackReason || null,
        resumed: false,
        startedAtUtc,
        totalTasks,
        taskKeys,
        nextTaskIndex: 0,
        done: totalTasks === 0,
        cleared,
      });
    }

    if (action === "step") {
      const currentState = await getSyncRunState().catch(() => null);
      const taskIndex = Number(
        currentState && !currentState.done && currentState.syncMode === syncMode
          ? currentState.nextTaskIndex
          : body.taskIndex || 0,
      );
      const dirtyMonthKeys =
        currentState && !currentState.done && currentState.syncMode === syncMode && currentState.dirtyMode
          ? currentState.dirtyMonthKeys || []
          : [];
      const batchSize = Number(body.batchSize || 1);
      const batch = await runWarmupTaskBatch(taskIndex, batchSize, syncMode, { dirtyMonthKeys });
      let okTaskCount = 0;
      let failedTaskCount = 0;
      let done = batch.done;
      if (currentState && !currentState.done && currentState.syncMode === syncMode) {
        const nextState = await updateSyncRunStateAfterBatch({
          previous: currentState,
          batch,
        });
        okTaskCount = nextState.okTaskCount;
        failedTaskCount = nextState.failedTaskCount;
        done = nextState.done;
        if (done && nextState.dirtyMode && failedTaskCount === 0 && (nextState.dirtyMonthKeys || []).length) {
          await resolveDirtyMonthKeys(nextState.dirtyMonthKeys || []).catch(() => undefined);
        }
      }
      return NextResponse.json({
        ok: true,
        mode: "step",
        warmup: true,
        syncMode,
        okTaskCount,
        failedTaskCount,
        ...batch,
        done,
      });
    }

    if (action === "complete") {
      const startedAtUtc = String(body.startedAtUtc || "").trim();
      if (!startedAtUtc) {
        return NextResponse.json({ ok: false, error: "Missing startedAtUtc" }, { status: 400 });
      }
      await writeFinalSyncStatusCounts(
        startedAtUtc,
        true,
        Number(body.okTaskCount || 0),
        Number(body.failedTaskCount || 0),
        Number(body.totalTaskCount || 0),
      );
      return NextResponse.json({ ok: true, mode: "complete" });
    }

    return NextResponse.json({ ok: false, error: "Invalid action" }, { status: 400 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
