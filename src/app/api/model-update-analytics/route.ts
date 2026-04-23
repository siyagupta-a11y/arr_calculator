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

type MixpanelMetricsResult = {
  dauLastDay: ProviderResult;
  wauLastDay: ProviderResult;
  mauLastDay: ProviderResult;
  signupsInMonth: ProviderResult;
  productionMessagesInMonth: ProviderResult;
  highVolumeWorkspacesInMonth: ProviderResult;
  activeBuilders10of30: ProviderResult;
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
  queryParams: Record<string, string>,
  fallbackEndpoint?: string,
): Promise<ProviderResult> {
  const endpoint = String(process.env[endpointEnv] || "").trim() || String(fallbackEndpoint || "").trim();
  if (!endpoint) {
    return {
      status: "not_configured",
      value: null,
      details: `${endpointEnv} is not set`,
    };
  }

  const token = String(process.env[tokenEnv] || "").trim();
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(queryParams)) {
    url.searchParams.set(key, value);
  }

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

function toMonthStartIso(dateText: string) {
  return `${dateText.slice(0, 7)}-01`;
}

function toMonthEndIso(dateText: string) {
  const [yearRaw, monthRaw] = dateText.slice(0, 7).split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return dateText;
  const d = new Date(Date.UTC(year, month, 0, 0, 0, 0, 0));
  return d.toISOString().slice(0, 10);
}

async function fetchMixpanelMetrics(startDate: string, endDate: string): Promise<MixpanelMetricsResult> {
  const baseEndpoint = String(process.env.MODEL_UPDATE_MIXPANEL_ENDPOINT || "").trim();
  const tokenEnv = "MODEL_UPDATE_MIXPANEL_BEARER_TOKEN";
  const monthStart = toMonthStartIso(endDate);
  const monthEnd = toMonthEndIso(endDate);
  const baseParams = {
    start_date: startDate,
    end_date: endDate,
    last_day: endDate,
    month_start: monthStart,
    month_end: monthEnd,
  };

  const withMetric = (metric: string) => ({ ...baseParams, metric });

  const [dauLastDay, wauLastDay, mauLastDay, signupsInMonth, productionMessagesInMonth, highVolumeWorkspacesInMonth, activeBuilders10of30] =
    await Promise.all([
      fetchProviderMetric("MODEL_UPDATE_MIXPANEL_DAU_ENDPOINT", tokenEnv, withMetric("dau_last_day"), baseEndpoint),
      fetchProviderMetric("MODEL_UPDATE_MIXPANEL_WAU_ENDPOINT", tokenEnv, withMetric("wau_last_day"), baseEndpoint),
      fetchProviderMetric("MODEL_UPDATE_MIXPANEL_MAU_ENDPOINT", tokenEnv, withMetric("mau_last_day"), baseEndpoint),
      fetchProviderMetric("MODEL_UPDATE_MIXPANEL_SIGNUPS_ENDPOINT", tokenEnv, withMetric("signups_in_month"), baseEndpoint),
      fetchProviderMetric(
        "MODEL_UPDATE_MIXPANEL_PRODUCTION_MESSAGES_ENDPOINT",
        tokenEnv,
        withMetric("production_messages_in_month"),
        baseEndpoint,
      ),
      fetchProviderMetric(
        "MODEL_UPDATE_MIXPANEL_HIGH_VOLUME_WORKSPACES_ENDPOINT",
        tokenEnv,
        withMetric("high_volume_workspaces_1k_incoming"),
        baseEndpoint,
      ),
      fetchProviderMetric(
        "MODEL_UPDATE_MIXPANEL_ACTIVE_BUILDERS_ENDPOINT",
        tokenEnv,
        withMetric("active_builders_10_of_30"),
        baseEndpoint,
      ),
    ]);

  return {
    dauLastDay,
    wauLastDay,
    mauLastDay,
    signupsInMonth,
    productionMessagesInMonth,
    highVolumeWorkspacesInMonth,
    activeBuilders10of30,
  };
}

async function runReport(startDate: string, endDate: string) {
  const [mixpanelMetrics, googleAnalytics] = await Promise.all([
    fetchMixpanelMetrics(startDate, endDate),
    fetchProviderMetric(
      "MODEL_UPDATE_GA_ENDPOINT",
      "MODEL_UPDATE_GA_BEARER_TOKEN",
      {
        start_date: startDate,
        end_date: endDate,
      },
    ),
  ]);

  return {
    startDate,
    endDate,
    mixpanelMetrics,
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
