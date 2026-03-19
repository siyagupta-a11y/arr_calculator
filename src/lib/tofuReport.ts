import {
  generateCombinedAllSubsReport,
  type CombinedAllSubsResponse,
  type CombinedAllSubsRow,
  type CombinedAllSubsCombineMode,
  type CombinedAllSubsRequest,
} from "@/lib/combinedAllSubsReport";

export type TofuRequest = CombinedAllSubsRequest;

export type TofuMonthRow = {
  periodKey: string;
  periodLabel: string;
  beginningArr: number;
  newArr: number;
  expansionArr: number;
  contractionArr: number;
  churnArr: number;
  endingArr: number;
};

export type TofuResponse = {
  startDate: string;
  endDate: string;
  combineMode: CombinedAllSubsCombineMode;
  targetCurrency: string;
  rows: TofuMonthRow[];
};

export type TofuDetailMetric =
  | "beginningArr"
  | "newArr"
  | "expansionArr"
  | "contractionArr"
  | "churnArr"
  | "endingArr";

export type TofuDetailRequest = TofuRequest & {
  detailPeriodKey: string;
  detailMetric: TofuDetailMetric;
};

export type TofuDetailRow = {
  customerId: string;
  customerLabel: string;
  source: "hubspot_account" | "stripe_only_customer";
  previousArr: number;
  currentArr: number;
  deltaArr: number;
  previousMrr: number;
  currentMrr: number;
  deltaMrr: number;
  contributionArr: number;
  contributionMrr: number;
};

export type TofuDetailResponse = {
  startDate: string;
  endDate: string;
  combineMode: CombinedAllSubsCombineMode;
  targetCurrency: string;
  detailPeriodKey: string;
  detailPeriodLabel: string;
  detailPreviousPeriodKey: string;
  detailPreviousPeriodLabel: string;
  detailMetric: TofuDetailMetric;
  rows: TofuDetailRow[];
  summary: {
    rowCount: number;
    totalArr: number;
    totalMrr: number;
  };
};

const TOFU_DETAIL_METRICS = new Set<TofuDetailMetric>([
  "beginningArr",
  "newArr",
  "expansionArr",
  "contractionArr",
  "churnArr",
  "endingArr",
]);

function round2(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function parseIsoDateOnly(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function toIsoDateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function monthBeforeRange(startDate: string) {
  const start = parseIsoDateOnly(startDate);
  if (!start) return null;
  const prevMonthStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1));
  const prevMonthEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 0));
  return {
    startDate: toIsoDateOnly(prevMonthStart),
    endDate: toIsoDateOnly(prevMonthEnd),
  };
}

function previousPeriodKeyFor(
  periodKey: string,
  periods: Array<{ key: string }>,
  allPeriodKeys: string[],
) {
  const selectedIdx = periods.findIndex((period) => period.key === periodKey);
  const selectedPrevKey = selectedIdx > 0 ? periods[selectedIdx - 1].key : "";
  const allIdx = allPeriodKeys.indexOf(periodKey);
  return selectedPrevKey || (allIdx > 0 ? allPeriodKeys[allIdx - 1] : "");
}

async function loadExpandedTofuSource(request: TofuRequest): Promise<{
  expanded: CombinedAllSubsResponse;
  periods: Array<{ key: string; label: string }>;
  allPeriodKeys: string[];
}> {
  const prev = monthBeforeRange(request.startDate);
  const expandedRequest: CombinedAllSubsRequest = {
    startDate: prev?.startDate || request.startDate,
    endDate: request.endDate,
    combineMode: request.combineMode,
  };
  const expanded = await generateCombinedAllSubsReport(expandedRequest);

  const allPeriods = (expanded.periods || []).map((period) => ({
    key: String(period.key || ""),
    label: String(period.label || period.key || ""),
  }));
  const selectedStartMonthKey = String(request.startDate || "").slice(0, 7);
  const periods = allPeriods.filter((period) => period.key >= selectedStartMonthKey);
  const allPeriodKeys = allPeriods.map((period) => period.key);

  return { expanded, periods, allPeriodKeys };
}

function arrAtPeriod(row: CombinedAllSubsRow, periodKey: string) {
  return round2(Number(row.valuesByPeriod[periodKey] || 0));
}

function contributionForMetric(metric: TofuDetailMetric, previousArr: number, currentArr: number) {
  const prevHas = Math.abs(previousArr) > 1e-9;
  const currHas = Math.abs(currentArr) > 1e-9;
  const delta = round2(currentArr - previousArr);

  if (metric === "beginningArr") return prevHas ? previousArr : null;
  if (metric === "endingArr") return currHas ? currentArr : null;
  if (metric === "newArr") return !prevHas && currHas ? currentArr : null;
  if (metric === "churnArr") return prevHas && !currHas ? -previousArr : null;
  if (metric === "expansionArr") return prevHas && currHas && delta > 0 ? delta : null;
  if (metric === "contractionArr") return prevHas && currHas && delta < 0 ? delta : null;
  return null;
}

export async function generateTofuReport(request: TofuRequest): Promise<TofuResponse> {
  const start = parseIsoDateOnly(request.startDate);
  const end = parseIsoDateOnly(request.endDate);
  if (!start || !end) {
    throw new Error("Invalid startDate/endDate");
  }
  if (end.getTime() < start.getTime()) {
    throw new Error("endDate must be >= startDate");
  }

  const { expanded, periods, allPeriodKeys } = await loadExpandedTofuSource(request);

  const rows: TofuMonthRow[] = periods.map((period, idx) => {
    const selectedPrevKey = idx > 0 ? periods[idx - 1].key : "";
    const prevKey = selectedPrevKey || previousPeriodKeyFor(period.key, periods, allPeriodKeys);

    let beginningArr = 0;
    let newArr = 0;
    let expansionArr = 0;
    let contractionArr = 0;
    let churnArr = 0;
    let endingArr = 0;

    for (const row of expanded.rows || []) {
      const curr = round2(Number(row.valuesByPeriod[period.key] || 0));
      const prev = round2(
        prevKey
          ? Number(row.valuesByPeriod[prevKey] || 0)
          : 0,
      );

      beginningArr = round2(beginningArr + prev);
      endingArr = round2(endingArr + curr);

      const prevHas = Math.abs(prev) > 1e-9;
      const currHas = Math.abs(curr) > 1e-9;

      if (!prevHas && currHas) {
        newArr = round2(newArr + curr);
        continue;
      }

      if (prevHas && !currHas) {
        churnArr = round2(churnArr - prev);
        continue;
      }

      if (prevHas && currHas) {
        const diff = round2(curr - prev);
        if (diff > 0) expansionArr = round2(expansionArr + diff);
        else if (diff < 0) contractionArr = round2(contractionArr + diff);
      }
    }

    return {
      periodKey: period.key,
      periodLabel: period.label,
      beginningArr,
      newArr,
      expansionArr,
      contractionArr,
      churnArr,
      endingArr,
    };
  });

  return {
    startDate: request.startDate,
    endDate: request.endDate,
    combineMode: expanded.combineMode,
    targetCurrency: expanded.targetCurrency,
    rows,
  };
}

export async function generateTofuDetailReport(request: TofuDetailRequest): Promise<TofuDetailResponse> {
  const start = parseIsoDateOnly(request.startDate);
  const end = parseIsoDateOnly(request.endDate);
  if (!start || !end) {
    throw new Error("Invalid startDate/endDate");
  }
  if (end.getTime() < start.getTime()) {
    throw new Error("endDate must be >= startDate");
  }
  if (!TOFU_DETAIL_METRICS.has(request.detailMetric)) {
    throw new Error("Invalid detail metric");
  }

  const { expanded, periods, allPeriodKeys } = await loadExpandedTofuSource(request);
  const detailPeriodKey = String(request.detailPeriodKey || "").trim();
  const period = periods.find((item) => item.key === detailPeriodKey);
  if (!period) {
    throw new Error("Invalid detail period");
  }

  const previousPeriodKey = previousPeriodKeyFor(period.key, periods, allPeriodKeys);
  const previousPeriodLabel = periods.find((item) => item.key === previousPeriodKey)?.label || previousPeriodKey;

  const detailRows: TofuDetailRow[] = [];
  for (const row of expanded.rows || []) {
    const previousArr = previousPeriodKey ? arrAtPeriod(row, previousPeriodKey) : 0;
    const currentArr = arrAtPeriod(row, period.key);
    const contributionArr = contributionForMetric(request.detailMetric, previousArr, currentArr);
    if (contributionArr == null) continue;

    const deltaArr = round2(currentArr - previousArr);
    const previousMrr = round2(previousArr / 12);
    const currentMrr = round2(currentArr / 12);
    const deltaMrr = round2(deltaArr / 12);
    const contributionMrr = round2(contributionArr / 12);

    detailRows.push({
      customerId: row.id,
      customerLabel: row.customerLabel,
      source: row.source,
      previousArr,
      currentArr,
      deltaArr,
      previousMrr,
      currentMrr,
      deltaMrr,
      contributionArr: round2(contributionArr),
      contributionMrr,
    });
  }

  detailRows.sort((a, b) => {
    const diff = Math.abs(b.contributionMrr) - Math.abs(a.contributionMrr);
    if (Math.abs(diff) > 1e-9) return diff;
    return a.customerLabel.localeCompare(b.customerLabel);
  });

  return {
    startDate: request.startDate,
    endDate: request.endDate,
    combineMode: expanded.combineMode,
    targetCurrency: expanded.targetCurrency,
    detailPeriodKey: period.key,
    detailPeriodLabel: period.label,
    detailPreviousPeriodKey: previousPeriodKey,
    detailPreviousPeriodLabel: previousPeriodLabel,
    detailMetric: request.detailMetric,
    rows: detailRows,
    summary: {
      rowCount: detailRows.length,
      totalArr: round2(detailRows.reduce((sum, row) => sum + row.contributionArr, 0)),
      totalMrr: round2(detailRows.reduce((sum, row) => sum + row.contributionMrr, 0)),
    },
  };
}
