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

export type StripeBigQueryReportPageResult = StripeBigQueryReportBase & {
  page: number;
  totalPages: number;
};

type BigQueryNamedParameter = {
  name: string;
  type: "INT64" | "STRING";
  value: string;
};

const TOKEN_AUDIENCE = "https://oauth2.googleapis.com/token";
const BQ_SCOPE = "https://www.googleapis.com/auth/bigquery";
const BQ_MAX_RESULTS = Number(process.env.BIGQUERY_MAX_RESULTS || "50000");

function base64Url(input: Buffer | string) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return b.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getServiceAccount(): ServiceAccount {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const rawB64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;

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
  CAST(UNIX_MILLIS(period_start) AS INT64) AS invoice_created_ts
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
  CAST(invoice_created_ts AS INT64) AS invoice_created_ts
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
  CAST(UNIX_MILLIS(COALESCE(invoice_created_ts, period_start_ts)) AS INT64) AS invoice_created_ts
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
  CAST(COALESCE(invoice_created_ts, period_start_ts) AS INT64) AS invoice_created_ts
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

function getBigQuerySourceConfig(): BigQuerySourceConfig {
  const table = mustEnv("BIGQUERY_STRIPE_TABLE");
  const servingTable = (process.env.BIGQUERY_STRIPE_SERVING_TABLE || "").trim();
  const servingSchemaMode = (process.env.BIGQUERY_SERVING_SCHEMA_MODE || "int").toLowerCase();
  const schemaMode = servingTable ? "int_ts" : (process.env.BIGQUERY_SCHEMA_MODE || "int_ts").toLowerCase();
  const tsUnit = servingTable
    ? (process.env.BIGQUERY_SERVING_TS_UNIT || "milliseconds").toLowerCase()
    : (process.env.BIGQUERY_TS_UNIT || "milliseconds").toLowerCase();
  const tsMultiplier = schemaMode === "timestamp" ? 1 : tsUnit === "seconds" ? 1000 : 1;
  return { table, servingTable, servingSchemaMode, schemaMode, tsUnit, tsMultiplier };
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
  CAST(COALESCE(invoice_created_ts, period_start_ts) AS INT64) AS invoice_created_ts
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
  CAST(UNIX_MILLIS(COALESCE(invoice_created_ts, period_start_ts)) AS INT64) AS invoice_created_ts
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
): BuiltStripeBigQueryReport {
  const rawSourceQuery = buildRawSourceQuery(sourceConfig);
  const groupByFields = normalizeGroupByFields(request.groupByFields);
  const rawDescriptionExpr =
    "COALESCE(NULLIF(TRIM(CAST(line_item_description AS STRING)), ''), NULLIF(TRIM(CAST(line_item_id AS STRING)), ''), '(no description)')";
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
    const expression = `IF(period_start_ts <= ${endTs} AND period_end_ts > ${startTs}, annualized, 0.0)`;
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
    CAST(amount_minor AS FLOAT64) AS amount_major,
    COALESCE(CAST(quantity AS FLOAT64), 1.0) AS quantity,
    CASE
      WHEN LOWER(TRIM(${rawDescriptionExpr})) IN ('web search and crawl', 'ai tokens')
      THEN CAST(amount_minor AS FLOAT64) * 12.0
      WHEN UNIX_MILLIS(
        TIMESTAMP(
          DATETIME_ADD(DATETIME(TIMESTAMP_MILLIS(period_start_ts), 'UTC'), INTERVAL 1 MONTH),
          'UTC'
        )
      ) = period_end_ts
      THEN CAST(amount_minor AS FLOAT64) * 12.0
      ELSE
        (CAST(amount_minor AS FLOAT64) * 12.0)
          * (
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
    END AS annualized
  FROM source
  WHERE
    LOWER(COALESCE(currency, '')) = @target_currency
    AND CAST(period_end_ts AS INT64) > CAST(period_start_ts AS INT64)
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
  FROM prepared
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
): Promise<StripeBigQueryReportBase & { totalPages: number; page: number }> {
  const sa = getServiceAccount();
  const projectId = process.env.BIGQUERY_PROJECT_ID || sa.project_id;
  if (!projectId) throw new Error("Missing BIGQUERY_PROJECT_ID (or project_id in service account JSON)");

  const sourceConfig = getBigQuerySourceConfig();
  const location = process.env.BIGQUERY_LOCATION || "US";
  const rangeStart = toQueryTimestamp(request.startTsMs, sourceConfig);
  const rangeEnd = toQueryTimestamp(request.endTsMs, sourceConfig);
  const built = buildStripeBigQueryReportQuery(request, sourceConfig, rangeStart, rangeEnd);
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
): Promise<StripeBigQueryReportPageResult> {
  const result = await queryStripeReportBigQueryBase(request, "page");
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
): Promise<StripeBigQueryReportBase> {
  const result = await queryStripeReportBigQueryBase(request, "all");
  return {
    rows: result.rows,
    totalsByPeriod: result.totalsByPeriod,
    totalRows: result.totalRows,
    sourceRowsFetched: result.sourceRowsFetched,
  };
}

export async function loadStripeLineItemsFromBigQuery(
  startTsMs: number,
  endTsMs: number,
  filters?: StripeBigQueryFilters,
): Promise<SyncedStripeLineItem[]> {
  const sa = getServiceAccount();
  const projectId = process.env.BIGQUERY_PROJECT_ID || sa.project_id;
  if (!projectId) throw new Error("Missing BIGQUERY_PROJECT_ID (or project_id in service account JSON)");

  const table = mustEnv("BIGQUERY_STRIPE_TABLE");
  const servingTable = (process.env.BIGQUERY_STRIPE_SERVING_TABLE || "").trim();
  const servingSchemaMode = (process.env.BIGQUERY_SERVING_SCHEMA_MODE || "int").toLowerCase();
  const location = process.env.BIGQUERY_LOCATION || "US";
  const schemaMode = servingTable ? "int_ts" : (process.env.BIGQUERY_SCHEMA_MODE || "int_ts").toLowerCase();
  const tsUnit = servingTable
    ? (process.env.BIGQUERY_SERVING_TS_UNIT || "milliseconds").toLowerCase()
    : (process.env.BIGQUERY_TS_UNIT || "milliseconds").toLowerCase();
  const tsMultiplier = schemaMode === "timestamp" ? 1 : tsUnit === "seconds" ? 1000 : 1;

  const rangeStart =
    schemaMode === "timestamp"
      ? Math.floor(startTsMs)
      : tsUnit === "seconds"
        ? Math.floor(startTsMs / 1000)
        : Math.floor(startTsMs);
  const rangeEnd =
    schemaMode === "timestamp"
      ? Math.floor(endTsMs)
      : tsUnit === "seconds"
        ? Math.floor(endTsMs / 1000)
        : Math.floor(endTsMs);

  const accessToken = await getAccessToken(sa);
  const built = servingTable
    ? servingSchemaMode === "int"
      ? buildServingQueryIntColumns(servingTable, filters)
      : buildServingQueryTimestampColumns(servingTable, filters)
    : { query: buildQuery(table), filterParams: [] as BigQueryNamedParameter[] };
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
      const item = mapBigQueryRowToSyncedItem(obj, tsMultiplier);
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
