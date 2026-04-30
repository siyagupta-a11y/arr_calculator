import { getToken } from "next-auth/jwt";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  buildWarmupTaskDefinitions,
  clearWebsiteCaches,
  runWarmupTaskBatch,
  syncWebsiteCache,
  writeFinalSyncStatusCounts,
} from "@/lib/siteCacheSync";

export const runtime = "nodejs";
export const maxDuration = 300;

type Body = {
  action?: "start" | "step" | "complete" | "run";
  warmup?: boolean;
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

    if (action === "run") {
      const result = await syncWebsiteCache({ warmup });
      return NextResponse.json({ ok: true, mode: "run", ...result });
    }

    if (action === "start") {
      const startedAtUtc = new Date().toISOString();
      const cleared = await clearWebsiteCaches();
      const totalTasks = warmup ? buildWarmupTaskDefinitions().length : 0;
      if (!warmup) {
        await writeFinalSyncStatusCounts(startedAtUtc, false, 0, 0, 0);
      }
      return NextResponse.json({
        ok: true,
        mode: "start",
        warmup,
        startedAtUtc,
        totalTasks,
        nextTaskIndex: 0,
        done: totalTasks === 0,
        cleared,
      });
    }

    if (action === "step") {
      const taskIndex = Number(body.taskIndex || 0);
      const batchSize = Number(body.batchSize || 1);
      const batch = await runWarmupTaskBatch(taskIndex, batchSize);
      return NextResponse.json({
        ok: true,
        mode: "step",
        warmup: true,
        ...batch,
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
