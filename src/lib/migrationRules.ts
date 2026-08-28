export type MigrationPlanVersion = "v3" | "v4";

export type MigrationMetricInput = {
  migratedAt: string;
  migratedArr: number;
};

function parseIsoDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  ) {
    return null;
  }
  return date;
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function migrationReportWindow(asOfDate: string) {
  const asOf = parseIsoDate(asOfDate);
  if (!asOf) throw new Error("Invalid asOfDate; expected YYYY-MM-DD");
  const minimumStart = new Date(Date.UTC(2026, 3, 1));
  if (asOf.getTime() < minimumStart.getTime()) {
    throw new Error("Migration reporting starts on 2026-04-01");
  }

  const fiscalYearStartYear = asOf.getUTCMonth() >= 3 ? asOf.getUTCFullYear() : asOf.getUTCFullYear() - 1;
  const calculatedFiscalStart = new Date(Date.UTC(fiscalYearStartYear, 3, 1));
  const fiscalYearStart = calculatedFiscalStart < minimumStart ? minimumStart : calculatedFiscalStart;
  const currentMonthStart = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1));

  return {
    asOfDate: isoDate(asOf),
    fiscalYearStart: isoDate(fiscalYearStart),
    currentMonthStart: isoDate(currentMonthStart),
  };
}

function normalizedWords(values: string[]) {
  return values
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

export function isExplicitV3ToV4Migration(values: string[]) {
  const normalized = normalizedWords(values);
  if (!normalized) return false;
  return (
    /\bv3\s*(?:to|into|→|->)\s*v4\b/.test(normalized) ||
    /\bv3\b.*\bv4\b/.test(normalized) ||
    /\bmigrat(?:e|ed|ing|ion)\b/.test(normalized)
  );
}

export function migrationPlanVersion(
  values: string[],
  unversionedPlanVersion: MigrationPlanVersion = "v3",
): MigrationPlanVersion | null {
  const normalized = normalizedWords(values);
  if (!normalized || normalized === "refund" || normalized === "discount") return null;
  if (/\badd\s*ons?\b/.test(normalized)) return null;
  if (/\bai\s+tokens?\b/.test(normalized)) return null;
  if (/\bconversation\s+sessions?\b/.test(normalized)) return null;
  if (normalized.includes("web search and crawl")) return null;

  const recognizedPlan = /\b(enterprise|managed|team|plus|pay\s+as\s+you\s+go|payg|free)\b/.test(normalized);
  if (!recognizedPlan) return null;
  if (/(^|[^a-z0-9])v4([^a-z0-9]|$)/.test(normalized)) return "v4";
  if (/(^|[^a-z0-9])v3([^a-z0-9]|$)/.test(normalized)) return "v3";
  if (/(^|[^a-z0-9])v[12]([^a-z0-9]|$)/.test(normalized)) return null;
  return unversionedPlanVersion;
}

export function calculateMigrationMetrics(
  rows: MigrationMetricInput[],
  startDate: string,
  endDate: string,
) {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (!start || !end || end.getTime() < start.getTime()) {
    throw new Error("Invalid migration metric date range");
  }

  const included = (rows || []).filter((row) => {
    const migratedAt = parseIsoDate(String(row.migratedAt || "").slice(0, 10));
    return migratedAt && migratedAt.getTime() >= start.getTime() && migratedAt.getTime() <= end.getTime();
  });
  return {
    logosMigrated: included.length,
    arrMigrated: Math.round(included.reduce((sum, row) => sum + Math.max(0, Number(row.migratedArr || 0)), 0) * 100) / 100,
  };
}
