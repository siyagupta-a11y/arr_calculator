const STRIPE_BASE = "https://api.stripe.com/v1";
const STRIPE_MAX_RETRIES = 4;
const STRIPE_BASE_BACKOFF_MS = 300;
const STRIPE_POLL_INTERVAL_MS = Number(process.env.STRIPE_AI_SPEND_REPORT_POLL_INTERVAL_MS || "2000");
const STRIPE_POLL_ATTEMPTS = Number(process.env.STRIPE_AI_SPEND_REPORT_POLL_ATTEMPTS || "60");
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export type StripeAiSpendGrain = "daily" | "weekly" | "monthly" | "quarterly";

export type StripeAiSpendRequest = {
  startDate: string;
  endDate: string;
  grain: StripeAiSpendGrain;
  targetCurrency: string;
  topLimit: number;
  detailLimit: number;
};

export type StripeAiSpendPoint = {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  revenue: number;
  lineCount: number;
  customerCount: number;
};

export type StripeAiSpendGroupRow = {
  key: string;
  label: string;
  revenue: number;
  lineCount: number;
};

export type StripeAiSpendPriceRow = {
  priceId: string;
  priceLabel: string;
  productId: string;
  productLabel: string;
  revenue: number;
  lineCount: number;
};

export type StripeAiSpendDetailRow = {
  invoiceDate: string;
  customerId: string;
  customerName: string;
  lineItemId: string;
  lineItemDescription: string;
  priceId: string;
  priceLabel: string;
  productId: string;
  productLabel: string;
  revenue: number;
  quantity: number;
};

export type StripeAiSpendResult = {
  startDate: string;
  endDate: string;
  grain: StripeAiSpendGrain;
  targetCurrency: string;
  totalRevenue: number;
  points: StripeAiSpendPoint[];
  topCustomers: StripeAiSpendGroupRow[];
  topProducts: StripeAiSpendGroupRow[];
  topPrices: StripeAiSpendPriceRow[];
  detailRows: StripeAiSpendDetailRow[];
  reportSource: "stripe_reporting_api";
  reportTypeId: string;
  reportRunId: string;
};

type StripeListResponse<T> = {
  data: T[];
  has_more: boolean;
};

type StripeReportType = {
  id: string;
  name?: string | null;
  data_available_start?: number | null;
  data_available_end?: number | null;
};

type StripeReportRun = {
  id: string;
  status?: string | null;
  report_type?: string | null;
  parameters?: Record<string, unknown> | null;
  error?: unknown;
  result?: unknown;
};

type CsvRecord = Record<string, string>;

type NormalizedRecord = {
  eventDate: string;
  revenue: number;
  quantity: number;
  customerId: string;
  customerName: string;
  lineItemId: string;
  lineItemDescription: string;
  priceId: string;
  priceLabel: string;
  productId: string;
  productLabel: string;
};

const DATE_KEYS = [
  "event_date",
  "invoice_date",
  "usage_date",
  "date",
  "period_start",
  "service_period_start",
  "invoice_created",
  "invoice_created_at",
  "created",
  "timestamp",
];

const REVENUE_KEYS = [
  "revenue",
  "metered_revenue",
  "gross_revenue",
  "net_revenue",
  "amount",
  "line_amount",
  "line_item_amount",
  "amount_excluding_tax",
  "subtotal",
  "total_amount",
];

const CURRENCY_KEYS = ["currency", "line_item_currency", "invoice_currency"];
const CUSTOMER_ID_KEYS = ["customer_id", "customer", "account_id", "client_id"];
const CUSTOMER_NAME_KEYS = ["customer_name", "customer_display_name", "customer_description", "account_name"];
const LINE_ITEM_ID_KEYS = ["line_item_id", "invoice_line_item_id", "invoice_line_id", "item_id", "id"];
const LINE_ITEM_DESC_KEYS = ["line_item_description", "description", "line_description", "item_description"];
const PRICE_ID_KEYS = ["price_id", "price", "plan_id"];
const PRICE_LABEL_KEYS = ["price_nickname", "price_label", "price_name", "price_description"];
const PRODUCT_ID_KEYS = ["product_id", "product", "product_code"];
const PRODUCT_LABEL_KEYS = ["product_name", "product_description", "product_label"];
const QUANTITY_KEYS = ["quantity", "usage_quantity", "metered_usage", "usage", "units"];

function getStripeSecretKey() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Missing STRIPE_SECRET_KEY in environment");
  return key;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(raw: string | null) {
  if (!raw) return null;
  const asNum = Number(raw);
  if (!Number.isNaN(asNum) && asNum >= 0) return asNum * 1000;
  return null;
}

function parseJsonSafe<T>(text: string): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function stripeRequest(path: string, options?: { method?: "GET" | "POST"; params?: URLSearchParams }) {
  const method = options?.method || "GET";
  const params = options?.params || new URLSearchParams();

  for (let attempt = 0; attempt <= STRIPE_MAX_RETRIES; attempt++) {
    const url = method === "GET" ? `${STRIPE_BASE}${path}${params.toString() ? `?${params.toString()}` : ""}` : `${STRIPE_BASE}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${getStripeSecretKey()}`,
        ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: method === "POST" ? params.toString() : undefined,
      cache: "no-store",
    });

    const text = await res.text();
    if (res.ok) return text;

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === STRIPE_MAX_RETRIES) {
      throw new Error(`Stripe API error ${res.status}: ${text}`);
    }

    const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
    const backoffMs = STRIPE_BASE_BACKOFF_MS * Math.pow(2, attempt);
    const jitterMs = Math.floor(Math.random() * 200);
    await sleep(Math.max(retryAfterMs ?? 0, backoffMs + jitterMs));
  }

  throw new Error("Stripe API request failed unexpectedly");
}

async function stripeRequestJson<T>(path: string, options?: { method?: "GET" | "POST"; params?: URLSearchParams }) {
  const text = await stripeRequest(path, options);
  const json = parseJsonSafe<T>(text);
  if (!json) {
    const sample = text.slice(0, 240);
    throw new Error(`Stripe API returned non-JSON for ${path}. Response starts with: ${sample}`);
  }
  return json;
}

function formatDateUtc(date: Date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function getCurrentMonthDateRangeIso() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    startDate: formatDateUtc(start),
    endDate: formatDateUtc(now),
  };
}

function dayStartUnix(dateIso: string) {
  const date = parseIsoDate(dateIso);
  if (!date) return null;
  return Math.floor(date.getTime() / 1000);
}

function dayEndExclusiveUnix(dateIso: string) {
  const date = parseIsoDate(dateIso);
  if (!date) return null;
  return Math.floor(date.getTime() / 1000) + 24 * 60 * 60;
}

function unixToIsoDate(unixSeconds: number) {
  return formatDateUtc(new Date(unixSeconds * 1000));
}

function asNumber(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asString(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function sanitizeId(raw: string) {
  const clean = raw.trim();
  return clean || "(blank)";
}

function sanitizeLabel(raw: string, fallback: string) {
  const clean = raw.trim();
  return clean || fallback;
}

function normalizeColumnName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === "\"") {
        if (src[i + 1] === "\"") {
          cell += "\"";
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === "\"") {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    if (ch === "\r") continue;
    cell += ch;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((line) => line.some((item) => item.trim() !== ""));
}

function csvToRecords(text: string): CsvRecord[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];

  const headerCounts = new Map<string, number>();
  const headers = rows[0].map((raw, idx) => {
    const normalized = normalizeColumnName(raw) || `column_${idx + 1}`;
    const count = (headerCounts.get(normalized) || 0) + 1;
    headerCounts.set(normalized, count);
    return count > 1 ? `${normalized}_${count}` : normalized;
  });

  const out: CsvRecord[] = [];
  for (let i = 1; i < rows.length; i++) {
    const values = rows[i];
    const row: CsvRecord = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = asString(values[j] || "").trim();
    }
    out.push(row);
  }
  return out;
}

function firstValue(row: CsvRecord, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function firstValueWithKey(row: CsvRecord, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && String(value).trim() !== "") {
      return { key, value: String(value).trim() };
    }
  }
  return { key: "", value: "" };
}

function parseDateValue(raw: string) {
  const value = raw.trim();
  if (!value) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (/^\d{10}$/.test(value)) return formatDateUtc(new Date(Number(value) * 1000));
  if (/^\d{13}$/.test(value)) return formatDateUtc(new Date(Number(value)));

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatDateUtc(parsed);
}

function parseNumberValue(raw: string) {
  const value = raw.trim();
  if (!value) return 0;

  const isParenNegative = value.startsWith("(") && value.endsWith(")");
  const cleaned = value
    .replace(/[()]/g, "")
    .replace(/[,\s]/g, "")
    .replace(/^[A-Z]{3}/, "")
    .replace(/[A-Z]{3}$/, "")
    .replace(/[$€£¥]/g, "");
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return 0;
  return isParenNegative ? -parsed : parsed;
}

function parseAmountValue(raw: string, sourceKey: string) {
  const parsed = parseNumberValue(raw);
  const key = sourceKey.toLowerCase();
  if (key.includes("minor") || key.includes("cent") || key.includes("cents")) {
    return parsed / 100;
  }
  return parsed;
}

function collectAllKeys(rows: CsvRecord[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

function buildCandidateKeys(
  availableKeys: string[],
  exactKeys: string[],
  tokenGroups: string[][],
) {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (key: string) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };

  for (const key of exactKeys) push(key);
  for (const key of availableKeys) {
    for (const tokens of tokenGroups) {
      if (tokens.every((token) => key.includes(token))) {
        push(key);
        break;
      }
    }
  }
  return out;
}

function normalizeStripeRows(rows: CsvRecord[], targetCurrency: string): NormalizedRecord[] {
  const currencyFilter = targetCurrency.trim().toUpperCase();
  const allKeys = collectAllKeys(rows).map((key) => key.toLowerCase());
  const dateKeys = buildCandidateKeys(allKeys, DATE_KEYS, [
    ["date"],
    ["usage", "date"],
    ["invoice", "date"],
    ["period", "start"],
    ["event", "date"],
    ["created"],
  ]);
  const revenueKeys = buildCandidateKeys(allKeys, REVENUE_KEYS, [
    ["revenue"],
    ["amount"],
    ["subtotal"],
    ["total"],
    ["gross"],
    ["net"],
  ]);
  const currencyKeys = buildCandidateKeys(allKeys, CURRENCY_KEYS, [["currency"]]);
  const customerIdKeys = buildCandidateKeys(allKeys, CUSTOMER_ID_KEYS, [["customer", "id"], ["account", "id"]]);
  const customerNameKeys = buildCandidateKeys(allKeys, CUSTOMER_NAME_KEYS, [["customer", "name"], ["account", "name"]]);
  const lineItemIdKeys = buildCandidateKeys(allKeys, LINE_ITEM_ID_KEYS, [["line", "item", "id"], ["invoice", "line", "id"]]);
  const lineItemDescKeys = buildCandidateKeys(allKeys, LINE_ITEM_DESC_KEYS, [["line", "item", "description"], ["description"]]);
  const priceIdKeys = buildCandidateKeys(allKeys, PRICE_ID_KEYS, [["price", "id"], ["plan", "id"]]);
  const priceLabelKeys = buildCandidateKeys(allKeys, PRICE_LABEL_KEYS, [["price", "name"], ["price", "nickname"], ["price", "label"]]);
  const productIdKeys = buildCandidateKeys(allKeys, PRODUCT_ID_KEYS, [["product", "id"], ["sku"]]);
  const productLabelKeys = buildCandidateKeys(allKeys, PRODUCT_LABEL_KEYS, [["product", "name"], ["product", "description"]]);
  const quantityKeys = buildCandidateKeys(allKeys, QUANTITY_KEYS, [["quantity"], ["usage"], ["units"]]);

  const out: NormalizedRecord[] = [];

  for (const row of rows) {
    const currency = firstValue(row, currencyKeys).toUpperCase();
    if (currencyFilter && currency && currency !== currencyFilter) continue;

    const eventDate = parseDateValue(firstValue(row, dateKeys));
    if (!eventDate) continue;

    const revenueEntry = firstValueWithKey(row, revenueKeys);
    const quantityEntry = firstValueWithKey(row, quantityKeys);
    const revenue = parseAmountValue(revenueEntry.value, revenueEntry.key);
    const quantity = parseNumberValue(quantityEntry.value);

    const customerId = sanitizeId(firstValue(row, customerIdKeys));
    const customerName = sanitizeLabel(firstValue(row, customerNameKeys), customerId);
    const lineItemId = sanitizeId(firstValue(row, lineItemIdKeys));
    const lineItemDescription = sanitizeLabel(firstValue(row, lineItemDescKeys), lineItemId);
    const priceId = sanitizeId(firstValue(row, priceIdKeys));
    const priceLabel = sanitizeLabel(firstValue(row, priceLabelKeys), priceId);
    const productId = sanitizeId(firstValue(row, productIdKeys));
    const productLabel = sanitizeLabel(firstValue(row, productLabelKeys), productId);

    out.push({
      eventDate,
      revenue,
      quantity,
      customerId,
      customerName,
      lineItemId,
      lineItemDescription,
      priceId,
      priceLabel,
      productId,
      productLabel,
    });
  }

  return out;
}

function parseBucketStart(eventDateIso: string, grain: StripeAiSpendGrain) {
  const date = new Date(`${eventDateIso}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;

  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();

  if (grain === "daily") return new Date(Date.UTC(year, month, day));
  if (grain === "weekly") {
    const weekday = date.getUTCDay();
    const offset = (weekday + 6) % 7;
    return new Date(Date.UTC(year, month, day - offset));
  }
  if (grain === "monthly") return new Date(Date.UTC(year, month, 1));
  const quarterMonth = Math.floor(month / 3) * 3;
  return new Date(Date.UTC(year, quarterMonth, 1));
}

function bucketEndDate(start: Date, grain: StripeAiSpendGrain) {
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const day = start.getUTCDate();
  if (grain === "daily") return start;
  if (grain === "weekly") return new Date(Date.UTC(year, month, day + 6));
  if (grain === "monthly") return new Date(Date.UTC(year, month + 1, 0));
  return new Date(Date.UTC(year, month + 3, 0));
}

function bucketMeta(start: Date, grain: StripeAiSpendGrain) {
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const startIso = formatDateUtc(start);
  if (grain === "daily") {
    return { key: startIso, label: startIso, periodStart: startIso };
  }
  if (grain === "weekly") {
    return { key: startIso, label: `Week of ${startIso}`, periodStart: startIso };
  }
  if (grain === "monthly") {
    return {
      key: `${year}-${String(month + 1).padStart(2, "0")}`,
      label: `${MONTH_NAMES[month]} ${year}`,
      periodStart: startIso,
    };
  }
  return {
    key: `${year}-Q${Math.floor(month / 3) + 1}`,
    label: `Q${Math.floor(month / 3) + 1} ${year}`,
    periodStart: startIso,
  };
}

function buildTopGroups(
  rows: NormalizedRecord[],
  limit: number,
  keyFn: (row: NormalizedRecord) => string,
  labelFn: (row: NormalizedRecord) => string,
): StripeAiSpendGroupRow[] {
  const map = new Map<string, StripeAiSpendGroupRow>();
  for (const row of rows) {
    const key = sanitizeId(keyFn(row));
    const next = map.get(key) || { key, label: sanitizeLabel(labelFn(row), key), revenue: 0, lineCount: 0 };
    next.revenue += row.revenue;
    next.lineCount += 1;
    if (!next.label || next.label === "(blank)") {
      next.label = sanitizeLabel(labelFn(row), key);
    }
    map.set(key, next);
  }
  return Array.from(map.values())
    .sort((a, b) => b.revenue - a.revenue || a.label.localeCompare(b.label))
    .slice(0, Math.max(1, limit))
    .map((row) => ({ ...row, revenue: round2(row.revenue) }));
}

function buildTopPrices(rows: NormalizedRecord[], limit: number): StripeAiSpendPriceRow[] {
  const map = new Map<string, StripeAiSpendPriceRow>();
  for (const row of rows) {
    const priceId = sanitizeId(row.priceId);
    const productId = sanitizeId(row.productId);
    const key = `${priceId}::${productId}`;
    const next = map.get(key) || {
      priceId,
      priceLabel: sanitizeLabel(row.priceLabel, priceId),
      productId,
      productLabel: sanitizeLabel(row.productLabel, productId),
      revenue: 0,
      lineCount: 0,
    };
    next.revenue += row.revenue;
    next.lineCount += 1;
    map.set(key, next);
  }
  return Array.from(map.values())
    .sort((a, b) => b.revenue - a.revenue || a.priceLabel.localeCompare(b.priceLabel))
    .slice(0, Math.max(1, limit))
    .map((row) => ({ ...row, revenue: round2(row.revenue) }));
}

function buildSummaryPoints(rows: NormalizedRecord[], grain: StripeAiSpendGrain): StripeAiSpendPoint[] {
  const map = new Map<
    string,
    {
      key: string;
      label: string;
      periodStart: string;
      periodEnd: string;
      revenue: number;
      lineCount: number;
      customers: Set<string>;
    }
  >();

  for (const row of rows) {
    const start = parseBucketStart(row.eventDate, grain);
    if (!start) continue;
    const end = bucketEndDate(start, grain);
    const meta = bucketMeta(start, grain);
    const entry = map.get(meta.key) || {
      key: meta.key,
      label: meta.label,
      periodStart: meta.periodStart,
      periodEnd: formatDateUtc(end),
      revenue: 0,
      lineCount: 0,
      customers: new Set<string>(),
    };

    entry.revenue += row.revenue;
    entry.lineCount += 1;
    entry.customers.add(row.customerId);
    map.set(meta.key, entry);
  }

  return Array.from(map.values())
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart))
    .map((entry) => ({
      key: entry.key,
      label: entry.label,
      periodStart: entry.periodStart,
      periodEnd: entry.periodEnd,
      revenue: round2(entry.revenue),
      lineCount: entry.lineCount,
      customerCount: entry.customers.size,
    }));
}

function buildDetailRows(rows: NormalizedRecord[], detailLimit: number): StripeAiSpendDetailRow[] {
  return [...rows]
    .sort((a, b) => b.revenue - a.revenue || b.eventDate.localeCompare(a.eventDate) || a.lineItemId.localeCompare(b.lineItemId))
    .slice(0, Math.max(1, detailLimit))
    .map((row) => ({
      invoiceDate: row.eventDate,
      customerId: row.customerId,
      customerName: row.customerName,
      lineItemId: row.lineItemId,
      lineItemDescription: row.lineItemDescription,
      priceId: row.priceId,
      priceLabel: row.priceLabel,
      productId: row.productId,
      productLabel: row.productLabel,
      revenue: round2(row.revenue),
      quantity: round2(row.quantity),
    }));
}

function parseReportTypeVersion(id: string) {
  const match = id.match(/\.([0-9]+)$/);
  if (!match) return 0;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : 0;
}

function reportTypeScore(reportType: StripeReportType) {
  const haystack = `${reportType.id} ${reportType.name || ""}`.toLowerCase();
  let score = 0;
  if (haystack.includes("metered")) score += 6;
  if (haystack.includes("usage")) score += 5;
  if (haystack.includes("revenue")) score += 7;
  if (haystack.includes("billing")) score += 1;
  return score;
}

async function listAllReportTypes() {
  const all: StripeReportType[] = [];
  let startingAfter: string | null = null;

  while (true) {
    const params = new URLSearchParams();
    params.set("limit", "100");
    if (startingAfter) params.set("starting_after", startingAfter);

    const page = await stripeRequestJson<StripeListResponse<StripeReportType>>("/reporting/report_types", {
      method: "GET",
      params,
    });

    const data = Array.isArray(page.data) ? page.data : [];
    all.push(...data);
    if (!page.has_more || data.length === 0) break;
    startingAfter = data[data.length - 1]?.id || null;
    if (!startingAfter) break;
  }

  return all;
}

async function resolveReportType() {
  const configuredType = String(process.env.STRIPE_AI_SPEND_REPORT_TYPE || "").trim();
  if (configuredType) {
    return stripeRequestJson<StripeReportType>(`/reporting/report_types/${encodeURIComponent(configuredType)}`, {
      method: "GET",
    });
  }

  const reportTypes = await listAllReportTypes();
  const candidates = reportTypes
    .filter((reportType) => reportTypeScore(reportType) >= 11)
    .sort(
      (a, b) =>
        reportTypeScore(b) - reportTypeScore(a) ||
        parseReportTypeVersion(b.id) - parseReportTypeVersion(a.id) ||
        a.id.localeCompare(b.id),
    );

  if (!candidates.length) {
    throw new Error(
      "Could not find a metered usage revenue report type in Stripe. Set STRIPE_AI_SPEND_REPORT_TYPE explicitly.",
    );
  }

  return candidates[0];
}

function getReportRunIntervalUnix(run: StripeReportRun, key: "interval_start" | "interval_end") {
  const value = run.parameters && typeof run.parameters === "object" ? run.parameters[key] : null;
  return asNumber(value);
}

async function listRecentReportRuns(reportTypeId: string, startUnix: number, endUnix: number) {
  const params = new URLSearchParams();
  params.set("limit", "25");
  params.set("report_type", reportTypeId);
  params.set("created[gte]", String(Math.floor(Date.now() / 1000) - 6 * 60 * 60));

  const page = await stripeRequestJson<StripeListResponse<StripeReportRun>>("/reporting/report_runs", {
    method: "GET",
    params,
  });
  const runs = Array.isArray(page.data) ? page.data : [];
  return runs.find(
    (run) =>
      run.status === "succeeded" &&
      getReportRunIntervalUnix(run, "interval_start") === startUnix &&
      getReportRunIntervalUnix(run, "interval_end") === endUnix,
  );
}

async function createReportRun(reportTypeId: string, startUnix: number, endUnix: number) {
  const params = new URLSearchParams();
  params.set("report_type", reportTypeId);
  params.set("parameters[interval_start]", String(startUnix));
  params.set("parameters[interval_end]", String(endUnix));
  params.set("parameters[timezone]", String(process.env.STRIPE_AI_SPEND_REPORT_TIMEZONE || "UTC"));

  return stripeRequestJson<StripeReportRun>("/reporting/report_runs", {
    method: "POST",
    params,
  });
}

async function getReportRun(reportRunId: string) {
  return stripeRequestJson<StripeReportRun>(`/reporting/report_runs/${encodeURIComponent(reportRunId)}`, {
    method: "GET",
  });
}

function extractReportRunError(errorRaw: unknown) {
  if (typeof errorRaw === "string") return errorRaw;
  if (!errorRaw || typeof errorRaw !== "object") return "Stripe report run failed";

  const asObj = errorRaw as Record<string, unknown>;
  const reason = asString(asObj.reason || asObj.code || "");
  const message = asString(asObj.message || "");
  if (reason && message) return `${reason}: ${message}`;
  if (message) return message;
  if (reason) return reason;
  return "Stripe report run failed";
}

async function waitForSucceededRun(initialRunId: string) {
  let run = await getReportRun(initialRunId);
  for (let attempt = 0; attempt < STRIPE_POLL_ATTEMPTS; attempt++) {
    if (run.status === "succeeded") return run;
    if (run.status === "failed" || run.status === "canceled") {
      throw new Error(`Stripe report run failed: ${extractReportRunError(run.error)}`);
    }
    await sleep(Math.max(200, STRIPE_POLL_INTERVAL_MS));
    run = await getReportRun(initialRunId);
  }
  throw new Error("Timed out waiting for Stripe report run to complete");
}

function extractReportFileId(run: StripeReportRun) {
  const result = run.result;
  if (typeof result === "string" && result.startsWith("file_")) return result;
  if (!result || typeof result !== "object") return null;
  const maybeId = asString((result as Record<string, unknown>).id || "");
  return maybeId.startsWith("file_") ? maybeId : null;
}

async function downloadReportCsv(run: StripeReportRun) {
  const fileId = extractReportFileId(run);
  if (!fileId) {
    throw new Error("Stripe report run succeeded but did not return a downloadable file id");
  }
  return stripeRequest(`/files/${encodeURIComponent(fileId)}/contents`, { method: "GET" });
}

function clampInterval(startUnix: number, endUnix: number, reportType: StripeReportType) {
  const minStart = asNumber(reportType.data_available_start);
  const maxEnd = asNumber(reportType.data_available_end);

  let nextStart = startUnix;
  let nextEnd = endUnix;
  if (minStart !== null) nextStart = Math.max(nextStart, minStart);
  if (maxEnd !== null) nextEnd = Math.min(nextEnd, maxEnd);

  if (nextEnd <= nextStart) {
    throw new Error(
      "No report data available for this period yet. Try again later or choose a wider date window.",
    );
  }
  return { startUnix: nextStart, endUnix: nextEnd };
}

export async function queryStripeAiSpendReport(request: StripeAiSpendRequest): Promise<StripeAiSpendResult> {
  const startUnixRaw = dayStartUnix(request.startDate);
  const endUnixRaw = dayEndExclusiveUnix(request.endDate);
  if (startUnixRaw === null || endUnixRaw === null) {
    throw new Error("Invalid startDate/endDate");
  }
  if (endUnixRaw <= startUnixRaw) {
    throw new Error("endDate must be >= startDate");
  }

  const reportType = await resolveReportType();
  const { startUnix, endUnix } = clampInterval(startUnixRaw, endUnixRaw, reportType);
  const cachedRun = await listRecentReportRuns(reportType.id, startUnix, endUnix);
  const run = cachedRun || (await createReportRun(reportType.id, startUnix, endUnix));
  const succeededRun = run.status === "succeeded" ? run : await waitForSucceededRun(run.id);
  const csvText = await downloadReportCsv(succeededRun);
  const rawRows = csvToRecords(csvText);
  const normalizedRows = normalizeStripeRows(rawRows, request.targetCurrency);

  const points = buildSummaryPoints(normalizedRows, request.grain);
  const topCustomers = buildTopGroups(
    normalizedRows,
    request.topLimit,
    (row) => row.customerId,
    (row) => row.customerName,
  );
  const topProducts = buildTopGroups(
    normalizedRows,
    request.topLimit,
    (row) => row.productId,
    (row) => row.productLabel,
  );
  const topPrices = buildTopPrices(normalizedRows, request.topLimit);
  const detailRows = buildDetailRows(normalizedRows, request.detailLimit);
  const totalRevenue = round2(normalizedRows.reduce((sum, row) => sum + row.revenue, 0));

  return {
    startDate: unixToIsoDate(startUnix),
    endDate: unixToIsoDate(Math.max(startUnix, endUnix - 1)),
    grain: request.grain,
    targetCurrency: request.targetCurrency,
    totalRevenue,
    points,
    topCustomers,
    topProducts,
    topPrices,
    detailRows,
    reportSource: "stripe_reporting_api",
    reportTypeId: reportType.id,
    reportRunId: succeededRun.id,
  };
}
