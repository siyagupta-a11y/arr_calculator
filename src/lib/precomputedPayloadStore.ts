import {
  insertBigQueryRows,
  runBigQuerySqlRows,
  runBigQuerySqlStatement,
  type StripeBigQueryProfile,
} from "@/lib/stripeBigquery";

type StoreOptions = {
  profile?: StripeBigQueryProfile;
};

type PrecomputedPayloadRow = {
  endpoint_key: string;
  cache_key: string;
  start_date: string;
  end_date: string;
  grain: string;
  generated_at: string;
  payload_json: string;
};

const PRECOMPUTED_TABLE_PROJECT = String(process.env.PRECOMPUTED_TABLES_PROJECT || "botpress-stripe-data-pipeline")
  .trim() || "botpress-stripe-data-pipeline";
const PRECOMPUTED_TABLE_DATASET = String(process.env.PRECOMPUTED_TABLES_DATASET || "precomputed_tables")
  .trim() || "precomputed_tables";
const PRECOMPUTED_PAYLOAD_TABLE = String(process.env.PRECOMPUTED_PAYLOAD_TABLE || "api_payload_cache")
  .trim() || "api_payload_cache";
const PRECOMPUTED_PROFILE: StripeBigQueryProfile = "stripe_arr_correct";

let ensured = false;

function validateIdentifier(value: string, fallback: string) {
  const normalized = String(value || "").trim() || fallback;
  if (!/^[A-Za-z0-9_]+$/.test(normalized)) {
    throw new Error(`Invalid BigQuery identifier: ${normalized}`);
  }
  return normalized;
}

function tableParts() {
  const project = String(PRECOMPUTED_TABLE_PROJECT || "").trim() || "botpress-stripe-data-pipeline";
  if (!/^[A-Za-z0-9_-]+$/.test(project)) {
    throw new Error(`Invalid BigQuery project id: ${project}`);
  }
  const dataset = validateIdentifier(PRECOMPUTED_TABLE_DATASET, "precomputed_tables");
  const table = validateIdentifier(PRECOMPUTED_PAYLOAD_TABLE, "api_payload_cache");
  return { project, dataset, table, tableRef: `\`${project}.${dataset}.${table}\`` };
}

async function ensureTable(options?: StoreOptions) {
  if (ensured) return;
  const { tableRef } = tableParts();
  await runBigQuerySqlStatement(
    `
CREATE TABLE IF NOT EXISTS ${tableRef} (
  endpoint_key STRING NOT NULL,
  cache_key STRING NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  grain STRING NOT NULL,
  generated_at TIMESTAMP NOT NULL,
  payload_json STRING NOT NULL
)
PARTITION BY DATE(generated_at)
CLUSTER BY endpoint_key, grain, start_date, end_date
`,
    [],
    { profile: options?.profile || PRECOMPUTED_PROFILE },
  );
  ensured = true;
}

export async function readPrecomputedPayload<T>(
  endpointKey: string,
  cacheKey: string,
  options?: StoreOptions,
): Promise<T | null> {
  await ensureTable(options);
  const { tableRef } = tableParts();
  const rows = await runBigQuerySqlRows(
    `
SELECT payload_json
FROM ${tableRef}
WHERE endpoint_key = @endpoint_key
  AND cache_key = @cache_key
ORDER BY generated_at DESC
LIMIT 1
`,
    [
      { name: "endpoint_key", type: "STRING", value: String(endpointKey || "").trim() },
      { name: "cache_key", type: "STRING", value: String(cacheKey || "").trim() },
    ],
    { profile: options?.profile || PRECOMPUTED_PROFILE },
  );
  const payloadJson = String(rows[0]?.payload_json || "").trim();
  if (!payloadJson) return null;
  try {
    return JSON.parse(payloadJson) as T;
  } catch {
    return null;
  }
}

export async function writePrecomputedPayload(
  row: Omit<PrecomputedPayloadRow, "generated_at">,
  options?: StoreOptions,
) {
  await ensureTable(options);
  const { project, dataset, table, tableRef } = tableParts();
  await runBigQuerySqlStatement(
    `
DELETE FROM ${tableRef}
WHERE endpoint_key = @endpoint_key
  AND cache_key = @cache_key
`,
    [
      { name: "endpoint_key", type: "STRING", value: String(row.endpoint_key || "").trim() },
      { name: "cache_key", type: "STRING", value: String(row.cache_key || "").trim() },
    ],
    { profile: options?.profile || PRECOMPUTED_PROFILE },
  );

  await insertBigQueryRows({
    projectId: project,
    dataset,
    table,
    rows: [
      {
        endpoint_key: String(row.endpoint_key || "").trim(),
        cache_key: String(row.cache_key || "").trim(),
        start_date: String(row.start_date || "").trim(),
        end_date: String(row.end_date || "").trim(),
        grain: String(row.grain || "").trim(),
        generated_at: new Date().toISOString(),
        payload_json: String(row.payload_json || ""),
      },
    ],
    options: { profile: options?.profile || PRECOMPUTED_PROFILE },
  });
}

