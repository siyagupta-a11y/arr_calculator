import { createHash, createSign } from "node:crypto";

type ServiceAccount = {
  client_email: string;
  private_key: string;
  project_id?: string;
};

type GcsListResponse = {
  prefixes?: unknown;
  nextPageToken?: unknown;
};

type BigQueryQueryResponse = {
  errors?: Array<unknown>;
};

export type StripeBigQueryBucketRefreshRequest = {
  dryRun?: boolean;
  snapshot?: string;
  mode?: string;
};

export type StripeBigQueryBucketRefreshTableResult = {
  folder: string;
  tableName: string;
  uri: string;
  updated: boolean;
};

export type StripeBigQueryBucketRefreshResult = {
  bucket: string;
  snapshot: string;
  mode: string;
  fileGlob: string;
  projectId: string;
  dataset: string;
  location: string;
  sourceFormat: string;
  dryRun: boolean;
  folderCount: number;
  updatedCount: number;
  tables: StripeBigQueryBucketRefreshTableResult[];
};

const TOKEN_AUDIENCE = "https://oauth2.googleapis.com/token";
const CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const GCS_API_ROOT = "https://storage.googleapis.com/storage/v1";
const BQ_API_ROOT = "https://bigquery.googleapis.com/bigquery/v2";
const SNAPSHOT_PATTERN = /^\d{10}$/;

const FOLDER_TABLE_OVERRIDES: Record<string, string> = {
  // The canonical table name in this dataset is invoice_lines.
  invoice_line_items: "invoice_lines",
};

function asBool(value: unknown, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "y";
}

function env(name: string, fallback: string) {
  const value = process.env[name];
  return value == null || value === "" ? fallback : value;
}

function envAny(names: string[], fallback: string) {
  for (const name of names) {
    const value = process.env[name];
    if (value != null && value !== "") return value;
  }
  return fallback;
}

function base64Url(input: Buffer | string) {
  const raw = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return raw.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function getServiceAccount(): ServiceAccount {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const rawB64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  if (!raw && !rawB64) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_JSON_BASE64");
  }

  const jsonText = raw || Buffer.from(rawB64!, "base64").toString("utf8");
  const parsed = JSON.parse(jsonText) as Partial<ServiceAccount>;
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("Service account JSON is missing client_email/private_key");
  }

  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    project_id: parsed.project_id,
  };
}

async function getAccessToken(serviceAccount: ServiceAccount) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: TOKEN_AUDIENCE,
    scope: CLOUD_SCOPE,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };

  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(serviceAccount.private_key);
  const assertion = `${unsigned}.${base64Url(signature)}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const response = await fetch(TOKEN_AUDIENCE, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Google token error ${response.status}: ${text}`);
  }
  const json = JSON.parse(text) as { access_token?: string };
  if (!json.access_token) {
    throw new Error("Token response missing access_token");
  }
  return json.access_token;
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) ${url}: ${text}`);
  }
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

function normalizePrefix(prefix: string) {
  const clean = String(prefix || "").trim();
  if (!clean) return "";
  return clean.endsWith("/") ? clean : `${clean}/`;
}

async function listImmediateChildFolders(params: {
  accessToken: string;
  bucket: string;
  rootPrefix: string;
}) {
  const { accessToken, bucket, rootPrefix } = params;
  const folders: string[] = [];
  let pageToken = "";

  while (true) {
    const url = new URL(`${GCS_API_ROOT}/b/${encodeURIComponent(bucket)}/o`);
    url.searchParams.set("prefix", rootPrefix);
    url.searchParams.set("delimiter", "/");
    url.searchParams.set("maxResults", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const data = await fetchJson<GcsListResponse>(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });

    const prefixes = Array.isArray(data.prefixes) ? data.prefixes : [];
    for (const rawPrefix of prefixes) {
      if (typeof rawPrefix !== "string") continue;
      if (!rawPrefix.startsWith(rootPrefix)) continue;
      const trimmed = rawPrefix.slice(rootPrefix.length).replace(/\/+$/, "");
      if (!trimmed) continue;
      folders.push(trimmed);
    }

    pageToken = typeof data.nextPageToken === "string" ? data.nextPageToken : "";
    if (!pageToken) break;
  }

  return folders.sort((a, b) => a.localeCompare(b));
}

function slugifyTableName(folderName: string) {
  const normalized = folderName
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  const withPrefix = /^[a-z_]/.test(normalized) ? normalized : `t_${normalized || "folder"}`;
  return withPrefix.slice(0, 128);
}

function hashSuffix(input: string) {
  return createHash("sha1").update(input).digest("hex").slice(0, 8);
}

function buildFolderTableMap(folders: string[]) {
  const taken = new Map<string, string>();
  const mapping: Array<{ folder: string; tableName: string }> = [];

  for (const folder of folders) {
    let tableName = FOLDER_TABLE_OVERRIDES[folder] || slugifyTableName(folder);
    const existing = taken.get(tableName);
    if (existing && existing !== folder) {
      tableName = `${tableName.slice(0, 119)}_${hashSuffix(folder)}`;
    }
    taken.set(tableName, folder);
    mapping.push({ folder, tableName });
  }

  return mapping;
}

function buildCreateExternalTableSql(params: {
  projectId: string;
  dataset: string;
  tableName: string;
  sourceFormat: string;
  uri: string;
}) {
  const { projectId, dataset, tableName, sourceFormat, uri } = params;
  return [
    `CREATE OR REPLACE EXTERNAL TABLE \`${projectId}.${dataset}.${tableName}\``,
    "OPTIONS (",
    `  format = '${sourceFormat}',`,
    `  uris = ['${uri}']`,
    ");",
  ].join("\n");
}

async function runBigQuerySql(params: {
  accessToken: string;
  projectId: string;
  location: string;
  query: string;
}) {
  const { accessToken, projectId, location, query } = params;
  const url = `${BQ_API_ROOT}/projects/${encodeURIComponent(projectId)}/queries`;
  const body = {
    query,
    useLegacySql: false,
    location,
  };

  const data = await fetchJson<BigQueryQueryResponse>(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  if (Array.isArray(data.errors) && data.errors.length > 0) {
    throw new Error(`BigQuery query error: ${JSON.stringify(data.errors)}`);
  }
}

export async function refreshStripeBigQueryExternalTablesFromBucket(
  request: StripeBigQueryBucketRefreshRequest = {},
): Promise<StripeBigQueryBucketRefreshResult> {
  const bucket = envAny(["GCS_BUCKET", "STRIPE_GCS_BUCKET"], "");
  if (!bucket) throw new Error("Missing env var: GCS_BUCKET");
  const mode = String(request.mode || env("STRIPE_BQ_SNAPSHOT_MODE", "livemode"))
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (!mode) throw new Error("Invalid mode");
  const snapshotOverride = String(request.snapshot || env("STRIPE_BQ_SNAPSHOT", "")).trim();
  const fileGlob = env("GCS_FILE_GLOB", "*");
  const sourceFormat = env("SOURCE_FORMAT", "PARQUET").toUpperCase();

  const serviceAccount = getServiceAccount();
  const projectId = envAny(["BQ_PROJECT_ID", "BIGQUERY_PROJECT_ID"], serviceAccount.project_id || "");
  if (!projectId) {
    throw new Error("Missing BQ_PROJECT_ID and project_id was not present in service account JSON");
  }

  const dataset = env("BQ_DATASET", "stripe");
  const location = envAny(["BQ_LOCATION", "BIGQUERY_LOCATION"], "US");
  const dryRun = request.dryRun ?? asBool(process.env.STRIPE_BQ_BUCKET_REFRESH_DRY_RUN, false);

  const accessToken = await getAccessToken(serviceAccount);
  const topLevelFolders = await listImmediateChildFolders({ accessToken, bucket, rootPrefix: normalizePrefix("") });
  const snapshotCandidatesRaw = topLevelFolders.filter(Boolean);
  const snapshotCandidates = (snapshotCandidatesRaw.some((folder) => SNAPSHOT_PATTERN.test(folder))
    ? snapshotCandidatesRaw.filter((folder) => SNAPSHOT_PATTERN.test(folder))
    : snapshotCandidatesRaw
  ).sort((a, b) => a.localeCompare(b));

  let snapshot = snapshotOverride;
  let folders: string[] = [];

  if (snapshot) {
    folders = await listImmediateChildFolders({
      accessToken,
      bucket,
      rootPrefix: normalizePrefix(`${snapshot}/${mode}`),
    });
  } else {
    for (let idx = snapshotCandidates.length - 1; idx >= 0; idx--) {
      const candidate = snapshotCandidates[idx];
      const candidateFolders = await listImmediateChildFolders({
        accessToken,
        bucket,
        rootPrefix: normalizePrefix(`${candidate}/${mode}`),
      });
      if (candidateFolders.length > 0) {
        snapshot = candidate;
        folders = candidateFolders;
        break;
      }
    }
  }

  if (!snapshot) {
    throw new Error(`No snapshot found in bucket ${bucket}`);
  }
  if (folders.length === 0) {
    throw new Error(`No folders found under gs://${bucket}/${snapshot}/${mode}/`);
  }

  const mapping = buildFolderTableMap(folders);

  const tables: StripeBigQueryBucketRefreshTableResult[] = [];
  for (const item of mapping) {
    const uri = `gs://${bucket}/${snapshot}/${mode}/${item.folder}/${fileGlob}`;
    const query = buildCreateExternalTableSql({
      projectId,
      dataset,
      tableName: item.tableName,
      sourceFormat,
      uri,
    });

    if (!dryRun) {
      await runBigQuerySql({
        accessToken,
        projectId,
        location,
        query,
      });
    }

    tables.push({
      folder: item.folder,
      tableName: item.tableName,
      uri,
      updated: !dryRun,
    });
  }

  return {
    bucket,
    snapshot,
    mode,
    fileGlob,
    projectId,
    dataset,
    location,
    sourceFormat,
    dryRun,
    folderCount: folders.length,
    updatedCount: tables.filter((table) => table.updated).length,
    tables,
  };
}
