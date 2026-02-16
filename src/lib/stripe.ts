const STRIPE_BASE = "https://api.stripe.com/v1";
const STRIPE_MAX_RETRIES = 4;
const STRIPE_BASE_BACKOFF_MS = 300;
const STRIPE_LINE_FETCH_CONCURRENCY = Number(process.env.STRIPE_LINE_FETCH_CONCURRENCY || "8");

export type StripeCustomer = {
  id: string;
  name?: string | null;
  email?: string | null;
};

export type StripeInvoice = {
  id: string;
  customer?: string | StripeCustomer | null;
  currency?: string | null;
  status?: string | null;
  created?: number | null;
};

export type StripePrice = {
  id?: string;
  nickname?: string | null;
  product?: string | StripeProduct | null;
  recurring?: {
    interval?: string | null;
    interval_count?: number | null;
  } | null;
};

export type StripeProduct = {
  id?: string;
  name?: string | null;
};

export type StripeInvoiceLineItem = {
  id: string;
  amount: number;
  currency?: string | null;
  quantity?: number | null;
  period?: {
    start?: number | null;
    end?: number | null;
  } | null;
  price?: StripePrice | null;
  description?: string | null;
};

export type StripeInvoiceWithLines = {
  invoice: StripeInvoice;
  customerId: string;
  customerName: string;
  lineItems: StripeInvoiceLineItem[];
};

export type StripeInvoiceQuery = {
  status?: string;
  createdGte?: number;
  createdLte?: number;
  maxInvoices?: number;
  startingAfter?: string | null;
};

export type StripeInvoiceBatchResult = {
  invoicesWithLines: StripeInvoiceWithLines[];
  hasMore: boolean;
  nextStartingAfter: string | null;
  fetchedInvoices: number;
};

type StripePriceDetail = {
  id?: string;
  nickname?: string | null;
  product?: string | StripeProduct | null;
};

type StripeListResponse<T> = {
  data: T[];
  has_more: boolean;
};

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

async function stripeFetch<T>(path: string, params: URLSearchParams) {
  for (let attempt = 0; attempt <= STRIPE_MAX_RETRIES; attempt++) {
    const res = await fetch(`${STRIPE_BASE}${path}?${params.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${getStripeSecretKey()}`,
      },
      cache: "no-store",
    });

    const text = await res.text();
    if (res.ok) {
      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        const sample = text.slice(0, 240);
        throw new Error(
          `Stripe API returned non-JSON for ${path} (status ${res.status}). Response starts with: ${sample}`,
        );
      }
    }

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

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>) {
  if (!items.length) return [] as R[];
  const safeLimit = Math.max(1, Math.min(limit, items.length));
  const out: R[] = new Array(items.length);
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

function normalizeCustomer(invoice: StripeInvoice) {
  const customerRaw = invoice.customer;
  if (!customerRaw) {
    return { customerId: "", customerName: "(no customer)" };
  }

  if (typeof customerRaw === "string") {
    return { customerId: customerRaw, customerName: customerRaw };
  }

  const customerId = String(customerRaw.id || "");
  const customerName = String(customerRaw.name || customerRaw.email || customerId || "(unknown customer)");
  return { customerId, customerName };
}

function normalizePriceDisplayName(priceId: string, price: StripePriceDetail | null | undefined) {
  const nickname = String(price?.nickname || "").trim();
  if (nickname) return nickname;

  const product = price?.product;
  if (product && typeof product === "object") {
    const productName = String(product.name || "").trim();
    if (productName) return productName;
  }

  return priceId;
}

async function listInvoiceLines(invoiceId: string) {
  const lineItems: StripeInvoiceLineItem[] = [];
  let lineStartingAfter: string | null = null;

  while (true) {
    const params = new URLSearchParams();
    params.set("limit", "100");
    params.append("expand[]", "data.price");
    if (lineStartingAfter) params.set("starting_after", lineStartingAfter);

    const page = await stripeFetch<StripeListResponse<StripeInvoiceLineItem>>(`/invoices/${invoiceId}/lines`, params);
    lineItems.push(...(page.data || []));
    if (!page.has_more || !page.data.length) break;
    lineStartingAfter = page.data[page.data.length - 1].id;
  }

  return lineItems;
}

export async function listInvoiceBatchWithLineItems(query?: StripeInvoiceQuery): Promise<StripeInvoiceBatchResult> {
  const invoiceStatus = query?.status || process.env.STRIPE_INVOICE_STATUS || "paid";
  const maxInvoices = Math.max(1, Number(query?.maxInvoices || 500));
  const invoices: StripeInvoice[] = [];
  let startingAfter: string | null = query?.startingAfter || null;
  let hasMore = false;

  while (invoices.length < maxInvoices) {
    const remaining = maxInvoices - invoices.length;
    const params = new URLSearchParams();
    params.set("limit", String(Math.min(100, remaining)));
    params.set("status", invoiceStatus);
    params.append("expand[]", "data.customer");
    if (query?.createdGte) params.set("created[gte]", String(query.createdGte));
    if (query?.createdLte) params.set("created[lte]", String(query.createdLte));
    if (startingAfter) params.set("starting_after", startingAfter);

    const page = await stripeFetch<StripeListResponse<StripeInvoice>>("/invoices", params);
    const pageData = page.data || [];
    invoices.push(...pageData);
    if (!page.has_more || !pageData.length) {
      hasMore = false;
      startingAfter = null;
      break;
    }

    hasMore = true;
    startingAfter = page.data[page.data.length - 1].id;

    if (invoices.length >= maxInvoices) break;
  }

  const results = await mapWithConcurrency(invoices, STRIPE_LINE_FETCH_CONCURRENCY, async (invoice) => {
    const [lineItems] = await Promise.all([listInvoiceLines(invoice.id)]);
    const { customerId, customerName } = normalizeCustomer(invoice);
    return {
      invoice,
      customerId,
      customerName,
      lineItems,
    };
  });

  return {
    invoicesWithLines: results,
    hasMore,
    nextStartingAfter: hasMore ? startingAfter : null,
    fetchedInvoices: invoices.length,
  };
}

export async function listInvoicesWithLineItems(query?: StripeInvoiceQuery): Promise<StripeInvoiceWithLines[]> {
  const out: StripeInvoiceWithLines[] = [];
  let cursor: string | null = query?.startingAfter || null;
  const maxInvoices = Number(query?.maxInvoices || 0);
  let remaining = maxInvoices > 0 ? maxInvoices : Number.POSITIVE_INFINITY;

  while (remaining > 0) {
    const batchSize = Number.isFinite(remaining) ? Math.min(remaining, 500) : 500;
    const batch = await listInvoiceBatchWithLineItems({
      ...query,
      maxInvoices: batchSize,
      startingAfter: cursor,
    });
    out.push(...batch.invoicesWithLines);
    remaining = Number.isFinite(remaining) ? remaining - batch.fetchedInvoices : remaining;
    if (!batch.hasMore || !batch.nextStartingAfter || batch.fetchedInvoices === 0) break;
    cursor = batch.nextStartingAfter;
  }

  return out;
}

const PRICE_DISPLAY_NAME_CACHE = new Map<string, string>();
const PRICE_LOOKUP_CONCURRENCY = Number(process.env.STRIPE_PRICE_LOOKUP_CONCURRENCY || "6");

export async function getPriceDisplayNamesById(priceIds: string[]) {
  const uniqueIds = Array.from(new Set((priceIds || []).map((id) => String(id || "").trim()).filter(Boolean)));
  const idsToFetch = uniqueIds.filter((id) => !PRICE_DISPLAY_NAME_CACHE.has(id));

  await mapWithConcurrency(idsToFetch, PRICE_LOOKUP_CONCURRENCY, async (priceId) => {
    try {
      const params = new URLSearchParams();
      params.append("expand[]", "product");
      const price = await stripeFetch<StripePriceDetail>(`/prices/${encodeURIComponent(priceId)}`, params);
      PRICE_DISPLAY_NAME_CACHE.set(priceId, normalizePriceDisplayName(priceId, price));
    } catch {
      // Keep report generation resilient if one price lookup fails.
    }
  });

  const out: Record<string, string> = {};
  for (const id of uniqueIds) {
    const name = PRICE_DISPLAY_NAME_CACHE.get(id);
    if (name) out[id] = name;
  }
  return out;
}
