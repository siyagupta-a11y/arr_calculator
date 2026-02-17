import { createSign } from "node:crypto";
import type { SyncedStripeLineItem } from "@/lib/stripeSyncStore";

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

const TOKEN_AUDIENCE = "https://oauth2.googleapis.com/token";
const BQ_SCOPE = "https://www.googleapis.com/auth/bigquery";

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
  const customerName = asString(raw.customer_name || raw.customerName);
  const lineItemDescription = asString(raw.line_item_description || raw.lineItemDescription);

  const periodStart = Math.floor(asNumber(raw.period_start_ts || raw.periodStartTs) * tsMultiplier);
  const periodEnd = Math.floor(asNumber(raw.period_end_ts || raw.periodEndTs) * tsMultiplier);
  const invoiceCreated = Math.floor(asNumber(raw.invoice_created_ts || raw.invoiceCreatedTs) * tsMultiplier);

  return {
    key: `${invoiceId}:${lineItemId}`,
    invoiceId,
    invoiceCreatedTs: invoiceCreated,
    customerId,
    customerName,
    lineItemId,
    lineItemDescription,
    amountMinor: Math.floor(asNumber(raw.amount_minor || raw.amountMinor)),
    currency: asString(raw.currency).toLowerCase(),
    quantity: asNumber(raw.quantity || 1),
    periodStartTs: periodStart,
    periodEndTs: periodEnd,
  };
}

function buildQuery(table: string) {
  const mode = (process.env.BIGQUERY_SCHEMA_MODE || "int_ts").toLowerCase();
  if (mode === "timestamp") {
    return `
SELECT
  CAST(customer_id AS STRING) AS customer_id,
  '' AS customer_name,
  CAST(invoice_id AS STRING) AS invoice_id,
  CAST(id AS STRING) AS line_item_id,
  CAST(description AS STRING) AS line_item_description,
  CAST(
    COALESCE(
      SAFE_CAST(JSON_VALUE(TO_JSON_STRING(t), '$.amount') AS INT64),
      0
    ) AS INT64
  ) AS amount_minor,
  LOWER(CAST(currency AS STRING)) AS currency,
  CAST(COALESCE(quantity, 1) AS FLOAT64) AS quantity,
  CAST(UNIX_MILLIS(period_start) AS INT64) AS period_start_ts,
  CAST(UNIX_MILLIS(period_end) AS INT64) AS period_end_ts,
  CAST(UNIX_MILLIS(date) AS INT64) AS invoice_created_ts
FROM \`${table}\` AS t
WHERE
  period_start <= TIMESTAMP_MILLIS(@range_end_ts)
  AND period_end >= TIMESTAMP_MILLIS(@range_start_ts)
  AND (is_deleted IS NULL OR is_deleted = FALSE)
`;
  }

  return `
SELECT
  CAST(customer_id AS STRING) AS customer_id,
  CAST(customer_name AS STRING) AS customer_name,
  CAST(invoice_id AS STRING) AS invoice_id,
  CAST(line_item_id AS STRING) AS line_item_id,
  CAST(line_item_description AS STRING) AS line_item_description,
  CAST(amount_minor AS INT64) AS amount_minor,
  LOWER(CAST(currency AS STRING)) AS currency,
  CAST(quantity AS FLOAT64) AS quantity,
  CAST(period_start_ts AS INT64) AS period_start_ts,
  CAST(period_end_ts AS INT64) AS period_end_ts,
  CAST(invoice_created_ts AS INT64) AS invoice_created_ts
FROM \`${table}\`
WHERE
  CAST(period_start_ts AS INT64) <= @range_end_ts
  AND CAST(period_end_ts AS INT64) >= @range_start_ts
`;
}

async function fetchBigQueryResultsPage(
  accessToken: string,
  projectId: string,
  location: string,
  query: string,
  rangeStart: number,
  rangeEnd: number,
  pageToken?: string,
): Promise<BigQueryQueryResponse> {
  const body: Record<string, unknown> = {
    query,
    useLegacySql: false,
    location,
    parameterMode: "NAMED",
    queryParameters: [
      {
        name: "range_start_ts",
        parameterType: { type: "INT64" },
        parameterValue: { value: String(rangeStart) },
      },
      {
        name: "range_end_ts",
        parameterType: { type: "INT64" },
        parameterValue: { value: String(rangeEnd) },
      },
    ],
    maxResults: 10000,
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
    const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/queries/${jobId}?location=${encodeURIComponent(location)}&maxResults=10000`;
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

export async function loadStripeLineItemsFromBigQuery(startTsMs: number, endTsMs: number): Promise<SyncedStripeLineItem[]> {
  const sa = getServiceAccount();
  const projectId = process.env.BIGQUERY_PROJECT_ID || sa.project_id;
  if (!projectId) throw new Error("Missing BIGQUERY_PROJECT_ID (or project_id in service account JSON)");

  const table = mustEnv("BIGQUERY_STRIPE_TABLE");
  const location = process.env.BIGQUERY_LOCATION || "US";
  const schemaMode = (process.env.BIGQUERY_SCHEMA_MODE || "int_ts").toLowerCase();
  const tsUnit = (process.env.BIGQUERY_TS_UNIT || "milliseconds").toLowerCase();
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
  const query = buildQuery(table);

  const out: SyncedStripeLineItem[] = [];
  let pageToken: string | undefined;

  while (true) {
    let json = await fetchBigQueryResultsPage(accessToken, projectId, location, query, rangeStart, rangeEnd, pageToken);
    if (!json.jobComplete && json.jobReference?.jobId) {
      const jobProjectId = json.jobReference.projectId || projectId;
      const jobLocation = json.jobReference.location || location;
      json = await waitForJobCompletion(accessToken, jobProjectId, json.jobReference.jobId, jobLocation);
    }

    const fields = (json.schema?.fields || []).map((f) => f.name);
    for (const row of json.rows || []) {
      const obj = rowToObject(fields, row);
      out.push(mapBigQueryRowToSyncedItem(obj, tsMultiplier));
    }

    if (!json.pageToken) break;
    pageToken = json.pageToken;
  }

  return out;
}
