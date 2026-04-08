import { NextResponse } from "next/server";
import { fetchQuickBooksSalesMarketingCostsByMonth } from "@/lib/quickbooks";
import {
  getMonthlyAverageCurrencyLayerFxRateForCloseMonth,
  getMonthlyAverageFxRateForCloseMonth,
} from "@/lib/fx";
import { FX_TARGET_CURRENCY } from "@/lib/logic";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";

export const runtime = "nodejs";
export const maxDuration = 300;
const CACHE_TTL_MS = readTtlMs("API_QUICKBOOKS_SALES_MARKETING_COSTS_CACHE_TTL_MS", 60_000);

type RequestBody = {
  startDate?: string;
  endDate?: string;
  accountIds?: string[];
  accountNames?: string[];
  fxProvider?: "frankfurter" | "currencylayer";
  targetCurrency?: string;
};

function normalizeIds(values: unknown) {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => String(value || "").trim().replace(/\.0+$/, ""))
        .filter(Boolean),
    ),
  );
}

function normalizeNames(values: unknown) {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

function statusCodeFromMessage(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes("invalid startdate") || lower.includes("invalid enddate")) return 400;
  if (lower.includes("enddate must be >=")) return 400;
  if (lower.includes("not connected")) return 400;
  return 500;
}

function round2(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeCurrency(value: unknown, fallback = "") {
  const normalized = String(value || "").trim().toUpperCase();
  return normalized || fallback;
}

function monthKeyFromPoint(point: { key?: string; periodStart?: string }) {
  return String(point.key || point.periodStart || "").slice(0, 7);
}

function realmIdFromScopedAccountId(value: string) {
  const text = String(value || "").trim();
  const idx = text.indexOf(":");
  if (idx <= 0) return "";
  return text.slice(0, idx).trim();
}

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const body = (raw ? JSON.parse(raw) : {}) as RequestBody;
    const startDate = String(body.startDate || "");
    const endDate = String(body.endDate || "");
    const accountIds = normalizeIds(body.accountIds);
    const accountNames = normalizeNames(body.accountNames);
    const targetCurrency = normalizeCurrency(body.targetCurrency, normalizeCurrency(FX_TARGET_CURRENCY, "USD"));
    const fxProvider = String(body.fxProvider || "frankfurter").trim().toLowerCase();
    const key = `api:quickbooks:sales-marketing-costs:${stableStringify({
      startDate,
      endDate,
      accountIds,
      accountNames,
      targetCurrency,
      fxProvider,
    })}`;

    const responsePayload = await getOrSetCache(key, CACHE_TTL_MS, async () => {
      const payload = await fetchQuickBooksSalesMarketingCostsByMonth(startDate, endDate, {
        selectedAccountIds: accountIds,
        selectedAccountNames: accountNames,
      });

      // Convert costs to target currency using monthly average FX rates
      const defaultSourceCurrency = normalizeCurrency(payload.currency, "USD");
      const monthlyRateForMonth =
        fxProvider === "currencylayer"
          ? getMonthlyAverageCurrencyLayerFxRateForCloseMonth
          : getMonthlyAverageFxRateForCloseMonth;
      const points = Array.isArray(payload.points) ? payload.points : [];
      if (!targetCurrency || !points.length) {
        return payload;
      }

      const accountCurrencyByAccountId = payload.accountCurrencyByAccountId || {};
      const realmCurrencyByRealmId = payload.realmCurrencyByRealmId || {};
      const currencies = new Set<string>();
      const conversionPairs = new Set<string>();

      for (const point of points) {
        const monthKey = monthKeyFromPoint(point);
        if (!monthKey) continue;
        const pointCostByCurrency =
          point.costByCurrency && Object.keys(point.costByCurrency).length > 0
            ? point.costByCurrency
            : { [defaultSourceCurrency]: Number(point.totalCost || 0) };
        for (const sourceCurrencyRaw of Object.keys(pointCostByCurrency)) {
          const sourceCurrency = normalizeCurrency(sourceCurrencyRaw, defaultSourceCurrency);
          if (!sourceCurrency) continue;
          currencies.add(sourceCurrency);
          if (sourceCurrency !== targetCurrency) {
            conversionPairs.add(`${sourceCurrency}|${targetCurrency}|${monthKey}`);
          }
        }
        for (const accountId of Object.keys(point.accountCostsByAccountId || {})) {
          const accountCurrency = normalizeCurrency(
            accountCurrencyByAccountId[accountId],
            normalizeCurrency(realmCurrencyByRealmId[realmIdFromScopedAccountId(accountId)], defaultSourceCurrency),
          );
          if (!accountCurrency) continue;
          currencies.add(accountCurrency);
          if (accountCurrency !== targetCurrency) {
            conversionPairs.add(`${accountCurrency}|${targetCurrency}|${monthKey}`);
          }
        }
      }

      const fxMap = new Map<string, number>();
      await Promise.all(
        Array.from(conversionPairs).map(async (pairKey) => {
          const [sourceCurrency, targetCurrencyForPair, monthKey] = pairKey.split("|");
          const date = new Date(`${monthKey}-01T00:00:00Z`);
          const fx = await monthlyRateForMonth(sourceCurrency, targetCurrencyForPair, date);
          fxMap.set(pairKey, fx.rate);
        }),
      );

      const convertAmount = (amount: number, sourceCurrencyRaw: string, monthKey: string) => {
        const sourceCurrency = normalizeCurrency(sourceCurrencyRaw, defaultSourceCurrency);
        const rawAmount = Number(amount || 0);
        if (!sourceCurrency || sourceCurrency === targetCurrency) return round2(rawAmount);
        const rate = fxMap.get(`${sourceCurrency}|${targetCurrency}|${monthKey}`) || 0;
        if (rate <= 0) return round2(rawAmount);
        return round2(rawAmount * rate);
      };

      const convertedPoints = points.map((point) => {
        const monthKey = monthKeyFromPoint(point);
        const pointCostByCurrency =
          point.costByCurrency && Object.keys(point.costByCurrency).length > 0
            ? point.costByCurrency
            : { [defaultSourceCurrency]: Number(point.totalCost || 0) };
        let convertedTotalCost = 0;
        for (const [sourceCurrency, amount] of Object.entries(pointCostByCurrency)) {
          convertedTotalCost = round2(
            convertedTotalCost + convertAmount(Number(amount || 0), sourceCurrency, monthKey),
          );
        }

        const convertedAccountCostsByAccountId: Record<string, number> = {};
        for (const [accountId, amountRaw] of Object.entries(point.accountCostsByAccountId || {})) {
          const sourceCurrency = normalizeCurrency(
            accountCurrencyByAccountId[accountId],
            normalizeCurrency(realmCurrencyByRealmId[realmIdFromScopedAccountId(accountId)], defaultSourceCurrency),
          );
          convertedAccountCostsByAccountId[accountId] = convertAmount(Number(amountRaw || 0), sourceCurrency, monthKey);
        }

        return {
          ...point,
          totalCost: round2(convertedTotalCost),
          accountCostsByAccountId: convertedAccountCostsByAccountId,
        };
      });

      return {
        ...payload,
        currency: targetCurrency,
        sourceCurrencies: Array.from(currencies).sort(),
        points: convertedPoints,
      };
    });

    return NextResponse.json(responsePayload);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: statusCodeFromMessage(message) });
  }
}
