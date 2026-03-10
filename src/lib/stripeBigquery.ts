import { createSign } from "node:crypto";
import type { SyncedStripeLineItem } from "@/lib/stripeSyncStore";
import type { ReportRow } from "@/lib/types";

type ServiceAccount = {
  client_email: string;
  private_key: string;
  project_id?: string;
};

type BigQueryQueryResponse = {
  schema?: { fields?: Array<{ name: string }> };
  rows?: Array<{ f?: Array<{ v?: unknown }> }>;
  pageToken?: string;
  jobComplete?: boolean;
  jobReference?: {
    projectId?: string;
    jobId?: string;
    location?: string;
  };
};

export type StripeBigQueryFilters = {
  customerId?: string;
  lineItemDescription?: string;
  lineItemDescriptionPrefix?: string;
};

export type StripeBigQueryPeriodSpec = {
  key: string;
  label: string;
  startTsMs: number;
  endTsMs: number;
};

export type StripeBigQueryGroupField = "customerId" | "lineItemDescription" | "lineItemDescriptionPrefix";
export type StripeBigQueryProfile = "default" | "stripe_arr_correct";

export type StripeBigQueryReportRequest = {
  startTsMs: number;
  endTsMs: number;
  targetCurrency: string;
  page: number;
  pageSize: number;
  periods: StripeBigQueryPeriodSpec[];
  sortByPeriodKey?: string;
  groupByFields?: StripeBigQueryGroupField[];
  filters?: StripeBigQueryFilters;
};

type StripeBigQueryReportBase = {
  rows: ReportRow[];
  totalsByPeriod: { key: string; label: string; total: number }[];
  totalRows: number;
  sourceRowsFetched: number;
};

export type StripeBigQueryPeriodTotal = {
  key: string;
  label: string;
  total: number;
};

export type StripeBigQueryReportPageResult = StripeBigQueryReportBase & {
  page: number;
  totalPages: number;
};

export type StripeThroughMrrGroupBy =
  | "none"
  | "customer_id"
  | "product_id"
  | "price_id"
  | "subscription_id"
  | "subscription_item_id"
  | "event_type";

export type StripeThroughMrrMonthlyRow = {
  monthKey: string;
  monthLabel: string;
  monthEndMrr: number;
  newMrr: number;
  expansionMrr: number;
  contractionMrr: number;
  churnMrr: number;
  netMrrChange: number;
};

export type StripeThroughMrrRawDetailRow = {
  eventTimestampUtc: string;
  eventType: string;
  mrrChange: number;
  customerId: string;
  subscriptionId: string;
  subscriptionItemId: string;
  productId: string;
  productDescription: string;
  priceId: string;
  priceDescription: string;
};

export type StripeThroughMrrGroupedDetailRow = {
  groupKey: string;
  groupLabel: string;
  monthKey: string;
  monthLabel: string;
  eventCount: number;
  netMrrChange: number;
  newMrr: number;
  expansionMrr: number;
  contractionMrr: number;
  churnMrr: number;
};

export type StripeThroughMrrReportRequest = {
  startDate: string;
  endDate: string;
  detailStartMonth: string;
  detailEndMonth: string;
  groupBy: StripeThroughMrrGroupBy;
  page: number;
  pageSize: number;
  targetCurrency: string;
};

export type StripeThroughMrrReportResult = {
  startDate: string;
  endDate: string;
  detailStartMonth: string;
  detailEndMonth: string;
  groupBy: StripeThroughMrrGroupBy;
  targetCurrency: string;
  totalMrr: number;
  months: StripeThroughMrrMonthlyRow[];
  detailRows: Array<StripeThroughMrrRawDetailRow | StripeThroughMrrGroupedDetailRow>;
  detailMode: "raw" | "grouped";
  pagination: {
    page: number;
    pageSize: number;
    returnedRows: number;
    totalRows: number;
    totalPages: number;
    hasMore: boolean;
  };
};

export type StripeBillingOverviewGrain = "daily" | "weekly" | "monthly" | "quarterly";

export type StripeBillingOverviewRequest = {
  startDate: string;
  endDate: string;
  grain: StripeBillingOverviewGrain;
  targetCurrency: string;
};

export type StripeBillingOverviewPoint = {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  mrrEnd: number;
  newMrr: number;
  expansionMrr: number;
  contractionMrr: number;
  churnMrr: number;
  netMrrChange: number;
  mrrGrowthRatePct: number;
  arr: number;
  arrGrowth: number;
};

export type StripeBillingOverviewCustomerArrRow = {
  customerId: string;
  periodKey: string;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  arr: number;
};

export type StripeBillingOverviewResult = {
  startDate: string;
  endDate: string;
  grain: StripeBillingOverviewGrain;
  targetCurrency: string;
  currentMrr: number;
  currentArr: number;
  historyPoints: StripeBillingOverviewPoint[];
  points: StripeBillingOverviewPoint[];
  customerArrRows: StripeBillingOverviewCustomerArrRow[];
};

type BigQueryNamedParameter = {
  name: string;
  type: "INT64" | "STRING";
  value: string;
};

type StripeBigQueryOptions = {
  profile?: StripeBigQueryProfile;
};

const TOKEN_AUDIENCE = "https://oauth2.googleapis.com/token";
const BQ_SCOPE = "https://www.googleapis.com/auth/bigquery";
const BQ_MAX_RESULTS = Number(process.env.BIGQUERY_MAX_RESULTS || "50000");
const STRIPE_ARR_CORRECT_DEFAULT_TABLE = "botpress-stripe-data-pipeline.stripe.invoice_lines_helper";
const STRIPE_ARR_CORRECT_MRR_CHANGE_DEFAULT_TABLE =
  "botpress-stripe-data-pipeline.stripe.subscription_item_change_events_v2_beta";
const STRIPE_PRODUCTS_DEFAULT_TABLE = "botpress-stripe-data-pipeline.stripe.products";
const STRIPE_ARR_CORRECT_ENV_MAP: Record<string, string> = {
  GOOGLE_SERVICE_ACCOUNT_JSON: "GOOGLE_SERVICE_ACCOUNT_JSON_STRIPE_ARR_CORRECT",
  GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: "GOOGLE_SERVICE_ACCOUNT_JSON_BASE64_STRIPE_ARR_CORRECT",
  BIGQUERY_PROJECT_ID: "BIGQUERY_STRIPE_ARR_CORRECT_PROJECT_ID",
  BIGQUERY_LOCATION: "BIGQUERY_STRIPE_ARR_CORRECT_LOCATION",
  BIGQUERY_STRIPE_TABLE: "BIGQUERY_STRIPE_ARR_CORRECT_TABLE",
  BIGQUERY_STRIPE_SERVING_TABLE: "BIGQUERY_STRIPE_ARR_CORRECT_SERVING_TABLE",
  BIGQUERY_SERVING_SCHEMA_MODE: "BIGQUERY_STRIPE_ARR_CORRECT_SERVING_SCHEMA_MODE",
  BIGQUERY_SCHEMA_MODE: "BIGQUERY_STRIPE_ARR_CORRECT_SCHEMA_MODE",
  BIGQUERY_SERVING_TS_UNIT: "BIGQUERY_STRIPE_ARR_CORRECT_SERVING_TS_UNIT",
  BIGQUERY_TS_UNIT: "BIGQUERY_STRIPE_ARR_CORRECT_TS_UNIT",
};

function base64Url(input: Buffer | string) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return b.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function normalizeProfile(profile?: StripeBigQueryProfile): StripeBigQueryProfile {
  return profile === "stripe_arr_correct" ? "stripe_arr_correct" : "default";
}

function readEnv(name: string, profile: StripeBigQueryProfile = "default") {
  if (profile !== "stripe_arr_correct") return process.env[name];

  const mappedName = STRIPE_ARR_CORRECT_ENV_MAP[name];
  const mappedValue = mappedName ? process.env[mappedName] : undefined;
  if (mappedValue) return mappedValue;

  // For the corrected profile, pin table/project defaults and avoid inheriting
  // the default Stripe serving table by accident.
  if (name === "BIGQUERY_STRIPE_TABLE") return STRIPE_ARR_CORRECT_DEFAULT_TABLE;
  if (name === "BIGQUERY_STRIPE_SERVING_TABLE") return "";
  if (name === "BIGQUERY_SCHEMA_MODE") return "int_ts";
  if (name === "BIGQUERY_TS_UNIT") return "milliseconds";
  if (name === "BIGQUERY_SERVING_SCHEMA_MODE") return "int";
  if (name === "BIGQUERY_SERVING_TS_UNIT") return "milliseconds";

  if (name === "GOOGLE_SERVICE_ACCOUNT_JSON" || name === "GOOGLE_SERVICE_ACCOUNT_JSON_BASE64") {
    return process.env[name];
  }
  if (name === "BIGQUERY_LOCATION") {
    return process.env[name];
  }
  return process.env[name];
}

function mustEnv(name: string, profile: StripeBigQueryProfile = "default") {
  const v = readEnv(name, profile);
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getServiceAccount(profile: StripeBigQueryProfile = "default"): ServiceAccount {
  const raw = readEnv("GOOGLE_SERVICE_ACCOUNT_JSON", profile);
  const rawB64 = readEnv("GOOGLE_SERVICE_ACCOUNT_JSON_BASE64", profile);

  if (!raw && !rawB64) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_JSON_BASE64");
  }

  const jsonText = raw || Buffer.from(rawB64!, "base64").toString("utf8");
  const parsed = JSON.parse(jsonText) as Partial<ServiceAccount>;

  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("Invalid Google service account JSON");
  }

  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    project_id: parsed.project_id,
  };
}

async function getAccessToken(sa: ServiceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: TOKEN_AUDIENCE,
    scope: BQ_SCOPE,
    iat: now,
    exp: now + 3600,
  };

  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(sa.private_key);
  const assertion = `${unsigned}.${base64Url(signature)}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const res = await fetch(TOKEN_AUDIENCE, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Google token error ${res.status}: ${text}`);
  const json = JSON.parse(text) as { access_token?: string };
  if (!json.access_token) throw new Error("Google token response missing access_token");
  return json.access_token;
}

function asString(v: unknown) {
  if (v == null) return "";
  return String(v);
}

function asNumber(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function rowToObject(fields: string[], row: { f?: Array<{ v?: unknown }> }) {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < fields.length; i++) {
    out[fields[i]] = row.f?.[i]?.v;
  }
  return out;
}

function mapBigQueryRowToSyncedItem(raw: Record<string, unknown>, tsMultiplier: number): SyncedStripeLineItem {
  const invoiceId = asString(raw.invoice_id || raw.invoiceId);
  const lineItemId = asString(raw.line_item_id || raw.lineItemId);
  const customerId = asString(raw.customer_id || raw.customerId);
  const lineItemDescription = asString(raw.line_item_description || raw.lineItemDescription);

  const periodStart = Math.floor(asNumber(raw.period_start_ts || raw.periodStartTs) * tsMultiplier);
  const periodEnd = Math.floor(asNumber(raw.period_end_ts || raw.periodEndTs) * tsMultiplier);
  const invoiceCreated = Math.floor(asNumber(raw.invoice_created_ts || raw.invoiceCreatedTs) * tsMultiplier);

  return {
    key: `${invoiceId}:${lineItemId}`,
    invoiceId,
    invoiceCreatedTs: invoiceCreated,
    customerId,
    customerName: customerId,
    lineItemId,
    lineItemDescription,
    amountMinor: asNumber(raw.amount_minor || raw.amountMinor),
    currency: asString(raw.currency).toLowerCase(),
    quantity: asNumber(raw.quantity || 1),
    periodStartTs: periodStart,
    periodEndTs: periodEnd,
  };
}

function parseTextFilter(raw: string) {
  const tokens = String(raw || "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);

  const includeTerms: string[] = [];
  const excludeTerms: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.startsWith("not ")) {
      const term = token.slice(4).trim().toLowerCase();
      if (term) excludeTerms.push(term);
    } else {
      includeTerms.push(lower);
    }
  }

  return { includeTerms, excludeTerms };
}

function pushStringFilterSql(
  clauses: string[],
  params: BigQueryNamedParameter[],
  columnExpr: string,
  rawFilter: string | undefined,
  prefix: string,
) {
  if (!rawFilter) return;
  const { includeTerms, excludeTerms } = parseTextFilter(rawFilter);
  if (includeTerms.length === 0 && excludeTerms.length === 0) return;

  if (includeTerms.length > 0) {
    const includeChecks: string[] = [];
    for (let i = 0; i < includeTerms.length; i++) {
      const name = `${prefix}_inc_${i}`;
      params.push({ name, type: "STRING", value: includeTerms[i] });
      includeChecks.push(`STRPOS(LOWER(CAST(${columnExpr} AS STRING)), @${name}) > 0`);
    }
    clauses.push(`(${includeChecks.join(" OR ")})`);
  }

  if (excludeTerms.length > 0) {
    for (let i = 0; i < excludeTerms.length; i++) {
      const name = `${prefix}_exc_${i}`;
      params.push({ name, type: "STRING", value: excludeTerms[i] });
      clauses.push(`STRPOS(LOWER(CAST(${columnExpr} AS STRING)), @${name}) = 0`);
    }
  }
}

function buildQuery(table: string) {
  const mode = (process.env.BIGQUERY_SCHEMA_MODE || "int_ts").toLowerCase();
  if (mode === "timestamp") {
    return `
SELECT
  COALESCE(JSON_VALUE(TO_JSON_STRING(t), '$.customer_id'), '') AS customer_id,
  CAST(invoice_id AS STRING) AS invoice_id,
  CAST(id AS STRING) AS line_item_id,
  CAST(description AS STRING) AS line_item_description,
  CAST(COALESCE(amount, 0) AS FLOAT64) AS amount_minor,
  LOWER(CAST(currency AS STRING)) AS currency,
  CAST(COALESCE(quantity, 1) AS FLOAT64) AS quantity,
  CAST(UNIX_MILLIS(period_start) AS INT64) AS period_start_ts,
  CAST(UNIX_MILLIS(period_end) AS INT64) AS period_end_ts,
  CAST(UNIX_MILLIS(period_start) AS INT64) AS invoice_created_ts,
  TO_JSON_STRING(t) AS raw_row_json
FROM \`${table}\` AS t
WHERE
  period_start <= TIMESTAMP_MILLIS(@range_end_ts)
  AND period_end > TIMESTAMP_MILLIS(@range_start_ts)
`;
  }

  return `
SELECT
  CAST(customer_id AS STRING) AS customer_id,
  CAST(invoice_id AS STRING) AS invoice_id,
  CAST(line_item_id AS STRING) AS line_item_id,
  CAST(line_item_description AS STRING) AS line_item_description,
  CAST(amount_minor AS FLOAT64) AS amount_minor,
  LOWER(CAST(currency AS STRING)) AS currency,
  CAST(quantity AS FLOAT64) AS quantity,
  CAST(period_start_ts AS INT64) AS period_start_ts,
  CAST(period_end_ts AS INT64) AS period_end_ts,
  CAST(invoice_created_ts AS INT64) AS invoice_created_ts,
  TO_JSON_STRING(t) AS raw_row_json
FROM \`${table}\` AS t
WHERE
  CAST(period_start_ts AS INT64) <= @range_end_ts
  AND CAST(period_end_ts AS INT64) > @range_start_ts
`;
}

function buildServingQueryTimestampColumns(table: string, filters?: StripeBigQueryFilters) {
  const filterClauses: string[] = [];
  const filterParams: BigQueryNamedParameter[] = [];
  pushStringFilterSql(filterClauses, filterParams, "customer_id", filters?.customerId, "customer_id");
  pushStringFilterSql(
    filterClauses,
    filterParams,
    "line_item_description",
    filters?.lineItemDescription,
    "line_item_description",
  );

  const query = `
SELECT
  CAST(customer_id AS STRING) AS customer_id,
  CAST(invoice_id AS STRING) AS invoice_id,
  CAST(line_item_id AS STRING) AS line_item_id,
  CAST(line_item_description AS STRING) AS line_item_description,
  CAST(amount_minor AS FLOAT64) AS amount_minor,
  LOWER(CAST(currency AS STRING)) AS currency,
  CAST(quantity AS FLOAT64) AS quantity,
  CAST(UNIX_MILLIS(period_start_ts) AS INT64) AS period_start_ts,
  CAST(UNIX_MILLIS(period_end_ts) AS INT64) AS period_end_ts,
  CAST(UNIX_MILLIS(COALESCE(invoice_created_ts, period_start_ts)) AS INT64) AS invoice_created_ts,
  TO_JSON_STRING(t) AS raw_row_json
FROM \`${table}\` AS t
WHERE
  period_start_ts <= TIMESTAMP_MILLIS(@range_end_ts)
  AND period_end_ts > TIMESTAMP_MILLIS(@range_start_ts)
  ${filterClauses.length ? `AND ${filterClauses.join(" AND ")}` : ""}
ORDER BY period_start_ts DESC, invoice_id DESC, line_item_id DESC
`;
  return { query, filterParams };
}

function buildServingQueryIntColumns(table: string, filters?: StripeBigQueryFilters) {
  const filterClauses: string[] = [];
  const filterParams: BigQueryNamedParameter[] = [];
  pushStringFilterSql(filterClauses, filterParams, "customer_id", filters?.customerId, "customer_id");
  pushStringFilterSql(
    filterClauses,
    filterParams,
    "line_item_description",
    filters?.lineItemDescription,
    "line_item_description",
  );

  const query = `
SELECT
  CAST(customer_id AS STRING) AS customer_id,
  CAST(invoice_id AS STRING) AS invoice_id,
  CAST(line_item_id AS STRING) AS line_item_id,
  CAST(line_item_description AS STRING) AS line_item_description,
  CAST(amount_minor AS FLOAT64) AS amount_minor,
  LOWER(CAST(currency AS STRING)) AS currency,
  CAST(quantity AS FLOAT64) AS quantity,
  CAST(period_start_ts AS INT64) AS period_start_ts,
  CAST(period_end_ts AS INT64) AS period_end_ts,
  CAST(COALESCE(invoice_created_ts, period_start_ts) AS INT64) AS invoice_created_ts,
  TO_JSON_STRING(t) AS raw_row_json
FROM \`${table}\` AS t
WHERE
  CAST(period_start_ts AS INT64) <= @range_end_ts
  AND CAST(period_end_ts AS INT64) > @range_start_ts
  ${filterClauses.length ? `AND ${filterClauses.join(" AND ")}` : ""}
ORDER BY CAST(period_start_ts AS INT64) DESC, invoice_id DESC, line_item_id DESC
`;
  return { query, filterParams };
}

type BigQuerySourceConfig = {
  table: string;
  servingTable: string;
  servingSchemaMode: string;
  schemaMode: string;
  tsUnit: string;
  tsMultiplier: number;
};

function getBigQuerySourceConfig(profile: StripeBigQueryProfile = "default"): BigQuerySourceConfig {
  const table = mustEnv("BIGQUERY_STRIPE_TABLE", profile);
  const servingTable = (readEnv("BIGQUERY_STRIPE_SERVING_TABLE", profile) || "").trim();
  const servingSchemaMode = (readEnv("BIGQUERY_SERVING_SCHEMA_MODE", profile) || "int").toLowerCase();
  const schemaMode = servingTable ? "int_ts" : (readEnv("BIGQUERY_SCHEMA_MODE", profile) || "int_ts").toLowerCase();
  const tsUnit = servingTable
    ? (readEnv("BIGQUERY_SERVING_TS_UNIT", profile) || "milliseconds").toLowerCase()
    : (readEnv("BIGQUERY_TS_UNIT", profile) || "milliseconds").toLowerCase();
  const tsMultiplier = schemaMode === "timestamp" ? 1 : tsUnit === "seconds" ? 1000 : 1;
  return { table, servingTable, servingSchemaMode, schemaMode, tsUnit, tsMultiplier };
}

function getStripeArrCorrectMrrChangeTable() {
  const configured = String(process.env.BIGQUERY_STRIPE_ARR_CORRECT_MRR_CHANGE_TABLE || "").trim();
  return configured || STRIPE_ARR_CORRECT_MRR_CHANGE_DEFAULT_TABLE;
}

function getStripeProductsTable(profile: StripeBigQueryProfile = "default") {
  const envName =
    profile === "stripe_arr_correct"
      ? "BIGQUERY_STRIPE_ARR_CORRECT_PRODUCTS_TABLE"
      : "BIGQUERY_STRIPE_PRODUCTS_TABLE";
  const configured = String(process.env[envName] || "").trim();
  return configured || STRIPE_PRODUCTS_DEFAULT_TABLE;
}

function toQueryTimestamp(tsMs: number, sourceConfig: BigQuerySourceConfig) {
  if (sourceConfig.schemaMode === "timestamp") return Math.floor(tsMs);
  if (sourceConfig.tsUnit === "seconds") return Math.floor(tsMs / 1000);
  return Math.floor(tsMs);
}

function buildRawSourceQuery(sourceConfig: BigQuerySourceConfig) {
  if (sourceConfig.servingTable) {
    if (sourceConfig.servingSchemaMode === "int") {
      return `
SELECT
  CAST(customer_id AS STRING) AS customer_id,
  CAST(invoice_id AS STRING) AS invoice_id,
  CAST(line_item_id AS STRING) AS line_item_id,
  CAST(line_item_description AS STRING) AS line_item_description,
  CAST(amount_minor AS FLOAT64) AS amount_minor,
  LOWER(CAST(currency AS STRING)) AS currency,
  CAST(quantity AS FLOAT64) AS quantity,
  CAST(period_start_ts AS INT64) AS period_start_ts,
  CAST(period_end_ts AS INT64) AS period_end_ts,
  CAST(COALESCE(invoice_created_ts, period_start_ts) AS INT64) AS invoice_created_ts,
  TO_JSON_STRING(t) AS raw_row_json
FROM \`${sourceConfig.servingTable}\` AS t
WHERE
  CAST(period_start_ts AS INT64) <= @range_end_ts
  AND CAST(period_end_ts AS INT64) > @range_start_ts
`;
    }

    return `
SELECT
  CAST(customer_id AS STRING) AS customer_id,
  CAST(invoice_id AS STRING) AS invoice_id,
  CAST(line_item_id AS STRING) AS line_item_id,
  CAST(line_item_description AS STRING) AS line_item_description,
  CAST(amount_minor AS FLOAT64) AS amount_minor,
  LOWER(CAST(currency AS STRING)) AS currency,
  CAST(quantity AS FLOAT64) AS quantity,
  CAST(UNIX_MILLIS(period_start_ts) AS INT64) AS period_start_ts,
  CAST(UNIX_MILLIS(period_end_ts) AS INT64) AS period_end_ts,
  CAST(UNIX_MILLIS(COALESCE(invoice_created_ts, period_start_ts)) AS INT64) AS invoice_created_ts,
  TO_JSON_STRING(t) AS raw_row_json
FROM \`${sourceConfig.servingTable}\` AS t
WHERE
  period_start_ts <= TIMESTAMP_MILLIS(@range_end_ts)
  AND period_end_ts > TIMESTAMP_MILLIS(@range_start_ts)
`;
  }

  return buildQuery(sourceConfig.table);
}

function normalizeDescriptionBucketSql(valueExpr: string) {
  const normalized = `TRIM(REGEXP_REPLACE(REPLACE(REPLACE(LOWER(${valueExpr}), '_', ' '), '-', ' '), r'\\s+', ' '))`;
  return `CASE
    WHEN ${normalized} = '' THEN '(blank)'
    WHEN REGEXP_CONTAINS(${normalized}, r'remaining time on .+ add on') THEN 'Remaining Time on Add-On'
    WHEN REGEXP_CONTAINS(${normalized}, r'time on .+ add on') THEN 'Time on Add-On'
    ELSE ${valueExpr}
  END`;
}

function normalizeGroupByFields(fields?: StripeBigQueryGroupField[]) {
  return Array.from(new Set((fields || []).filter(Boolean)));
}

function asInt(v: unknown) {
  return Math.max(0, Math.floor(asNumber(v)));
}

function parseIsoDateUtc(dateText: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText || "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || !Number.isInteger(day)) return null;
  if (monthIndex < 0 || monthIndex > 11) return null;
  if (day < 1 || day > 31) return null;
  const ts = Date.UTC(year, monthIndex, day, 0, 0, 0, 0);
  const d = new Date(ts);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== monthIndex ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}

function parseIsoMonthUtc(monthText: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(monthText || "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex)) return null;
  if (monthIndex < 0 || monthIndex > 11) return null;
  return new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
}

function isoMonthFromDateUtc(d: Date) {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

async function fetchBigQueryResultsPage(
  accessToken: string,
  projectId: string,
  location: string,
  query: string,
  params: BigQueryNamedParameter[],
  pageToken?: string,
): Promise<BigQueryQueryResponse> {
  const queryParameters: Array<{ name: string; parameterType: { type: string }; parameterValue: { value: string } }> =
    params.map((p) => ({
      name: p.name,
      parameterType: { type: p.type },
      parameterValue: { value: p.value },
    }));

  const body: Record<string, unknown> = {
    query,
    useLegacySql: false,
    location,
    parameterMode: "NAMED",
    queryParameters,
    maxResults: BQ_MAX_RESULTS,
    timeoutMs: 20000,
  };

  if (pageToken) body.pageToken = pageToken;

  const res = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/queries`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`BigQuery error ${res.status}: ${text}`);
  return JSON.parse(text) as BigQueryQueryResponse;
}

async function waitForJobCompletion(
  accessToken: string,
  projectId: string,
  jobId: string,
  location: string,
): Promise<BigQueryQueryResponse> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/queries/${jobId}?location=${encodeURIComponent(location)}&maxResults=${encodeURIComponent(String(BQ_MAX_RESULTS))}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`BigQuery getQueryResults error ${res.status}: ${text}`);
    const json = JSON.parse(text) as BigQueryQueryResponse;
    if (json.jobComplete) return json;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("BigQuery query timed out waiting for completion");
}

async function runBigQueryQueryRows(
  accessToken: string,
  projectId: string,
  location: string,
  query: string,
  params: BigQueryNamedParameter[],
) {
  const rowsOut: Record<string, unknown>[] = [];
  let pageToken: string | undefined;
  let fields: string[] = [];

  while (true) {
    let json = await fetchBigQueryResultsPage(
      accessToken,
      projectId,
      location,
      query,
      params,
      pageToken,
    );
    if (!json.jobComplete && json.jobReference?.jobId) {
      const jobProjectId = json.jobReference.projectId || projectId;
      const jobLocation = json.jobReference.location || location;
      json = await waitForJobCompletion(accessToken, jobProjectId, json.jobReference.jobId, jobLocation);
    }

    const pageFields = (json.schema?.fields || []).map((f) => f.name);
    if (pageFields.length) fields = pageFields;
    for (const row of json.rows || []) {
      rowsOut.push(rowToObject(fields, row));
    }

    if (!json.pageToken) break;
    pageToken = json.pageToken;
  }

  return rowsOut;
}

type BuiltStripeBigQueryReport = {
  ctesSql: string;
  sharedParams: BigQueryNamedParameter[];
  periodAliases: string[];
  orderBySql: string;
  groupByFields: StripeBigQueryGroupField[];
};

function buildStripeBigQueryReportQuery(
  request: StripeBigQueryReportRequest,
  sourceConfig: BigQuerySourceConfig,
  rangeStart: number,
  rangeEnd: number,
  profile: StripeBigQueryProfile,
): BuiltStripeBigQueryReport {
  const useStripeArrCorrectAnnualizationRules = profile === "stripe_arr_correct";
  const rawSourceQuery = buildRawSourceQuery(sourceConfig);
  const groupByFields = normalizeGroupByFields(request.groupByFields);
  const rawDescriptionExpr =
    "COALESCE(NULLIF(TRIM(CAST(line_item_description AS STRING)), ''), NULLIF(TRIM(CAST(line_item_id AS STRING)), ''), '(no description)')";
  const normalizedDescriptionExpr = `TRIM(REGEXP_REPLACE(LOWER(${rawDescriptionExpr}), r'\\s+', ' '))`;
  const forceTwelveByDescriptionCondition = useStripeArrCorrectAnnualizationRules
    ? `(${normalizedDescriptionExpr} = 'web search and crawl' OR STRPOS(${normalizedDescriptionExpr}, 'ai tokens') > 0)`
    : `${normalizedDescriptionExpr} IN ('web search and crawl', 'ai tokens')`;
  const cancellationDateRawExpr = `COALESCE(
    JSON_VALUE(raw_row_json, '$.cancellation_date'),
    JSON_VALUE(raw_row_json, '$.cancellationDate'),
    JSON_VALUE(raw_row_json, '$.canceled_at'),
    JSON_VALUE(raw_row_json, '$.canceledAt')
  )`;
  const cancellationDateIntExpr = `SAFE_CAST(${cancellationDateRawExpr} AS INT64)`;
  const cancellationDateExpr = `COALESCE(
    SAFE_CAST(${cancellationDateRawExpr} AS DATE),
    DATE(SAFE_CAST(${cancellationDateRawExpr} AS TIMESTAMP)),
    CASE
      WHEN ${cancellationDateIntExpr} IS NULL THEN NULL
      WHEN ${cancellationDateIntExpr} >= 100000000000 THEN DATE(TIMESTAMP_MILLIS(${cancellationDateIntExpr}))
      WHEN ${cancellationDateIntExpr} >= 1000000000 THEN DATE(TIMESTAMP_SECONDS(${cancellationDateIntExpr}))
      ELSE NULL
    END
  )`;
  const cancelledFlagExpr = `LOWER(TRIM(COALESCE(
    JSON_VALUE(raw_row_json, '$.cancelled'),
    JSON_VALUE(raw_row_json, '$.canceled'),
    'false'
  ))) IN ('true', '1', 't', 'yes', 'y')`;
  const cancelledInCurrentMonthExpr = `(
    ${cancelledFlagExpr}
    AND DATE_TRUNC(${cancellationDateExpr}, MONTH) = DATE_TRUNC(DATE(TIMESTAMP_MILLIS(period_start_ts)), MONTH)
  )`;
  const descriptionPrefixExpr = `COALESCE(NULLIF(TRIM(SPLIT(${rawDescriptionExpr}, ' - ')[SAFE_OFFSET(0)]), ''), '(blank)')`;
  const descriptionBucketExpr = normalizeDescriptionBucketSql(rawDescriptionExpr);
  const descriptionPrefixBucketExpr = normalizeDescriptionBucketSql(descriptionPrefixExpr);

  const filterClauses: string[] = [];
  const filterParams: BigQueryNamedParameter[] = [];
  pushStringFilterSql(filterClauses, filterParams, "customer_id", request.filters?.customerId, "customer_id");
  pushStringFilterSql(
    filterClauses,
    filterParams,
    rawDescriptionExpr,
    request.filters?.lineItemDescription,
    "line_item_description",
  );
  pushStringFilterSql(
    filterClauses,
    filterParams,
    descriptionPrefixExpr,
    request.filters?.lineItemDescriptionPrefix,
    "line_item_description_prefix",
  );

  const periodAliases = request.periods.map((_, idx) => `period_${idx}`);
  const periodExpressions = request.periods.map((period, idx) => {
    const alias = periodAliases[idx];
    const startTs = Math.floor(period.startTsMs);
    const endTs = Math.floor(period.endTsMs);
    const expression = `IF(
      period_start_ts <= ${endTs}
      AND period_end_ts > ${startTs}
      AND NOT (
        period_start_ts < ${startTs}
        AND DATE(TIMESTAMP_MILLIS(period_end_ts), 'UTC') = DATE(TIMESTAMP_MILLIS(${startTs}), 'UTC')
      ),
      annualized,
      0.0
    )`;
    return `ROUND(${expression}, 2) AS ${alias}`;
  });
  const periodAliasByKey = new Map(request.periods.map((period, idx) => [period.key, periodAliases[idx]]));
  const sortAlias =
    request.sortByPeriodKey && request.sortByPeriodKey !== "none"
      ? periodAliasByKey.get(request.sortByPeriodKey) || ""
      : "";
  const orderBySql = [
    sortAlias ? `${sortAlias} DESC` : "",
    "deal_name ASC",
    "deal_id ASC",
    "line_item_id ASC",
    "line_item_description ASC",
    "close_date ASC",
  ]
    .filter(Boolean)
    .join(", ");

  const groupFieldSourceColumn: Record<StripeBigQueryGroupField, string> = {
    customerId: "group_customer_id_base",
    lineItemDescription: "group_line_item_description_base",
    lineItemDescriptionPrefix: "group_line_item_description_prefix_base",
  };
  const groupFieldOutputColumn: Record<StripeBigQueryGroupField, string> = {
    customerId: "group_customer_id",
    lineItemDescription: "group_line_item_description",
    lineItemDescriptionPrefix: "group_line_item_description_prefix",
  };

  const ctes: string[] = [];
  ctes.push(`raw_source AS (${rawSourceQuery})`);
  ctes.push(`source AS (
  SELECT *
  FROM raw_source
  WHERE 1=1
  ${filterClauses.map((clause) => `AND ${clause}`).join("\n  ")}
)`);
  ctes.push(`prepared AS (
  SELECT
    COALESCE(NULLIF(TRIM(CAST(customer_id AS STRING)), ''), '(no customer id)') AS deal_name_base,
    COALESCE(NULLIF(TRIM(CAST(customer_id AS STRING)), ''), '(no customer id)') AS deal_id_base,
    CAST(invoice_id AS STRING) AS invoice_id,
    COALESCE(
      NULLIF(TRIM(CAST(line_item_id AS STRING)), ''),
      CONCAT(
        'line_',
        CAST(
          FARM_FINGERPRINT(
            CONCAT(
              CAST(invoice_id AS STRING),
              '|',
              CAST(period_start_ts AS STRING),
              '|',
              CAST(period_end_ts AS STRING),
              '|',
              CAST(amount_minor AS STRING),
              '|',
              COALESCE(CAST(customer_id AS STRING), '')
            )
          ) AS STRING
        )
      )
    ) AS line_item_id_base,
    ${rawDescriptionExpr} AS raw_description,
    ${descriptionBucketExpr} AS group_line_item_description_base,
    ${descriptionPrefixBucketExpr} AS group_line_item_description_prefix_base,
    COALESCE(NULLIF(TRIM(CAST(customer_id AS STRING)), ''), '(no customer id)') AS group_customer_id_base,
    FORMAT_DATE('%Y-%m-%d', DATE(TIMESTAMP_MILLIS(invoice_created_ts))) AS close_date_base,
    FORMAT_DATE('%Y-%m-%d', DATE(TIMESTAMP_MILLIS(period_start_ts))) AS window_start_base,
    FORMAT_DATE('%Y-%m-%d', DATE(TIMESTAMP_MILLIS(period_end_ts))) AS window_end_base,
    CAST(period_start_ts AS INT64) AS period_start_ts,
    CAST(period_end_ts AS INT64) AS period_end_ts,
    GREATEST(CAST(period_end_ts AS INT64) - CAST(period_start_ts AS INT64), 0) AS duration_ms_base,
    CAST(amount_minor AS FLOAT64) AS amount_major,
    COALESCE(CAST(quantity AS FLOAT64), 1.0) AS quantity,
    ${cancelledInCurrentMonthExpr} AS is_cancelled_in_current_month_base,
    CASE
      WHEN UNIX_MILLIS(
        TIMESTAMP(
          DATETIME_ADD(DATETIME(TIMESTAMP_MILLIS(period_start_ts), 'UTC'), INTERVAL 1 YEAR),
          'UTC'
        )
      ) = period_end_ts
      THEN 1.0
      WHEN ${forceTwelveByDescriptionCondition}
      THEN 12.0
      WHEN CAST(period_end_ts AS INT64) <= CAST(period_start_ts AS INT64)
      THEN 0.0
      WHEN UNIX_MILLIS(
        TIMESTAMP(
          DATETIME_ADD(DATETIME(TIMESTAMP_MILLIS(period_start_ts), 'UTC'), INTERVAL 1 MONTH),
          'UTC'
        )
      ) = period_end_ts
      THEN 12.0
      ELSE
        12.0 * (
          CAST(
            (
              UNIX_MILLIS(
                TIMESTAMP(
                  DATE_ADD(
                    DATE_TRUNC(DATE(TIMESTAMP_MILLIS(period_start_ts), 'UTC'), MONTH),
                    INTERVAL 1 MONTH
                  ),
                  'UTC'
                )
              )
              - UNIX_MILLIS(
                TIMESTAMP(DATE_TRUNC(DATE(TIMESTAMP_MILLIS(period_start_ts), 'UTC'), MONTH), 'UTC')
              )
            ) AS FLOAT64
          )
          / GREATEST(
            CAST(period_end_ts - period_start_ts AS FLOAT64),
            1.0
          )
        )
    END AS annualization_multiplier_base
  FROM source
  WHERE
    LOWER(COALESCE(currency, '')) = @target_currency
    AND (
      CAST(period_end_ts AS INT64) > CAST(period_start_ts AS INT64)
      OR (
        CAST(period_end_ts AS INT64) = CAST(period_start_ts AS INT64)
        AND LOWER(TRIM(${rawDescriptionExpr})) IN ('refund', 'discount')
      )
    )
)`);
  ctes.push(`invoice_percent_flag AS (
  SELECT
    invoice_id,
    MAX(IF(STRPOS(raw_description, '%') > 0, 1, 0)) AS has_percent_description
  FROM prepared
  GROUP BY invoice_id
)`);
  ctes.push(`invoice_anchor AS (
  SELECT
    invoice_id,
    ARRAY_AGG(annualization_multiplier_base ORDER BY amount_major DESC, line_item_id_base DESC LIMIT 1)[OFFSET(0)] AS invoice_refund_anchor_multiplier,
    ARRAY_AGG(
      annualization_multiplier_base
      ORDER BY duration_ms_base DESC, amount_major DESC, line_item_id_base DESC
      LIMIT 1
    )[OFFSET(0)] AS invoice_discount_anchor_multiplier
  FROM prepared
  GROUP BY invoice_id
)`);
  ctes.push(`cancelled_current_month_invoices AS (
  SELECT DISTINCT invoice_id
  FROM prepared
  WHERE is_cancelled_in_current_month_base
)`);
  const preparedAnnualizedWhereClauses: string[] = [];
  if (useStripeArrCorrectAnnualizationRules) {
    preparedAnnualizedWhereClauses.push("NOT p.is_cancelled_in_current_month_base");
    preparedAnnualizedWhereClauses.push("NOT (LOWER(TRIM(p.raw_description)) = 'refund' AND cmi.invoice_id IS NOT NULL)");
  } else {
    preparedAnnualizedWhereClauses.push(
      "NOT (LOWER(TRIM(p.raw_description)) = 'discount' AND IFNULL(f.has_percent_description, 0) = 1)",
    );
  }
  ctes.push(`prepared_with_annualized AS (
  SELECT
    p.*,
    CASE
      WHEN LOWER(TRIM(p.raw_description)) = 'refund'
      THEN ${
        useStripeArrCorrectAnnualizationRules
          ? "p.amount_major * 12.0"
          : "p.amount_major * IFNULL(a.invoice_refund_anchor_multiplier, 0.0)"
      }
      WHEN LOWER(TRIM(p.raw_description)) = 'discount'
      THEN ${
        useStripeArrCorrectAnnualizationRules
          ? "p.amount_major * p.annualization_multiplier_base"
          : "p.amount_major * IFNULL(a.invoice_discount_anchor_multiplier, 0.0)"
      }
      ELSE p.amount_major * p.annualization_multiplier_base
    END AS annualized
  FROM prepared AS p
  LEFT JOIN invoice_anchor AS a
    ON a.invoice_id = p.invoice_id
  LEFT JOIN invoice_percent_flag AS f
    ON f.invoice_id = p.invoice_id
  LEFT JOIN cancelled_current_month_invoices AS cmi
    ON cmi.invoice_id = p.invoice_id
  ${preparedAnnualizedWhereClauses.length ? `WHERE ${preparedAnnualizedWhereClauses.join("\n    AND ")}` : ""}
)`);
  ctes.push(`scored AS (
  SELECT
    deal_name_base,
    deal_id_base,
    line_item_id_base,
    raw_description,
    group_customer_id_base,
    group_line_item_description_base,
    group_line_item_description_prefix_base,
    close_date_base,
    window_start_base,
    window_end_base,
    amount_major,
    quantity,
    annualized,
    ${periodExpressions.join(",\n    ")}
  FROM prepared_with_annualized
)`);

  if (groupByFields.length > 0) {
    const groupBySelect = (["customerId", "lineItemDescription", "lineItemDescriptionPrefix"] as StripeBigQueryGroupField[]).map(
      (field) =>
        groupByFields.includes(field)
          ? `${groupFieldSourceColumn[field]} AS ${groupFieldOutputColumn[field]}`
          : `CAST(NULL AS STRING) AS ${groupFieldOutputColumn[field]}`,
    );
    const groupByColumns = groupByFields.map((field) => groupFieldSourceColumn[field]);
    const periodAggregates = periodAliases.map((alias) => `ROUND(SUM(${alias}), 2) AS ${alias}`);

    const dealNameExpr = `ARRAY_TO_STRING([${groupByFields
      .map((field) => `COALESCE(${groupFieldOutputColumn[field]}, '(blank)')`)
      .join(", ")}], ' | ')`;
    const dealIdExpr = groupByFields.includes("customerId") ? "COALESCE(group_customer_id, '(blank)')" : "'(group)'";
    const lineItemIdExpr = `ARRAY_TO_STRING([${groupByFields
      .map((field) => `CONCAT('${field}:', COALESCE(${groupFieldOutputColumn[field]}, '(blank)'))`)
      .join(", ")}], '|')`;
    const nonCustomerGroupFields = groupByFields.filter((field) => field !== "customerId");
    const lineItemDescriptionExpr = nonCustomerGroupFields.length
      ? `ARRAY_TO_STRING([${nonCustomerGroupFields
          .map((field) => `COALESCE(${groupFieldOutputColumn[field]}, '(blank)')`)
          .join(", ")}], ' | ')`
      : "''";

    ctes.push(`grouped_rows AS (
  SELECT
    ${groupBySelect.join(",\n    ")},
    ROUND(SUM(annualized), 2) AS value_usd,
    ROUND(SUM(amount_major), 2) AS amount,
    ROUND(SUM(amount_major), 2) AS net_price,
    SUM(quantity) AS quantity,
    ${periodAggregates.join(",\n    ")}
  FROM scored
  GROUP BY ${groupByColumns.join(", ")}
)`);
    ctes.push(`final_rows AS (
  SELECT
    ${dealNameExpr} AS deal_name,
    ${dealIdExpr} AS deal_id,
    ${lineItemIdExpr} AS line_item_id,
    ${lineItemDescriptionExpr} AS line_item_description,
    group_customer_id,
    group_line_item_description,
    group_line_item_description_prefix,
    '' AS close_date,
    '' AS window_start,
    '' AS window_end,
    value_usd,
    amount,
    net_price,
    quantity,
    ${periodAliases.join(", ")}
  FROM grouped_rows
)`);
  } else {
    ctes.push(`final_rows AS (
  SELECT
    deal_name_base AS deal_name,
    deal_id_base AS deal_id,
    line_item_id_base AS line_item_id,
    raw_description AS line_item_description,
    CAST(NULL AS STRING) AS group_customer_id,
    CAST(NULL AS STRING) AS group_line_item_description,
    CAST(NULL AS STRING) AS group_line_item_description_prefix,
    close_date_base AS close_date,
    window_start_base AS window_start,
    window_end_base AS window_end,
    annualized AS value_usd,
    ROUND(amount_major, 2) AS amount,
    ROUND(amount_major, 2) AS net_price,
    quantity,
    ${periodAliases.join(", ")}
  FROM scored
)`);
  }

  ctes.push(`non_zero AS (
  SELECT *
  FROM final_rows
)`);

  const sharedParams: BigQueryNamedParameter[] = [
    { name: "range_start_ts", type: "INT64", value: String(rangeStart) },
    { name: "range_end_ts", type: "INT64", value: String(rangeEnd) },
    { name: "target_currency", type: "STRING", value: request.targetCurrency.toLowerCase() },
    ...filterParams,
  ];

  return {
    ctesSql: `WITH\n${ctes.join(",\n")}`,
    sharedParams,
    periodAliases,
    orderBySql,
    groupByFields,
  };
}

function mapBigQueryReportRows(
  rawRows: Record<string, unknown>[],
  periods: StripeBigQueryPeriodSpec[],
  periodAliases: string[],
  targetCurrency: string,
  groupByFields: StripeBigQueryGroupField[],
) {
  const rows: ReportRow[] = [];
  for (const raw of rawRows) {
    const valuesByPeriod: Record<string, number> = {};
    for (let idx = 0; idx < periods.length; idx++) {
      valuesByPeriod[periods[idx].key] = asNumber(raw[periodAliases[idx]]);
    }

    const groupValues =
      groupByFields.length > 0
        ? {
            ...(groupByFields.includes("customerId")
              ? { customerId: asString(raw.group_customer_id) || "(blank)" }
              : {}),
            ...(groupByFields.includes("lineItemDescription")
              ? { lineItemDescription: asString(raw.group_line_item_description) || "(blank)" }
              : {}),
            ...(groupByFields.includes("lineItemDescriptionPrefix")
              ? { lineItemDescriptionPrefix: asString(raw.group_line_item_description_prefix) || "(blank)" }
              : {}),
          }
        : undefined;

    rows.push({
      dealName: asString(raw.deal_name),
      dealId: asString(raw.deal_id),
      lineItemId: asString(raw.line_item_id),
      valueUsd: asNumber(raw.value_usd),
      dealCurrency: targetCurrency.toUpperCase(),
      fxRate: null,
      fxDateUsed: "",
      dealType: "stripe_invoice_line",
      closeDate: asString(raw.close_date),
      windowStart: asString(raw.window_start),
      windowEnd: asString(raw.window_end),
      isOpenEnded: false,
      recurringbillingfrequency: "",
      termMonths: null,
      amount: asNumber(raw.amount),
      netPrice: asNumber(raw.net_price),
      quantity: asNumber(raw.quantity || 1),
      valuesByPeriod,
      deploymentType: "",
      accountId: "",
      territory: "",
      country: "",
      industry: "",
      lineItemDescription: asString(raw.line_item_description),
      groupValues,
    });
  }
  return rows;
}

async function queryStripeReportBigQueryBase(
  request: StripeBigQueryReportRequest,
  mode: "page" | "all",
  options?: StripeBigQueryOptions,
): Promise<StripeBigQueryReportBase & { totalPages: number; page: number }> {
  const profile = normalizeProfile(options?.profile);
  const sa = getServiceAccount(profile);
  const projectId = readEnv("BIGQUERY_PROJECT_ID", profile) || sa.project_id;
  if (!projectId) throw new Error("Missing BIGQUERY_PROJECT_ID (or project_id in service account JSON)");

  const sourceConfig = getBigQuerySourceConfig(profile);
  const location = readEnv("BIGQUERY_LOCATION", profile) || "US";
  const rangeStart = toQueryTimestamp(request.startTsMs, sourceConfig);
  const rangeEnd = toQueryTimestamp(request.endTsMs, sourceConfig);
  const built = buildStripeBigQueryReportQuery(request, sourceConfig, rangeStart, rangeEnd, profile);
  const accessToken = await getAccessToken(sa);

  const summaryQuery = `${built.ctesSql}
SELECT
  (SELECT COUNT(*) FROM prepared) AS source_rows_fetched,
  COUNT(*) AS total_rows
  ${built.periodAliases.length ? `,\n  ${built.periodAliases.map((alias) => `ROUND(COALESCE(SUM(${alias}), 0), 2) AS total_${alias}`).join(",\n  ")}` : ""}
FROM non_zero`;
  const summaryRows = await runBigQueryQueryRows(accessToken, projectId, location, summaryQuery, built.sharedParams);
  const summary = summaryRows[0] || {};
  const sourceRowsFetched = asInt(summary.source_rows_fetched);
  const totalRows = asInt(summary.total_rows);
  const totalsByPeriod = request.periods.map((period, idx) => {
    const alias = built.periodAliases[idx];
    return {
      key: period.key,
      label: period.label,
      total: asNumber(summary[`total_${alias}`]),
    };
  });

  const totalPages = totalRows > 0 ? Math.ceil(totalRows / Math.max(1, request.pageSize)) : 1;
  const page = Math.min(Math.max(1, Math.floor(request.page || 1)), totalPages);
  const offsetRows = (page - 1) * Math.max(1, request.pageSize);

  let pageRowsRaw: Record<string, unknown>[] = [];
  if (totalRows > 0) {
    const pageQuery =
      mode === "all"
        ? `${built.ctesSql}
SELECT *
FROM non_zero
ORDER BY ${built.orderBySql}`
        : `${built.ctesSql}
SELECT *
FROM non_zero
ORDER BY ${built.orderBySql}
LIMIT @limit_rows
OFFSET @offset_rows`;
    const pageParams =
      mode === "all"
        ? built.sharedParams
        : [
            ...built.sharedParams,
            { name: "limit_rows", type: "INT64" as const, value: String(Math.max(1, Math.floor(request.pageSize))) },
            { name: "offset_rows", type: "INT64" as const, value: String(offsetRows) },
          ];
    pageRowsRaw = await runBigQueryQueryRows(accessToken, projectId, location, pageQuery, pageParams);
  }

  const rows = mapBigQueryReportRows(
    pageRowsRaw,
    request.periods,
    built.periodAliases,
    request.targetCurrency,
    built.groupByFields,
  );

  return {
    rows,
    totalsByPeriod,
    totalRows,
    sourceRowsFetched,
    totalPages,
    page,
  };
}

export async function queryStripeReportPageFromBigQuery(
  request: StripeBigQueryReportRequest,
  options?: StripeBigQueryOptions,
): Promise<StripeBigQueryReportPageResult> {
  const result = await queryStripeReportBigQueryBase(request, "page", options);
  return {
    rows: result.rows,
    totalsByPeriod: result.totalsByPeriod,
    totalRows: result.totalRows,
    sourceRowsFetched: result.sourceRowsFetched,
    totalPages: result.totalPages,
    page: result.page,
  };
}

export async function queryStripeReportAllRowsFromBigQuery(
  request: StripeBigQueryReportRequest,
  options?: StripeBigQueryOptions,
): Promise<StripeBigQueryReportBase> {
  const result = await queryStripeReportBigQueryBase(request, "all", options);
  return {
    rows: result.rows,
    totalsByPeriod: result.totalsByPeriod,
    totalRows: result.totalRows,
    sourceRowsFetched: result.sourceRowsFetched,
  };
}

export async function queryStripeCumulativeMrrChangeByPeriodsFromBigQuery(
  request: Pick<StripeBigQueryReportRequest, "periods" | "targetCurrency">,
  options?: StripeBigQueryOptions,
): Promise<StripeBigQueryPeriodTotal[]> {
  if (!request.periods.length) return [];

  const profile = normalizeProfile(options?.profile);
  const sa = getServiceAccount(profile);
  const projectId = readEnv("BIGQUERY_PROJECT_ID", profile) || sa.project_id;
  if (!projectId) throw new Error("Missing BIGQUERY_PROJECT_ID (or project_id in service account JSON)");

  const location = readEnv("BIGQUERY_LOCATION", profile) || "US";
  const accessToken = await getAccessToken(sa);
  const table = getStripeArrCorrectMrrChangeTable();
  const maxCutoffTs = Math.max(...request.periods.map((period) => Math.floor(period.endTsMs) + 1));

  const periodSelectSql = request.periods
    .map((period, idx) => {
      const cutoffTs = Math.floor(period.endTsMs) + 1;
      return `ROUND(
    COALESCE(SUM(IF(event_timestamp < TIMESTAMP_MILLIS(${cutoffTs}), CAST(COALESCE(mrr_change, 0) AS FLOAT64), 0.0)), 0.0) / 100.0,
    2
  ) AS total_period_${idx}`;
    })
    .join(",\n  ");

  const query = `
SELECT
  ${periodSelectSql}
FROM \`${table}\`
WHERE
  LOWER(COALESCE(CAST(currency AS STRING), '')) = @target_currency
  AND event_timestamp < TIMESTAMP_MILLIS(@max_cutoff_ts)
`;
  const params: BigQueryNamedParameter[] = [
    { name: "target_currency", type: "STRING", value: request.targetCurrency.toLowerCase() },
    { name: "max_cutoff_ts", type: "INT64", value: String(maxCutoffTs) },
  ];

  const rows = await runBigQueryQueryRows(accessToken, projectId, location, query, params);
  const totals = rows[0] || {};
  return request.periods.map((period, idx) => ({
    key: period.key,
    label: period.label,
    total: asNumber(totals[`total_period_${idx}`]),
  }));
}

const STRIPE_THROUGH_MRR_GROUP_BY_SQL: Record<
  Exclude<StripeThroughMrrGroupBy, "none">,
  { keyExpr: string; labelExpr: string }
> = {
  customer_id: {
    keyExpr: "customer_id",
    labelExpr: "customer_id",
  },
  product_id: {
    keyExpr: "product_id",
    labelExpr:
      "CASE WHEN product_description = '' OR product_description = '(blank)' OR LOWER(product_description) = LOWER(product_id) THEN product_id WHEN product_id = '' OR product_id = '(blank)' THEN product_description ELSE CONCAT(product_id, ' (', product_description, ')') END",
  },
  price_id: {
    keyExpr: "price_id",
    labelExpr:
      "CASE WHEN price_description = '' OR price_description = '(blank)' OR LOWER(price_description) = LOWER(price_id) THEN price_id WHEN price_id = '' OR price_id = '(blank)' THEN price_description ELSE CONCAT(price_id, ' (', price_description, ')') END",
  },
  subscription_id: {
    keyExpr: "subscription_id",
    labelExpr: "subscription_id",
  },
  subscription_item_id: {
    keyExpr: "subscription_item_id",
    labelExpr: "subscription_item_id",
  },
  event_type: {
    keyExpr: "event_type",
    labelExpr: "event_type",
  },
};

function normalizeStripeThroughMrrGroupBy(groupBy: string | undefined): StripeThroughMrrGroupBy {
  const candidate = String(groupBy || "").trim();
  if (candidate === "none") return "none";
  if (candidate in STRIPE_THROUGH_MRR_GROUP_BY_SQL) {
    return candidate as Exclude<StripeThroughMrrGroupBy, "none">;
  }
  return "none";
}

function normalizeStripeBillingOverviewGrain(grain: string | undefined): StripeBillingOverviewGrain {
  const candidate = String(grain || "").trim().toLowerCase();
  if (candidate === "daily") return "daily";
  if (candidate === "weekly") return "weekly";
  if (candidate === "quarterly") return "quarterly";
  return "monthly";
}

function buildStripeThroughMrrDetailBaseCte(table: string, productsTable: string) {
  return `
WITH source AS (
  SELECT
    event_timestamp,
    UPPER(CAST(event_type AS STRING)) AS event_type,
    CAST(COALESCE(mrr_change, 0) AS FLOAT64) / 100.0 AS mrr_change_major,
    TO_JSON_STRING(t) AS raw_json
  FROM \`${table}\` AS t
  WHERE
    LOWER(COALESCE(CAST(currency AS STRING), '')) = @target_currency
    AND event_timestamp >= TIMESTAMP(@detail_range_start_date)
    AND event_timestamp < TIMESTAMP(@detail_end_exclusive_date)
),
parsed AS (
  SELECT
    event_timestamp,
    event_type,
    mrr_change_major,
    COALESCE(NULLIF(TRIM(JSON_VALUE(raw_json, '$.customer_id')), ''), '(blank)') AS customer_id,
    COALESCE(
      NULLIF(TRIM(JSON_VALUE(raw_json, '$.subscription_id')), ''),
      '(blank)'
    ) AS subscription_id,
    COALESCE(
      NULLIF(TRIM(JSON_VALUE(raw_json, '$.subscription_item_id')), ''),
      NULLIF(TRIM(JSON_VALUE(raw_json, '$.subscription_item')), ''),
      '(blank)'
    ) AS subscription_item_id,
    COALESCE(
      NULLIF(TRIM(JSON_VALUE(raw_json, '$.price_id')), ''),
      NULLIF(TRIM(JSON_VALUE(raw_json, '$.price.id')), ''),
      NULLIF(TRIM(JSON_VALUE(raw_json, '$.price')), ''),
      '(blank)'
    ) AS price_id,
    COALESCE(
      NULLIF(TRIM(JSON_VALUE(raw_json, '$.product_id')), ''),
      NULLIF(TRIM(JSON_VALUE(raw_json, '$.product.id')), ''),
      NULLIF(TRIM(JSON_VALUE(raw_json, '$.product')), ''),
      '(blank)'
    ) AS product_id,
    COALESCE(
      NULLIF(TRIM(JSON_VALUE(raw_json, '$.price_nickname')), ''),
      NULLIF(TRIM(JSON_VALUE(raw_json, '$.price_description')), ''),
      NULLIF(TRIM(JSON_VALUE(raw_json, '$.price_name')), ''),
      NULLIF(TRIM(JSON_VALUE(raw_json, '$.price_display_name')), ''),
      NULLIF(TRIM(JSON_VALUE(raw_json, '$.price.nickname')), ''),
      NULLIF(TRIM(JSON_VALUE(raw_json, '$.price.name')), ''),
      NULLIF(TRIM(JSON_VALUE(raw_json, '$.price.lookup_key')), ''),
      NULLIF(TRIM(JSON_VALUE(raw_json, '$.price.product_name')), ''),
      '(blank)'
    ) AS price_description,
    COALESCE(
      NULLIF(TRIM(JSON_VALUE(raw_json, '$.product_name')), ''),
      NULLIF(TRIM(JSON_VALUE(raw_json, '$.product_description')), ''),
      NULLIF(TRIM(JSON_VALUE(raw_json, '$.product.name')), ''),
      NULLIF(TRIM(JSON_VALUE(raw_json, '$.product.display_name')), ''),
      NULLIF(TRIM(JSON_VALUE(raw_json, '$.product.nickname')), ''),
      ''
    ) AS product_description_event
  FROM source
) ,
products_lookup AS (
  SELECT
    COALESCE(NULLIF(TRIM(CAST(id AS STRING)), ''), '(blank)') AS product_id,
    COALESCE(
      NULLIF(TRIM(CAST(description AS STRING)), ''),
      NULLIF(TRIM(CAST(name AS STRING)), ''),
      '(blank)'
    ) AS product_description_table
  FROM \`${productsTable}\`
) ,
enriched AS (
  SELECT
    p.event_timestamp,
    p.event_type,
    p.mrr_change_major,
    p.customer_id,
    p.subscription_id,
    p.subscription_item_id,
    p.price_id,
    p.product_id,
    p.price_description,
    COALESCE(
      NULLIF(TRIM(pl.product_description_table), ''),
      NULLIF(TRIM(p.product_description_event), ''),
      '(blank)'
    ) AS product_description
  FROM parsed p
  LEFT JOIN products_lookup pl
    ON pl.product_id = p.product_id
)`;
}

export async function queryStripeThroughMrrReportFromBigQuery(
  request: StripeThroughMrrReportRequest,
  options?: StripeBigQueryOptions,
): Promise<StripeThroughMrrReportResult> {
  const startDate = parseIsoDateUtc(request.startDate);
  const endDate = parseIsoDateUtc(request.endDate);
  if (!startDate || !endDate) {
    throw new Error("Invalid startDate/endDate");
  }
  if (endDate.getTime() < startDate.getTime()) {
    throw new Error("endDate must be >= startDate");
  }

  const startMonth = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1, 0, 0, 0, 0));
  const endMonth = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1, 0, 0, 0, 0));
  let detailStartMonthDate = parseIsoMonthUtc(request.detailStartMonth) || startMonth;
  let detailEndMonthDate = parseIsoMonthUtc(request.detailEndMonth) || endMonth;
  if (detailStartMonthDate.getTime() < startMonth.getTime()) detailStartMonthDate = startMonth;
  if (detailStartMonthDate.getTime() > endMonth.getTime()) detailStartMonthDate = endMonth;
  if (detailEndMonthDate.getTime() < startMonth.getTime()) detailEndMonthDate = startMonth;
  if (detailEndMonthDate.getTime() > endMonth.getTime()) detailEndMonthDate = endMonth;
  if (detailStartMonthDate.getTime() > detailEndMonthDate.getTime()) {
    const swap = detailStartMonthDate;
    detailStartMonthDate = detailEndMonthDate;
    detailEndMonthDate = swap;
  }

  const endExclusiveDate = new Date(
    Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate() + 1, 0, 0, 0, 0),
  );
  const detailRangeStartDate = new Date(Math.max(startDate.getTime(), detailStartMonthDate.getTime()));
  const detailEndMonthNextStartDate = new Date(
    Date.UTC(detailEndMonthDate.getUTCFullYear(), detailEndMonthDate.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  );
  const detailEndExclusiveDate =
    detailEndMonthNextStartDate.getTime() < endExclusiveDate.getTime() ? detailEndMonthNextStartDate : endExclusiveDate;

  const startDateIso = startDate.toISOString().slice(0, 10);
  const endDateIso = endDate.toISOString().slice(0, 10);
  const endExclusiveDateIso = endExclusiveDate.toISOString().slice(0, 10);
  const detailRangeStartDateIso = detailRangeStartDate.toISOString().slice(0, 10);
  const detailEndExclusiveDateIso = detailEndExclusiveDate.toISOString().slice(0, 10);
  const detailStartMonth = isoMonthFromDateUtc(detailStartMonthDate);
  const detailEndMonth = isoMonthFromDateUtc(detailEndMonthDate);
  const groupBy = normalizeStripeThroughMrrGroupBy(request.groupBy);
  const targetCurrency = String(request.targetCurrency || "usd").trim().toLowerCase() || "usd";
  const pageSize = Math.max(1, Math.min(5000, Math.floor(asNumber(request.pageSize) || 1000)));
  const page = Math.max(1, Math.floor(asNumber(request.page) || 1));

  const profile = normalizeProfile(options?.profile);
  const sa = getServiceAccount(profile);
  const projectId = readEnv("BIGQUERY_PROJECT_ID", profile) || sa.project_id;
  if (!projectId) throw new Error("Missing BIGQUERY_PROJECT_ID (or project_id in service account JSON)");
  const location = readEnv("BIGQUERY_LOCATION", profile) || "US";
  const accessToken = await getAccessToken(sa);
  const table = getStripeArrCorrectMrrChangeTable();
  const productsTable = getStripeProductsTable(profile);

  const monthlySummaryQuery = `
WITH bounds AS (
  SELECT
    DATE(@start_date) AS range_start_date,
    DATE(@end_date) AS range_end_date,
    DATE(@end_exclusive_date) AS range_end_exclusive_date,
    DATE_TRUNC(DATE(@start_date), MONTH) AS first_month_start
),
months AS (
  SELECT
    month_start
  FROM bounds b
  CROSS JOIN UNNEST(GENERATE_DATE_ARRAY(b.first_month_start, DATE_TRUNC(b.range_end_date, MONTH), INTERVAL 1 MONTH)) AS month_start
),
base_before_first_month AS (
  SELECT
    COALESCE(SUM(CAST(COALESCE(mrr_change, 0) AS FLOAT64)) / 100.0, 0.0) AS base_mrr
  FROM \`${table}\` t
  CROSS JOIN bounds b
  WHERE
    LOWER(COALESCE(CAST(currency AS STRING), '')) = @target_currency
    AND event_timestamp < TIMESTAMP(b.first_month_start)
),
monthly_net AS (
  SELECT
    DATE_TRUNC(DATE(event_timestamp), MONTH) AS month_start,
    COALESCE(SUM(CAST(COALESCE(mrr_change, 0) AS FLOAT64)) / 100.0, 0.0) AS net_mrr_change
  FROM \`${table}\` t
  CROSS JOIN bounds b
  WHERE
    LOWER(COALESCE(CAST(currency AS STRING), '')) = @target_currency
    AND event_timestamp >= TIMESTAMP(b.first_month_start)
    AND event_timestamp < TIMESTAMP(b.range_end_exclusive_date)
  GROUP BY month_start
),
monthly_flow_in_range AS (
  SELECT
    DATE_TRUNC(DATE(event_timestamp), MONTH) AS month_start,
    COALESCE(SUM(IF(UPPER(CAST(event_type AS STRING)) = 'ACTIVE_START', CAST(COALESCE(mrr_change, 0) AS FLOAT64), 0.0)) / 100.0, 0.0) AS new_mrr,
    COALESCE(SUM(IF(UPPER(CAST(event_type AS STRING)) = 'ACTIVE_UPGRADE', CAST(COALESCE(mrr_change, 0) AS FLOAT64), 0.0)) / 100.0, 0.0) AS expansion_mrr,
    COALESCE(SUM(IF(UPPER(CAST(event_type AS STRING)) = 'ACTIVE_DOWNGRADE', CAST(COALESCE(mrr_change, 0) AS FLOAT64), 0.0)) / 100.0, 0.0) AS contraction_mrr,
    COALESCE(SUM(IF(UPPER(CAST(event_type AS STRING)) = 'ACTIVE_END', CAST(COALESCE(mrr_change, 0) AS FLOAT64), 0.0)) / 100.0, 0.0) AS churn_mrr,
    COALESCE(SUM(CAST(COALESCE(mrr_change, 0) AS FLOAT64)) / 100.0, 0.0) AS net_mrr_change
  FROM \`${table}\` t
  CROSS JOIN bounds b
  WHERE
    LOWER(COALESCE(CAST(currency AS STRING), '')) = @target_currency
    AND event_timestamp >= TIMESTAMP(b.range_start_date)
    AND event_timestamp < TIMESTAMP(b.range_end_exclusive_date)
  GROUP BY month_start
)
SELECT
  FORMAT_DATE('%Y-%m', m.month_start) AS month_key,
  FORMAT_DATE('%b %Y', m.month_start) AS month_label,
  ROUND(
    b.base_mrr + SUM(COALESCE(n.net_mrr_change, 0.0)) OVER (ORDER BY m.month_start ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),
    2
  ) AS month_end_mrr,
  ROUND(COALESCE(f.new_mrr, 0.0), 2) AS new_mrr,
  ROUND(COALESCE(f.expansion_mrr, 0.0), 2) AS expansion_mrr,
  ROUND(COALESCE(f.contraction_mrr, 0.0), 2) AS contraction_mrr,
  ROUND(COALESCE(f.churn_mrr, 0.0), 2) AS churn_mrr,
  ROUND(COALESCE(f.net_mrr_change, 0.0), 2) AS net_mrr_change
FROM months m
CROSS JOIN base_before_first_month b
LEFT JOIN monthly_net n
  ON n.month_start = m.month_start
LEFT JOIN monthly_flow_in_range f
  ON f.month_start = m.month_start
ORDER BY m.month_start
`;

  const totalMrrQuery = `
SELECT
  ROUND(COALESCE(SUM(CAST(COALESCE(mrr_change, 0) AS FLOAT64)) / 100.0, 0.0), 2) AS total_mrr
FROM \`${table}\`
WHERE
  LOWER(COALESCE(CAST(currency AS STRING), '')) = @target_currency
  AND event_timestamp < TIMESTAMP(@end_exclusive_date)
`;

  const baseParams: BigQueryNamedParameter[] = [
    { name: "target_currency", type: "STRING", value: targetCurrency },
    { name: "start_date", type: "STRING", value: startDateIso },
    { name: "end_date", type: "STRING", value: endDateIso },
    { name: "end_exclusive_date", type: "STRING", value: endExclusiveDateIso },
  ];

  const [monthlySummaryRows, totalMrrRows] = await Promise.all([
    runBigQueryQueryRows(accessToken, projectId, location, monthlySummaryQuery, baseParams),
    runBigQueryQueryRows(accessToken, projectId, location, totalMrrQuery, [
      { name: "target_currency", type: "STRING", value: targetCurrency },
      { name: "end_exclusive_date", type: "STRING", value: endExclusiveDateIso },
    ]),
  ]);

  const months: StripeThroughMrrMonthlyRow[] = monthlySummaryRows.map((row) => ({
    monthKey: asString(row.month_key),
    monthLabel: asString(row.month_label),
    monthEndMrr: asNumber(row.month_end_mrr),
    newMrr: asNumber(row.new_mrr),
    expansionMrr: asNumber(row.expansion_mrr),
    contractionMrr: asNumber(row.contraction_mrr),
    churnMrr: asNumber(row.churn_mrr),
    netMrrChange: asNumber(row.net_mrr_change),
  }));
  const totalMrr = asNumber((totalMrrRows[0] || {}).total_mrr);

  const detailBaseCte = buildStripeThroughMrrDetailBaseCte(table, productsTable);
  const detailBaseParams: BigQueryNamedParameter[] = [
    { name: "target_currency", type: "STRING", value: targetCurrency },
    { name: "detail_range_start_date", type: "STRING", value: detailRangeStartDateIso },
    { name: "detail_end_exclusive_date", type: "STRING", value: detailEndExclusiveDateIso },
  ];

  let totalRows = 0;
  let detailRowsRaw: Record<string, unknown>[] = [];
  if (groupBy === "none") {
    const countQuery = `${detailBaseCte}
SELECT
  COUNT(*) AS total_rows
FROM enriched`;
    const countRows = await runBigQueryQueryRows(accessToken, projectId, location, countQuery, detailBaseParams);
    totalRows = asInt((countRows[0] || {}).total_rows);
    const totalPages = totalRows > 0 ? Math.ceil(totalRows / pageSize) : 1;
    const clampedPage = Math.min(page, totalPages);
    const offsetRows = (clampedPage - 1) * pageSize;
    if (totalRows > 0) {
      const rowsQuery = `${detailBaseCte}
SELECT
  FORMAT_TIMESTAMP('%Y-%m-%d %H:%M:%S', event_timestamp, 'UTC') AS event_timestamp_utc,
  event_type,
  ROUND(mrr_change_major, 2) AS mrr_change,
  customer_id,
  subscription_id,
  subscription_item_id,
  product_id,
  product_description,
  price_id,
  price_description
FROM enriched
ORDER BY event_timestamp DESC, subscription_item_id DESC, price_id DESC
LIMIT @limit_rows
OFFSET @offset_rows`;
      detailRowsRaw = await runBigQueryQueryRows(accessToken, projectId, location, rowsQuery, [
        ...detailBaseParams,
        { name: "limit_rows", type: "INT64", value: String(pageSize) },
        { name: "offset_rows", type: "INT64", value: String(offsetRows) },
      ]);
    }
  } else {
    const groupSql = STRIPE_THROUGH_MRR_GROUP_BY_SQL[groupBy];
    const countQuery = `${detailBaseCte}
, grouped_source AS (
  SELECT
    ${groupSql.keyExpr} AS group_key,
    ${groupSql.labelExpr} AS group_label,
    event_timestamp,
    event_type,
    mrr_change_major
  FROM enriched
),
group_totals AS (
  SELECT
    group_key,
    group_label,
    ROUND(COALESCE(SUM(mrr_change_major), 0.0), 2) AS net_mrr_change
  FROM grouped_source
  GROUP BY group_key, group_label
)
SELECT
  COUNT(*) AS total_rows
FROM group_totals`;
    const countRows = await runBigQueryQueryRows(accessToken, projectId, location, countQuery, detailBaseParams);
    totalRows = asInt((countRows[0] || {}).total_rows);
    const totalPages = totalRows > 0 ? Math.ceil(totalRows / pageSize) : 1;
    const clampedPage = Math.min(page, totalPages);
    const offsetRows = (clampedPage - 1) * pageSize;
    if (totalRows > 0) {
      const rowsQuery = `${detailBaseCte}
, grouped_source AS (
  SELECT
    ${groupSql.keyExpr} AS group_key,
    ${groupSql.labelExpr} AS group_label,
    event_timestamp,
    event_type,
    mrr_change_major
  FROM enriched
),
group_totals AS (
  SELECT
    group_key,
    group_label,
    ROUND(COALESCE(SUM(mrr_change_major), 0.0), 2) AS net_mrr_change
  FROM grouped_source
  GROUP BY group_key, group_label
),
paged_groups AS (
  SELECT
    group_key,
    group_label,
    net_mrr_change
  FROM group_totals
  ORDER BY net_mrr_change DESC, group_label ASC
  LIMIT @limit_rows
  OFFSET @offset_rows
)
SELECT
  pg.group_key,
  pg.group_label,
  FORMAT_DATE('%Y-%m', DATE_TRUNC(DATE(gs.event_timestamp), MONTH)) AS month_key,
  FORMAT_DATE('%b %Y', DATE_TRUNC(DATE(gs.event_timestamp), MONTH)) AS month_label,
  COUNT(*) AS event_count,
  ROUND(COALESCE(SUM(gs.mrr_change_major), 0.0), 2) AS net_mrr_change,
  ROUND(COALESCE(SUM(IF(gs.event_type = 'ACTIVE_START', gs.mrr_change_major, 0.0)), 0.0), 2) AS new_mrr,
  ROUND(COALESCE(SUM(IF(gs.event_type = 'ACTIVE_UPGRADE', gs.mrr_change_major, 0.0)), 0.0), 2) AS expansion_mrr,
  ROUND(COALESCE(SUM(IF(gs.event_type = 'ACTIVE_DOWNGRADE', gs.mrr_change_major, 0.0)), 0.0), 2) AS contraction_mrr,
  ROUND(COALESCE(SUM(IF(gs.event_type = 'ACTIVE_END', gs.mrr_change_major, 0.0)), 0.0), 2) AS churn_mrr
FROM paged_groups pg
LEFT JOIN grouped_source gs
  ON gs.group_key = pg.group_key
  AND gs.group_label = pg.group_label
GROUP BY
  pg.group_key,
  pg.group_label,
  pg.net_mrr_change,
  DATE_TRUNC(DATE(gs.event_timestamp), MONTH)
HAVING DATE_TRUNC(DATE(gs.event_timestamp), MONTH) IS NOT NULL
ORDER BY pg.net_mrr_change DESC, pg.group_label ASC, DATE_TRUNC(DATE(gs.event_timestamp), MONTH) ASC`;
      detailRowsRaw = await runBigQueryQueryRows(accessToken, projectId, location, rowsQuery, [
        ...detailBaseParams,
        { name: "limit_rows", type: "INT64", value: String(pageSize) },
        { name: "offset_rows", type: "INT64", value: String(offsetRows) },
      ]);
    }
  }

  const detailMode: "raw" | "grouped" = groupBy === "none" ? "raw" : "grouped";
  const totalPages = totalRows > 0 ? Math.ceil(totalRows / pageSize) : 1;
  const clampedPage = Math.min(page, totalPages);
  const detailRows: Array<StripeThroughMrrRawDetailRow | StripeThroughMrrGroupedDetailRow> =
    detailMode === "raw"
      ? detailRowsRaw.map((row) => ({
          eventTimestampUtc: asString(row.event_timestamp_utc),
          eventType: asString(row.event_type),
          mrrChange: asNumber(row.mrr_change),
          customerId: asString(row.customer_id),
          subscriptionId: asString(row.subscription_id),
          subscriptionItemId: asString(row.subscription_item_id),
          productId: asString(row.product_id),
          productDescription: asString(row.product_description),
          priceId: asString(row.price_id),
          priceDescription: asString(row.price_description),
        }))
      : detailRowsRaw.map((row) => ({
          groupKey: asString(row.group_key),
          groupLabel: asString(row.group_label),
          monthKey: asString(row.month_key),
          monthLabel: asString(row.month_label),
          eventCount: asInt(row.event_count),
          netMrrChange: asNumber(row.net_mrr_change),
          newMrr: asNumber(row.new_mrr),
          expansionMrr: asNumber(row.expansion_mrr),
          contractionMrr: asNumber(row.contraction_mrr),
          churnMrr: asNumber(row.churn_mrr),
        }));

  return {
    startDate: startDateIso,
    endDate: endDateIso,
    detailStartMonth,
    detailEndMonth,
    groupBy,
    targetCurrency: targetCurrency.toUpperCase(),
    totalMrr,
    months,
    detailRows,
    detailMode,
    pagination: {
      page: clampedPage,
      pageSize,
      returnedRows: detailRows.length,
      totalRows,
      totalPages,
      hasMore: clampedPage < totalPages,
    },
  };
}

export async function queryStripeBillingOverviewFromBigQuery(
  request: StripeBillingOverviewRequest,
  options?: StripeBigQueryOptions,
): Promise<StripeBillingOverviewResult> {
  const startDate = parseIsoDateUtc(request.startDate);
  const endDate = parseIsoDateUtc(request.endDate);
  if (!startDate || !endDate) {
    throw new Error("Invalid startDate/endDate");
  }
  if (endDate.getTime() < startDate.getTime()) {
    throw new Error("endDate must be >= startDate");
  }

  const startDateIso = startDate.toISOString().slice(0, 10);
  const endDateIso = endDate.toISOString().slice(0, 10);
  const grain = normalizeStripeBillingOverviewGrain(request.grain);
  const targetCurrency = String(request.targetCurrency || "usd").trim().toLowerCase() || "usd";

  const profile = normalizeProfile(options?.profile);
  const sa = getServiceAccount(profile);
  const projectId = readEnv("BIGQUERY_PROJECT_ID", profile) || sa.project_id;
  if (!projectId) throw new Error("Missing BIGQUERY_PROJECT_ID (or project_id in service account JSON)");
  const location = readEnv("BIGQUERY_LOCATION", profile) || "US";
  const accessToken = await getAccessToken(sa);
  const table = getStripeArrCorrectMrrChangeTable();

  const pointsQuery = `
WITH bounds AS (
  SELECT
    DATE(@start_date) AS requested_start_date,
    DATE(@end_date) AS requested_end_date,
    DATE_ADD(DATE(@end_date), INTERVAL 1 DAY) AS requested_end_exclusive_date,
    CASE
      WHEN @grain = 'daily' THEN DATE_SUB(DATE(@start_date), INTERVAL 90 DAY)
      WHEN @grain = 'weekly' THEN DATE_SUB(DATE(@start_date), INTERVAL 13 WEEK)
      WHEN @grain = 'monthly' THEN DATE_SUB(DATE(@start_date), INTERVAL 3 MONTH)
      ELSE DATE_SUB(DATE(@start_date), INTERVAL 3 MONTH)
    END AS series_start_date
),
bucket_candidates AS (
  SELECT
    d AS bucket_start,
    DATE_ADD(d, INTERVAL 1 DAY) AS bucket_end_exclusive_raw
  FROM bounds b
  CROSS JOIN UNNEST(GENERATE_DATE_ARRAY(b.series_start_date, b.requested_end_date, INTERVAL 1 DAY)) AS d
  WHERE @grain = 'daily'

  UNION ALL

  SELECT
    d AS bucket_start,
    DATE_ADD(d, INTERVAL 1 WEEK) AS bucket_end_exclusive_raw
  FROM bounds b
  CROSS JOIN UNNEST(
    GENERATE_DATE_ARRAY(
      DATE_TRUNC(b.series_start_date, WEEK(MONDAY)),
      DATE_TRUNC(b.requested_end_date, WEEK(MONDAY)),
      INTERVAL 1 WEEK
    )
  ) AS d
  WHERE @grain = 'weekly'

  UNION ALL

  SELECT
    d AS bucket_start,
    DATE_ADD(d, INTERVAL 1 MONTH) AS bucket_end_exclusive_raw
  FROM bounds b
  CROSS JOIN UNNEST(
    GENERATE_DATE_ARRAY(
      DATE_TRUNC(b.series_start_date, MONTH),
      DATE_TRUNC(b.requested_end_date, MONTH),
      INTERVAL 1 MONTH
    )
  ) AS d
  WHERE @grain = 'monthly'

  UNION ALL

  SELECT
    d AS bucket_start,
    DATE_ADD(d, INTERVAL 3 MONTH) AS bucket_end_exclusive_raw
  FROM bounds b
  CROSS JOIN UNNEST(
    GENERATE_DATE_ARRAY(
      DATE_TRUNC(b.series_start_date, QUARTER),
      DATE_TRUNC(b.requested_end_date, QUARTER),
      INTERVAL 3 MONTH
    )
  ) AS d
  WHERE @grain = 'quarterly'
),
buckets AS (
  SELECT
    bc.bucket_start,
    GREATEST(bc.bucket_start, b.series_start_date) AS effective_start,
    LEAST(bc.bucket_end_exclusive_raw, b.requested_end_exclusive_date) AS effective_end_exclusive
  FROM bucket_candidates bc
  CROSS JOIN bounds b
  WHERE GREATEST(bc.bucket_start, b.series_start_date) < LEAST(bc.bucket_end_exclusive_raw, b.requested_end_exclusive_date)
),
events_base AS (
  SELECT
    event_timestamp,
    COALESCE(NULLIF(TRIM(CAST(customer_id AS STRING)), ''), '(blank)') AS customer_id,
    CAST(COALESCE(mrr_change, 0) AS FLOAT64) / 100.0 AS mrr_change_major
  FROM \`${table}\` AS t
  CROSS JOIN bounds b
  WHERE
    LOWER(COALESCE(CAST(currency AS STRING), '')) = @target_currency
    AND event_timestamp < TIMESTAMP(b.requested_end_exclusive_date)
),
events_in_series AS (
  SELECT
    event_timestamp,
    customer_id,
    mrr_change_major
  FROM events_base e
  CROSS JOIN bounds b
  WHERE
    e.event_timestamp >= TIMESTAMP(b.series_start_date)
    AND e.event_timestamp < TIMESTAMP(b.requested_end_exclusive_date)
),
base_before_series_total AS (
  SELECT
    COALESCE(SUM(e.mrr_change_major), 0.0) AS base_mrr
  FROM events_base e
  CROSS JOIN bounds b
  WHERE
    e.event_timestamp < TIMESTAMP(b.series_start_date)
),
base_before_series_by_customer AS (
  SELECT
    e.customer_id,
    COALESCE(SUM(e.mrr_change_major), 0.0) AS base_mrr
  FROM events_base e
  CROSS JOIN bounds b
  WHERE e.event_timestamp < TIMESTAMP(b.series_start_date)
  GROUP BY e.customer_id
),
customer_bucket_changes AS (
  SELECT
    bu.bucket_start,
    bu.effective_start,
    bu.effective_end_exclusive,
    e.customer_id,
    COALESCE(SUM(e.mrr_change_major), 0.0) AS delta_mrr
  FROM buckets bu
  JOIN events_in_series e
    ON e.event_timestamp >= TIMESTAMP(bu.effective_start)
    AND e.event_timestamp < TIMESTAMP(bu.effective_end_exclusive)
  GROUP BY
    bu.bucket_start,
    bu.effective_start,
    bu.effective_end_exclusive,
    e.customer_id
),
customer_bucket_transitions AS (
  SELECT
    cbc.bucket_start,
    cbc.effective_start,
    cbc.effective_end_exclusive,
    cbc.customer_id,
    COALESCE(base.base_mrr, 0.0)
      + COALESCE(
        SUM(cbc.delta_mrr) OVER (
          PARTITION BY cbc.customer_id
          ORDER BY cbc.bucket_start
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ),
        0.0
      ) AS mrr_start,
    COALESCE(base.base_mrr, 0.0)
      + SUM(cbc.delta_mrr) OVER (
        PARTITION BY cbc.customer_id
        ORDER BY cbc.bucket_start
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS mrr_end,
    cbc.delta_mrr AS net_mrr_change
  FROM customer_bucket_changes cbc
  LEFT JOIN base_before_series_by_customer base
    ON base.customer_id = cbc.customer_id
),
bucket_transition_sums AS (
  SELECT
    cbt.bucket_start,
    COALESCE(
      SUM(
        CASE
          WHEN ABS(cbt.mrr_start) <= 1e-9 AND ABS(cbt.mrr_end) > 1e-9
          THEN cbt.net_mrr_change
          ELSE 0.0
        END
      ),
      0.0
    ) AS new_mrr,
    COALESCE(
      SUM(
        CASE
          WHEN ABS(cbt.mrr_start) > 1e-9 AND ABS(cbt.mrr_end) > 1e-9 AND cbt.mrr_end > cbt.mrr_start
          THEN cbt.net_mrr_change
          ELSE 0.0
        END
      ),
      0.0
    ) AS expansion_mrr,
    COALESCE(
      SUM(
        CASE
          WHEN ABS(cbt.mrr_start) > 1e-9 AND ABS(cbt.mrr_end) > 1e-9 AND cbt.mrr_end < cbt.mrr_start
          THEN cbt.net_mrr_change
          ELSE 0.0
        END
      ),
      0.0
    ) AS contraction_mrr,
    COALESCE(
      SUM(
        CASE
          WHEN ABS(cbt.mrr_start) > 1e-9 AND ABS(cbt.mrr_end) <= 1e-9
          THEN cbt.net_mrr_change
          ELSE 0.0
        END
      ),
      0.0
    ) AS churn_mrr
  FROM customer_bucket_transitions cbt
  GROUP BY cbt.bucket_start
),
bucket_net AS (
  SELECT
    cbc.bucket_start,
    COALESCE(SUM(cbc.delta_mrr), 0.0) AS net_mrr_change
  FROM customer_bucket_changes cbc
  GROUP BY cbc.bucket_start
),
bucket_flows AS (
  SELECT
    bu.bucket_start,
    bu.effective_start,
    bu.effective_end_exclusive,
    COALESCE(bts.new_mrr, 0.0) AS new_mrr,
    COALESCE(bts.expansion_mrr, 0.0) AS expansion_mrr,
    COALESCE(bts.contraction_mrr, 0.0) AS contraction_mrr,
    COALESCE(bts.churn_mrr, 0.0) AS churn_mrr,
    COALESCE(bn.net_mrr_change, 0.0) AS net_mrr_change
  FROM buckets bu
  LEFT JOIN bucket_transition_sums bts
    ON bts.bucket_start = bu.bucket_start
  LEFT JOIN bucket_net bn
    ON bn.bucket_start = bu.bucket_start
),
series AS (
  SELECT
    bf.bucket_start,
    bf.effective_start,
    DATE_SUB(bf.effective_end_exclusive, INTERVAL 1 DAY) AS effective_end,
    bf.new_mrr,
    bf.expansion_mrr,
    bf.contraction_mrr,
    bf.churn_mrr,
    bf.net_mrr_change,
    base.base_mrr + SUM(bf.net_mrr_change) OVER (
      ORDER BY bf.bucket_start
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS mrr_end
  FROM bucket_flows bf
  CROSS JOIN base_before_series_total base
)
SELECT
  CASE
    WHEN @grain = 'quarterly'
    THEN CONCAT(CAST(EXTRACT(YEAR FROM bucket_start) AS STRING), '-Q', CAST(EXTRACT(QUARTER FROM bucket_start) AS STRING))
    ELSE FORMAT_DATE('%Y-%m-%d', effective_start)
  END AS period_key,
  CASE
    WHEN @grain = 'daily' THEN FORMAT_DATE('%Y-%m-%d', effective_start)
    WHEN @grain = 'weekly' THEN CONCAT('Week of ', FORMAT_DATE('%Y-%m-%d', effective_start))
    WHEN @grain = 'monthly' THEN FORMAT_DATE('%b %Y', bucket_start)
    ELSE CONCAT('Q', CAST(EXTRACT(QUARTER FROM bucket_start) AS STRING), ' ', CAST(EXTRACT(YEAR FROM bucket_start) AS STRING))
  END AS period_label,
  FORMAT_DATE('%Y-%m-%d', effective_start) AS period_start,
  FORMAT_DATE('%Y-%m-%d', effective_end) AS period_end,
  ROUND(mrr_end, 2) AS mrr_end,
  ROUND(new_mrr, 2) AS new_mrr,
  ROUND(expansion_mrr, 2) AS expansion_mrr,
  ROUND(contraction_mrr, 2) AS contraction_mrr,
  ROUND(churn_mrr, 2) AS churn_mrr,
  ROUND(net_mrr_change, 2) AS net_mrr_change,
  ROUND(
    COALESCE(
      SAFE_DIVIDE(
        mrr_end - LAG(mrr_end) OVER (ORDER BY bucket_start),
        NULLIF(ABS(LAG(mrr_end) OVER (ORDER BY bucket_start)), 0.0)
      ) * 100.0,
      0.0
    ),
    2
  ) AS mrr_growth_rate_pct,
  ROUND(mrr_end * 12.0, 2) AS arr,
  ROUND(
    COALESCE(
      (mrr_end * 12.0) - LAG(mrr_end * 12.0) OVER (ORDER BY bucket_start),
      0.0
    ),
    2
  ) AS arr_growth
FROM series
ORDER BY bucket_start
`;

  const customerArrQuery = `
WITH bounds AS (
  SELECT
    DATE(@start_date) AS requested_start_date,
    DATE(@end_date) AS requested_end_date,
    DATE_ADD(DATE(@end_date), INTERVAL 1 DAY) AS requested_end_exclusive_date
),
requested_bucket_candidates AS (
  SELECT
    d AS bucket_start,
    DATE_ADD(d, INTERVAL 1 DAY) AS bucket_end_exclusive_raw
  FROM bounds b
  CROSS JOIN UNNEST(GENERATE_DATE_ARRAY(b.requested_start_date, b.requested_end_date, INTERVAL 1 DAY)) AS d
  WHERE @grain = 'daily'

  UNION ALL

  SELECT
    d AS bucket_start,
    DATE_ADD(d, INTERVAL 1 WEEK) AS bucket_end_exclusive_raw
  FROM bounds b
  CROSS JOIN UNNEST(
    GENERATE_DATE_ARRAY(
      DATE_TRUNC(b.requested_start_date, WEEK(MONDAY)),
      DATE_TRUNC(b.requested_end_date, WEEK(MONDAY)),
      INTERVAL 1 WEEK
    )
  ) AS d
  WHERE @grain = 'weekly'

  UNION ALL

  SELECT
    d AS bucket_start,
    DATE_ADD(d, INTERVAL 1 MONTH) AS bucket_end_exclusive_raw
  FROM bounds b
  CROSS JOIN UNNEST(
    GENERATE_DATE_ARRAY(
      DATE_TRUNC(b.requested_start_date, MONTH),
      DATE_TRUNC(b.requested_end_date, MONTH),
      INTERVAL 1 MONTH
    )
  ) AS d
  WHERE @grain = 'monthly'

  UNION ALL

  SELECT
    d AS bucket_start,
    DATE_ADD(d, INTERVAL 3 MONTH) AS bucket_end_exclusive_raw
  FROM bounds b
  CROSS JOIN UNNEST(
    GENERATE_DATE_ARRAY(
      DATE_TRUNC(b.requested_start_date, QUARTER),
      DATE_TRUNC(b.requested_end_date, QUARTER),
      INTERVAL 3 MONTH
    )
  ) AS d
  WHERE @grain = 'quarterly'
),
requested_buckets AS (
  SELECT
    bc.bucket_start,
    GREATEST(bc.bucket_start, b.requested_start_date) AS effective_start,
    LEAST(bc.bucket_end_exclusive_raw, b.requested_end_exclusive_date) AS effective_end_exclusive
  FROM requested_bucket_candidates bc
  CROSS JOIN bounds b
  WHERE GREATEST(bc.bucket_start, b.requested_start_date) < LEAST(bc.bucket_end_exclusive_raw, b.requested_end_exclusive_date)
),
first_requested_bucket AS (
  SELECT MIN(bucket_start) AS first_bucket_start
  FROM requested_buckets
),
events_base AS (
  SELECT
    event_timestamp,
    COALESCE(NULLIF(TRIM(CAST(customer_id AS STRING)), ''), '(blank)') AS customer_id,
    CAST(COALESCE(mrr_change, 0) AS FLOAT64) / 100.0 AS mrr_change_major
  FROM \`${table}\` AS t
  CROSS JOIN bounds b
  WHERE
    LOWER(COALESCE(CAST(currency AS STRING), '')) = @target_currency
    AND event_timestamp < TIMESTAMP(b.requested_end_exclusive_date)
),
events_before_requested AS (
  SELECT
    e.customer_id,
    COALESCE(SUM(e.mrr_change_major), 0.0) AS start_mrr
  FROM events_base e
  CROSS JOIN bounds b
  WHERE e.event_timestamp < TIMESTAMP(b.requested_start_date)
  GROUP BY e.customer_id
),
events_in_requested AS (
  SELECT
    e.event_timestamp,
    e.customer_id,
    e.mrr_change_major
  FROM events_base e
  CROSS JOIN bounds b
  WHERE e.event_timestamp >= TIMESTAMP(b.requested_start_date)
),
requested_bucket_changes AS (
  SELECT
    rb.bucket_start,
    er.customer_id,
    COALESCE(SUM(er.mrr_change_major), 0.0) AS delta_mrr
  FROM requested_buckets rb
  JOIN events_in_requested er
    ON er.event_timestamp >= TIMESTAMP(rb.effective_start)
    AND er.event_timestamp < TIMESTAMP(rb.effective_end_exclusive)
  GROUP BY
    rb.bucket_start,
    er.customer_id
),
customer_seed_rows AS (
  SELECT
    eb.customer_id,
    fb.first_bucket_start AS bucket_start,
    0.0 AS delta_mrr
  FROM events_before_requested eb
  CROSS JOIN first_requested_bucket fb
  WHERE ABS(eb.start_mrr) > 1e-9
    AND fb.first_bucket_start IS NOT NULL
),
customer_bucket_deltas AS (
  SELECT
    combined.customer_id,
    combined.bucket_start,
    COALESCE(SUM(combined.delta_mrr), 0.0) AS delta_mrr
  FROM (
    SELECT
      rbc.customer_id,
      rbc.bucket_start,
      rbc.delta_mrr
    FROM requested_bucket_changes rbc
    UNION ALL
    SELECT
      csr.customer_id,
      csr.bucket_start,
      csr.delta_mrr
    FROM customer_seed_rows csr
  ) AS combined
  GROUP BY combined.customer_id, combined.bucket_start
),
customer_bucket_snapshots AS (
  SELECT
    cbd.customer_id,
    cbd.bucket_start,
    COALESCE(ebr.start_mrr, 0.0)
      + SUM(cbd.delta_mrr) OVER (
        PARTITION BY cbd.customer_id
        ORDER BY cbd.bucket_start
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS mrr_end
  FROM customer_bucket_deltas cbd
  LEFT JOIN events_before_requested ebr
    ON ebr.customer_id = cbd.customer_id
)
SELECT
  cbt.customer_id,
  CASE
    WHEN @grain = 'quarterly'
    THEN CONCAT(CAST(EXTRACT(YEAR FROM rb.bucket_start) AS STRING), '-Q', CAST(EXTRACT(QUARTER FROM rb.bucket_start) AS STRING))
    ELSE FORMAT_DATE('%Y-%m-%d', rb.effective_start)
  END AS period_key,
  CASE
    WHEN @grain = 'daily' THEN FORMAT_DATE('%Y-%m-%d', rb.effective_start)
    WHEN @grain = 'weekly' THEN CONCAT('Week of ', FORMAT_DATE('%Y-%m-%d', rb.effective_start))
    WHEN @grain = 'monthly' THEN FORMAT_DATE('%b %Y', rb.bucket_start)
    ELSE CONCAT('Q', CAST(EXTRACT(QUARTER FROM rb.bucket_start) AS STRING), ' ', CAST(EXTRACT(YEAR FROM rb.bucket_start) AS STRING))
  END AS period_label,
  FORMAT_DATE('%Y-%m-%d', rb.effective_start) AS period_start,
  FORMAT_DATE('%Y-%m-%d', DATE_SUB(rb.effective_end_exclusive, INTERVAL 1 DAY)) AS period_end,
  ROUND(cbt.mrr_end * 12.0, 2) AS arr
FROM customer_bucket_snapshots cbt
JOIN requested_buckets rb
  ON rb.bucket_start = cbt.bucket_start
ORDER BY cbt.customer_id ASC, cbt.bucket_start ASC
`;

  const params: BigQueryNamedParameter[] = [
    { name: "start_date", type: "STRING", value: startDateIso },
    { name: "end_date", type: "STRING", value: endDateIso },
    { name: "grain", type: "STRING", value: grain },
    { name: "target_currency", type: "STRING", value: targetCurrency },
  ];

  const [pointRows, customerArrRawRows] = await Promise.all([
    runBigQueryQueryRows(accessToken, projectId, location, pointsQuery, params),
    runBigQueryQueryRows(accessToken, projectId, location, customerArrQuery, params),
  ]);

  const allPoints: StripeBillingOverviewPoint[] = pointRows.map((row) => ({
    key: asString(row.period_key),
    label: asString(row.period_label),
    periodStart: asString(row.period_start),
    periodEnd: asString(row.period_end),
    mrrEnd: asNumber(row.mrr_end),
    newMrr: asNumber(row.new_mrr),
    expansionMrr: asNumber(row.expansion_mrr),
    contractionMrr: asNumber(row.contraction_mrr),
    churnMrr: asNumber(row.churn_mrr),
    netMrrChange: asNumber(row.net_mrr_change),
    mrrGrowthRatePct: asNumber(row.mrr_growth_rate_pct),
    arr: asNumber(row.arr),
    arrGrowth: asNumber(row.arr_growth),
  }));
  const customerArrRows: StripeBillingOverviewCustomerArrRow[] = customerArrRawRows.map((row) => ({
    customerId: asString(row.customer_id),
    periodKey: asString(row.period_key),
    periodLabel: asString(row.period_label),
    periodStart: asString(row.period_start),
    periodEnd: asString(row.period_end),
    arr: asNumber(row.arr),
  }));

  const historyPoints = allPoints.filter((point) => point.periodStart < startDateIso);
  const points = allPoints.filter((point) => point.periodStart >= startDateIso && point.periodStart <= endDateIso);
  const currentMrr = points.length ? points[points.length - 1].mrrEnd : 0;
  return {
    startDate: startDateIso,
    endDate: endDateIso,
    grain,
    targetCurrency: targetCurrency.toUpperCase(),
    currentMrr,
    currentArr: Math.round(currentMrr * 12 * 100) / 100,
    historyPoints,
    points,
    customerArrRows,
  };
}

export async function loadStripeLineItemsFromBigQuery(
  startTsMs: number,
  endTsMs: number,
  filters?: StripeBigQueryFilters,
  options?: StripeBigQueryOptions,
): Promise<SyncedStripeLineItem[]> {
  const profile = normalizeProfile(options?.profile);
  const sa = getServiceAccount(profile);
  const projectId = readEnv("BIGQUERY_PROJECT_ID", profile) || sa.project_id;
  if (!projectId) throw new Error("Missing BIGQUERY_PROJECT_ID (or project_id in service account JSON)");

  const sourceConfig = getBigQuerySourceConfig(profile);
  const location = readEnv("BIGQUERY_LOCATION", profile) || "US";
  const rangeStart = toQueryTimestamp(startTsMs, sourceConfig);
  const rangeEnd = toQueryTimestamp(endTsMs, sourceConfig);

  const accessToken = await getAccessToken(sa);
  const built = sourceConfig.servingTable
    ? sourceConfig.servingSchemaMode === "int"
      ? buildServingQueryIntColumns(sourceConfig.servingTable, filters)
      : buildServingQueryTimestampColumns(sourceConfig.servingTable, filters)
    : { query: buildQuery(sourceConfig.table), filterParams: [] as BigQueryNamedParameter[] };
  const query = built.query;
  const extraParams = built.filterParams;
  const queryParams: BigQueryNamedParameter[] = [
    { name: "range_start_ts", type: "INT64", value: String(rangeStart) },
    { name: "range_end_ts", type: "INT64", value: String(rangeEnd) },
    ...extraParams,
  ];

  const out: SyncedStripeLineItem[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;

  while (true) {
    let json = await fetchBigQueryResultsPage(
      accessToken,
      projectId,
      location,
      query,
      queryParams,
      pageToken,
    );
    if (!json.jobComplete && json.jobReference?.jobId) {
      const jobProjectId = json.jobReference.projectId || projectId;
      const jobLocation = json.jobReference.location || location;
      json = await waitForJobCompletion(accessToken, jobProjectId, json.jobReference.jobId, jobLocation);
    }

    const fields = (json.schema?.fields || []).map((f) => f.name);
    for (const row of json.rows || []) {
      const obj = rowToObject(fields, row);
      const item = mapBigQueryRowToSyncedItem(obj, sourceConfig.tsMultiplier);
      const dedupeKey = [
        item.invoiceId,
        item.lineItemId,
        String(item.periodStartTs),
        String(item.periodEndTs),
        String(item.amountMinor),
      ].join("|");
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push(item);
    }

    if (!json.pageToken) break;
    pageToken = json.pageToken;
  }

  return out;
}
