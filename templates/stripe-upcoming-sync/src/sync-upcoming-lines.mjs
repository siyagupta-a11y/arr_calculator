import crypto from "node:crypto";

const STRIPE_BASE_URL = "https://api.stripe.com/v1";
const STRIPE_MAX_RETRIES = Number(process.env.STRIPE_MAX_RETRIES || "4");
const STRIPE_BASE_BACKOFF_MS = Number(process.env.STRIPE_BASE_BACKOFF_MS || "300");
const STRIPE_MAX_CONCURRENCY = Math.max(1, Number(process.env.STRIPE_MAX_CONCURRENCY || "8"));
const BQ_LOCATION = process.env.BQ_LOCATION || "US";
const BQ_INSERT_CHUNK_SIZE = Math.max(1, Number(process.env.BQ_INSERT_CHUNK_SIZE || "500"));

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const STRIPE_SECRET_KEY = mustEnv("STRIPE_SECRET_KEY");
const BQ_PROJECT_ID = process.env.BQ_PROJECT_ID || "orbital-lantern-330119";
const BQ_DATASET = process.env.BQ_DATASET || "stripe";

const BQ_SUBSCRIPTIONS_TABLE = process.env.BQ_SUBSCRIPTIONS_TABLE || "subscriptions";
const BQ_SNAPSHOT_TABLE = process.env.BQ_SNAPSHOT_TABLE || "upcoming_invoice_line_snapshots";
const BQ_RUNS_TABLE = process.env.BQ_RUNS_TABLE || "upcoming_invoice_sync_runs";

const STRIPE_API_VERSION = process.env.STRIPE_API_VERSION || "";
const SNAPSHOT_DATE = process.env.SNAPSHOT_DATE || new Date().toISOString().slice(0, 10);
const RUN_ID = process.env.RUN_ID || SNAPSHOT_DATE;
const SNAPSHOT_TS = new Date().toISOString();

let cachedGoogleToken = null;
let cachedGoogleTokenExpTs = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function base64Url(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buffer
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function parseServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const rawB64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;

  if (!raw && !rawB64) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_JSON_BASE64");
  }

  const jsonText = raw || Buffer.from(rawB64, "base64").toString("utf8");
  const parsed = JSON.parse(jsonText);

  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("Invalid Google service account JSON");
  }

  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
  };
}

async function getGoogleAccessToken() {
  const now = Date.now();
  if (cachedGoogleToken && now < cachedGoogleTokenExpTs - 60_000) {
    return cachedGoogleToken;
  }

  const sa = parseServiceAccount();
  const nowSec = Math.floor(now / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/bigquery",
    iat: nowSec,
    exp: nowSec + 3600,
  };

  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(sa.private_key);
  const assertion = `${unsigned}.${base64Url(signature)}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Google OAuth token error ${res.status}: ${text}`);

  const json = JSON.parse(text);
  if (!json.access_token) throw new Error("Google OAuth token response missing access_token");

  cachedGoogleToken = json.access_token;
  cachedGoogleTokenExpTs = now + (Number(json.expires_in || 3600) * 1000);
  return cachedGoogleToken;
}

function parseTableRef(raw) {
  const parts = String(raw || "").split(".").filter(Boolean);
  if (parts.length === 1) {
    return { projectId: BQ_PROJECT_ID, datasetId: BQ_DATASET, tableId: parts[0] };
  }
  if (parts.length === 2) {
    return { projectId: BQ_PROJECT_ID, datasetId: parts[0], tableId: parts[1] };
  }
  if (parts.length === 3) {
    return { projectId: parts[0], datasetId: parts[1], tableId: parts[2] };
  }
  throw new Error(`Invalid table reference: ${raw}`);
}

function fqTable(raw) {
  const t = parseTableRef(raw);
  return `${t.projectId}.${t.datasetId}.${t.tableId}`;
}

async function bqFetch(path, init = {}) {
  const token = await getGoogleAccessToken();
  const res = await fetch(`https://bigquery.googleapis.com/bigquery/v2${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  const text = await res.text();
  let json = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }

  if (!res.ok) {
    throw new Error(`BigQuery API error ${res.status}: ${JSON.stringify(json)}`);
  }

  return json;
}

function toQueryParameter(name, value) {
  if (typeof value === "number") {
    return {
      name,
      parameterType: { type: Number.isInteger(value) ? "INT64" : "FLOAT64" },
      parameterValue: { value: String(value) },
    };
  }

  return {
    name,
    parameterType: { type: "STRING" },
    parameterValue: { value: String(value ?? "") },
  };
}

function rowToObject(fields, row) {
  const out = {};
  for (let i = 0; i < fields.length; i++) {
    out[fields[i]] = row?.f?.[i]?.v ?? null;
  }
  return out;
}

async function bqQuery(sql, params = {}) {
  const queryParameters = Object.entries(params).map(([name, value]) => toQueryParameter(name, value));
  const payload = {
    query: sql,
    useLegacySql: false,
    location: BQ_LOCATION,
  };
  if (queryParameters.length) {
    payload.parameterMode = "NAMED";
    payload.queryParameters = queryParameters;
  }

  let page = await bqFetch(`/projects/${encodeURIComponent(BQ_PROJECT_ID)}/queries`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (!page.jobComplete) {
    const jobId = page?.jobReference?.jobId;
    if (!jobId) throw new Error("BigQuery query job did not return jobId");

    for (let i = 0; i < 180; i++) {
      await sleep(1000);
      page = await bqFetch(
        `/projects/${encodeURIComponent(BQ_PROJECT_ID)}/queries/${encodeURIComponent(jobId)}?location=${encodeURIComponent(BQ_LOCATION)}`,
        { method: "GET" },
      );
      if (page.jobComplete) break;
    }
  }

  const fields = (page?.schema?.fields || []).map((f) => f.name);
  const out = [];
  if (Array.isArray(page?.rows)) {
    for (const row of page.rows) out.push(rowToObject(fields, row));
  }

  const jobId = page?.jobReference?.jobId;
  let nextToken = page?.pageToken || null;
  while (nextToken && jobId) {
    const next = await bqFetch(
      `/projects/${encodeURIComponent(BQ_PROJECT_ID)}/queries/${encodeURIComponent(jobId)}?location=${encodeURIComponent(BQ_LOCATION)}&pageToken=${encodeURIComponent(nextToken)}`,
      { method: "GET" },
    );
    if (Array.isArray(next?.rows)) {
      for (const row of next.rows) out.push(rowToObject(fields, row));
    }
    nextToken = next?.pageToken || null;
  }

  return out;
}

async function bqInsertRows(tableRef, rows) {
  if (!rows.length) return;

  const table = parseTableRef(tableRef);
  const payload = {
    kind: "bigquery#tableDataInsertAllRequest",
    skipInvalidRows: false,
    ignoreUnknownValues: false,
    rows: rows.map((r) => ({
      insertId: r.insertId || crypto.randomUUID(),
      json: r.json || r,
    })),
  };

  const result = await bqFetch(
    `/projects/${encodeURIComponent(table.projectId)}/datasets/${encodeURIComponent(table.datasetId)}/tables/${encodeURIComponent(table.tableId)}/insertAll`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );

  if (Array.isArray(result?.insertErrors) && result.insertErrors.length) {
    throw new Error(`BigQuery insertAll errors: ${JSON.stringify(result.insertErrors.slice(0, 3))}`);
  }
}

function parseRetryAfterMs(raw) {
  if (!raw) return null;
  const asNum = Number(raw);
  if (!Number.isNaN(asNum) && asNum >= 0) return asNum * 1000;
  return null;
}

function parseStripeError(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.error || {};
  } catch {
    return { message: text };
  }
}

function isSkippableStripeError(status, err) {
  const code = String(err?.code || "").toLowerCase();
  const message = String(err?.message || "").toLowerCase();

  if (code === "invoice_upcoming_none") return true;
  if (message.includes("no upcoming invoice")) return true;
  if (status === 404) return true;
  if (status === 400 && message.includes("no such subscription")) return true;
  return false;
}

async function stripeGet(path, params = {}) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === "") continue;
    query.set(k, String(v));
  }

  for (let attempt = 0; attempt <= STRIPE_MAX_RETRIES; attempt++) {
    const url = `${STRIPE_BASE_URL}${path}?${query.toString()}`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        ...(STRIPE_API_VERSION ? { "Stripe-Version": STRIPE_API_VERSION } : {}),
      },
      cache: "no-store",
    });

    const text = await res.text();

    if (res.ok) {
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Stripe returned non-JSON response for ${path}`);
      }
    }

    const err = parseStripeError(text);
    if (isSkippableStripeError(res.status, err)) {
      return { data: [], has_more: false, _skipped: true };
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === STRIPE_MAX_RETRIES) {
      throw new Error(`Stripe API error ${res.status}: ${JSON.stringify(err)}`);
    }

    const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
    const backoffMs = STRIPE_BASE_BACKOFF_MS * Math.pow(2, attempt);
    const jitterMs = Math.floor(Math.random() * 200);
    await sleep(Math.max(retryAfterMs ?? 0, backoffMs + jitterMs));
  }

  throw new Error("Stripe request failed unexpectedly");
}

function normalizeProductId(price) {
  if (!price) return "";
  if (typeof price.product === "string") return price.product;
  if (price.product && typeof price.product === "object") return String(price.product.id || "");
  return "";
}

function buildLineFingerprint({ customerId, subscriptionId, line }) {
  const key = [
    customerId,
    subscriptionId,
    String(line.price?.id || ""),
    String(line.description || ""),
    String(line.period?.start || ""),
    String(line.period?.end || ""),
    String(line.amount || 0),
    String(line.currency || ""),
    String(line.quantity || 1),
  ].join("|");

  return sha256Hex(key).slice(0, 32);
}

function toIsoFromUnixSeconds(value) {
  const n = Number(value || 0);
  if (!n || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function normalizeUpcomingLineRow({ customerId, subscriptionId, line }) {
  const quantity = Number(line?.quantity ?? 1);
  const amountMinor = Number(line?.amount || 0);
  const unitAmountMinorRaw = line?.price?.unit_amount;
  const unitAmountMinor = unitAmountMinorRaw == null ? null : Number(unitAmountMinorRaw);
  const priceId = String(line?.price?.id || "");

  return {
    snapshot_date: SNAPSHOT_DATE,
    snapshot_ts: SNAPSHOT_TS,
    run_id: RUN_ID,
    customer_id: customerId,
    subscription_id: subscriptionId,
    preview_currency: String(line?.currency || "").toLowerCase(),
    line_fingerprint: buildLineFingerprint({ customerId, subscriptionId, line }),
    stripe_line_id: String(line?.id || ""),
    price_id: priceId,
    product_id: normalizeProductId(line?.price),
    description: String(line?.description || ""),
    quantity,
    unit_amount_minor: unitAmountMinor,
    amount_minor: amountMinor,
    currency: String(line?.currency || "").toLowerCase(),
    period_start: toIsoFromUnixSeconds(line?.period?.start),
    period_end: toIsoFromUnixSeconds(line?.period?.end),
    raw_json: JSON.stringify(line || {}),
  };
}

async function mapWithConcurrency(items, limit, fn) {
  if (!items.length) return [];

  const out = new Array(items.length);
  const safeLimit = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  async function worker() {
    while (true) {
      const idx = next;
      next++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: safeLimit }, () => worker()));
  return out;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function listUpcomingLinesForSubscription(customerId, subscriptionId) {
  const rows = [];
  let startingAfter = null;

  while (true) {
    const page = await stripeGet("/invoices/upcoming/lines", {
      customer: customerId,
      subscription: subscriptionId,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
      "expand[]": "data.price.product",
    });

    const pageData = Array.isArray(page?.data) ? page.data : [];
    for (const line of pageData) {
      rows.push(normalizeUpcomingLineRow({ customerId, subscriptionId, line }));
    }

    if (!page?.has_more || pageData.length === 0) break;
    startingAfter = String(pageData[pageData.length - 1].id || "");
    if (!startingAfter) break;
  }

  return rows;
}

async function getActiveSubscriptions() {
  const table = fqTable(BQ_SUBSCRIPTIONS_TABLE);
  const sql = `
SELECT
  CAST(id AS STRING) AS subscription_id,
  CAST(customer AS STRING) AS customer_id
FROM \`${table}\`
WHERE
  status IN ('active', 'trialing', 'past_due')
  AND customer IS NOT NULL
`;

  const rows = await bqQuery(sql);
  return rows
    .map((r) => ({
      subscriptionId: String(r.subscription_id || "").trim(),
      customerId: String(r.customer_id || "").trim(),
    }))
    .filter((r) => r.subscriptionId && r.customerId);
}

async function insertOrReplaceRunRow(status) {
  const runsTable = fqTable(BQ_RUNS_TABLE);
  await bqQuery(`DELETE FROM \`${runsTable}\` WHERE run_id = @run_id`, { run_id: RUN_ID });
  await bqInsertRows(BQ_RUNS_TABLE, [
    {
      run_id: RUN_ID,
      snapshot_date: SNAPSHOT_DATE,
      started_at: SNAPSHOT_TS,
      finished_at: null,
      status,
      subscriptions_scanned: 0,
      lines_written: 0,
      error_message: null,
    },
  ]);
}

async function finalizeRunRow({ status, subscriptionsScanned, linesWritten, errorMessage }) {
  const runsTable = fqTable(BQ_RUNS_TABLE);
  const sql = `
UPDATE \`${runsTable}\`
SET
  finished_at = CURRENT_TIMESTAMP(),
  status = @status,
  subscriptions_scanned = @subscriptions_scanned,
  lines_written = @lines_written,
  error_message = @error_message
WHERE run_id = @run_id
`;

  await bqQuery(sql, {
    status,
    subscriptions_scanned: Number(subscriptionsScanned || 0),
    lines_written: Number(linesWritten || 0),
    error_message: errorMessage || "",
    run_id: RUN_ID,
  });
}

async function loadSnapshotRows(snapshotRows) {
  const snapshotTable = fqTable(BQ_SNAPSHOT_TABLE);
  await bqQuery(`DELETE FROM \`${snapshotTable}\` WHERE run_id = @run_id`, { run_id: RUN_ID });

  const chunks = chunk(snapshotRows, BQ_INSERT_CHUNK_SIZE);
  for (const c of chunks) {
    await bqInsertRows(BQ_SNAPSHOT_TABLE, c);
  }
}

async function main() {
  console.log(
    JSON.stringify({
      stage: "start",
      runId: RUN_ID,
      snapshotDate: SNAPSHOT_DATE,
      snapshotTs: SNAPSHOT_TS,
    }),
  );

  await insertOrReplaceRunRow("running");

  let subscriptionsScanned = 0;
  let linesWritten = 0;

  try {
    const subscriptions = await getActiveSubscriptions();
    subscriptionsScanned = subscriptions.length;

    console.log(
      JSON.stringify({
        stage: "subscriptions_loaded",
        count: subscriptionsScanned,
      }),
    );

    const lineRowsBySubscription = await mapWithConcurrency(
      subscriptions,
      STRIPE_MAX_CONCURRENCY,
      async (sub, idx) => {
        const rows = await listUpcomingLinesForSubscription(sub.customerId, sub.subscriptionId);
        if ((idx + 1) % 250 === 0) {
          console.log(
            JSON.stringify({
              stage: "progress",
              processedSubscriptions: idx + 1,
              totalSubscriptions: subscriptions.length,
            }),
          );
        }
        return rows;
      },
    );

    const snapshotRows = lineRowsBySubscription.flat();
    linesWritten = snapshotRows.length;

    console.log(
      JSON.stringify({
        stage: "rows_built",
        linesWritten,
      }),
    );

    await loadSnapshotRows(snapshotRows);

    await finalizeRunRow({
      status: "success",
      subscriptionsScanned,
      linesWritten,
      errorMessage: null,
    });

    console.log(
      JSON.stringify({
        stage: "done",
        status: "success",
        subscriptionsScanned,
        linesWritten,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    try {
      await finalizeRunRow({
        status: "failed",
        subscriptionsScanned,
        linesWritten,
        errorMessage: message,
      });
    } catch (inner) {
      console.error("Failed updating run status", inner);
    }

    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
