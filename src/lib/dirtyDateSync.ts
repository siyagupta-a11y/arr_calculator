import { runBigQuerySqlRows, runBigQuerySqlStatement, type StripeBigQueryProfile } from "@/lib/stripeBigquery";

type SyncMode = "fast" | "full";

type SourceConfig = {
  source: string;
  tableRef: string;
  watermarkExpr: string;
  monthDateExpr: string;
  forceFullOnChange?: boolean;
};

export type DirtyMonthSyncPlan = {
  useDirtyMonths: boolean;
  dirtyMonthKeys: string[];
  fallbackReason: string | null;
  bootstrapSources: string[];
  forceFullSources: string[];
};

const PRECOMPUTED_TABLE_PROJECT = String(process.env.PRECOMPUTED_TABLES_PROJECT || "botpress-stripe-data-pipeline")
  .trim() || "botpress-stripe-data-pipeline";
const PRECOMPUTED_TABLE_DATASET = String(process.env.PRECOMPUTED_TABLES_DATASET || "precomputed_tables").trim()
  || "precomputed_tables";
const DIRTY_MONTHS_TABLE = String(process.env.CACHE_SYNC_DIRTY_MONTHS_TABLE || "dirty_months").trim() || "dirty_months";
const WATERMARKS_TABLE = String(process.env.CACHE_SYNC_DIRTY_WATERMARKS_TABLE || "dirty_source_watermarks").trim()
  || "dirty_source_watermarks";
const STRIPE_SOURCE_PROJECT = String(process.env.STRIPE_SOURCE_PROJECT || "botpress-stripe-data-pipeline").trim()
  || "botpress-stripe-data-pipeline";
const STRIPE_SOURCE_DATASET = String(process.env.STRIPE_SOURCE_DATASET || "stripe").trim() || "stripe";
const HUBSPOT_SOURCE_PROJECT = String(process.env.HUBSPOT_SOURCE_PROJECT || "botpress-stripe-data-pipeline").trim()
  || "botpress-stripe-data-pipeline";
const HUBSPOT_SOURCE_DATASET = String(process.env.HUBSPOT_SOURCE_DATASET || "hubspot").trim() || "hubspot";
const PROFILE: StripeBigQueryProfile = "stripe_arr_correct";

let ensured = false;

function isEnabled() {
  const raw = String(process.env.CACHE_SYNC_DIRTY_MONTHS_ENABLED || "true").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no";
}

function validateIdentifier(value: string, fallback: string) {
  const normalized = String(value || "").trim() || fallback;
  if (!/^[A-Za-z0-9_]+$/.test(normalized)) throw new Error(`Invalid BigQuery identifier: ${normalized}`);
  return normalized;
}

function validateProject(value: string, fallback: string) {
  const normalized = String(value || "").trim() || fallback;
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) throw new Error(`Invalid BigQuery project id: ${normalized}`);
  return normalized;
}

function precomputedTableRef(tableName: string) {
  const project = validateProject(PRECOMPUTED_TABLE_PROJECT, "botpress-stripe-data-pipeline");
  const dataset = validateIdentifier(PRECOMPUTED_TABLE_DATASET, "precomputed_tables");
  const table = validateIdentifier(tableName, tableName);
  return `\`${project}.${dataset}.${table}\``;
}

function stripeTableRef(tableName: string) {
  const project = validateProject(STRIPE_SOURCE_PROJECT, "botpress-stripe-data-pipeline");
  const dataset = validateIdentifier(STRIPE_SOURCE_DATASET, "stripe");
  const table = validateIdentifier(tableName, tableName);
  return `\`${project}.${dataset}.${table}\``;
}

function hubspotTableRef(tableName: string) {
  const project = validateProject(HUBSPOT_SOURCE_PROJECT, "botpress-stripe-data-pipeline");
  const dataset = validateIdentifier(HUBSPOT_SOURCE_DATASET, "hubspot");
  const table = validateIdentifier(tableName, tableName);
  return `\`${project}.${dataset}.${table}\``;
}

function sourceConfigs(): SourceConfig[] {
  return [
    {
      source: "invoices",
      tableRef: stripeTableRef("invoices"),
      watermarkExpr: "batch_timestamp",
      monthDateExpr: "DATE(COALESCE(date, period_start, batch_timestamp))",
    },
    {
      source: "upcoming_invoice_line_snapshots",
      tableRef: stripeTableRef("upcoming_invoice_line_snapshots"),
      watermarkExpr: "TIMESTAMP(snapshot_date)",
      monthDateExpr: "DATE(snapshot_date)",
    },
    {
      source: "subscription_item_change_events",
      tableRef: stripeTableRef("subscription_item_change_events_v2_beta"),
      watermarkExpr: "event_timestamp",
      monthDateExpr: "DATE(event_timestamp)",
    },
    {
      source: "customers",
      tableRef: stripeTableRef("customers"),
      watermarkExpr: "batch_timestamp",
      monthDateExpr: "DATE(COALESCE(batch_timestamp, created))",
      forceFullOnChange: true,
    },
    {
      source: "products",
      tableRef: stripeTableRef("products"),
      watermarkExpr: "batch_timestamp",
      monthDateExpr: "DATE(COALESCE(batch_timestamp, created))",
      forceFullOnChange: true,
    },
    {
      source: "hubspot_deals",
      tableRef: hubspotTableRef("deals_view"),
      watermarkExpr: "received_at",
      monthDateExpr: "COALESCE(SAFE_CAST(SUBSTR(NULLIF(TRIM(closedate), ''), 1, 10) AS DATE), SAFE_CAST(SUBSTR(NULLIF(TRIM(createdate), ''), 1, 10) AS DATE), DATE(received_at))",
    },
    {
      source: "hubspot_companies",
      tableRef: hubspotTableRef("companies_view"),
      watermarkExpr: "received_at",
      monthDateExpr: "COALESCE(SAFE_CAST(SUBSTR(NULLIF(TRIM(createdate), ''), 1, 10) AS DATE), DATE(received_at))",
      forceFullOnChange: true,
    },
  ];
}

function parseMs(value: string | null | undefined) {
  if (!value) return Number.NaN;
  return Date.parse(String(value).trim());
}

function isAfterIsoTs(left: string | null | undefined, right: string | null | undefined) {
  const leftMs = parseMs(left);
  const rightMs = parseMs(right);
  if (!Number.isFinite(leftMs)) return false;
  if (!Number.isFinite(rightMs)) return true;
  return leftMs > rightMs;
}

function toMonthKey(d: Date) {
  const y = d.getUTCFullYear();
  const m = `${d.getUTCMonth() + 1}`.padStart(2, "0");
  return `${y}-${m}`;
}

function currentAndPreviousMonthKeysUtc() {
  const now = new Date();
  const current = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [toMonthKey(previous), toMonthKey(current)];
}

function rollingMonthKeysUtc(monthCount: number) {
  const safe = Number.isFinite(monthCount) ? Math.max(1, Math.floor(monthCount)) : 2;
  const now = new Date();
  const out: string[] = [];
  for (let i = 0; i < safe; i += 1) {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(toMonthKey(monthStart));
  }
  return Array.from(new Set(out));
}

async function ensureTables() {
  if (ensured) return;
  const dirtyTable = precomputedTableRef(DIRTY_MONTHS_TABLE);
  const watermarkTable = precomputedTableRef(WATERMARKS_TABLE);
  await runBigQuerySqlStatement(
    `
CREATE TABLE IF NOT EXISTS ${dirtyTable} (
  source STRING NOT NULL,
  month_key STRING NOT NULL,
  reason STRING,
  first_detected_at TIMESTAMP NOT NULL,
  last_detected_at TIMESTAMP NOT NULL,
  resolved_at TIMESTAMP,
  is_active BOOL NOT NULL
)
PARTITION BY DATE(last_detected_at)
CLUSTER BY is_active, month_key, source
`,
    [],
    { profile: PROFILE },
  );
  await runBigQuerySqlStatement(
    `
CREATE TABLE IF NOT EXISTS ${watermarkTable} (
  source STRING NOT NULL,
  watermark_iso STRING NOT NULL,
  updated_at TIMESTAMP NOT NULL
)
PARTITION BY DATE(updated_at)
CLUSTER BY source
`,
    [],
    { profile: PROFILE },
  );
  ensured = true;
}

async function readWatermarksBySource() {
  const watermarkTable = precomputedTableRef(WATERMARKS_TABLE);
  const rows = await runBigQuerySqlRows(
    `
SELECT source, watermark_iso
FROM (
  SELECT
    source,
    watermark_iso,
    ROW_NUMBER() OVER (PARTITION BY source ORDER BY updated_at DESC) AS rn
  FROM ${watermarkTable}
)
WHERE rn = 1
`,
    [],
    { profile: PROFILE },
  );
  const out = new Map<string, string>();
  for (const row of rows || []) {
    const source = String(row.source || "").trim();
    const watermark = String(row.watermark_iso || "").trim();
    if (!source || !watermark) continue;
    out.set(source, watermark);
  }
  return out;
}

async function queryCurrentWatermark(cfg: SourceConfig) {
  const rows = await runBigQuerySqlRows(
    `
SELECT FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ', MAX(${cfg.watermarkExpr})) AS watermark_iso
FROM ${cfg.tableRef}
WHERE ${cfg.watermarkExpr} IS NOT NULL
`,
    [],
    { profile: PROFILE },
  );
  const value = String(rows[0]?.watermark_iso || "").trim();
  return value || null;
}

async function queryChangedMonthKeys(cfg: SourceConfig, previousWatermarkIso: string) {
  const rows = await runBigQuerySqlRows(
    `
SELECT DISTINCT FORMAT_DATE('%Y-%m', DATE_TRUNC(${cfg.monthDateExpr}, MONTH)) AS month_key
FROM ${cfg.tableRef}
WHERE ${cfg.watermarkExpr} IS NOT NULL
  AND ${cfg.monthDateExpr} IS NOT NULL
  AND ${cfg.watermarkExpr} > TIMESTAMP(@previous_watermark_iso)
`,
    [{ name: "previous_watermark_iso", type: "STRING", value: previousWatermarkIso }],
    { profile: PROFILE },
  );
  const out = new Set<string>();
  for (const row of rows || []) {
    const monthKey = String(row.month_key || "").trim();
    if (/^\d{4}-\d{2}$/.test(monthKey)) out.add(monthKey);
  }
  return Array.from(out.values());
}

async function upsertWatermark(source: string, watermarkIso: string) {
  if (!source || !watermarkIso) return;
  const tableRef = precomputedTableRef(WATERMARKS_TABLE);
  await runBigQuerySqlStatement(
    `
MERGE ${tableRef} AS t
USING (
  SELECT @source AS source, @watermark_iso AS watermark_iso
) AS s
ON t.source = s.source
WHEN MATCHED THEN
  UPDATE SET watermark_iso = s.watermark_iso, updated_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN
  INSERT (source, watermark_iso, updated_at)
  VALUES (s.source, s.watermark_iso, CURRENT_TIMESTAMP())
`,
    [
      { name: "source", type: "STRING", value: source },
      { name: "watermark_iso", type: "STRING", value: watermarkIso },
    ],
    { profile: PROFILE },
  );
}

async function markDirtyMonth(source: string, monthKey: string, reason: string) {
  if (!source || !/^\d{4}-\d{2}$/.test(monthKey)) return;
  const tableRef = precomputedTableRef(DIRTY_MONTHS_TABLE);
  await runBigQuerySqlStatement(
    `
MERGE ${tableRef} AS t
USING (
  SELECT @source AS source, @month_key AS month_key, @reason AS reason
) AS s
ON t.source = s.source AND t.month_key = s.month_key
WHEN MATCHED THEN
  UPDATE SET
    reason = s.reason,
    is_active = TRUE,
    resolved_at = NULL,
    last_detected_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN
  INSERT (source, month_key, reason, first_detected_at, last_detected_at, resolved_at, is_active)
  VALUES (s.source, s.month_key, s.reason, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(), NULL, TRUE)
`,
    [
      { name: "source", type: "STRING", value: source },
      { name: "month_key", type: "STRING", value: monthKey },
      { name: "reason", type: "STRING", value: reason },
    ],
    { profile: PROFILE },
  );
}

export async function listActiveDirtyMonthKeys() {
  await ensureTables();
  const tableRef = precomputedTableRef(DIRTY_MONTHS_TABLE);
  const rows = await runBigQuerySqlRows(
    `
SELECT DISTINCT month_key
FROM ${tableRef}
WHERE is_active = TRUE
ORDER BY month_key
`,
    [],
    { profile: PROFILE },
  );
  const keys: string[] = [];
  for (const row of rows || []) {
    const monthKey = String(row.month_key || "").trim();
    if (/^\d{4}-\d{2}$/.test(monthKey)) keys.push(monthKey);
  }
  return keys;
}

export async function resolveDirtyMonthKeys(monthKeys: string[]) {
  await ensureTables();
  const unique = Array.from(new Set((monthKeys || []).map((value) => String(value || "").trim()).filter((value) => /^\d{4}-\d{2}$/.test(value))));
  if (!unique.length) return { updated: 0 };
  const tableRef = precomputedTableRef(DIRTY_MONTHS_TABLE);
  const literal = unique.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
  await runBigQuerySqlStatement(
    `
UPDATE ${tableRef}
SET
  is_active = FALSE,
  resolved_at = CURRENT_TIMESTAMP()
WHERE is_active = TRUE
  AND month_key IN (${literal})
`,
    [],
    { profile: PROFILE },
  );
  return { updated: unique.length };
}

export async function detectDirtyMonthSyncPlan(syncMode: SyncMode): Promise<DirtyMonthSyncPlan> {
  if (!isEnabled()) {
    return {
      useDirtyMonths: false,
      dirtyMonthKeys: [],
      fallbackReason: "dirty-month-sync-disabled",
      bootstrapSources: [],
      forceFullSources: [],
    };
  }
  if (syncMode === "full") {
    return {
      useDirtyMonths: false,
      dirtyMonthKeys: [],
      fallbackReason: "full-sync-mode",
      bootstrapSources: [],
      forceFullSources: [],
    };
  }

  await ensureTables();
  const existingWatermarks = await readWatermarksBySource();
  const monthKeysBySource = new Map<string, Set<string>>();
  const watermarkUpdates = new Map<string, string>();
  const bootstrapSources: string[] = [];
  const forceFullSources: string[] = [];
  const configs = sourceConfigs();
  const nonBigQuerySafetyWindowRaw = Number(process.env.CACHE_SYNC_NON_BQ_SAFETY_WINDOW_MONTHS || 2);
  const nonBigQuerySafetyWindowMonths = Number.isFinite(nonBigQuerySafetyWindowRaw)
    ? Math.max(1, Math.min(12, Math.floor(nonBigQuerySafetyWindowRaw)))
    : 2;

  for (const cfg of configs) {
    const currentWatermark = await queryCurrentWatermark(cfg);
    if (currentWatermark) watermarkUpdates.set(cfg.source, currentWatermark);
    const previousWatermark = existingWatermarks.get(cfg.source) || null;
    if (!previousWatermark) {
      if (currentWatermark) bootstrapSources.push(cfg.source);
      continue;
    }
    if (!isAfterIsoTs(currentWatermark, previousWatermark)) continue;
    if (cfg.forceFullOnChange) {
      forceFullSources.push(cfg.source);
      continue;
    }
    const changedMonths = await queryChangedMonthKeys(cfg, previousWatermark);
    if (!changedMonths.length) continue;
    const bucket = monthKeysBySource.get(cfg.source) || new Set<string>();
    for (const monthKey of changedMonths) bucket.add(monthKey);
    monthKeysBySource.set(cfg.source, bucket);
  }

  const watermarkUpdateOps = Array.from(watermarkUpdates.entries()).map(([source, watermarkIso]) =>
    upsertWatermark(source, watermarkIso)
  );

  if (bootstrapSources.length || forceFullSources.length) {
    await Promise.all(watermarkUpdateOps);
    return {
      useDirtyMonths: false,
      dirtyMonthKeys: [],
      fallbackReason: bootstrapSources.length ? "bootstrap-watermarks" : "dimension-source-changed",
      bootstrapSources,
      forceFullSources,
    };
  }

  const markOps: Promise<unknown>[] = [];
  for (const [source, keys] of monthKeysBySource.entries()) {
    for (const monthKey of keys) {
      markOps.push(markDirtyMonth(source, monthKey, "source-change"));
    }
  }
  if (monthKeysBySource.has("upcoming_invoice_line_snapshots")) {
    for (const monthKey of currentAndPreviousMonthKeysUtc()) {
      markOps.push(markDirtyMonth("upcoming_invoice_line_snapshots", monthKey, "snapshot-safety-window"));
    }
  }
  for (const monthKey of rollingMonthKeysUtc(nonBigQuerySafetyWindowMonths)) {
    markOps.push(markDirtyMonth("non_bq_sources", monthKey, "external-source-safety-window"));
  }

  await Promise.all([...markOps, ...watermarkUpdateOps]);
  const dirtyMonthKeys = await listActiveDirtyMonthKeys();
  return {
    useDirtyMonths: true,
    dirtyMonthKeys,
    fallbackReason: null,
    bootstrapSources: [],
    forceFullSources: [],
  };
}
