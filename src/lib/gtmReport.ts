import { queryGtmArrRows, queryGtmCrmMetrics, type GtmBigQueryArrRow } from "@/lib/gtmBigquery";
import { FX_TARGET_CURRENCY, round2 } from "@/lib/logic";
import {
  countBusinessDays,
  getGtmTarget,
  getGtmTargetRows,
  paceMonthlyTarget,
  type GtmTargetFormat,
} from "@/lib/gtmTargets";

export type GtmMetricStatus = "green" | "yellow" | "red" | "neutral" | "unavailable";
export type GtmMetricDirection = "higher" | "lower" | "neutral";

export type GtmMetric = {
  id: string;
  section: string;
  label: string;
  owner: string;
  format: GtmTargetFormat | "multiple";
  value: number | null;
  priorValue: number | null;
  target: number | null;
  pacedTarget: number | null;
  achievement: number | null;
  status: GtmMetricStatus;
  direction: GtmMetricDirection;
  source: string;
  note?: string;
};

export type GtmArrBridgeRow = {
  segment: "selfserve" | "sales_assist" | "salesled" | "total";
  label: string;
  beginningArr: number;
  newArr: number;
  expansionArr: number;
  contractionArr: number;
  churnArr: number;
  endingArr: number;
  netNewArr: number;
};

export type GtmWorkbookComparison = {
  id: string;
  label: string;
  workbookValue: number;
  automatedValue: number;
  variance: number;
  matches: boolean;
};

export type GtmReportResponse = {
  monthKey: string;
  monthLabel: string;
  monthStartDate: string;
  monthEndDate: string;
  asOfDate: string;
  targetCurrency: string;
  businessDays: { elapsed: number; total: number };
  metrics: GtmMetric[];
  arrBridge: GtmArrBridgeRow[];
  targetRows: ReturnType<typeof getGtmTargetRows>;
  workbookComparison: GtmWorkbookComparison[];
  warnings: string[];
};

const WORKBOOK_AUGUST_REFERENCE = [
  { id: "beginning_arr", label: "Beginning ARR", value: 5779561 },
  { id: "net_new_arr", label: "Net New ARR", value: 65355 },
  { id: "selfserve_new", label: "PLG / self-serve ARR — new", value: 128928 },
  { id: "sales_new", label: "Sales-led ARR — new", value: 111819 },
  { id: "selfserve_expansion", label: "Self-serve expansion", value: 53322 },
  { id: "selfserve_churn", label: "Self-serve churn + contraction", value: -179916 },
  { id: "sales_expansion", label: "Sales expansion", value: 72900 },
  { id: "sales_churn", label: "Sales churn + contraction", value: -121698 },
  { id: "ending_arr", label: "Ending ARR", value: 5844916 },
] as const;

function parseMonth(monthKey: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(monthKey || "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  if (!Number.isInteger(year) || month < 0 || month > 11) return null;
  return new Date(Date.UTC(year, month, 1));
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function monthLabel(monthKey: string) {
  const month = parseMonth(monthKey);
  if (!month) return monthKey;
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(month);
}

function sum(values: Array<number | null | undefined>) {
  return round2(values.reduce<number>((total, value) => total + Number(value || 0), 0));
}

function emptyBridge(segment: GtmArrBridgeRow["segment"], label: string): GtmArrBridgeRow {
  return { segment, label, beginningArr: 0, newArr: 0, expansionArr: 0, contractionArr: 0, churnArr: 0, endingArr: 0, netNewArr: 0 };
}

function bridgeFromBigQuery(row: GtmBigQueryArrRow | null, segment: GtmBigQueryArrRow["segment"], label: string): GtmArrBridgeRow {
  if (!row) return emptyBridge(segment, label);
  return {
    segment,
    label,
    beginningArr: round2(row.beginningArr),
    newArr: round2(row.newArr),
    expansionArr: round2(row.expansionArr),
    contractionArr: round2(row.contractionArr),
    churnArr: round2(row.churnArr),
    endingArr: round2(row.endingArr),
    netNewArr: round2(row.endingArr - row.beginningArr),
  };
}

function totalBridge(rows: GtmArrBridgeRow[]): GtmArrBridgeRow {
  const total = emptyBridge("total", "Total");
  for (const row of rows) {
    total.beginningArr = sum([total.beginningArr, row.beginningArr]);
    total.newArr = sum([total.newArr, row.newArr]);
    total.expansionArr = sum([total.expansionArr, row.expansionArr]);
    total.contractionArr = sum([total.contractionArr, row.contractionArr]);
    total.churnArr = sum([total.churnArr, row.churnArr]);
    total.endingArr = sum([total.endingArr, row.endingArr]);
  }
  total.netNewArr = round2(total.endingArr - total.beginningArr);
  return total;
}

function targetStatus(
  value: number | null,
  pacedTarget: number | null,
  direction: GtmMetricDirection,
): GtmMetricStatus {
  if (value == null) return "unavailable";
  if (pacedTarget == null || Math.abs(pacedTarget) < 1e-9 || direction === "neutral") return "neutral";
  if (direction === "lower") {
    const ratio = Math.abs(value) / Math.abs(pacedTarget);
    if (ratio <= 1.05) return "green";
    if (ratio <= 1.2) return "yellow";
    return "red";
  }
  const ratio = value / pacedTarget;
  if (ratio >= 0.95) return "green";
  if (ratio >= 0.8) return "yellow";
  return "red";
}

function buildMetric(args: {
  id: string;
  section: string;
  label: string;
  owner: string;
  format: GtmMetric["format"];
  value: number | null;
  priorValue?: number | null;
  target?: number | null;
  elapsedBusinessDays: number;
  totalBusinessDays: number;
  direction?: GtmMetricDirection;
  source: string;
  note?: string;
}): GtmMetric {
  const direction = args.direction || "higher";
  const target = args.target ?? null;
  const pacedTarget = args.format === "percent" || args.format === "multiple"
    ? target
    : paceMonthlyTarget(target, args.elapsedBusinessDays, args.totalBusinessDays);
  const achievement =
    args.value != null && target != null && Math.abs(target) > 1e-9 ? round2(args.value / target) : null;
  return {
    id: args.id,
    section: args.section,
    label: args.label,
    owner: args.owner,
    format: args.format,
    value: args.value == null ? null : round2(args.value),
    priorValue: args.priorValue == null ? null : round2(args.priorValue),
    target,
    pacedTarget,
    achievement,
    status: targetStatus(args.value, pacedTarget, direction),
    direction,
    source: args.source,
    note: args.note,
  };
}

export async function generateGtmReport(input: { monthKey: string; asOfDate?: string }): Promise<GtmReportResponse> {
  const month = parseMonth(input.monthKey);
  if (!month) throw new Error("Invalid month. Expected YYYY-MM.");
  const monthStartDate = isoDate(month);
  const monthEndDate = isoDate(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)));
  const today = isoDate(new Date());
  const requestedAsOf = /^\d{4}-\d{2}-\d{2}$/.test(String(input.asOfDate || "")) ? String(input.asOfDate) : today;
  const asOfDate = requestedAsOf < monthStartDate
    ? monthStartDate
    : requestedAsOf > monthEndDate
      ? monthEndDate
      : requestedAsOf;
  const previousMonthStartDate = isoDate(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1)));
  const elapsedBusinessDays = countBusinessDays(monthStartDate, asOfDate);
  const totalBusinessDays = countBusinessDays(monthStartDate, monthEndDate);
  const warnings: string[] = [];
  const latestExpectedArrDate = today >= monthStartDate && today <= monthEndDate ? today : monthEndDate;
  if (asOfDate < latestExpectedArrDate) {
    warnings.push("The ARR bridge uses the latest monthly BigQuery snapshot; the earlier Actuals-through date applies to CRM funnel metrics only.");
  }

  const [arrPeriodRows, crm] = await Promise.all([
    queryGtmArrRows({ startDate: previousMonthStartDate, endDate: asOfDate }),
    queryGtmCrmMetrics({ monthStartDate, monthEndDate, asOfDate }),
  ]);
  warnings.push(...crm.warnings);
  if (!arrPeriodRows.some((row) => row.monthKey === input.monthKey)) {
    warnings.push(`No combined CARR rows were available in BigQuery for ${input.monthKey}.`);
  }

  const currentBySegment = new Map(
    arrPeriodRows.filter((row) => row.monthKey === input.monthKey).map((row) => [row.segment, row]),
  );
  const previousMonthKey = previousMonthStartDate.slice(0, 7);
  const priorBySegment = new Map(
    arrPeriodRows.filter((row) => row.monthKey === previousMonthKey).map((row) => [row.segment, row]),
  );

  const arrRows = [
    bridgeFromBigQuery(currentBySegment.get("selfserve") || null, "selfserve", "Self-serve"),
    bridgeFromBigQuery(currentBySegment.get("sales_assist") || null, "sales_assist", "Sales Assist"),
    bridgeFromBigQuery(currentBySegment.get("salesled") || null, "salesled", "Sales-led"),
  ];
  const priorRows = [
    bridgeFromBigQuery(priorBySegment.get("selfserve") || null, "selfserve", "Self-serve"),
    bridgeFromBigQuery(priorBySegment.get("sales_assist") || null, "sales_assist", "Sales Assist"),
    bridgeFromBigQuery(priorBySegment.get("salesled") || null, "salesled", "Sales-led"),
  ];
  const currentTotal = totalBridge(arrRows);
  const priorTotal = totalBridge(priorRows);
  const arrBridge = [...arrRows, currentTotal];
  const selfserve = arrRows[0];
  const salesAssist = arrRows[1];
  const salesLed = arrRows[2];
  const priorSelfserve = priorRows[0];
  const priorSalesTotal = totalBridge([priorRows[1], priorRows[2]]);
  const salesTotal = totalBridge([salesAssist, salesLed]);
  const target = (id: string) => getGtmTarget(input.monthKey, id);
  const metricBase = { elapsedBusinessDays, totalBusinessDays };

  const metrics: GtmMetric[] = [
    buildMetric({ ...metricBase, id: "net_new_arr", section: "Headline", label: "Net New ARR", owner: "Frank Jessop", format: "currency", value: currentTotal.netNewArr, priorValue: priorTotal.netNewArr, target: target("net_new_arr"), source: "Combined CARR model · BigQuery", note: "Ending ARR minus beginning ARR for the selected month." }),
    buildMetric({ ...metricBase, id: "selfserve_new", section: "ARR by motion", label: "PLG / self-serve ARR — new", owner: "Frank Jessop", format: "currency", value: selfserve.newArr, priorValue: priorSelfserve.newArr, target: target("new_arr_selfserve"), source: "Combined CARR model · BigQuery", note: "Includes reactivation, matching the workbook bridge." }),
    buildMetric({ ...metricBase, id: "sales_new", section: "ARR by motion", label: "Sales ARR — new (Sales Assist + Sales-led)", owner: "Frank Jessop", format: "currency", value: salesTotal.newArr, priorValue: priorSalesTotal.newArr, target: sum([target("new_arr_sales_assist"), target("new_arr_sales_led"), target("new_arr_outbound")]), source: "Combined CARR model · BigQuery", note: "Includes reactivation. Outbound has its own Targets-tab target but is included in sales-led actual because the BigQuery model does not expose it as a separate motion." }),
    buildMetric({ ...metricBase, id: "pipeline_created", section: "Pipeline", label: "Pipeline $ created — new business", owner: "Eva / Sarah", format: "currency", value: crm.pipelineCreated, target: target("pipeline_total"), source: "HubSpot replica · BigQuery", note: crm.pipelineCreatedAllTypes == null ? undefined : `All deal types created in the Sales Default and Transactional pipelines: ${round2(crm.pipelineCreatedAllTypes)}.` }),
    buildMetric({ ...metricBase, id: "open_pipeline", section: "Pipeline", label: "Open pipeline closing this month", owner: "Eva / Sarah", format: "currency", value: crm.openPipeline, target: target("pipeline_total"), source: "HubSpot replica · BigQuery", note: crm.openPipelineDealCount == null ? undefined : `${crm.openPipelineDealCount} open new-business deals. Historical months reflect the current replicated deal state, not a point-in-time snapshot.` }),
    buildMetric({ ...metricBase, id: "pipeline_coverage", section: "Pipeline", label: "Pipeline coverage", owner: "Eva / Sarah", format: "multiple", value: crm.openPipeline != null && target("new_arr_total") ? round2(crm.openPipeline / Number(target("new_arr_total"))) : null, target: target("pipeline_total") != null && target("new_arr_total") ? round2(Number(target("pipeline_total")) / Number(target("new_arr_total"))) : null, source: "HubSpot replica · BigQuery + Targets tab", note: "Open new-business pipeline divided by the Targets-tab new-business ARR target. The target multiple is derived from Pipeline Required, not the weekly tab's hard-coded 3×." }),
    buildMetric({ ...metricBase, id: "overall_signups", section: "Pipeline", label: "Overall sign-ups", owner: "Eva", format: "count", value: crm.overallSignups, source: "Marketing funnel · BigQuery" }),
    buildMetric({ ...metricBase, id: "cs_signups", section: "Pipeline", label: "CS sign-ups", owner: "Eva", format: "count", value: crm.csSignups, source: "Marketing CS vertical · BigQuery" }),
    buildMetric({ ...metricBase, id: "business_signups", section: "Pipeline", label: "Business sign-ups (non-CS)", owner: "Eva", format: "count", value: crm.businessSignups, source: "Marketing funnel · BigQuery", note: "Overall sign-ups less sign-ups classified in the CS vertical." }),
    buildMetric({ ...metricBase, id: "mqls", section: "Pipeline", label: "MQLs", owner: "Eva", format: "count", value: crm.mqls, source: "HubSpot contacts replica · BigQuery", note: "Contacts entering Marketing Qualified Lead during the selected month." }),
    buildMetric({ ...metricBase, id: "sqls", section: "Sales funnel", label: "SQLs", owner: "Sarah", format: "count", value: crm.sqls, source: "HubSpot contacts replica · BigQuery", note: "Contacts entering Sales Qualified Lead during the selected month." }),
    buildMetric({ ...metricBase, id: "mql_to_sql", section: "Sales funnel", label: "MQL → SQL conversion (directional)", owner: "Eva / Sarah", format: "percent", value: crm.mqls && crm.sqls != null ? round2(crm.sqls / crm.mqls) : null, source: "HubSpot contacts replica · BigQuery", note: "Directional ratio of SQL entries to MQL entries in the month; it is not a matured-contact cohort conversion." }),
    buildMetric({ ...metricBase, id: "opps_created", section: "Sales funnel", label: "New-business opps created", owner: "Sarah", format: "count", value: crm.oppsCreated, source: "HubSpot deals replica · BigQuery" }),
    buildMetric({ ...metricBase, id: "opps_from_mql", section: "Sales funnel", label: "Opps from MQLs (pipeline proxy)", owner: "Sarah", format: "count", value: crm.oppsFromMqlProxy, source: "HubSpot deals replica · BigQuery", note: "Sales Default pipeline proxy, matching the workbook appendix caveat." }),
    buildMetric({ ...metricBase, id: "opps_from_pql", section: "Sales funnel", label: "Opps from PQLs (pipeline proxy)", owner: "Sarah", format: "count", value: crm.oppsFromPqlProxy, source: "HubSpot deals replica · BigQuery", note: "Transactional pipeline proxy, matching the workbook appendix caveat." }),
    buildMetric({ ...metricBase, id: "sql_to_opp", section: "Sales funnel", label: "SQL → Opp conversion (directional)", owner: "Sarah", format: "percent", value: crm.sqls && crm.oppsCreated != null ? round2(crm.oppsCreated / crm.sqls) : null, source: "HubSpot replica · BigQuery", note: "Directional period ratio, not a matured cohort conversion." }),
    buildMetric({ ...metricBase, id: "sales_acv", section: "Sales funnel", label: "ACV (sales-led, trailing 90 days)", owner: "Sarah", format: "currency", value: crm.salesLedAcv, source: "HubSpot deals replica · BigQuery" }),
    buildMetric({ ...metricBase, id: "win_rate", section: "Sales funnel", label: "Win / close rate (last 30 days)", owner: "Sarah", format: "percent", value: crm.winRate, source: "HubSpot deals replica · BigQuery", note: "Closed won divided by closed won plus closed lost in Sales Default and Transactional pipelines." }),
    buildMetric({ ...metricBase, id: "held_show_rate", section: "Sales funnel", label: "Held / show rate", owner: "Sarah", format: "percent", value: crm.heldShowRate, source: "HubSpot meetings · not in BigQuery", note: "Unavailable until meeting engagements are added to the HubSpot BigQuery replication." }),
    buildMetric({ ...metricBase, id: "signup_to_pql", section: "PLG funnel", label: "Sign-up → PQL", owner: "Mathieu", format: "percent", value: null, source: "Product analytics", note: "Source not connected to this website." }),
    buildMetric({ ...metricBase, id: "pql_to_opp", section: "PLG funnel", label: "PQL → Opp", owner: "Mathieu", format: "percent", value: null, source: "Product analytics", note: "Source not connected to this website." }),
    buildMetric({ ...metricBase, id: "signup_to_paid", section: "PLG funnel", label: "Sign-up → paid (CS specific)", owner: "Mathieu", format: "percent", value: null, source: "Product analytics", note: "Source not connected to this website." }),
    buildMetric({ ...metricBase, id: "selfserve_acv", section: "PLG funnel", label: "ACV (self-serve / PLG)", owner: "Mathieu", format: "currency", value: null, source: "Product analytics", note: "Source not connected to this website." }),
    buildMetric({ ...metricBase, id: "four_active_days", section: "PLG funnel", label: "Signup → 4 active days in first 14 days", owner: "Mathieu", format: "percent", value: null, source: "Product analytics", note: "Source not connected to this website." }),
    buildMetric({ ...metricBase, id: "one_meaningful_action", section: "PLG funnel", label: "Signup → 1 meaningful action in first 14 days", owner: "Mathieu", format: "percent", value: null, source: "Product analytics", note: "Source not connected to this website." }),
    buildMetric({ ...metricBase, id: "five_meaningful_actions", section: "PLG funnel", label: "Signup → 5 meaningful actions in first 14 days", owner: "Mathieu", format: "percent", value: null, source: "Product analytics", note: "Source not connected to this website." }),
    buildMetric({ ...metricBase, id: "selfserve_expansion", section: "Post-sales", label: "Self-serve expansion", owner: "Frank Jessop", format: "currency", value: selfserve.expansionArr, priorValue: priorSelfserve.expansionArr, target: target("expansion_selfserve"), source: "Combined CARR model · BigQuery" }),
    buildMetric({ ...metricBase, id: "selfserve_churn", section: "Post-sales", label: "Self-serve churn + contraction", owner: "Frank Jessop", format: "currency", value: sum([selfserve.churnArr, selfserve.contractionArr]), priorValue: sum([priorSelfserve.churnArr, priorSelfserve.contractionArr]), target: sum([target("selfserve_churn"), target("selfserve_contraction")]), direction: "lower", source: "Combined CARR model · BigQuery" }),
    buildMetric({ ...metricBase, id: "sales_expansion", section: "Post-sales", label: "Sales expansion", owner: "Frank Jessop", format: "currency", value: salesTotal.expansionArr, priorValue: priorSalesTotal.expansionArr, target: target("expansion_assigned_total"), source: "Combined CARR model · BigQuery" }),
    buildMetric({ ...metricBase, id: "sales_churn", section: "Post-sales", label: "Sales churn + contraction", owner: "Frank Jessop", format: "currency", value: sum([salesTotal.churnArr, salesTotal.contractionArr]), priorValue: sum([priorSalesTotal.churnArr, priorSalesTotal.contractionArr]), target: sum([target("sales_assist_churn"), target("sales_assist_contraction"), target("sales_led_churn"), target("sales_led_contraction")]), direction: "lower", source: "Combined CARR model · BigQuery" }),
  ];

  const actualByWorkbookId = new Map<string, number>([
    ["beginning_arr", currentTotal.beginningArr],
    ["net_new_arr", currentTotal.netNewArr],
    ["selfserve_new", selfserve.newArr],
    ["sales_new", salesTotal.newArr],
    ["selfserve_expansion", selfserve.expansionArr],
    ["selfserve_churn", sum([selfserve.churnArr, selfserve.contractionArr])],
    ["sales_expansion", salesTotal.expansionArr],
    ["sales_churn", sum([salesTotal.churnArr, salesTotal.contractionArr])],
    ["ending_arr", currentTotal.endingArr],
  ]);
  const workbookComparison = input.monthKey === "2026-08" && asOfDate === "2026-08-31"
    ? WORKBOOK_AUGUST_REFERENCE.map((reference) => {
        const automatedValue = round2(actualByWorkbookId.get(reference.id) || 0);
        const variance = round2(automatedValue - reference.value);
        const tolerance = Math.max(1, Math.abs(reference.value) * 0.005);
        return { id: reference.id, label: reference.label, workbookValue: reference.value, automatedValue, variance, matches: Math.abs(variance) <= tolerance };
      })
    : [];

  return {
    monthKey: input.monthKey,
    monthLabel: monthLabel(input.monthKey),
    monthStartDate,
    monthEndDate,
    asOfDate,
    targetCurrency: String(FX_TARGET_CURRENCY || "USD").toUpperCase(),
    businessDays: { elapsed: elapsedBusinessDays, total: totalBusinessDays },
    metrics,
    arrBridge,
    targetRows: getGtmTargetRows(input.monthKey),
    workbookComparison,
    warnings,
  };
}
