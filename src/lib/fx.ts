// lib/fx.ts
import {
  loadCurrencyLayerMonthlyFxEntries,
  saveCurrencyLayerMonthlyFxEntries,
  type CurrencyLayerMonthlyFxEntry,
} from "@/lib/currencyLayerMonthlyFxStore";

const FRANKFURTER_BASE_URL = "https://api.frankfurter.app";
const CURRENCYLAYER_BASE_URL = String(process.env.CURRENCYLAYER_BASE_URL || "https://api.currencylayer.com").trim();
const CURRENCYLAYER_ACCESS_KEY = String(
  process.env.CURRENCYLAYER_ACCESS_KEY || process.env.CURRENCYLAYER_API_KEY || "",
).trim();

type FxOut = { rate: number; dateUsed: string };

const FX_MONTHLY_CACHE = new Map<string, FxOut>(); // key: YYYY-MM|FROM|TO
const CURRENCYLAYER_MONTHLY_CACHE = new Map<string, FxOut>(); // key: YYYY-MM|FROM|TO
const CURRENCYLAYER_TIMEFRAME_CACHE = new Map<string, Record<string, Record<string, number>>>(); // key: START|END|CUR1,CUR2
const CURRENCYLAYER_HISTORICAL_CACHE = new Map<string, Record<string, number>>(); // key: YYYY-MM-DD|CUR1,CUR2
const CURRENCYLAYER_PERSISTED_MONTHLY_CACHE = new Map<string, CurrencyLayerMonthlyFxEntry>();
let CURRENCYLAYER_PERSISTED_LOADED = false;
let CURRENCYLAYER_PERSISTED_LOAD_PROMISE: Promise<void> | null = null;
let CURRENCYLAYER_PERSISTED_SAVE_CHAIN = Promise.resolve();

type CurrencyLayerError = {
  code?: string;
  info?: string;
  rateLimited?: boolean;
};

type CurrencyLayerUsdQuotesResult = {
  quotes: Record<string, Record<string, number>>;
  error?: CurrencyLayerError;
};

function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function fmtYyyyMmDd(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysInMonth(start: Date) {
  const days: Date[] = [];
  const d = new Date(start.getFullYear(), start.getMonth(), 1);
  while (d.getMonth() === start.getMonth()) {
    days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

function dedupeCurrencies(values: string[]) {
  return Array.from(new Set(values.map((value) => String(value || "").trim().toUpperCase()).filter(Boolean)));
}

function nowMs() {
  return Date.now();
}

function isRateLimitedError(error: CurrencyLayerError | undefined) {
  if (!error) return false;
  if (error.rateLimited) return true;
  const code = Number(error.code || 0);
  return code === 104 || code === 106;
}

function normalizeCurrencyLayerCacheKey(value: string) {
  return String(value || "").trim().toUpperCase();
}

async function ensureCurrencyLayerPersistentCacheLoaded() {
  if (CURRENCYLAYER_PERSISTED_LOADED) return;
  if (CURRENCYLAYER_PERSISTED_LOAD_PROMISE) return CURRENCYLAYER_PERSISTED_LOAD_PROMISE;
  CURRENCYLAYER_PERSISTED_LOAD_PROMISE = (async () => {
    const payload = await loadCurrencyLayerMonthlyFxEntries();
    for (const [rawKey, entry] of Object.entries(payload.entries || {})) {
      const key = normalizeCurrencyLayerCacheKey(rawKey);
      if (!key) continue;
      CURRENCYLAYER_PERSISTED_MONTHLY_CACHE.set(key, entry);
      if (entry?.status === "ok" && Number(entry.rate || 0) > 0) {
        CURRENCYLAYER_MONTHLY_CACHE.set(key, {
          rate: Number(entry.rate || 0),
          dateUsed: String(entry.dateUsed || ""),
        });
      }
    }
    CURRENCYLAYER_PERSISTED_LOADED = true;
  })().finally(() => {
    CURRENCYLAYER_PERSISTED_LOAD_PROMISE = null;
  });
  return CURRENCYLAYER_PERSISTED_LOAD_PROMISE;
}

function queueCurrencyLayerPersistentCacheSave() {
  CURRENCYLAYER_PERSISTED_SAVE_CHAIN = CURRENCYLAYER_PERSISTED_SAVE_CHAIN
    .then(async () => {
      const entries = Object.fromEntries(CURRENCYLAYER_PERSISTED_MONTHLY_CACHE.entries());
      await saveCurrencyLayerMonthlyFxEntries(entries);
    })
    .catch(() => {
      // Keep request paths resilient even if persistence fails.
    });
  return CURRENCYLAYER_PERSISTED_SAVE_CHAIN;
}

async function setCurrencyLayerPersistentEntry(cacheKey: string, entry: CurrencyLayerMonthlyFxEntry) {
  await ensureCurrencyLayerPersistentCacheLoaded();
  const key = normalizeCurrencyLayerCacheKey(cacheKey);
  if (!key) return;
  const prev = CURRENCYLAYER_PERSISTED_MONTHLY_CACHE.get(key);
  const next: CurrencyLayerMonthlyFxEntry = {
    rate: Number(entry.rate || 0),
    dateUsed: String(entry.dateUsed || ""),
    status: entry.status,
    errorCode: entry.errorCode,
    errorInfo: entry.errorInfo,
    nextRetryAt: entry.nextRetryAt,
    updatedAt: Number(entry.updatedAt || nowMs()),
  };
  const prevSerialized = prev ? JSON.stringify(prev) : "";
  const nextSerialized = JSON.stringify(next);
  if (prevSerialized === nextSerialized) return;
  CURRENCYLAYER_PERSISTED_MONTHLY_CACHE.set(key, next);
  if (next.status === "ok" && next.rate > 0) {
    CURRENCYLAYER_MONTHLY_CACHE.set(key, { rate: next.rate, dateUsed: next.dateUsed });
  }
  await queueCurrencyLayerPersistentCacheSave();
}

function parseCurrencyLayerError(raw: unknown, httpStatus: number): CurrencyLayerError | undefined {
  if (!raw || typeof raw !== "object") {
    return httpStatus === 429 ? { rateLimited: true } : undefined;
  }
  const parsed = raw as {
    error?: {
      code?: number | string;
      info?: string;
    };
  };
  const code = parsed.error?.code != null ? String(parsed.error.code) : "";
  const info = String(parsed.error?.info || "").trim();
  const rateLimited = httpStatus === 429 || code === "104" || code === "106";
  if (!code && !info && !rateLimited) return undefined;
  return { code: code || undefined, info: info || undefined, rateLimited };
}

function parseUsdQuotes(quotes: Record<string, number | string> | undefined, currencies: string[]) {
  const out: Record<string, number> = {};
  if (!quotes) return out;
  for (const currency of currencies) {
    const raw = Number(quotes[`USD${currency}`]);
    if (!isNaN(raw) && raw > 0) out[currency] = raw;
  }
  return out;
}

function usdCrossRate(from: string, to: string, usdQuotes: Record<string, number>) {
  if (from === to) return 1;
  if (from === "USD") return Number(usdQuotes[to] || 0);
  if (to === "USD") {
    const usdToFrom = Number(usdQuotes[from] || 0);
    return usdToFrom > 0 ? 1 / usdToFrom : 0;
  }
  const usdToFrom = Number(usdQuotes[from] || 0);
  const usdToTo = Number(usdQuotes[to] || 0);
  if (usdToFrom <= 0 || usdToTo <= 0) return 0;
  return usdToTo / usdToFrom;
}

export async function getMonthlyAverageFxRateForCloseMonth(
  fromCurrency: string,
  toCurrency: string,
  closeDate: Date | null,
): Promise<FxOut> {
  const from = String(fromCurrency || "").trim().toUpperCase();
  const to = String(toCurrency || "").trim().toUpperCase();

  if (!from || !to) return { rate: 0, dateUsed: "" };
  if (from === to) return { rate: 1, dateUsed: "" };

  const d = closeDate && !isNaN(closeDate.getTime()) ? new Date(closeDate) : new Date();
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1);
  const monthEnd = endOfMonth(monthStart);

  const yyyyMm = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}`;
  const key = `${yyyyMm}|${from}|${to}`;
  if (FX_MONTHLY_CACHE.has(key)) return FX_MONTHLY_CACHE.get(key)!;

  const startStr = fmtYyyyMmDd(monthStart);
  const endStr = fmtYyyyMmDd(monthEnd);

  const avg = await fetchFrankfurterMonthlyAverage(startStr, endStr, from, to);
  const out = { rate: avg, dateUsed: yyyyMm };
  FX_MONTHLY_CACHE.set(key, out);
  return out;
}

async function fetchFrankfurterMonthlyAverage(
  startYyyyMmDd: string,
  endYyyyMmDd: string,
  from: string,
  to: string,
): Promise<number> {
  type FrankfurterRangeResponse = {
    rates?: Record<string, Record<string, number | string>>;
  };

  const url =
    `${FRANKFURTER_BASE_URL}/${encodeURIComponent(startYyyyMmDd)}..${encodeURIComponent(endYyyyMmDd)}` +
    `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return 0;

  let json: FrankfurterRangeResponse;
  try {
    json = (await res.json()) as FrankfurterRangeResponse;
  } catch {
    return 0;
  }

  const ratesObj = json?.rates || {};
  let sum = 0;
  let count = 0;

  for (const day of Object.keys(ratesObj)) {
    const r = Number(ratesObj?.[day]?.[to]);
    if (!isNaN(r) && r > 0) {
      sum += r;
      count++;
    }
  }

  if (!count) return 0;
  return sum / count;
}

export async function getMonthlyAverageCurrencyLayerFxRateForCloseMonth(
  fromCurrency: string,
  toCurrency: string,
  closeDate: Date | null,
): Promise<FxOut> {
  const from = String(fromCurrency || "").trim().toUpperCase();
  const to = String(toCurrency || "").trim().toUpperCase();

  if (!from || !to) return { rate: 0, dateUsed: "" };
  if (from === to) return { rate: 1, dateUsed: "" };
  if (!CURRENCYLAYER_ACCESS_KEY) return { rate: 0, dateUsed: "" };

  const d = closeDate && !isNaN(closeDate.getTime()) ? new Date(closeDate) : new Date();
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1);
  const monthEnd = endOfMonth(monthStart);

  const yyyyMm = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}`;
  const cacheKey = `${yyyyMm}|${from}|${to}`;
  if (CURRENCYLAYER_MONTHLY_CACHE.has(cacheKey)) {
    const cached = CURRENCYLAYER_MONTHLY_CACHE.get(cacheKey)!;
    if (Number(cached.rate || 0) > 0) return cached;
    CURRENCYLAYER_MONTHLY_CACHE.delete(cacheKey);
  }
  await ensureCurrencyLayerPersistentCacheLoaded();
  const persisted = CURRENCYLAYER_PERSISTED_MONTHLY_CACHE.get(normalizeCurrencyLayerCacheKey(cacheKey));
  if (persisted?.status === "ok" && Number(persisted.rate || 0) > 0) {
    const out = { rate: Number(persisted.rate || 0), dateUsed: String(persisted.dateUsed || yyyyMm) };
    CURRENCYLAYER_MONTHLY_CACHE.set(cacheKey, out);
    return out;
  }
  if (
    persisted?.status === "rate_limited" &&
    Number(persisted.nextRetryAt || 0) > nowMs()
  ) {
    return { rate: 0, dateUsed: yyyyMm };
  }

  const startStr = fmtYyyyMmDd(monthStart);
  const endStr = fmtYyyyMmDd(monthEnd);
  const neededCurrencies = dedupeCurrencies([from, to].filter((currency) => currency !== "USD"));

  const timeframe = await fetchCurrencyLayerTimeframeUsdQuotes(startStr, endStr, neededCurrencies);
  let sum = 0;
  let count = 0;
  let latestError: CurrencyLayerError | undefined = timeframe.error;

  for (const usdQuotes of Object.values(timeframe.quotes)) {
    const rate = usdCrossRate(from, to, usdQuotes);
    if (!isNaN(rate) && rate > 0) {
      sum += rate;
      count += 1;
    }
  }

  if (count === 0) {
    const dayValues: number[] = [];
    for (const day of daysInMonth(monthStart)) {
      const dayIso = fmtYyyyMmDd(day);
      const historical = await fetchCurrencyLayerHistoricalUsdQuotes(dayIso, neededCurrencies);
      if (historical.error) {
        latestError = historical.error;
        if (isRateLimitedError(historical.error)) break;
      }
      dayValues.push(usdCrossRate(from, to, historical.quotes));
    }
    for (const rate of dayValues) {
      if (!isNaN(rate) && rate > 0) {
        sum += rate;
        count += 1;
      }
    }
  }

  const out = { rate: count > 0 ? sum / count : 0, dateUsed: yyyyMm };
  if (out.rate > 0) {
    CURRENCYLAYER_MONTHLY_CACHE.set(cacheKey, out);
  }
  if (count > 0 && out.rate > 0) {
    await setCurrencyLayerPersistentEntry(cacheKey, {
      rate: out.rate,
      dateUsed: yyyyMm,
      status: "ok",
      updatedAt: nowMs(),
    });
  } else {
    const rateLimited = isRateLimitedError(latestError);
    await setCurrencyLayerPersistentEntry(cacheKey, {
      rate: 0,
      dateUsed: yyyyMm,
      status: rateLimited ? "rate_limited" : "error",
      errorCode: latestError?.code,
      errorInfo: latestError?.info,
      nextRetryAt: nowMs() + (rateLimited ? 6 * 60 * 60 * 1000 : 60 * 60 * 1000),
      updatedAt: nowMs(),
    });
  }
  return out;
}

async function fetchCurrencyLayerTimeframeUsdQuotes(
  startYyyyMmDd: string,
  endYyyyMmDd: string,
  currencies: string[],
): Promise<CurrencyLayerUsdQuotesResult> {
  if (!currencies.length) return { quotes: {} };
  const normalized = dedupeCurrencies(currencies);
  const key = `${startYyyyMmDd}|${endYyyyMmDd}|${normalized.join(",")}`;
  if (CURRENCYLAYER_TIMEFRAME_CACHE.has(key)) {
    return { quotes: CURRENCYLAYER_TIMEFRAME_CACHE.get(key)! };
  }

  type CurrencyLayerTimeframeResponse = {
    success?: boolean;
    quotes?: Record<string, Record<string, number | string>>;
    error?: {
      code?: number | string;
      info?: string;
    };
  };

  const url =
    `${CURRENCYLAYER_BASE_URL}/timeframe?access_key=${encodeURIComponent(CURRENCYLAYER_ACCESS_KEY)}` +
    `&start_date=${encodeURIComponent(startYyyyMmDd)}` +
    `&end_date=${encodeURIComponent(endYyyyMmDd)}` +
    `&source=USD&currencies=${encodeURIComponent(normalized.join(","))}`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { quotes: {}, error: parseCurrencyLayerError(parsed, res.status) };
  }

  let json: CurrencyLayerTimeframeResponse;
  try {
    json = (await res.json()) as CurrencyLayerTimeframeResponse;
  } catch {
    return { quotes: {} };
  }

  if (!json.success || !json.quotes) {
    return { quotes: {}, error: parseCurrencyLayerError(json, res.status) };
  }

  const out: Record<string, Record<string, number>> = {};
  for (const [day, dayQuotes] of Object.entries(json.quotes)) {
    out[day] = parseUsdQuotes(dayQuotes, normalized);
  }
  CURRENCYLAYER_TIMEFRAME_CACHE.set(key, out);
  return { quotes: out };
}

async function fetchCurrencyLayerHistoricalUsdQuotes(
  dayYyyyMmDd: string,
  currencies: string[],
): Promise<{ quotes: Record<string, number>; error?: CurrencyLayerError }> {
  if (!currencies.length) return { quotes: {} };
  const normalized = dedupeCurrencies(currencies);
  const key = `${dayYyyyMmDd}|${normalized.join(",")}`;
  if (CURRENCYLAYER_HISTORICAL_CACHE.has(key)) {
    return { quotes: CURRENCYLAYER_HISTORICAL_CACHE.get(key)! };
  }

  type CurrencyLayerHistoricalResponse = {
    success?: boolean;
    quotes?: Record<string, number | string>;
    error?: {
      code?: number | string;
      info?: string;
    };
  };

  const url =
    `${CURRENCYLAYER_BASE_URL}/historical?access_key=${encodeURIComponent(CURRENCYLAYER_ACCESS_KEY)}` +
    `&date=${encodeURIComponent(dayYyyyMmDd)}` +
    `&source=USD&currencies=${encodeURIComponent(normalized.join(","))}`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { quotes: {}, error: parseCurrencyLayerError(parsed, res.status) };
  }

  let json: CurrencyLayerHistoricalResponse;
  try {
    json = (await res.json()) as CurrencyLayerHistoricalResponse;
  } catch {
    return { quotes: {} };
  }

  if (!json.success) {
    return { quotes: {}, error: parseCurrencyLayerError(json, res.status) };
  }
  const out = parseUsdQuotes(json.quotes, normalized);
  CURRENCYLAYER_HISTORICAL_CACHE.set(key, out);
  return { quotes: out };
}
