import {
  generateCombinedAllSubsReport,
  type CombinedAllSubsRequest,
  type CombinedAllSubsRow,
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
  targetCurrency: string;
  rows: TofuMonthRow[];
};

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

function latestPeriodValueForRow(row: CombinedAllSubsRow, periodKeys: string[]) {
  if (!periodKeys.length) return 0;
  const latestKey = periodKeys[periodKeys.length - 1];
  return round2(Number(row.valuesByPeriod[latestKey] || 0));
}

function baselineByRowId(
  baselineRows: CombinedAllSubsRow[],
  baselinePeriodKeys: string[],
) {
  const output = new Map<string, number>();
  for (const row of baselineRows || []) {
    output.set(row.id, latestPeriodValueForRow(row, baselinePeriodKeys));
  }
  return output;
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

  const [main, baseline] = await Promise.all([
    generateCombinedAllSubsReport(request),
    (async () => {
      const prev = monthBeforeRange(request.startDate);
      if (!prev) return null;
      try {
        return await generateCombinedAllSubsReport(prev);
      } catch {
        return null;
      }
    })(),
  ]);

  const baselineValues = baselineByRowId(
    baseline?.rows || [],
    (baseline?.periods || []).map((period) => String(period.key || "")),
  );

  const periods = (main.periods || []).map((period) => ({
    key: String(period.key || ""),
    label: String(period.label || period.key || ""),
  }));

  const rows: TofuMonthRow[] = periods.map((period, idx) => {
    const prevKey = idx > 0 ? periods[idx - 1].key : "";

    let beginningArr = 0;
    let newArr = 0;
    let expansionArr = 0;
    let contractionArr = 0;
    let churnArr = 0;
    let endingArr = 0;

    for (const row of main.rows || []) {
      const curr = round2(Number(row.valuesByPeriod[period.key] || 0));
      const prev = round2(
        idx === 0
          ? Number(baselineValues.get(row.id) || 0)
          : Number(row.valuesByPeriod[prevKey] || 0),
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
    startDate: main.startDate,
    endDate: main.endDate,
    targetCurrency: main.targetCurrency,
    rows,
  };
}
