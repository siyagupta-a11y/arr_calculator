import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;

type ApiBody = {
  startDate?: string;
  endDate?: string;
};

type ProviderResult = {
  status: "ok" | "not_configured" | "error";
  value: number | null;
  details?: string;
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

function findFirstNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const n = findFirstNumber(item);
      if (n != null) return n;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const preferredKeys = ["value", "total", "count", "metric", "number", "users", "sessions"];
    for (const key of preferredKeys) {
      if (!(key in record)) continue;
      const n = findFirstNumber(record[key]);
      if (n != null) return n;
    }
    for (const key of Object.keys(record)) {
      const n = findFirstNumber(record[key]);
      if (n != null) return n;
    }
  }
  return null;
}

async function fetchProviderMetric(
  endpointEnv: string,
  tokenEnv: string,
  startDate: string,
  endDate: string,
): Promise<ProviderResult> {
  const endpoint = String(process.env[endpointEnv] || "").trim();
  if (!endpoint) {
    return {
      status: "not_configured",
      value: null,
      details: `${endpointEnv} is not set`,
    };
  }

  const token = String(process.env[tokenEnv] || "").trim();
  const url = new URL(endpoint);
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      return {
        status: "error",
        value: null,
        details: `HTTP ${res.status}: ${text.slice(0, 300)}`,
      };
    }
    const value = findFirstNumber(json);
    if (value == null) {
      return {
        status: "error",
        value: null,
        details: "No numeric metric found in response",
      };
    }
    return {
      status: "ok",
      value,
    };
  } catch (error: unknown) {
    return {
      status: "error",
      value: null,
      details: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function runReport(startDate: string, endDate: string) {
  const [mixpanel, googleAnalytics] = await Promise.all([
    fetchProviderMetric(
      "MODEL_UPDATE_MIXPANEL_ENDPOINT",
      "MODEL_UPDATE_MIXPANEL_BEARER_TOKEN",
      startDate,
      endDate,
    ),
    fetchProviderMetric(
      "MODEL_UPDATE_GA_ENDPOINT",
      "MODEL_UPDATE_GA_BEARER_TOKEN",
      startDate,
      endDate,
    ),
  ]);

  return {
    startDate,
    endDate,
    mixpanel,
    googleAnalytics,
  };
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Partial<ApiBody>;
    const { startDate, endDate } = parsePayload(body);
    const report = await runReport(startDate, endDate);
    return NextResponse.json(report);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") ||
      message.includes("endDate must be >= startDate")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
