import crypto from "node:crypto";

const STRIPE_BASE_URL = "https://api.stripe.com/v1";
const STRIPE_MAX_RETRIES = Number(process.env.STRIPE_MAX_RETRIES || "4");
const STRIPE_BASE_BACKOFF_MS = Number(process.env.STRIPE_BASE_BACKOFF_MS || "300");
const STRIPE_MAX_CONCURRENCY = Math.max(1, Number(process.env.STRIPE_MAX_CONCURRENCY || "16"));
const BQ_LOCATION = process.env.BQ_LOCATION || "northamerica-northeast1";
const BQ_INSERT_CHUNK_SIZE = Math.max(1, Number(process.env.BQ_INSERT_CHUNK_SIZE || "500"));

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const STRIPE_SECRET_KEY = mustEnv("STRIPE_SECRET_KEY");
const BQ_PROJECT_ID = process.env.BQ_PROJECT_ID || "orbital-lantern-330119";
const BQ_DATASET = process.env.BQ_DATASET || "stripe";

const BQ_SNAPSHOT_TABLE = process.env.BQ_SNAPSHOT_TABLE || "upcoming_invoice_line_snapshots";
const BQ_RUNS_TABLE = process.env.BQ_RUNS_TABLE || "upcoming_invoice_sync_runs";

const STRIPE_API_VERSION = process.env.STRIPE_API_VERSION || "";
const SNAPSHOT_TS = process.env.SNAPSHOT_TS || new Date().toISOString();
const SNAPSHOT_DATE = process.env.SNAPSHOT_DATE || SNAPSHOT_TS.slice(0, 10);
const snapshotTsForRunId = new Date(SNAPSHOT_TS);
const fallbackRunHour = Number.isNaN(snapshotTsForRunId.getTime())
  ? "00"
  : String(snapshotTsForRunId.getUTCHours()).padStart(2, "0");
const BASE_RUN_ID =
  process.env.RUN_ID || process.env.CLOUD_RUN_EXECUTION || `${SNAPSHOT_DATE}T${fallbackRunHour}00Z`;
const TARGET_YEAR_MONTH = process.env.TARGET_YEAR_MONTH || "";
const DAILY_CLOSE_HOUR_UTC = Number(process.env.DAILY_CLOSE_HOUR_UTC || "0");
const MONTH_END_CLOSE_HOUR_UTC = Number(process.env.MONTH_END_CLOSE_HOUR_UTC || "23");
const TASK_INDEX = Math.max(0, Number(process.env.CLOUD_RUN_TASK_INDEX || "0"));
const TASK_COUNT = Math.max(1, Number(process.env.CLOUD_RUN_TASK_COUNT || "1"));
const RUN_ID = TASK_COUNT > 1 ? `${BASE_RUN_ID}-t${TASK_INDEX}` : BASE_RUN_ID;

const SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due", "unpaid"]);

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

function pad2(n) {
  return String(n).padStart(2, "0");
}

function parseSnapshotDateUtc(dateStr) {
  const m = String(dateStr || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Invalid SNAPSHOT_DATE: ${dateStr}. Expected YYYY-MM-DD`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error(`Invalid SNAPSHOT_DATE: ${dateStr}. Expected YYYY-MM-DD`);
  }
  return { year, month, day };
}

function parseTargetYearMonth(yearMonth) {
  const m = String(yearMonth || "").match(/^(\d{4})-(\d{2})$/);
  if (!m) throw new Error(`Invalid TARGET_YEAR_MONTH: ${yearMonth}. Expected YYYY-MM`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Invalid TARGET_YEAR_MONTH: ${yearMonth}. Expected YYYY-MM`);
  }
  return { year, month };
}

function validateHour(name, value) {
  if (!Number.isInteger(value) || value < 0 || value > 23) {
    throw new Error(`Invalid ${name}: ${value}. Expected an integer from 0 to 23`);
  }
}

function isLastDayOfMonth({ year, month, day }) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day === lastDay;
}

function shiftDateUtc(dateStr, deltaDays) {
  const parsed = parseSnapshotDateUtc(dateStr);
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + deltaDays, 0, 0, 0, 0));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

function getSnapshotRetentionContext(snapshotDate, snapshotTs) {
  const ts = new Date(snapshotTs);
  if (Number.isNaN(ts.getTime())) {
    throw new Error(`Invalid SNAPSHOT_TS: ${snapshotTs}. Expected ISO-8601 timestamp`);
  }

  const runHourUtc = ts.getUTCHours();
  const currentDay = parseSnapshotDateUtc(snapshotDate);
  const previousDate = shiftDateUtc(snapshotDate, -1);
  const previousDay = parseSnapshotDateUtc(previousDate);
  const previousDayIsMonthEnd = isLastDayOfMonth(previousDay);
  const currentDayIsMonthEnd = isLastDayOfMonth(currentDay);

  // Close normal days at 00:00 of the following day; close month-end at 23:00 of the same day.
  let closeSnapshotDate = null;
  let closeType = "none";
  if (runHourUtc === MONTH_END_CLOSE_HOUR_UTC && currentDayIsMonthEnd) {
    closeSnapshotDate = snapshotDate;
    closeType = "month_end_close";
  } else if (runHourUtc === DAILY_CLOSE_HOUR_UTC && !previousDayIsMonthEnd) {
    closeSnapshotDate = previousDate;
    closeType = "midnight_close";
  }

  return {
    runHourUtc,
    inputSnapshotDate: snapshotDate,
    effectiveSnapshotDate: closeSnapshotDate || snapshotDate,
    shouldPruneDailySnapshots: Boolean(closeSnapshotDate),
    closeSnapshotDate,
    closeType,
  };
}

function getTargetMonthWindow(snapshotDate, targetYearMonthOverride) {
  if (targetYearMonthOverride) {
    const parsed = parseTargetYearMonth(targetYearMonthOverride);
    const startTs = Math.floor(Date.UTC(parsed.year, parsed.month - 1, 1, 0, 0, 0, 0) / 1000);
    const endTs = Math.floor(Date.UTC(parsed.year, parsed.month, 1, 0, 0, 0, 0) / 1000);
    return {
      targetYearMonth: `${parsed.year}-${pad2(parsed.month)}`,
      startTs,
      endTs,
    };
  }

  const parsedSnapshot = parseSnapshotDateUtc(snapshotDate);
  const startTs = Math.floor(Date.UTC(parsedSnapshot.year, parsedSnapshot.month, 1, 0, 0, 0, 0) / 1000);
  const endTs = Math.floor(Date.UTC(parsedSnapshot.year, parsedSnapshot.month + 1, 1, 0, 0, 0, 0) / 1000);
  const nextMonth = new Date(startTs * 1000);
  return {
    targetYearMonth: `${nextMonth.getUTCFullYear()}-${pad2(nextMonth.getUTCMonth() + 1)}`,
    startTs,
    endTs,
  };
}

function normalizeCustomerId(customerValue) {
  if (!customerValue) return "";
  if (typeof customerValue === "string") return customerValue.trim();
  if (typeof customerValue === "object") return String(customerValue.id || "").trim();
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

function normalizeUpcomingLineRow({ customerId, subscriptionId, line, snapshotDate, snapshotTs, runId }) {
  const quantity = Number(line?.quantity ?? 1);
  const amountMinor = Number(line?.amount || 0);
  const unitAmountMinorRaw = line?.price?.unit_amount;
  const unitAmountMinor = unitAmountMinorRaw == null ? null : Number(unitAmountMinorRaw);
  const priceId = String(line?.price?.id || "");

  return {
    snapshot_date: snapshotDate,
    snapshot_ts: snapshotTs,
    run_id: runId,
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

function hashString32(input) {
  let hash = 2166136261;
  const str = String(input || "");
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function belongsToCurrentTask(subscriptionId) {
  if (TASK_COUNT <= 1) return true;
  return hashString32(subscriptionId) % TASK_COUNT === TASK_INDEX;
}

async function listUpcomingLinesForSubscription(customerId, subscriptionId, snapshotMeta) {
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
      rows.push(normalizeUpcomingLineRow({ customerId, subscriptionId, line, ...snapshotMeta }));
    }

    if (!page?.has_more || pageData.length === 0) break;
    startingAfter = String(pageData[pageData.length - 1].id || "");
    if (!startingAfter) break;
  }

  return rows;
}

async function listSubscriptionsFromStripe() {
  const subscriptions = [];
  let startingAfter = null;

  while (true) {
    const page = await stripeGet("/subscriptions", {
      status: "all",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });

    const pageData = Array.isArray(page?.data) ? page.data : [];
    for (const sub of pageData) {
      const status = String(sub?.status || "").toLowerCase();
      if (!SUBSCRIPTION_STATUSES.has(status)) continue;

      const subscriptionId = String(sub?.id || "").trim();
      const customerId = normalizeCustomerId(sub?.customer);
      const nextInvoiceTs = Number(sub?.current_period_end || 0);

      if (!subscriptionId || !customerId || !nextInvoiceTs) continue;

      subscriptions.push({
        subscriptionId,
        customerId,
        status,
        nextInvoiceTs,
      });
    }

    if (!page?.has_more || pageData.length === 0) break;
    startingAfter = String(pageData[pageData.length - 1].id || "");
    if (!startingAfter) break;
  }

  return subscriptions;
}

async function getNextMonthSubscriptions(targetMonthWindow) {
  const all = await listSubscriptionsFromStripe();
  const filtered = all.filter(
    (sub) => sub.nextInvoiceTs >= targetMonthWindow.startTs && sub.nextInvoiceTs < targetMonthWindow.endTs,
  );

  return {
    allActiveCount: all.length,
    targetMonthSubscriptions: filtered.map((s) => ({
      subscriptionId: s.subscriptionId,
      customerId: s.customerId,
    })),
  };
}

async function insertRunLog({ status, subscriptionsScanned, linesWritten, errorMessage, finished, snapshotMeta }) {
  await bqInsertRows(BQ_RUNS_TABLE, [
    {
      run_id: snapshotMeta.runId,
      snapshot_date: snapshotMeta.snapshotDate,
      started_at: snapshotMeta.snapshotTs,
      finished_at: finished ? new Date().toISOString() : null,
      status,
      subscriptions_scanned: Number(subscriptionsScanned || 0),
      lines_written: Number(linesWritten || 0),
      error_message: errorMessage || null,
    },
  ]);
}

async function loadSnapshotRows(snapshotRows) {
  const chunks = chunk(snapshotRows, BQ_INSERT_CHUNK_SIZE);
  for (const c of chunks) {
    await bqInsertRows(BQ_SNAPSHOT_TABLE, c);
  }
}

async function pruneToDailyCloseSnapshot({ snapshotDate, baseRunId }) {
  const sql = `
DELETE FROM \`${fqTable(BQ_SNAPSHOT_TABLE)}\`
WHERE snapshot_date = DATE(@snapshotDate)
  AND NOT (
    run_id = @baseRunId
    OR run_id LIKE @taskRunPrefix
  )
`;

  await bqQuery(sql, {
    snapshotDate,
    baseRunId,
    taskRunPrefix: `${baseRunId}-t%`,
  });
}

async function main() {
  validateHour("DAILY_CLOSE_HOUR_UTC", DAILY_CLOSE_HOUR_UTC);
  validateHour("MONTH_END_CLOSE_HOUR_UTC", MONTH_END_CLOSE_HOUR_UTC);
  const retention = getSnapshotRetentionContext(SNAPSHOT_DATE, SNAPSHOT_TS);
  const snapshotMeta = {
    snapshotDate: retention.effectiveSnapshotDate,
    snapshotTs: SNAPSHOT_TS,
    runId: RUN_ID,
  };

  const targetMonthWindow = getTargetMonthWindow(snapshotMeta.snapshotDate, TARGET_YEAR_MONTH);

  console.log(
    JSON.stringify({
      stage: "start",
      runId: snapshotMeta.runId,
      snapshotDateInput: SNAPSHOT_DATE,
      snapshotDateEffective: snapshotMeta.snapshotDate,
      snapshotTs: snapshotMeta.snapshotTs,
      closeType: retention.closeType,
      closeSnapshotDate: retention.closeSnapshotDate,
      closeHourUtc: retention.runHourUtc,
      targetYearMonth: targetMonthWindow.targetYearMonth,
      targetStartTs: targetMonthWindow.startTs,
      targetEndTsExclusive: targetMonthWindow.endTs,
      taskIndex: TASK_INDEX,
      taskCount: TASK_COUNT,
    }),
  );

  await insertRunLog({
    status: "running",
    subscriptionsScanned: 0,
    linesWritten: 0,
    errorMessage: null,
    finished: false,
    snapshotMeta,
  });

  let subscriptionsScanned = 0;
  let linesWritten = 0;

  try {
    const { allActiveCount, targetMonthSubscriptions } = await getNextMonthSubscriptions(targetMonthWindow);
    const shardedSubscriptions = targetMonthSubscriptions.filter((sub) => belongsToCurrentTask(sub.subscriptionId));
    subscriptionsScanned = shardedSubscriptions.length;

    console.log(
      JSON.stringify({
        stage: "subscriptions_loaded",
        activeSubscriptions: allActiveCount,
        targetMonthSubscriptions: targetMonthSubscriptions.length,
        taskSubscriptions: subscriptionsScanned,
        targetYearMonth: targetMonthWindow.targetYearMonth,
        taskIndex: TASK_INDEX,
        taskCount: TASK_COUNT,
      }),
    );

    const lineRowsBySubscription = await mapWithConcurrency(
      shardedSubscriptions,
      STRIPE_MAX_CONCURRENCY,
      async (sub, idx) => {
        const rows = await listUpcomingLinesForSubscription(sub.customerId, sub.subscriptionId, snapshotMeta);
        if ((idx + 1) % 250 === 0) {
          console.log(
            JSON.stringify({
              stage: "progress",
              processedSubscriptions: idx + 1,
              totalSubscriptions: shardedSubscriptions.length,
              targetYearMonth: targetMonthWindow.targetYearMonth,
              taskIndex: TASK_INDEX,
              taskCount: TASK_COUNT,
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
        taskIndex: TASK_INDEX,
        taskCount: TASK_COUNT,
      }),
    );

    await loadSnapshotRows(snapshotRows);
    if (retention.shouldPruneDailySnapshots) {
      await pruneToDailyCloseSnapshot({
        snapshotDate: snapshotMeta.snapshotDate,
        baseRunId: BASE_RUN_ID,
      });
      console.log(
        JSON.stringify({
          stage: "close_snapshot_pruned",
          closeType: retention.closeType,
          closeSnapshotDate: snapshotMeta.snapshotDate,
          baseRunId: BASE_RUN_ID,
        }),
      );
    }

    await insertRunLog({
      status: "success",
      subscriptionsScanned,
      linesWritten,
      errorMessage: null,
      finished: true,
      snapshotMeta,
    });

    console.log(
      JSON.stringify({
        stage: "done",
        status: "success",
        subscriptionsScanned,
        linesWritten,
        taskIndex: TASK_INDEX,
        taskCount: TASK_COUNT,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    try {
      await insertRunLog({
        status: "failed",
        subscriptionsScanned,
        linesWritten,
        errorMessage: message,
        finished: true,
        snapshotMeta,
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
