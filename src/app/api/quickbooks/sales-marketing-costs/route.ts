import { NextResponse } from "next/server";
import { fetchQuickBooksSalesMarketingCostsByMonth } from "@/lib/quickbooks";
import {
  getMonthlyAverageCurrencyLayerFxRateForCloseMonth,
  getMonthlyAverageFxRateForCloseMonth,
} from "@/lib/fx";
import { FX_TARGET_CURRENCY } from "@/lib/logic";

export const runtime = "nodejs";
export const maxDuration = 300;

type RequestBody = {
  startDate?: string;
  endDate?: string;
  accountIds?: string[];
  accountNames?: string[];
  fxProvider?: "frankfurter" | "currencylayer";
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

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const body = (raw ? JSON.parse(raw) : {}) as RequestBody;
    const startDate = String(body.startDate || "");
    const endDate = String(body.endDate || "");
    const accountIds = normalizeIds(body.accountIds);
    const accountNames = normalizeNames(body.accountNames);
    const payload = await fetchQuickBooksSalesMarketingCostsByMonth(startDate, endDate, {
      selectedAccountIds: accountIds,
      selectedAccountNames: accountNames,
    });

    // Convert costs to target currency using monthly average FX rates
    const sourceCurrency = String(payload.currency || "").trim().toUpperCase();
    const targetCurrency = String(FX_TARGET_CURRENCY || "USD").trim().toUpperCase();
    const fxProvider = String(body.fxProvider || "frankfurter").trim().toLowerCase();
    const monthlyRateForMonth =
      fxProvider === "currencylayer"
        ? getMonthlyAverageCurrencyLayerFxRateForCloseMonth
        : getMonthlyAverageFxRateForCloseMonth;
    if (sourceCurrency && targetCurrency && sourceCurrency !== targetCurrency && payload.points?.length) {
      // Collect unique month keys and fetch FX rates in parallel
      const monthKeys = [
        ...new Set(
          payload.points
            .map((p) => String(p.key || p.periodStart || "").slice(0, 7))
            .filter(Boolean),
        ),
      ];
      const fxMap = new Map<string, number>();
      await Promise.all(
        monthKeys.map(async (monthKey) => {
          const date = new Date(`${monthKey}-01T00:00:00Z`);
          const fx = await monthlyRateForMonth(sourceCurrency, targetCurrency, date);
          fxMap.set(monthKey, fx.rate);
        }),
      );

      // Apply conversion to each point
      const convertedPoints = payload.points.map((p) => {
        const monthKey = String(p.key || p.periodStart || "").slice(0, 7);
        const rate = fxMap.get(monthKey) ?? 0;
        const originalCost = Number(p.totalCost || 0);
        const convertedCost = rate > 0 ? Math.round(originalCost * rate * 100) / 100 : originalCost;
        return { ...p, totalCost: convertedCost };
      });

      return NextResponse.json({ ...payload, currency: targetCurrency, points: convertedPoints });
    }

    return NextResponse.json(payload);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: statusCodeFromMessage(message) });
  }
}
