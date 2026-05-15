import { NextResponse } from "next/server";
import { getOrSetCache, readTtlMs } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 120;
const CACHE_TTL_MS = readTtlMs("API_MODEL_UPDATE_ANALYTICS_CACHE_TTL_MS", 15 * 60 * 1000);

type ApiBody = {
  startDate?: string;
  endDate?: string;
  includeComparisonMetricsOnly?: boolean;
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
  newUsersInMonth: ProviderResult;
  productionMessagesInMonth: ProviderResult;
  highVolumeWorkspacesInMonth: ProviderResult;
  activeBuilders10of30: ProviderResult;
};

type MixpanelSavedReportContext = {
  projectId?: string;
  workspaceId?: string;
  bookmarkId?: string;
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

function findLastNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const n = findLastNumber(value[index]);
      if (n != null) return n;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const preferredKeys = [
      "value",
      "total",
      "count",
      "metric",
      "number",
      "users",
      "sessions",
      "series",
      "series_data",
      "seriesData",
      "data",
      "results",
      "result",
      "values",
      "points",
      "rows",
    ];
    for (const key of preferredKeys) {
      if (!(key in record)) continue;
      const n = findLastNumber(record[key]);
      if (n != null) return n;
    }
    const keys = Object.keys(record);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const n = findLastNumber(record[keys[index]]);
      if (n != null) return n;
    }
  }
  return null;
}

function readFirstNonEmptyEnv(names: string[]) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function buildMixpanelBasicAuthHeader() {
  const serviceAccountUsername = readFirstNonEmptyEnv([
    "MIXPANEL_SERVICE_ACCOUNT_USERNAME",
    "MODEL_UPDATE_MIXPANEL_SERVICE_ACCOUNT_USERNAME",
  ]);
  const serviceAccountPassword = readFirstNonEmptyEnv([
    "MIXPANEL_SERVICE_ACCOUNT_PASSWORD",
    "MODEL_UPDATE_MIXPANEL_SERVICE_ACCOUNT_PASSWORD",
    "MIXPANEL_SECRET",
    "MODEL_UPDATE_MIXPANEL_SECRET",
  ]);
  if (serviceAccountUsername) {
    if (!serviceAccountPassword) return "";
    return `Basic ${Buffer.from(`${serviceAccountUsername}:${serviceAccountPassword}`).toString("base64")}`;
  }

  const projectSecret = readFirstNonEmptyEnv(["MIXPANEL_SECRET", "MODEL_UPDATE_MIXPANEL_SECRET"]);
  if (!projectSecret) return "";
  return `Basic ${Buffer.from(`${projectSecret}:`).toString("base64")}`;
}

function parsePositiveIntegerText(value: string) {
  const raw = String(value || "").trim();
  if (!/^\d+$/.test(raw)) return "";
  return String(Number(raw));
}

function extractMixpanelReportContextFromUrl(rawUrl: string): MixpanelSavedReportContext | null {
  const raw = String(rawUrl || "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const context: MixpanelSavedReportContext = {};
  const pathMatch = /^\/project\/(\d+)\/view\/(\d+)\b/.exec(url.pathname || "");
  if (pathMatch) {
    context.projectId = String(pathMatch[1] || "");
    context.workspaceId = String(pathMatch[2] || "");
  }

  const hash = String(url.hash || "").replace(/^#/, "");
  if (hash) {
    const hashParams = new URLSearchParams(hash);
    const editorCardIdRaw = decodeURIComponent(String(hashParams.get("editor-card-id") || ""));
    const reportMatch = /report-(\d+)/i.exec(editorCardIdRaw);
    if (reportMatch) context.bookmarkId = String(reportMatch[1] || "");
  }

  if (!context.projectId && !context.bookmarkId) return null;
  return context;
}

async function fetchProviderMetric(
  endpointEnv: string,
  tokenEnvs: string[],
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

  const token = tokenEnvs
    .map((name) => String(process.env[name] || "").trim())
    .find((value) => !!value) || "";
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
    const value = findLastNumber(json);
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

async function fetchMixpanelSavedReportMetric(args: {
  tokenEnvs: string[];
  bookmarkIdEnv: string;
  fallbackUrl?: string;
}): Promise<ProviderResult> {
  const token = readFirstNonEmptyEnv(args.tokenEnvs);
  const authHeader = buildMixpanelBasicAuthHeader();
  if (!token || !authHeader) {
    return {
      status: "not_configured",
      value: null,
      details: `Set one of: ${args.tokenEnvs.join(", ")} and either MIXPANEL_SECRET or MIXPANEL_SERVICE_ACCOUNT_USERNAME with MIXPANEL_SECRET as the password`,
    };
  }

  const urlContext = extractMixpanelReportContextFromUrl(args.fallbackUrl || "");
  const bookmarkId = parsePositiveIntegerText(String(process.env[args.bookmarkIdEnv] || "")) || urlContext?.bookmarkId || "";
  const projectId =
    parsePositiveIntegerText(String(process.env.MIXPANEL_PROJECT_ID || "")) ||
    parsePositiveIntegerText(String(process.env.MODEL_UPDATE_MIXPANEL_PROJECT_ID || "")) ||
    urlContext?.projectId ||
    "";
  const workspaceId =
    parsePositiveIntegerText(String(process.env.MIXPANEL_WORKSPACE_ID || "")) ||
    parsePositiveIntegerText(String(process.env.MODEL_UPDATE_MIXPANEL_WORKSPACE_ID || "")) ||
    urlContext?.workspaceId ||
    "";

  if (!bookmarkId) {
    return {
      status: "not_configured",
      value: null,
      details: `${args.bookmarkIdEnv} is not set and no report id could be parsed from URL`,
    };
  }
  if (!projectId) {
    return {
      status: "not_configured",
      value: null,
      details: "Set MIXPANEL_PROJECT_ID (or MODEL_UPDATE_MIXPANEL_PROJECT_ID), or provide a board URL with /project/<id>/...",
    };
  }

  const url = new URL("https://mixpanel.com/api/query/insights");
  url.searchParams.set("project_id", projectId);
  url.searchParams.set("bookmark_id", bookmarkId);
  if (workspaceId) url.searchParams.set("workspace_id", workspaceId);

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: authHeader,
      },
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
        details: `Insights API HTTP ${res.status}: ${text.slice(0, 300)}`,
      };
    }
    const value = findLastNumber(json);
    if (value == null) {
      return {
        status: "error",
        value: null,
        details: "No numeric metric found in Mixpanel Insights response",
      };
    }
    return { status: "ok", value };
  } catch (error: unknown) {
    return {
      status: "error",
      value: null,
      details: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function fetchMixpanelMetricWithFallback(args: {
  endpointEnv: string;
  bookmarkIdEnv: string;
  tokenEnvs: string[];
  queryParams: Record<string, string>;
  baseEndpoint: string;
}): Promise<ProviderResult> {
  const endpointCandidate = String(process.env[args.endpointEnv] || "").trim();
  const fallbackUrl = endpointCandidate || args.baseEndpoint;
  const endpointUrlRaw = endpointCandidate || args.baseEndpoint;
  let shouldCallCustomEndpoint = true;
  try {
    if (endpointUrlRaw) {
      const parsed = new URL(endpointUrlRaw);
      if (parsed.hostname.toLowerCase().endsWith("mixpanel.com")) {
        // Mixpanel URLs should be queried through the saved-report API fallback, not as generic metric endpoints.
        shouldCallCustomEndpoint = false;
      }
    }
  } catch {
    // Keep default behavior if URL is malformed; fetchProviderMetric will report a useful error.
  }

  const viaEndpoint = shouldCallCustomEndpoint
    ? await fetchProviderMetric(
        args.endpointEnv,
        args.tokenEnvs,
        args.queryParams,
        args.baseEndpoint,
      )
    : {
        status: "not_configured" as const,
        value: null,
        details: "Using Mixpanel direct query fallback",
      };
  if (viaEndpoint.status === "ok") return viaEndpoint;

  const viaSavedReport = await fetchMixpanelSavedReportMetric({
    tokenEnvs: args.tokenEnvs,
    bookmarkIdEnv: args.bookmarkIdEnv,
    fallbackUrl,
  });

  if (viaSavedReport.status === "ok") return viaSavedReport;
  if (viaEndpoint.status === "error") return viaEndpoint;
  return viaSavedReport;
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

async function fetchMixpanelMetrics(startDate: string, endDate: string, includeComparisonMetricsOnly = false): Promise<MixpanelMetricsResult> {
  const baseEndpoint = String(process.env.MODEL_UPDATE_MIXPANEL_ENDPOINT || "").trim();
  const tokenEnvs = ["MODEL_UPDATE_MIXPANEL_BEARER_TOKEN", "MIXPANEL_SECRET"];
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

  const [dauLastDay, wauLastDay, mauLastDay, signupsInMonth, newUsersInMonth, productionMessagesInMonth, highVolumeWorkspacesInMonth, activeBuilders10of30] =
    await Promise.all([
      fetchMixpanelMetricWithFallback({
        endpointEnv: "MODEL_UPDATE_MIXPANEL_DAU_ENDPOINT",
        bookmarkIdEnv: "MODEL_UPDATE_MIXPANEL_DAU_BOOKMARK_ID",
        tokenEnvs,
        queryParams: withMetric("dau_last_day"),
        baseEndpoint,
      }),
      fetchMixpanelMetricWithFallback({
        endpointEnv: "MODEL_UPDATE_MIXPANEL_WAU_ENDPOINT",
        bookmarkIdEnv: "MODEL_UPDATE_MIXPANEL_WAU_BOOKMARK_ID",
        tokenEnvs,
        queryParams: withMetric("wau_last_day"),
        baseEndpoint,
      }),
      fetchMixpanelMetricWithFallback({
        endpointEnv: "MODEL_UPDATE_MIXPANEL_MAU_ENDPOINT",
        bookmarkIdEnv: "MODEL_UPDATE_MIXPANEL_MAU_BOOKMARK_ID",
        tokenEnvs,
        queryParams: withMetric("mau_last_day"),
        baseEndpoint,
      }),
      includeComparisonMetricsOnly
        ? ({ status: "not_configured", value: null, details: "Skipped for comparison-only snapshot" } as ProviderResult)
        : fetchMixpanelMetricWithFallback({
            endpointEnv: "MODEL_UPDATE_MIXPANEL_SIGNUPS_ENDPOINT",
            bookmarkIdEnv: "MODEL_UPDATE_MIXPANEL_SIGNUPS_BOOKMARK_ID",
            tokenEnvs,
            queryParams: withMetric("signups_in_month"),
            baseEndpoint,
          }),
      includeComparisonMetricsOnly
        ? ({ status: "not_configured", value: null, details: "Skipped for comparison-only snapshot" } as ProviderResult)
        : fetchMixpanelMetricWithFallback({
            endpointEnv: "MODEL_UPDATE_MIXPANEL_NEW_USERS_ENDPOINT",
            bookmarkIdEnv: "MODEL_UPDATE_MIXPANEL_NEW_USERS_BOOKMARK_ID",
            tokenEnvs,
            queryParams: withMetric("new_users_in_month"),
            baseEndpoint,
          }),
      fetchMixpanelMetricWithFallback({
        endpointEnv: "MODEL_UPDATE_MIXPANEL_PRODUCTION_MESSAGES_ENDPOINT",
        bookmarkIdEnv: "MODEL_UPDATE_MIXPANEL_PRODUCTION_MESSAGES_BOOKMARK_ID",
        tokenEnvs,
        queryParams: withMetric("production_messages_in_month"),
        baseEndpoint,
      }),
      includeComparisonMetricsOnly
        ? ({ status: "not_configured", value: null, details: "Skipped for comparison-only snapshot" } as ProviderResult)
        : fetchMixpanelMetricWithFallback({
            endpointEnv: "MODEL_UPDATE_MIXPANEL_HIGH_VOLUME_WORKSPACES_ENDPOINT",
            bookmarkIdEnv: "MODEL_UPDATE_MIXPANEL_HIGH_VOLUME_WORKSPACES_BOOKMARK_ID",
            tokenEnvs,
            queryParams: withMetric("high_volume_workspaces_1k_incoming"),
            baseEndpoint,
          }),
      fetchMixpanelMetricWithFallback({
        endpointEnv: "MODEL_UPDATE_MIXPANEL_ACTIVE_BUILDERS_ENDPOINT",
        bookmarkIdEnv: "MODEL_UPDATE_MIXPANEL_ACTIVE_BUILDERS_BOOKMARK_ID",
        tokenEnvs,
        queryParams: withMetric("active_builders_10_of_30"),
        baseEndpoint,
      }),
    ]);

  return {
    dauLastDay,
    wauLastDay,
    mauLastDay,
    signupsInMonth,
    newUsersInMonth,
    productionMessagesInMonth,
    highVolumeWorkspacesInMonth,
    activeBuilders10of30,
  };
}

async function runReport(startDate: string, endDate: string, includeComparisonMetricsOnly = false) {
  const cacheKey = `api:model-update-analytics:${startDate}:${endDate}:${includeComparisonMetricsOnly ? "comparison-only" : "full"}`;
  return getOrSetCache(cacheKey, CACHE_TTL_MS, async () => {
    const [mixpanelMetrics, googleAnalytics] = await Promise.all([
      fetchMixpanelMetrics(startDate, endDate, includeComparisonMetricsOnly),
      fetchProviderMetric(
        "MODEL_UPDATE_GA_ENDPOINT",
        ["MODEL_UPDATE_GA_BEARER_TOKEN"],
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
  });
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Partial<ApiBody>;
    const { startDate, endDate } = parsePayload(body);
    const report = await runReport(startDate, endDate, Boolean(body.includeComparisonMetricsOnly));
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
