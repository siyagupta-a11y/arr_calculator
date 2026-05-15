import { NextResponse } from "next/server";
import { canonicalCountryKey, canonicalCountryLabel, countryCodeFromValue, countryNameKeyToCodeEntries } from "@/lib/geo";

export const runtime = "nodejs";
export const maxDuration = 300;

type MetricKey = "churn" | "ai_spend";
type SegmentKey = "total" | "selfserve" | "sales_assist";

type ParsedQuestion = {
  metric: MetricKey | null;
  segment: SegmentKey;
  country: string;
  monthKey: string;
  monthLabel: string;
  startDate: string;
  endDate: string;
};

type AssistantRow = Record<string, string | number>;

type AssistantResponse = {
  status: "ok" | "needs_clarification";
  answer: string;
  parsed: ParsedQuestion;
  warnings: string[];
  table: {
    columns: string[];
    rows: AssistantRow[];
  };
};

type CombinedPoint = {
  key: string;
  churnMrr: number;
  mrrEnd: number;
  arr: number;
};

type CombinedBillingOverviewResponse = {
  targetCurrency: string;
  points: CombinedPoint[];
  lineSourcePoints?: {
    selfserve?: CombinedPoint[];
    salesAssist?: CombinedPoint[];
    aiSpend?: CombinedPoint[];
  };
};

type HubspotViewModelResponse = {
  chartPoints?: Array<{
    key: string;
    churnMrr: number;
  }>;
  groupedChartSeries?: Array<{
    key: string;
    label: string;
    points: Array<{
      key: string;
      churnMrr: number;
    }>;
  }>;
};

type StripeThroughMrrGroupedDetailRow = {
  groupKey: string;
  groupLabel?: string;
  customerCountry?: string;
  monthKey: string;
  monthEndMrr: number;
};

type StripeThroughMrrReportResponse = {
  targetCurrency: string;
  detailRows: StripeThroughMrrGroupedDetailRow[];
  pagination?: {
    page: number;
    totalPages: number;
    hasMore: boolean;
  };
};

const MONTH_INDEX: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};
const MONTH_NAMES = Object.keys(MONTH_INDEX);
const METRICS_ASSISTANT_UNDER_MAINTENANCE = false;

function round2(n: number) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function toIsoDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function parseIsoMonth(value: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || monthIndex < 0 || monthIndex > 11) return null;
  return new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
}

function previousMonthKeyInfo(monthKey: string) {
  const monthDate = parseIsoMonth(monthKey);
  if (!monthDate) return null;
  const previous = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() - 1, 1, 0, 0, 0, 0));
  return {
    monthKey: toIsoDateOnly(previous).slice(0, 7),
    startDate: toIsoDateOnly(previous),
  };
}

function startEndForMonth(year: number, monthIndex: number) {
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 0));
  const monthKey = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
  const monthName = MONTH_NAMES[monthIndex] || "";
  const monthLabel = `${monthName[0]?.toUpperCase() || ""}${monthName.slice(1)} ${year}`.trim();
  return {
    monthKey,
    monthLabel,
    startDate: toIsoDateOnly(start),
    endDate: toIsoDateOnly(end),
  };
}

function parseMonth(text: string) {
  const byName = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i.exec(
    text,
  );
  if (byName) {
    const monthName = String(byName[1] || "").toLowerCase();
    const year = Number(byName[2]);
    const monthIndex = MONTH_INDEX[monthName];
    if (Number.isFinite(year) && Number.isFinite(monthIndex)) return startEndForMonth(year, monthIndex);
  }

  const byIsoMonth = /\b(\d{4})-(0[1-9]|1[0-2])\b/.exec(text);
  if (byIsoMonth) {
    const year = Number(byIsoMonth[1]);
    const monthIndex = Number(byIsoMonth[2]) - 1;
    if (Number.isFinite(year) && Number.isFinite(monthIndex)) return startEndForMonth(year, monthIndex);
  }

  return null;
}

function normalizeCountryLookupKey(value: string) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseCountry(text: string) {
  const inOrForRegex = /\b(?:in|for)\s+([a-z][a-z\s.'-]{1,40}?)(?=\s+(?:in|for|on|during|from|to)\b|[?,.!]|$)/gi;
  for (const match of text.matchAll(inOrForRegex)) {
    const candidate = String(match[1] || "").trim();
    const code = countryCodeFromValue(candidate);
    if (code) return canonicalCountryLabel(code);
  }

  const normalizedQuestion = normalizeCountryLookupKey(text);
  const entries = countryNameKeyToCodeEntries().slice().sort((a, b) => b.key.length - a.key.length);
  for (const entry of entries) {
    if (!entry.key) continue;
    if (normalizedQuestion.includes(entry.key)) return canonicalCountryLabel(entry.code);
  }

  return "";
}

function parseMetric(textLower: string): MetricKey | null {
  if (textLower.includes("ai spend") || textLower.includes("ai-spend")) return "ai_spend";
  if (textLower.includes("churn")) return "churn";
  return null;
}

function parseSegment(textLower: string): SegmentKey {
  if (/\bsales[\s-]?assist\b/.test(textLower) || /\bsales[\s-]?led\b/.test(textLower)) return "sales_assist";
  if (/\bself[\s-]?serve\b/.test(textLower)) return "selfserve";
  return "total";
}

function currencyText(value: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: String(currency || "USD").toUpperCase(),
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value || 0);
  } catch {
    return new Intl.NumberFormat(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value || 0);
  }
}

async function postJson(req: Request, path: string, payload: Record<string, unknown>) {
  const response = await fetch(new URL(path, req.url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(req.headers.get("cookie") ? { cookie: req.headers.get("cookie") as string } : {}),
      ...(req.headers.get("authorization") ? { authorization: req.headers.get("authorization") as string } : {}),
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const message =
      json && typeof json === "object" && "error" in json
        ? String((json as { error?: unknown }).error || "Request failed")
        : text || `HTTP ${response.status}`;
    throw new Error(message);
  }

  return json;
}

function clarificationResponse(parsed: ParsedQuestion, message: string): AssistantResponse {
  return {
    status: "needs_clarification",
    answer: message,
    parsed,
    warnings: [],
    table: { columns: [], rows: [] },
  };
}

function emptyParsed(): ParsedQuestion {
  return {
    metric: null,
    segment: "total",
    country: "",
    monthKey: "",
    monthLabel: "",
    startDate: "",
    endDate: "",
  };
}

function findPointByMonth(points: CombinedPoint[] | undefined, monthKey: string) {
  const rows = points || [];
  return rows.find((point) => String(point.key || "") === monthKey) || null;
}

async function computeStripeCountryChurnMrrByEmail(
  req: Request,
  params: {
    country: string;
    previousMonthKey: string;
    targetMonthKey: string;
    queryStartDate: string;
    queryEndDate: string;
  },
) {
  const targetCountryLabel = canonicalCountryLabel(params.country);
  const targetCountryKey = canonicalCountryKey(targetCountryLabel);
  const byEmail = new Map<string, { previousMrr: number; currentMrr: number }>();
  const pageSize = 100000;
  let page = 1;
  let targetCurrency = "USD";
  let hasMore = true;
  let safetyCounter = 0;

  while (hasMore && safetyCounter < 25) {
    safetyCounter += 1;
    const stripeReport = (await postJson(req, "/api/stripe-through-mrr-report", {
      startDate: params.queryStartDate,
      endDate: params.queryEndDate,
      detailStartMonth: params.previousMonthKey,
      detailEndMonth: params.targetMonthKey,
      grain: "monthly",
      groupBy: "email",
      countryFilters: [params.country],
      page,
      pageSize,
    })) as StripeThroughMrrReportResponse;

    targetCurrency = String(stripeReport.targetCurrency || targetCurrency);
    for (const row of stripeReport.detailRows || []) {
      const key = String(row.groupKey || "").trim();
      const monthKey = String(row.monthKey || "").trim();
      const rowCountryKey = canonicalCountryKey(String(row.customerCountry || "").trim());
      if (!key) continue;
      if (!rowCountryKey || rowCountryKey !== targetCountryKey) continue;
      if (monthKey !== params.previousMonthKey && monthKey !== params.targetMonthKey) continue;
      if (!byEmail.has(key)) byEmail.set(key, { previousMrr: 0, currentMrr: 0 });
      const bucket = byEmail.get(key)!;
      const monthEndMrr = round2(Number(row.monthEndMrr || 0));
      if (monthKey === params.previousMonthKey) bucket.previousMrr = monthEndMrr;
      if (monthKey === params.targetMonthKey) bucket.currentMrr = monthEndMrr;
    }

    hasMore = stripeReport.pagination?.hasMore === true;
    page += 1;
  }

  let churnMrr = 0;
  for (const value of byEmail.values()) {
    if (value.previousMrr > 1e-9 && Math.abs(value.currentMrr) <= 1e-9) {
      churnMrr = round2(churnMrr - value.previousMrr);
    }
  }

  return {
    churnMrr,
    targetCurrency: String(targetCurrency || "USD").toUpperCase(),
    emailGroupsConsidered: byEmail.size,
    truncated: hasMore,
  };
}

export async function POST(req: Request) {
  try {
    if (METRICS_ASSISTANT_UNDER_MAINTENANCE) {
      return NextResponse.json(
        {
          status: "needs_clarification",
          answer: "Metrics Assistant is under maintenance. Do not use.",
          parsed: emptyParsed(),
          warnings: ["Under maintenance. Do not use."],
          table: { columns: [], rows: [] },
        } satisfies AssistantResponse,
        { status: 503 },
      );
    }

    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as { question?: string };
    const question = String(body.question || "").trim();
    if (!question) {
      return NextResponse.json(
        clarificationResponse(emptyParsed(), "Ask a question, for example: total churn in Brazil in April 2025."),
        { status: 400 },
      );
    }

    const lower = question.toLowerCase();
    const metric = parseMetric(lower);
    const segment = parseSegment(lower);
    const month = parseMonth(lower);
    const country = parseCountry(question);

    const parsed: ParsedQuestion = {
      metric,
      segment,
      country,
      monthKey: month?.monthKey || "",
      monthLabel: month?.monthLabel || "",
      startDate: month?.startDate || "",
      endDate: month?.endDate || "",
    };

    if (!metric) {
      return NextResponse.json(
        clarificationResponse(
          parsed,
          "I can answer churn and AI spend questions right now. Example: churn in Brazil in April 2025.",
        ),
      );
    }
    if (!month) {
      return NextResponse.json(
        clarificationResponse(parsed, "Please include a month and year, for example: April 2025."),
      );
    }

    const warnings: string[] = [];
    if (metric === "churn") {
      if (country) {
        if (segment !== "total") {
          warnings.push("Country-level churn currently uses the total (not self-serve/sales-assist split).");
        }

        const report = (await postJson(req, "/api/hubspot-view-model", {
          startDate: month.startDate,
          endDate: month.endDate,
          mode: "contracted",
          grain: "monthly",
          chartGroupBy: "country",
          groupByFields: [],
          filterDealName: "",
          filterDeploymentType: "all",
          filterAccountId: "",
          filterTerritory: "all",
          filterCountry: country,
          filterIndustry: "all",
          filterDealType: "all",
          filterPlan: "all",
          arrDisplayScope: "all",
        })) as HubspotViewModelResponse;

        const countryKey = canonicalCountryKey(country);
        const countrySeries = (report.groupedChartSeries || []).find((series) => String(series.key || "") === countryKey) || null;
        const point = (countrySeries?.points || []).find((entry) => String(entry.key || "") === month.monthKey) || null;
        if (!point) {
          return NextResponse.json(
            clarificationResponse(parsed, `No churn data found for ${country} in ${month.monthLabel}.`),
          );
        }
        const hubspotChurnMrr = round2(Number(point?.churnMrr || 0));
        const previousMonth = previousMonthKeyInfo(month.monthKey);
        if (!previousMonth) {
          return NextResponse.json(
            clarificationResponse(parsed, `Could not determine previous month for ${month.monthKey}.`),
          );
        }
        const stripeCountryChurn = await computeStripeCountryChurnMrrByEmail(req, {
          country,
          previousMonthKey: previousMonth.monthKey,
          targetMonthKey: month.monthKey,
          queryStartDate: previousMonth.startDate,
          queryEndDate: month.endDate,
        });
        if (stripeCountryChurn.truncated) {
          warnings.push("Stripe country churn was truncated due to pagination safety limits.");
        }
        const churnMrr = round2(hubspotChurnMrr + stripeCountryChurn.churnMrr);
        const churnArr = round2(churnMrr * 12);
        const currency = stripeCountryChurn.targetCurrency || "USD";

        const answer = `Total churn MRR for ${country} in ${month.monthLabel} is ${currencyText(churnMrr, currency)} (HubSpot ${currencyText(hubspotChurnMrr, currency)} + Stripe ${currencyText(stripeCountryChurn.churnMrr, currency)}). ARR impact ${currencyText(churnArr, currency)}.`;
        const columns = [
          "metric",
          "segment",
          "country",
          "month",
          "hubspot_churn_mrr",
          "stripe_churn_mrr",
          "total_churn_mrr",
          "total_churn_arr",
          "stripe_email_groups_considered",
        ];
        const rows: AssistantRow[] = [
          {
            metric: "churn",
            segment: "total",
            country,
            month: month.monthKey,
            hubspot_churn_mrr: hubspotChurnMrr,
            stripe_churn_mrr: stripeCountryChurn.churnMrr,
            total_churn_mrr: churnMrr,
            total_churn_arr: churnArr,
            stripe_email_groups_considered: stripeCountryChurn.emailGroupsConsidered,
          },
        ];

        return NextResponse.json({
          status: "ok",
          answer,
          parsed,
          warnings,
          table: { columns, rows },
        } satisfies AssistantResponse);
      }

      const report = (await postJson(req, "/api/combined-billing-overview-report", {
        startDate: month.startDate,
        endDate: month.endDate,
        grain: "monthly",
        includeCac: false,
      })) as CombinedBillingOverviewResponse;

      const targetCurrency = String(report.targetCurrency || "USD");
      const segmentPoint =
        segment === "sales_assist"
          ? findPointByMonth(report.lineSourcePoints?.salesAssist, month.monthKey)
          : segment === "selfserve"
            ? findPointByMonth(report.lineSourcePoints?.selfserve, month.monthKey)
            : findPointByMonth(report.points, month.monthKey);
      if (!segmentPoint) {
        return NextResponse.json(
          clarificationResponse(parsed, `No churn data found for ${month.monthLabel}.`),
        );
      }
      const churnMrr = round2(Number(segmentPoint?.churnMrr || 0));
      const churnArr = round2(churnMrr * 12);

      const answer = `Churn MRR for ${segment.replace("_", " ")} in ${month.monthLabel} is ${currencyText(
        churnMrr,
        targetCurrency,
      )} (ARR impact ${currencyText(churnArr, targetCurrency)}).`;
      const columns = ["metric", "segment", "month", "churn_mrr", "churn_arr"];
      const rows: AssistantRow[] = [
        {
          metric: "churn",
          segment,
          month: month.monthKey,
          churn_mrr: churnMrr,
          churn_arr: churnArr,
        },
      ];

      return NextResponse.json({
        status: "ok",
        answer,
        parsed,
        warnings,
        table: { columns, rows },
      } satisfies AssistantResponse);
    }

    if (country) {
      warnings.push("AI spend does not currently support country-level filters in this assistant.");
    }

    const report = (await postJson(req, "/api/combined-billing-overview-report", {
      startDate: month.startDate,
      endDate: month.endDate,
      grain: "monthly",
      includeCac: false,
    })) as CombinedBillingOverviewResponse;
    const targetCurrency = String(report.targetCurrency || "USD");
    const aiPoint = findPointByMonth(report.lineSourcePoints?.aiSpend, month.monthKey);
    if (!aiPoint) {
      return NextResponse.json(
        clarificationResponse(parsed, `No AI spend data found for ${month.monthLabel}.`),
      );
    }
    const aiArr = round2(Number(aiPoint?.arr || 0));
    const aiMrr = round2(Number(aiPoint?.mrrEnd || 0));

    const answer = `AI spend ARR in ${month.monthLabel} is ${currencyText(aiArr, targetCurrency)}.`;
    const columns = ["metric", "month", "ai_spend_arr", "ai_spend_mrr"];
    const rows: AssistantRow[] = [
      {
        metric: "ai_spend",
        month: month.monthKey,
        ai_spend_arr: aiArr,
        ai_spend_mrr: aiMrr,
      },
    ];

    return NextResponse.json({
      status: "ok",
      answer,
      parsed,
      warnings,
      table: { columns, rows },
    } satisfies AssistantResponse);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
