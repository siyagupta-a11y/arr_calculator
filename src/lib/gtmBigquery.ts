import { runBigQuerySqlRows, type BigQuerySqlParameter, type StripeBigQueryProfile } from "@/lib/stripeBigquery";

const PROFILE: StripeBigQueryProfile = "stripe_arr_correct";
const BIGQUERY_PROJECT = String(process.env.GTM_BIGQUERY_PROJECT || "botpress-stripe-data-pipeline").trim()
  || "botpress-stripe-data-pipeline";
const TRANSFORMED_DATASET = String(process.env.GTM_BIGQUERY_TRANSFORMED_DATASET || "transformed_data").trim()
  || "transformed_data";
const HUBSPOT_DATASET = String(process.env.GTM_BIGQUERY_HUBSPOT_DATASET || "hubspot").trim() || "hubspot";

const SALES_DEFAULT_PIPELINE_ID = "0cbbc8c6-dccf-4601-8d59-b6a15ed5129b";
const TRANSACTIONAL_PIPELINE_ID = "730649262";

export type GtmBigQueryCrmMetrics = {
  pipelineCreated: number | null;
  pipelineCreatedAllTypes: number | null;
  openPipeline: number | null;
  openPipelineDealCount: number | null;
  oppsCreated: number | null;
  oppsFromMqlProxy: number | null;
  oppsFromPqlProxy: number | null;
  mqls: number | null;
  sqls: number | null;
  overallSignups: number | null;
  csSignups: number | null;
  businessSignups: number | null;
  salesLedAcv: number | null;
  winRate: number | null;
  heldShowRate: number | null;
  meetingHygieneCount: number | null;
  newLogosSalesLed: number | null;
  newLogosSalesAssist: number | null;
  latestHubspotExtractedAt: string | null;
  warnings: string[];
};

export type GtmBigQueryArrRow = {
  monthKey: string;
  segment: "selfserve" | "sales_assist" | "salesled";
  beginningArr: number;
  newArr: number;
  expansionArr: number;
  contractionArr: number;
  churnArr: number;
  endingArr: number;
};

function safeIdentifier(value: string, label: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Invalid ${label} BigQuery identifier.`);
  return value;
}

function tableRef(dataset: string, table: string) {
  return `\`${safeIdentifier(BIGQUERY_PROJECT, "project")}.${safeIdentifier(dataset, "dataset")}.${safeIdentifier(table, "table")}\``;
}

function toNumber(value: unknown) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toStringOrNull(value: unknown) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function sharedDateParams(monthStartDate: string, monthEndDate: string, asOfDate: string): BigQuerySqlParameter[] {
  return [
    { name: "month_start", type: "STRING", value: monthStartDate },
    { name: "month_end", type: "STRING", value: monthEndDate },
    { name: "as_of", type: "STRING", value: asOfDate },
    { name: "sales_pipeline", type: "STRING", value: SALES_DEFAULT_PIPELINE_ID },
    { name: "transaction_pipeline", type: "STRING", value: TRANSACTIONAL_PIPELINE_ID },
  ];
}

function newBusinessSql(alias = "d") {
  return `REGEXP_REPLACE(LOWER(COALESCE(${alias}.dealtype, '')), r'[^a-z]', '') = 'newbusiness'`;
}

export async function queryGtmCrmMetrics(input: {
  monthStartDate: string;
  monthEndDate: string;
  asOfDate: string;
}): Promise<GtmBigQueryCrmMetrics> {
  const warnings: string[] = [];
  const result: GtmBigQueryCrmMetrics = {
    pipelineCreated: null,
    pipelineCreatedAllTypes: null,
    openPipeline: null,
    openPipelineDealCount: null,
    oppsCreated: null,
    oppsFromMqlProxy: null,
    oppsFromPqlProxy: null,
    mqls: null,
    sqls: null,
    overallSignups: null,
    csSignups: null,
    businessSignups: null,
    salesLedAcv: null,
    winRate: null,
    heldShowRate: null,
    meetingHygieneCount: null,
    newLogosSalesLed: null,
    newLogosSalesAssist: null,
    latestHubspotExtractedAt: null,
    warnings,
  };
  const params = sharedDateParams(input.monthStartDate, input.monthEndDate, input.asOfDate);

  const dealsPromise = runBigQuerySqlRows(
    `
WITH deals AS (
  SELECT *
  FROM ${tableRef(TRANSFORMED_DATASET, "stg_hubspot_deals")}
  WHERE COALESCE(is_archived, FALSE) = FALSE
), scoped AS (
  SELECT
    d.*,
    d.pipeline_id IN (@sales_pipeline, @transaction_pipeline) AS is_included_pipeline,
    ${newBusinessSql("d")} AS is_new_business,
    DATE(d.deal_created_at) BETWEEN DATE(@month_start) AND DATE(@as_of) AS created_in_range,
    DATE(COALESCE(d.closed_won_date, d.close_date)) BETWEEN DATE(@month_start) AND DATE(@as_of) AS won_in_range,
    DATE(d.close_date) BETWEEN DATE(@month_start) AND DATE(@month_end) AS closes_in_month,
    DATE(d.close_date) BETWEEN DATE_SUB(DATE(@as_of), INTERVAL 29 DAY) AND DATE(@as_of) AS closed_in_last_30_days,
    DATE(COALESCE(d.closed_won_date, d.close_date)) BETWEEN DATE_SUB(DATE(@as_of), INTERVAL 89 DAY) AND DATE(@as_of) AS won_in_last_90_days,
    COALESCE(d.amount_in_home_currency, d.amount, d.arr, d.contracted_carr, 0) AS deal_value
  FROM deals d
)
SELECT
  SUM(IF(created_in_range AND is_included_pipeline AND is_new_business, deal_value, 0)) AS pipeline_created,
  SUM(IF(created_in_range AND is_included_pipeline, deal_value, 0)) AS pipeline_created_all_types,
  SUM(IF(NOT COALESCE(is_closed, FALSE) AND closes_in_month AND is_included_pipeline AND is_new_business, deal_value, 0)) AS open_pipeline,
  COUNTIF(NOT COALESCE(is_closed, FALSE) AND closes_in_month AND is_included_pipeline AND is_new_business) AS open_pipeline_deal_count,
  COUNTIF(created_in_range AND is_included_pipeline AND is_new_business) AS opps_created,
  COUNTIF(created_in_range AND pipeline_id = @sales_pipeline AND is_new_business) AS opps_from_mql_proxy,
  COUNTIF(created_in_range AND pipeline_id = @transaction_pipeline AND is_new_business) AS opps_from_pql_proxy,
  AVG(IF(won_in_last_90_days AND pipeline_id = @sales_pipeline AND is_new_business AND COALESCE(is_closed_won, FALSE), deal_value, NULL)) AS sales_led_acv,
  SAFE_DIVIDE(
    COUNTIF(closed_in_last_30_days AND is_included_pipeline AND COALESCE(is_closed_won, FALSE)),
    COUNTIF(closed_in_last_30_days AND is_included_pipeline AND (COALESCE(is_closed_won, FALSE) OR COALESCE(is_closed_lost, FALSE)))
  ) AS win_rate,
  COUNT(DISTINCT IF(won_in_range AND pipeline_id = @sales_pipeline AND is_new_business AND COALESCE(is_closed_won, FALSE), COALESCE(primary_company_id, deal_id), NULL)) AS new_logos_sales_led,
  COUNT(DISTINCT IF(won_in_range AND pipeline_id = @transaction_pipeline AND is_new_business AND COALESCE(is_closed_won, FALSE), COALESCE(primary_company_id, deal_id), NULL)) AS new_logos_sales_assist,
  MAX(source_extracted_at) AS latest_hubspot_extracted_at
FROM scoped
`,
    params,
    { profile: PROFILE },
  ).then((rows) => {
    const row = rows[0] || {};
    result.pipelineCreated = toNumber(row.pipeline_created);
    result.pipelineCreatedAllTypes = toNumber(row.pipeline_created_all_types);
    result.openPipeline = toNumber(row.open_pipeline);
    result.openPipelineDealCount = toNumber(row.open_pipeline_deal_count);
    result.oppsCreated = toNumber(row.opps_created);
    result.oppsFromMqlProxy = toNumber(row.opps_from_mql_proxy);
    result.oppsFromPqlProxy = toNumber(row.opps_from_pql_proxy);
    result.salesLedAcv = toNumber(row.sales_led_acv);
    result.winRate = toNumber(row.win_rate);
    result.newLogosSalesLed = toNumber(row.new_logos_sales_led);
    result.newLogosSalesAssist = toNumber(row.new_logos_sales_assist);
    result.latestHubspotExtractedAt = toStringOrNull(row.latest_hubspot_extracted_at);
  }).catch((error: unknown) => {
    warnings.push(`BigQuery deal metrics unavailable: ${error instanceof Error ? error.message : String(error)}`);
  });

  const contactsPromise = runBigQuerySqlRows(
    `
WITH latest_contacts AS (
  SELECT
    id,
    properties_hs_v2_date_entered_marketingqualifiedlead AS entered_mql_at,
    properties_hs_v2_date_entered_salesqualifiedlead AS entered_sql_at,
    _airbyte_extracted_at AS source_extracted_at
  FROM ${tableRef(HUBSPOT_DATASET, "contacts")}
  WHERE COALESCE(archived, FALSE) = FALSE
  QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY _airbyte_extracted_at DESC, updatedAt DESC) = 1
)
SELECT
  COUNTIF(DATE(entered_mql_at) BETWEEN DATE(@month_start) AND DATE(@as_of)) AS mqls,
  COUNTIF(DATE(entered_sql_at) BETWEEN DATE(@month_start) AND DATE(@as_of)) AS sqls,
  MAX(source_extracted_at) AS latest_hubspot_extracted_at
FROM latest_contacts
`,
    params,
    { profile: PROFILE },
  ).then((rows) => {
    const row = rows[0] || {};
    result.mqls = toNumber(row.mqls);
    result.sqls = toNumber(row.sqls);
    const contactFreshness = toStringOrNull(row.latest_hubspot_extracted_at);
    if (!result.latestHubspotExtractedAt || (contactFreshness && contactFreshness > result.latestHubspotExtractedAt)) {
      result.latestHubspotExtractedAt = contactFreshness;
    }
  }).catch((error: unknown) => {
    warnings.push(`BigQuery contact-funnel metrics unavailable: ${error instanceof Error ? error.message : String(error)}`);
  });

  const signupPromise = runBigQuerySqlRows(
    `
WITH overall AS (
  SELECT SUM(stage_count) AS total_signups
  FROM ${tableRef(TRANSFORMED_DATASET, "rpt_marketing_overall_funnel_by_period")}
  WHERE stage_key = 'total_signups'
    AND period_start BETWEEN DATE(@month_start) AND DATE(@as_of)
), cs AS (
  SELECT SUM(cs_stage_count) AS cs_signups
  FROM ${tableRef(TRANSFORMED_DATASET, "rpt_marketing_cs_vertical_by_period")}
  WHERE stage_key = 'total_signups'
    AND period_start BETWEEN DATE(@month_start) AND DATE(@as_of)
)
SELECT
  overall.total_signups,
  cs.cs_signups,
  GREATEST(COALESCE(overall.total_signups, 0) - COALESCE(cs.cs_signups, 0), 0) AS business_signups
FROM overall CROSS JOIN cs
`,
    params,
    { profile: PROFILE },
  ).then((rows) => {
    const row = rows[0] || {};
    result.overallSignups = toNumber(row.total_signups);
    result.csSignups = toNumber(row.cs_signups);
    result.businessSignups = toNumber(row.business_signups);
  }).catch((error: unknown) => {
    warnings.push(`BigQuery signup metrics unavailable: ${error instanceof Error ? error.message : String(error)}`);
  });

  await Promise.all([dealsPromise, contactsPromise, signupPromise]);
  warnings.push("Held/show rate is unavailable because HubSpot meeting engagements are not replicated into BigQuery.");
  return result;
}

export async function queryGtmArrRows(input: {
  startDate: string;
  endDate: string;
}): Promise<GtmBigQueryArrRow[]> {
  const rows = await runBigQuerySqlRows(
    `
WITH monthly AS (
  SELECT *
  FROM ${tableRef(TRANSFORMED_DATASET, "rpt_carr_waterfall_by_period_and_motion")}
  WHERE grain = 'month'
    AND period_start BETWEEN DATE_TRUNC(DATE(@start_date), MONTH) AND DATE_TRUNC(DATE(@end_date), MONTH)
    AND motion IN ('self_serve', 'sales_assist', 'sales_led')
)
SELECT
  FORMAT_DATE('%Y-%m', period_start) AS month_key,
  motion,
  beginning_carr AS beginning_arr,
  COALESCE(new_carr, 0) + COALESCE(reactivation_carr, 0) AS new_arr,
  expansion_carr AS expansion_arr,
  contraction_carr AS contraction_arr,
  churn_carr AS churn_arr,
  ending_carr AS ending_arr
FROM monthly
ORDER BY month_key, motion
`,
    [
      { name: "start_date", type: "STRING", value: input.startDate },
      { name: "end_date", type: "STRING", value: input.endDate },
    ],
    { profile: PROFILE },
  );

  return rows.flatMap((row) => {
    const rawMotion = String(row.motion || "");
    const segment = rawMotion === "self_serve"
      ? "selfserve"
      : rawMotion === "sales_assist"
        ? "sales_assist"
        : rawMotion === "sales_led"
          ? "salesled"
          : null;
    if (!segment) return [];
    return [{
      monthKey: String(row.month_key || ""),
      segment,
      beginningArr: toNumber(row.beginning_arr) || 0,
      newArr: toNumber(row.new_arr) || 0,
      expansionArr: toNumber(row.expansion_arr) || 0,
      contractionArr: toNumber(row.contraction_arr) || 0,
      churnArr: toNumber(row.churn_arr) || 0,
      endingArr: toNumber(row.ending_arr) || 0,
    } satisfies GtmBigQueryArrRow];
  });
}
