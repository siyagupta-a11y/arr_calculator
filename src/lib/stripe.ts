const STRIPE_BASE = "https://api.stripe.com/v1";
const STRIPE_MAX_RETRIES = 4;
const STRIPE_BASE_BACKOFF_MS = 300;
const STRIPE_LINE_FETCH_CONCURRENCY = Number(process.env.STRIPE_LINE_FETCH_CONCURRENCY || "12");

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
  recurring?: {
    interval?: string | null;
    interval_count?: number | null;
  } | null;
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

export async function listInvoicesWithLineItems(query?: StripeInvoiceQuery): Promise<StripeInvoiceWithLines[]> {
  const invoiceStatus = query?.status || process.env.STRIPE_INVOICE_STATUS || "paid";
  const invoices: StripeInvoice[] = [];
  let startingAfter: string | null = null;

  while (true) {
    const params = new URLSearchParams();
    params.set("limit", "100");
    params.set("status", invoiceStatus);
    params.append("expand[]", "data.customer");
    if (query?.createdGte) params.set("created[gte]", String(query.createdGte));
    if (query?.createdLte) params.set("created[lte]", String(query.createdLte));
    if (startingAfter) params.set("starting_after", startingAfter);

    const page = await stripeFetch<StripeListResponse<StripeInvoice>>("/invoices", params);
    invoices.push(...(page.data || []));

    if (!page.has_more || !page.data.length) break;
    startingAfter = page.data[page.data.length - 1].id;
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

  return results;
}
