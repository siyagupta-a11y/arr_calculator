import { NextResponse } from "next/server";
import { queryBambooHrNewHiresByDateRange } from "@/lib/bamboohr";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 120;

const CACHE_TTL_MS = readTtlMs("API_MODEL_UPDATE_NEW_HIRES_CACHE_TTL_MS", 300_000);

type ApiBody = {
  startDate?: string;
  endDate?: string;
};

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function parsePayload(raw: Partial<ApiBody>) {
  const startDate = String(raw.startDate || "").trim();
  const endDate = String(raw.endDate || "").trim();
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    throw new Error("Invalid startDate/endDate");
  }
  if (endDate < startDate) {
    throw new Error("endDate must be >= startDate");
  }
  return { startDate, endDate };
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Partial<ApiBody>;
    const { startDate, endDate } = parsePayload(body);

    const key = `api:model-update-new-hires:${stableStringify({ startDate, endDate })}`;
    const rows = await getOrSetCache(key, CACHE_TTL_MS, () => queryBambooHrNewHiresByDateRange(startDate, endDate));
    return NextResponse.json({
      startDate,
      endDate,
      rows,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") ||
      message.includes("endDate must be >=")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

