import { fetchDealsInStage, fetchLineItemIdsForDeals, batchReadLineItems } from "@/lib/hubspot";
import { getMonthlyAverageFxRateForCloseMonth } from "@/lib/fx";
import {
  LI_PROPS,
  FX_TARGET_CURRENCY,
  parseDate,
  firstOfMonth,
  computeWindowForLineItem,
  computeCalculatedArrForLineItem,
  isOneTimeLineItem,
  buildMonthlyPeriods,
  aggregatePeriodsFromMonthly,
  round2,
} from "@/lib/logic";
import type { ReportRequest, ReportResponse, ReportRow, HubspotLineItem } from "@/lib/types";

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

type DealMeta = {
  dealId: string;
  dealName: string;
  deploymentType: string;
  accountId: string;
  territory: string;
  country: string;
  industry: string;
  closeDate: Date | null;
  closeMonth: Date | null;
  closeDateInRange: boolean;
  dealCurrency: string;
  dealType: string;
};

function formatDayKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function buildDailyPeriods(start: Date, end: Date) {
  const periods: Array<{ key: string; label: string; day: Date }> = [];
  for (
    let day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    day <= end;
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  ) {
    const d = new Date(day);
    const key = formatDayKey(d);
    periods.push({ key, label: key, day: d });
  }
  return periods;
}

function findEarliestNonOneTimeLineItemStart(
  liIds: string[],
  lineItemsById: Map<string, HubspotLineItem>,
) {
  let best: { liId: string; start: Date } | null = null;

  for (const liId of liIds) {
    const li = lineItemsById.get(liId);
    const p = li?.properties || {};

    if (isOneTimeLineItem(p)) continue;

    const arr = computeCalculatedArrForLineItem(p);
    if (!arr || arr <= 0) continue;

    const w = computeWindowForLineItem(p);
    const start = w?.start ? new Date(w.start) : null;
    if (!start || isNaN(start.getTime())) continue;

    if (!best || start < best.start) best = { liId, start };
  }

  return best;
}

export async function generateReport(
  body: ReportRequest & { startMonth?: string; endMonth?: string },
): Promise<ReportResponse> {
  const includedStage = mustEnv("INCLUDED_DEALSTAGE");

  const rawStart = body.startDate || body.startMonth;
  const rawEnd = body.endDate || body.endMonth;
  const startVal = parseDate(rawStart);
  const endVal = parseDate(rawEnd);
  if (!startVal || !endVal || isNaN(startVal.getTime()) || isNaN(endVal.getTime())) {
    throw new Error("Invalid startDate/endDate");
  }

  const rangeStart = new Date(startVal.getFullYear(), startVal.getMonth(), startVal.getDate(), 0, 0, 0, 0);
  const rangeEnd = new Date(endVal.getFullYear(), endVal.getMonth(), endVal.getDate(), 23, 59, 59, 999);
  if (rangeEnd < rangeStart) {
    throw new Error("endDate must be >= startDate");
  }

  const monthlyPeriods = buildMonthlyPeriods(firstOfMonth(rangeStart), firstOfMonth(rangeEnd));
  const dailyPeriods = buildDailyPeriods(rangeStart, rangeEnd);
  const aggregated = aggregatePeriodsFromMonthly(monthlyPeriods, body.grain);
  const outputPeriods =
    body.grain === "daily"
      ? dailyPeriods.map((p) => ({ key: p.key, label: p.label }))
      : aggregated.map((p) => ({ key: p.key, label: p.label }));

  const DEPLOYMENT_TYPE_PROP = "deployment_type__c";
  const ACCOUNT_ID_PROP = "hs_primary_associated_company";
  const TERRITORY_PROP = process.env.DEAL_TERRITORY_PROP || "territory";
  const COUNTRY_PROP = process.env.DEAL_COUNTRY_PROP || "country";
  const INDUSTRY_PROP = process.env.DEAL_INDUSTRY_PROP || "industry";

  const dealProps = [
    "dealname",
    "dealtype",
    "deal_currency_code",
    "closedate",
    DEPLOYMENT_TYPE_PROP,
    ACCOUNT_ID_PROP,
    TERRITORY_PROP,
    COUNTRY_PROP,
    INDUSTRY_PROP,
  ];

  const deals = await fetchDealsInStage(dealProps, includedStage);
  if (!deals.length) {
    return { periods: outputPeriods, totalsByPeriod: [], rows: [] };
  }

  const allDealMeta: DealMeta[] = deals.map((d) => {
    const pDeal = d.properties || {};
    const closeDate = parseDate(pDeal.closedate);
    const closeMonth = closeDate ? firstOfMonth(closeDate) : null;
    const closeDateInRange =
      !!closeDate &&
      closeDate.getTime() >= rangeStart.getTime() &&
      closeDate.getTime() <= rangeEnd.getTime();

    return {
      dealId: String(d.id),
      dealName: String(pDeal.dealname || ""),
      deploymentType: String(pDeal[DEPLOYMENT_TYPE_PROP] || ""),
      accountId: String(pDeal[ACCOUNT_ID_PROP] || ""),
      territory: String(pDeal[TERRITORY_PROP] || ""),
      country: String(pDeal[COUNTRY_PROP] || ""),
      industry: String(pDeal[INDUSTRY_PROP] || ""),
      closeDate,
      closeMonth,
      closeDateInRange,
      dealCurrency: String(pDeal.deal_currency_code || FX_TARGET_CURRENCY).trim().toUpperCase(),
      dealType: String(pDeal.dealtype || "").trim(),
    };
  });

  const dealMeta =
    body.mode === "contracted" && !body.contractedIncludeAllDeals && body.grain !== "daily"
      ? allDealMeta.filter((m) => m.closeDateInRange)
      : allDealMeta;
  if (!dealMeta.length) {
    return { periods: outputPeriods, totalsByPeriod: [], rows: [] };
  }

  const dealToLineItemIds = new Map<string, string[]>();
  const allLineItemIds = new Set<string>();

  const dealIdResults = await fetchLineItemIdsForDeals(dealMeta.map((m) => m.dealId));
  for (const { dealId, ids } of dealIdResults) {
    dealToLineItemIds.set(dealId, ids);
    ids.forEach((id) => allLineItemIds.add(id));
  }

  const lineItemsById = await batchReadLineItems(Array.from(allLineItemIds), LI_PROPS);

  const fxByKey = new Map<string, Awaited<ReturnType<typeof getMonthlyAverageFxRateForCloseMonth>>>();
  const fxPromises = new Map<string, Promise<Awaited<ReturnType<typeof getMonthlyAverageFxRateForCloseMonth>>>>();

  for (const m of dealMeta) {
    const monthKey = m.closeDate
      ? `${m.closeDate.getFullYear()}-${String(m.closeDate.getMonth() + 1).padStart(2, "0")}`
      : "current";
    const key = `${m.dealCurrency}|${monthKey}`;
    if (!fxPromises.has(key)) {
      fxPromises.set(key, getMonthlyAverageFxRateForCloseMonth(m.dealCurrency, FX_TARGET_CURRENCY, m.closeDate));
    }
  }

  await Promise.all(
    Array.from(fxPromises.entries()).map(async ([key, p]) => {
      fxByKey.set(key, await p);
    }),
  );

  const rows: ReportRow[] = [];

  for (const m of dealMeta) {
    const {
      dealId,
      dealName,
      deploymentType,
      accountId,
      territory,
      country,
      industry,
      closeDate,
      closeMonth,
      dealCurrency,
      dealType,
    } = m;

    const monthKey = closeDate
      ? `${closeDate.getFullYear()}-${String(closeDate.getMonth() + 1).padStart(2, "0")}`
      : "current";
    const fx = fxByKey.get(`${dealCurrency}|${monthKey}`) || { rate: 0, dateUsed: "" };

    const liIds = dealToLineItemIds.get(dealId) || [];
    if (!liIds.length) continue;

    const t = dealType.toLowerCase();
    const isExistingBusiness = t === "existingbusiness" || t === "upsell";

    const earliest =
      body.mode === "contracted" ? findEarliestNonOneTimeLineItemStart(liIds, lineItemsById) : null;

    const earliestLiId = earliest?.liId || null;
    const earliestStart = earliest?.start || null;
    const earliestBillingStartMonth = earliestStart ? firstOfMonth(earliestStart) : null;

    const allowCarry =
      body.mode === "contracted" &&
      !isExistingBusiness &&
      closeDate &&
      closeMonth &&
      earliestStart &&
      closeDate < earliestStart;

    for (const liId of liIds) {
      const li = lineItemsById.get(liId);
      const p = li?.properties || {};
      const w = computeWindowForLineItem(p);

      const liArr = computeCalculatedArrForLineItem(p);
      const liArrFx = fx.rate && liArr ? round2(liArr * fx.rate) : 0;

      const valuesMonthly: Record<string, number> = {};
      for (const mp of monthlyPeriods) {
        if (!w || !liArrFx) {
          valuesMonthly[mp.key] = 0;
          continue;
        }

        const monthEnd = mp.end;
        const coversMonthEnd = w.start <= monthEnd && w.end >= monthEnd;

        if (body.mode === "arr") {
          valuesMonthly[mp.key] = coversMonthEnd ? liArrFx : 0;
          continue;
        }

        if (isExistingBusiness) {
          valuesMonthly[mp.key] = coversMonthEnd ? liArrFx : 0;
          continue;
        }

        const isEarliestRecurring = earliestLiId && liId === earliestLiId;

        if (!isEarliestRecurring) {
          valuesMonthly[mp.key] = coversMonthEnd ? liArrFx : 0;
          continue;
        }

        const isCloseMonth = closeMonth ? mp.start.getTime() === closeMonth.getTime() : false;

        const inCarryRange =
          !!allowCarry &&
          !!closeMonth &&
          !!earliestBillingStartMonth &&
          mp.start.getTime() >= closeMonth.getTime() &&
          mp.start.getTime() <= earliestBillingStartMonth.getTime();

        const show = isCloseMonth || inCarryRange || coversMonthEnd;
        valuesMonthly[mp.key] = show ? liArrFx : 0;
      }

      const valuesByPeriod: Record<string, number> = {};
      if (body.grain === "monthly") {
        for (const mp of monthlyPeriods) valuesByPeriod[mp.key] = valuesMonthly[mp.key] || 0;
      } else if (body.grain === "quarterly" || body.grain === "annually") {
        for (const ap of aggregated as Array<{ key: string; members?: string[] }>) {
          const members: string[] = ap.members || [];
          const sum = members.reduce((acc, k) => acc + (valuesMonthly[k] || 0), 0);
          valuesByPeriod[ap.key] = round2(sum);
        }
      } else {
        const closeDayKey = closeDate ? formatDayKey(closeDate) : null;
        const earliestStartDay = earliestStart
          ? new Date(earliestStart.getFullYear(), earliestStart.getMonth(), earliestStart.getDate())
          : null;
        const closeDay = closeDate
          ? new Date(closeDate.getFullYear(), closeDate.getMonth(), closeDate.getDate())
          : null;

        for (const dp of dailyPeriods) {
          const dayPoint = dp.day;
          const coversDay = !!w && !!liArrFx && w.start <= dayPoint && w.end >= dayPoint;

          if (body.mode === "arr") {
            valuesByPeriod[dp.key] = coversDay ? liArrFx : 0;
            continue;
          }

          if (body.mode === "contracted") {
            valuesByPeriod[dp.key] = coversDay ? liArrFx : 0;
            continue;
          }

          if (isExistingBusiness) {
            valuesByPeriod[dp.key] = coversDay ? liArrFx : 0;
            continue;
          }

          const isEarliestRecurring = earliestLiId && liId === earliestLiId;
          if (!isEarliestRecurring) {
            valuesByPeriod[dp.key] = coversDay ? liArrFx : 0;
            continue;
          }

          const isCloseDay = closeDayKey ? dp.key === closeDayKey : false;
          const inCarryRange =
            !!allowCarry &&
            !!closeDay &&
            !!earliestStartDay &&
            dayPoint.getTime() >= closeDay.getTime() &&
            dayPoint.getTime() <= earliestStartDay.getTime();

          valuesByPeriod[dp.key] = isCloseDay || inCarryRange || coversDay ? liArrFx : 0;
        }
      }

      rows.push({
        dealName,
        dealId,
        lineItemId: liId,

        valueUsd: liArrFx,
        dealCurrency,
        fxRate: fx.rate || null,
        fxDateUsed: fx.dateUsed || "",

        dealType,
        closeDate: closeDate ? closeDate.toISOString().slice(0, 10) : "",

        windowStart: w?.start ? w.start.toISOString().slice(0, 10) : "",
        windowEnd: w ? (w.endIsOpenEnded ? "OPEN" : w.end.toISOString().slice(0, 10)) : "",
        isOpenEnded: w?.endIsOpenEnded ? true : false,

        recurringbillingfrequency: String(p.recurringbillingfrequency || ""),
        termMonths: p.hs_term_in_months ? Number(p.hs_term_in_months) : null,
        amount: p.amount ? Number(p.amount) : null,
        netPrice: p.net_price ? Number(p.net_price) : null,
        quantity: p.quantity ? Number(p.quantity) : 1,

        valuesByPeriod,
        deploymentType,
        accountId,
        territory,
        country,
        industry,
      });
    }
  }

  const totalsByPeriod = outputPeriods.map((p) => {
    const total = round2(rows.reduce((acc, r) => acc + (r.valuesByPeriod[p.key] || 0), 0));
    return { ...p, total };
  });

  return {
    periods: outputPeriods,
    totalsByPeriod,
    rows,
  };
}

export type CurrentDealMetrics = {
  asOfDate: string;
  dealId: string;
  currentArr: number;
  currentCarr: number;
};

function sumByDealForPeriod(report: ReportResponse, periodKey: string) {
  const byDeal = new Map<string, number>();
  for (const row of report.rows) {
    const current = byDeal.get(row.dealId) || 0;
    byDeal.set(row.dealId, round2(current + (row.valuesByPeriod[periodKey] || 0)));
  }
  return byDeal;
}

export async function generateCurrentDealMetrics(asOfDate?: string): Promise<CurrentDealMetrics[]> {
  const includedStage = mustEnv("INCLUDED_DEALSTAGE");
  const asOf = asOfDate || new Date().toISOString().slice(0, 10);
  const deals = await fetchDealsInStage(["dealname"], includedStage);
  if (!deals.length) return [];

  const [arrReport, carrReport] = await Promise.all([
    generateReport({
      startDate: asOf,
      endDate: asOf,
      mode: "arr",
      grain: "daily",
    }),
    generateReport({
      startDate: asOf,
      endDate: asOf,
      mode: "contracted",
      grain: "daily",
      contractedIncludeAllDeals: true,
    }),
  ]);

  const arrByDeal = sumByDealForPeriod(arrReport, asOf);
  const carrByDeal = sumByDealForPeriod(carrReport, asOf);

  return deals.map((deal) => {
    const dealId = String(deal.id || "");
    return {
      asOfDate: asOf,
      dealId,
      currentArr: round2(arrByDeal.get(dealId) || 0),
      currentCarr: round2(carrByDeal.get(dealId) || 0),
    };
  });
}
