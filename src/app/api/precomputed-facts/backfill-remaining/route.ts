import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { assertAdmin, syncPrecomputedFacts, type PrecomputedFactsSyncResult } from "@/lib/precomputedFacts";
import { runBigQuerySqlRows } from "@/lib/stripeBigquery";

export const runtime = "nodejs";
export const maxDuration = 800;

const PRECOMPUTED_PROJECT = String(process.env.PRECOMPUTED_TABLES_PROJECT || "botpress-stripe-data-pipeline").trim()
  || "botpress-stripe-data-pipeline";
const PRECOMPUTED_DATASET = String(process.env.PRECOMPUTED_TABLES_DATASET || "precomputed_tables").trim()
  || "precomputed_tables";
const HISTORY_START = String(process.env.COMBINED_BILLING_OVERVIEW_MONTHLY_CACHE_START || "2023-01-01").trim()
  || "2023-01-01";

function validateIdentifierPart(value: string, fallback: string) {
  const cleaned = String(value || "").trim() || fallback;
  if (!/^[A-Za-z0-9_]+$/.test(cleaned)) return fallback;
  return cleaned;
}

function tableRef(table: string) {
  const dataset = validateIdentifierPart(PRECOMPUTED_DATASET, "precomputed_tables");
  const tableName = validateIdentifierPart(table, table);
  return `\`${PRECOMPUTED_PROJECT}.${dataset}.${tableName}\``;
}

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function parseIsoDate(value: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const parsed = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month ||
    parsed.getUTCDate() !== day
  ) return null;
  return parsed;
}

function toIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addDays(dateIso: string, days: number) {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) return "";
  const next = new Date(parsed.getTime() + days * 24 * 60 * 60 * 1000);
  return toIsoDate(next);
}

function addMonths(dateIso: string, months: number) {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) return "";
  return toIsoDate(new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + months, 1)));
}

type PlannedSyncTask = {
  label: string;
  startDate: string;
  endDate: string;
  includeDaily: boolean;
  includeMonthly: boolean;
  includeCustomerArrDaily?: boolean;
  includeAiSpendDaily?: boolean;
  includeCustomerArrMonthly?: boolean;
  includeTofuMonthly?: boolean;
};

type ExecutedSyncTask = PlannedSyncTask & {
  ok: boolean;
  result?: PrecomputedFactsSyncResult;
  error?: string;
};

type RequestBody = {
  maxTasks?: number;
  chunkMonths?: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readAiSpendCoverage() {
  const rows = await runBigQuerySqlRows(
    `
SELECT
  COUNT(*) AS row_count,
  CAST(MIN(date) AS STRING) AS min_date,
  CAST(MAX(date) AS STRING) AS max_date
FROM ${tableRef("fact_ai_spend_daily_agg")}
`,
    [],
    { profile: "stripe_arr_correct" },
  );
  return {
    rowCount: Math.max(0, Number(rows[0]?.row_count || 0)),
    minDate: String(rows[0]?.min_date || "").trim(),
    maxDate: String(rows[0]?.max_date || "").trim(),
  };
}

async function readTofuCoverage() {
  const rows = await runBigQuerySqlRows(
    `
SELECT CAST(MAX(period_date) AS STRING) AS max_month
FROM ${tableRef("fact_tofu_monthly")}
`,
    [],
    { profile: "stripe_arr_correct" },
  );
  return {
    maxMonth: String(rows[0]?.max_month || "").trim(),
  };
}

function buildRemainingTasks(todayIso: string, ai: { rowCount: number; minDate: string; maxDate: string }, tofu: { maxMonth: string }) {
  const tasks: PlannedSyncTask[] = [];

  if (!isIsoDate(HISTORY_START)) throw new Error("Invalid configured history start date");

  if (ai.rowCount <= 0 || !isIsoDate(ai.minDate) || !isIsoDate(ai.maxDate)) {
    tasks.push({
      label: "AI spend daily full history",
      startDate: HISTORY_START,
      endDate: todayIso,
      includeDaily: true,
      includeMonthly: false,
      includeCustomerArrDaily: false,
      includeAiSpendDaily: true,
    });
  } else {
    const beforeStart = addDays(ai.minDate, -1);
    if (beforeStart && beforeStart >= HISTORY_START) {
      tasks.push({
        label: "AI spend daily missing historical range",
        startDate: HISTORY_START,
        endDate: beforeStart,
        includeDaily: true,
        includeMonthly: false,
        includeCustomerArrDaily: false,
        includeAiSpendDaily: true,
      });
    }
    const afterEnd = addDays(ai.maxDate, 1);
    if (afterEnd && afterEnd <= todayIso) {
      tasks.push({
        label: "AI spend daily missing latest range",
        startDate: afterEnd,
        endDate: todayIso,
        includeDaily: true,
        includeMonthly: false,
        includeCustomerArrDaily: false,
        includeAiSpendDaily: true,
      });
    }
  }

  const currentMonthStart = toIsoDate(new Date(Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    1,
  )));
  if (!isIsoDate(tofu.maxMonth)) {
    tasks.push({
      label: "TOFU monthly full history",
      startDate: HISTORY_START,
      endDate: todayIso,
      includeDaily: false,
      includeMonthly: true,
      includeCustomerArrMonthly: false,
      includeTofuMonthly: true,
    });
  } else {
    const nextMonthStart = addMonths(tofu.maxMonth, 1);
    if (nextMonthStart && nextMonthStart <= currentMonthStart) {
      tasks.push({
        label: "TOFU monthly missing latest month(s)",
        startDate: nextMonthStart,
        endDate: todayIso,
        includeDaily: false,
        includeMonthly: true,
        includeCustomerArrMonthly: false,
        includeTofuMonthly: true,
      });
    }
  }

  return tasks.filter((task) => task.endDate >= task.startDate);
}

function addMonthsUtc(dateIso: string, months: number) {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) return "";
  return toIsoDate(new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + months, 1)));
}

function endOfMonthUtc(dateIso: string) {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) return "";
  return toIsoDate(new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0)));
}

function toMonthStartIso(dateIso: string) {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) return "";
  return toIsoDate(new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), 1)));
}

function expandTasksToMonthChunks(tasks: PlannedSyncTask[], chunkMonths: number) {
  const out: PlannedSyncTask[] = [];
  const monthsPerChunk = Math.max(1, Math.floor(chunkMonths));
  for (const task of tasks) {
    const startMonth = toMonthStartIso(task.startDate);
    if (!startMonth) continue;
    let cursor = startMonth;
    while (cursor <= task.endDate) {
      const chunkEndByMonth = endOfMonthUtc(addMonthsUtc(cursor, monthsPerChunk - 1));
      const chunkEnd = chunkEndByMonth && chunkEndByMonth <= task.endDate ? chunkEndByMonth : task.endDate;
      const chunkStart = cursor < task.startDate ? task.startDate : cursor;
      out.push({
        label: `${task.label} (${chunkStart}..${chunkEnd})`,
        startDate: chunkStart,
        endDate: chunkEnd,
        includeDaily: task.includeDaily,
        includeMonthly: task.includeMonthly,
        includeCustomerArrDaily: task.includeCustomerArrDaily,
        includeAiSpendDaily: task.includeAiSpendDaily,
        includeCustomerArrMonthly: task.includeCustomerArrMonthly,
        includeTofuMonthly: task.includeTofuMonthly,
      });
      cursor = addMonthsUtc(cursor, monthsPerChunk);
      if (!cursor) break;
    }
  }
  return out;
}

export async function POST(req: NextRequest) {
  try {
    await assertAdmin(req);
    let body: RequestBody = {};
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      body = {};
    }
    const maxTasks = Math.max(1, Math.min(12, Math.floor(Number(body.maxTasks || 1) || 1)));
    const chunkMonths = Math.max(1, Math.min(3, Math.floor(Number(body.chunkMonths || 1) || 1)));
    const todayIso = toIsoDate(new Date());
    const ai = await readAiSpendCoverage();
    const tofu = await readTofuCoverage();
    const broadPlanned = buildRemainingTasks(todayIso, ai, tofu);
    const planned = expandTasksToMonthChunks(broadPlanned, chunkMonths);
    const selected = planned.slice(0, maxTasks);

    const executed: ExecutedSyncTask[] = [];
    for (const task of selected) {
      let succeeded = false;
      let lastError = "";
      let lastResult: PrecomputedFactsSyncResult | undefined;
      for (let attempt = 1; attempt <= 3 && !succeeded; attempt += 1) {
        try {
          const result = await syncPrecomputedFacts({
            mode: "full",
            startDate: task.startDate,
            endDate: task.endDate,
            includeEnsureTables: false,
            includeDimDate: false,
            includeDaily: task.includeDaily,
            includeMonthly: task.includeMonthly,
            includeCustomerArrDaily: task.includeCustomerArrDaily,
            includeAiSpendDaily: task.includeAiSpendDaily,
            includeCustomerArrMonthly: task.includeCustomerArrMonthly,
            includeTofuMonthly: task.includeTofuMonthly,
          });
          const ok = (result.steps || []).every((step) => step.ok);
          if (ok) {
            succeeded = true;
            lastResult = result;
            break;
          }
          lastError = result.steps.find((step) => !step.ok)?.detail || "Sync reported failure";
        } catch (error: unknown) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        if (!succeeded && attempt < 3) {
          await sleep(Math.min(8_000, 1_000 * 2 ** (attempt - 1)));
        }
      }
      if (succeeded) {
        executed.push({ ...task, ok: true, result: lastResult });
      } else {
        executed.push({
          ...task,
          ok: false,
          error: lastError || "Unknown error",
        });
      }
    }

    const ok = executed.every((item) => item.ok);
    return NextResponse.json(
      {
        ok,
        plannedTaskCount: planned.length,
        executedTaskCount: executed.length,
        remainingTaskCount: Math.max(0, planned.length - executed.length),
        tasks: executed.map((task) => ({
          label: task.label,
          startDate: task.startDate,
          endDate: task.endDate,
          includeDaily: task.includeDaily,
          includeMonthly: task.includeMonthly,
          includeCustomerArrDaily: task.includeCustomerArrDaily !== false,
          includeAiSpendDaily: task.includeAiSpendDaily !== false,
          includeCustomerArrMonthly: task.includeCustomerArrMonthly !== false,
          includeTofuMonthly: task.includeTofuMonthly !== false,
          ok: task.ok,
          error: task.error || "",
          syncRunId: task.result?.syncRunId || "",
        })),
      },
      { status: ok ? 200 : 500 },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
