import { NextResponse } from "next/server";
import {
  queryStripeCustomerIdsByWorkspaceIdsFromBigQuery,
  type StripeBigQueryProfile,
} from "@/lib/stripeBigquery";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 120;

const CACHE_TTL_MS = readTtlMs("API_MODEL_UPDATE_SALES_ASSIST_CACHE_TTL_MS", 600_000);
const STRIPE_OPTIONS: { profile: StripeBigQueryProfile } = {
  profile: "stripe_arr_correct",
};

type ApiBody = {
  workspaceIds?: unknown;
};

function normalizeWorkspaceIdToken(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function parseWorkspaceIds(input: unknown) {
  if (Array.isArray(input)) {
    return Array.from(new Set(input.map((value) => normalizeWorkspaceIdToken(value)).filter(Boolean)));
  }
  if (typeof input === "string") {
    return Array.from(
      new Set(
        input
          .split(/[,\s|;\n\r\t]+/)
          .map((value) => normalizeWorkspaceIdToken(value))
          .filter(Boolean),
      ),
    );
  }
  return [];
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as ApiBody;
    const workspaceIds = parseWorkspaceIds(body.workspaceIds);
    if (!workspaceIds.length) {
      return NextResponse.json({
        workspaceIds: [],
        customerIds: [],
        mappings: [],
      });
    }

    const key = `api:model-update-sales-assist-customers:${stableStringify({ workspaceIds })}`;
    const payload = await getOrSetCache(key, CACHE_TTL_MS, () =>
      queryStripeCustomerIdsByWorkspaceIdsFromBigQuery(workspaceIds, STRIPE_OPTIONS),
    );
    return NextResponse.json(payload);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

