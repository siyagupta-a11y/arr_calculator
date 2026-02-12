// lib/fx.ts
const FRANKFURTER_BASE_URL = "https://api.frankfurter.app";

type FxOut = { rate: number; dateUsed: string };

const FX_MONTHLY_CACHE = new Map<string, FxOut>(); // key: YYYY-MM|FROM|TO

function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function fmtYyyyMmDd(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
