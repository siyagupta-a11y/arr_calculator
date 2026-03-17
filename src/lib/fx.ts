// lib/fx.ts
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
  if (CURRENCYLAYER_MONTHLY_CACHE.has(cacheKey)) return CURRENCYLAYER_MONTHLY_CACHE.get(cacheKey)!;

  const startStr = fmtYyyyMmDd(monthStart);
  const endStr = fmtYyyyMmDd(monthEnd);
  const neededCurrencies = dedupeCurrencies([from, to].filter((currency) => currency !== "USD"));

  const timeframeQuotes = await fetchCurrencyLayerTimeframeUsdQuotes(startStr, endStr, neededCurrencies);
  let sum = 0;
  let count = 0;
  for (const usdQuotes of Object.values(timeframeQuotes)) {
    const rate = usdCrossRate(from, to, usdQuotes);
    if (!isNaN(rate) && rate > 0) {
      sum += rate;
      count += 1;
    }
  }

  if (count === 0) {
    const dayValues = await Promise.all(
      daysInMonth(monthStart).map(async (day) => {
        const dayIso = fmtYyyyMmDd(day);
        const usdQuotes = await fetchCurrencyLayerHistoricalUsdQuotes(dayIso, neededCurrencies);
        return usdCrossRate(from, to, usdQuotes);
      }),
    );
    for (const rate of dayValues) {
      if (!isNaN(rate) && rate > 0) {
        sum += rate;
        count += 1;
      }
    }
  }

  const out = { rate: count > 0 ? sum / count : 0, dateUsed: yyyyMm };
  CURRENCYLAYER_MONTHLY_CACHE.set(cacheKey, out);
  return out;
}

async function fetchCurrencyLayerTimeframeUsdQuotes(
  startYyyyMmDd: string,
  endYyyyMmDd: string,
  currencies: string[],
): Promise<Record<string, Record<string, number>>> {
  if (!currencies.length) return {};
  const normalized = dedupeCurrencies(currencies);
  const key = `${startYyyyMmDd}|${endYyyyMmDd}|${normalized.join(",")}`;
  if (CURRENCYLAYER_TIMEFRAME_CACHE.has(key)) return CURRENCYLAYER_TIMEFRAME_CACHE.get(key)!;

  type CurrencyLayerTimeframeResponse = {
    success?: boolean;
    quotes?: Record<string, Record<string, number | string>>;
  };

  const url =
    `${CURRENCYLAYER_BASE_URL}/timeframe?access_key=${encodeURIComponent(CURRENCYLAYER_ACCESS_KEY)}` +
    `&start_date=${encodeURIComponent(startYyyyMmDd)}` +
    `&end_date=${encodeURIComponent(endYyyyMmDd)}` +
    `&source=USD&currencies=${encodeURIComponent(normalized.join(","))}`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return {};

  let json: CurrencyLayerTimeframeResponse;
  try {
    json = (await res.json()) as CurrencyLayerTimeframeResponse;
  } catch {
    return {};
  }

  if (!json.success || !json.quotes) return {};

  const out: Record<string, Record<string, number>> = {};
  for (const [day, dayQuotes] of Object.entries(json.quotes)) {
    out[day] = parseUsdQuotes(dayQuotes, normalized);
  }
  CURRENCYLAYER_TIMEFRAME_CACHE.set(key, out);
  return out;
}

async function fetchCurrencyLayerHistoricalUsdQuotes(
  dayYyyyMmDd: string,
  currencies: string[],
): Promise<Record<string, number>> {
  if (!currencies.length) return {};
  const normalized = dedupeCurrencies(currencies);
  const key = `${dayYyyyMmDd}|${normalized.join(",")}`;
  if (CURRENCYLAYER_HISTORICAL_CACHE.has(key)) return CURRENCYLAYER_HISTORICAL_CACHE.get(key)!;

  type CurrencyLayerHistoricalResponse = {
    success?: boolean;
    quotes?: Record<string, number | string>;
  };

  const url =
    `${CURRENCYLAYER_BASE_URL}/historical?access_key=${encodeURIComponent(CURRENCYLAYER_ACCESS_KEY)}` +
    `&date=${encodeURIComponent(dayYyyyMmDd)}` +
    `&source=USD&currencies=${encodeURIComponent(normalized.join(","))}`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return {};

  let json: CurrencyLayerHistoricalResponse;
  try {
    json = (await res.json()) as CurrencyLayerHistoricalResponse;
  } catch {
    return {};
  }

  if (!json.success) return {};
  const out = parseUsdQuotes(json.quotes, normalized);
  CURRENCYLAYER_HISTORICAL_CACHE.set(key, out);
  return out;
}
