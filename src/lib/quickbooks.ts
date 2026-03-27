import { Buffer } from "node:buffer";
import {
  clearQuickBooksConnection,
  loadQuickBooksConnections,
  quickBooksStorageKind,
  saveQuickBooksConnection,
  type QuickBooksConnection,
  type QuickBooksStorageKind,
} from "@/lib/quickbooksStore";

const QUICKBOOKS_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const QUICKBOOKS_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const QUICKBOOKS_API_BASE_PROD = "https://quickbooks.api.intuit.com";
const QUICKBOOKS_API_BASE_SANDBOX = "https://sandbox-quickbooks.api.intuit.com";
const QUICKBOOKS_DEFAULT_SCOPE = "com.intuit.quickbooks.accounting";
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60_000;

type QuickBooksEnv = "production" | "sandbox";

type QuickBooksConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  minorVersion: string;
  apiBaseUrl: string;
};

type QuickBooksTokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
};

type QuickBooksSalesMarketingCostPoint = {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  totalCost: number;
  matchedAccounts: string[];
  accountCostsByAccountId?: Record<string, number>;
  costByCurrency?: Record<string, number>;
};

type QuickBooksDepartment = {
  id: string;
  name: string;
};

type QuickBooksExpenseAccount = {
  id: string;
  name: string;
  fullyQualifiedName: string;
  accountType: string;
  subAccount: boolean;
  active: boolean;
  realmId?: string;
  companyName?: string;
  sourceAccountId?: string;
};

type QuickBooksProfitAndLossCol = {
  id?: string;
  value?: string;
};

type QuickBooksProfitAndLossRow = {
  type?: string;
  group?: string;
  Header?: { ColData?: QuickBooksProfitAndLossCol[] };
  ColData?: QuickBooksProfitAndLossCol[];
  Rows?: { Row?: QuickBooksProfitAndLossRow[] };
};

type QuickBooksQueryDepartment = {
  Id?: unknown;
  Name?: unknown;
  FullyQualifiedName?: unknown;
  Active?: unknown;
};

type QuickBooksQueryAccount = {
  Id?: unknown;
  Name?: unknown;
  FullyQualifiedName?: unknown;
  AccountType?: unknown;
  SubAccount?: unknown;
  Active?: unknown;
};

function clean(value: string | undefined | null) {
  return String(value || "").trim();
}

function readFirstEnv(...names: string[]) {
  for (const name of names) {
    const value = clean(process.env[name]);
    if (value) return value;
  }
  return "";
}

function mustReadEnv(label: string, ...names: string[]) {
  const value = readFirstEnv(...names);
  if (value) return value;
  throw new Error(`Missing ${label}. Set one of: ${names.join(", ")}`);
}

function resolveQuickBooksEnv(): QuickBooksEnv {
  const raw = clean(readFirstEnv("QUICKBOOKS_ENV", "INTUIT_ENV", "QB_ENV") || "production").toLowerCase();
  if (raw === "production" || raw === "sandbox") return raw;
  throw new Error("Invalid QUICKBOOKS_ENV. Supported values are 'production' and 'sandbox'.");
}

function parseScopes(raw: string) {
  const tokens = raw
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens.length > 0 ? tokens : [QUICKBOOKS_DEFAULT_SCOPE];
}

function parseDateOnly(value: string) {
  const trimmed = clean(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const parsed = new Date(Date.UTC(year, month, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return parsed;
}

function isoDateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function isoMonthKey(value: Date) {
  return value.toISOString().slice(0, 7);
}

function endOfUtcMonth(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0));
}

function startOfNextUtcMonth(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1));
}

function parseCsvList(raw: string) {
  return raw
    .split(/[,\n]/)
    .map((token) => clean(token).toLowerCase())
    .filter(Boolean);
}

function parseCsvListRaw(raw: string) {
  return raw
    .split(/[,\n]/)
    .map((token) => clean(token))
    .filter(Boolean);
}

function normalizeEntityId(value: string) {
  const text = clean(value);
  if (!text) return "";
  return text.replace(/\.0+$/, "");
}

function normalizeIdList(values: string[]) {
  return Array.from(new Set(values.map((value) => normalizeEntityId(value)).filter(Boolean)));
}

function accountScopedId(realmId: string, accountId: string) {
  const normalizedRealm = clean(realmId);
  const normalizedAccount = normalizeEntityId(accountId);
  if (!normalizedRealm || !normalizedAccount) return normalizedAccount;
  return `${normalizedRealm}:${normalizedAccount}`;
}

function splitScopedAccountId(value: string) {
  const normalized = normalizeEntityId(value);
  const idx = normalized.indexOf(":");
  if (idx <= 0) return { realmId: "", accountId: normalized };
  return {
    realmId: normalized.slice(0, idx).trim(),
    accountId: normalizeEntityId(normalized.slice(idx + 1)),
  };
}

function normalizedAccountLabel(value: string) {
  const text = clean(value).toLowerCase().replace(/\s+/g, " ");
  const withoutPrefix = text.replace(/^\d+[\s:-]+/, "");
  return withoutPrefix.trim();
}

function companyNameFromCompanyInfo(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const candidate = value as {
    CompanyName?: unknown;
    LegalName?: unknown;
    Name?: unknown;
  };
  return (
    clean(typeof candidate.CompanyName === "string" ? candidate.CompanyName : "") ||
    clean(typeof candidate.LegalName === "string" ? candidate.LegalName : "") ||
    clean(typeof candidate.Name === "string" ? candidate.Name : "")
  );
}

function normalizeQuickBooksMoney(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const normalized = text
    .replace(/[$,\s]/g, "")
    .replace(/^\((.*)\)$/, "-$1");
  const num = Number(normalized);
  return Number.isFinite(num) ? num : null;
}

function amountFromColData(cols: QuickBooksProfitAndLossCol[] | undefined) {
  const list = Array.isArray(cols) ? cols : [];
  for (let i = list.length - 1; i >= 1; i -= 1) {
    const parsed = normalizeQuickBooksMoney(list[i]?.value);
    if (parsed != null) return parsed;
  }
  return null;
}

function matchesExpenseAccountName(accountLower: string, exactAccountNames: string[]) {
  const account = normalizedAccountLabel(accountLower);
  if (!account) return false;
  for (const candidate of exactAccountNames) {
    const target = normalizedAccountLabel(candidate);
    if (!target) continue;
    if (account === target) return true;
    if (account.endsWith(`:${target}`)) return true;
    if (target.endsWith(`:${account}`)) return true;
  }
  return false;
}

function collectSalesMarketingCostsFromRows(params: {
  rows: QuickBooksProfitAndLossRow[];
  inExpensesSection: boolean;
  includeAllExpenseAccounts: boolean;
  selectedAccountIdSet: Set<string>;
  exactAccountNames: string[];
  keywordMatchers: string[];
  matchedAccounts: Set<string>;
  accountCostsByAccountId: Map<string, number>;
  accountIdTransform?: (accountId: string) => string;
  matchedAccountTransform?: (accountName: string) => string;
}): number {
  const {
    rows,
    inExpensesSection,
    includeAllExpenseAccounts,
    selectedAccountIdSet,
    exactAccountNames,
    keywordMatchers,
    matchedAccounts,
    accountCostsByAccountId,
    accountIdTransform,
    matchedAccountTransform,
  } = params;
  let total = 0;

  for (const row of rows) {
    const group = clean(row.group).toLowerCase();
    const sectionLabel = clean(row.Header?.ColData?.[0]?.value).toLowerCase();
    const nextInExpenses =
      inExpensesSection ||
      group === "expenses" ||
      sectionLabel === "expenses" ||
      sectionLabel === "expense";
    const type = clean(row.type).toLowerCase();

    if (type === "data" && nextInExpenses) {
      const accountId = normalizeEntityId(clean(row.ColData?.[0]?.id));
      const accountName = clean(row.ColData?.[0]?.value);
      const accountLower = accountName.toLowerCase();
      const matchesSelectedId = accountId ? selectedAccountIdSet.has(accountId) : false;
      const matchesSelectedName = accountLower ? matchesExpenseAccountName(accountLower, exactAccountNames) : false;
      const isMatch =
        accountLower &&
        (
          selectedAccountIdSet.size > 0
            ? (matchesSelectedId || matchesSelectedName)
            : includeAllExpenseAccounts ||
              (exactAccountNames.length > 0
                ? matchesExpenseAccountName(accountLower, exactAccountNames)
                : keywordMatchers.some((keyword) => accountLower.includes(keyword))
              )
        );
      if (isMatch) {
        const amount = amountFromColData(row.ColData);
        if (amount != null) {
          total += amount;
          matchedAccounts.add(matchedAccountTransform ? matchedAccountTransform(accountName) : accountName);
          if (accountId) {
            const scopedAccountId = accountIdTransform ? accountIdTransform(accountId) : accountId;
            accountCostsByAccountId.set(
              scopedAccountId,
              Math.round(((accountCostsByAccountId.get(scopedAccountId) || 0) + amount) * 100) / 100,
            );
          }
        }
      }
    }

    const childRows = Array.isArray(row.Rows?.Row) ? row.Rows?.Row : [];
    if (childRows.length > 0) {
      total += collectSalesMarketingCostsFromRows({
        rows: childRows,
        inExpensesSection: nextInExpenses,
        includeAllExpenseAccounts,
        selectedAccountIdSet,
        exactAccountNames,
        keywordMatchers,
        matchedAccounts,
        accountCostsByAccountId,
        accountIdTransform,
        matchedAccountTransform,
      });
    }
  }

  return total;
}

function parseSalesMarketingCostsFromProfitAndLoss(
  payload: unknown,
  includeAllExpenseAccounts: boolean,
  selectedAccountIds: string[],
  exactAccountNames: string[],
  keywordMatchers: string[],
  options?: {
    accountIdTransform?: (accountId: string) => string;
    matchedAccountTransform?: (accountName: string) => string;
  },
) {
  const rows = ((payload as { Rows?: { Row?: QuickBooksProfitAndLossRow[] } } | null)?.Rows?.Row || [])
    .filter(Boolean);
  const matchedAccounts = new Set<string>();
  const selectedAccountIdSet = new Set(normalizeIdList(selectedAccountIds));
  const accountCostsByAccountId = new Map<string, number>();
  const total = collectSalesMarketingCostsFromRows({
    rows,
    inExpensesSection: false,
    includeAllExpenseAccounts,
    selectedAccountIdSet,
    exactAccountNames,
    keywordMatchers,
    matchedAccounts,
    accountCostsByAccountId,
    accountIdTransform: options?.accountIdTransform,
    matchedAccountTransform: options?.matchedAccountTransform,
  });
  return {
    total,
    matchedAccounts: Array.from(matchedAccounts).sort(),
    accountCostsByAccountId: Object.fromEntries(accountCostsByAccountId.entries()),
  };
}

async function listQuickBooksDepartments(connection: QuickBooksConnection): Promise<QuickBooksDepartment[]> {
  let departmentsRaw: unknown[] = [];
  try {
    const response = await runQuickBooksQueryForConnection(connection, "SELECT * FROM Department MAXRESULTS 1000");
    const queryResponse = response.queryResponse as { Department?: unknown[] } | null;
    departmentsRaw = Array.isArray(queryResponse?.Department) ? queryResponse?.Department || [] : [];
  } catch {
    return [];
  }

  const mapped: QuickBooksDepartment[] = [];
  for (const row of departmentsRaw) {
    const dept = (row || {}) as QuickBooksQueryDepartment;
    const id = clean(typeof dept.Id === "string" || typeof dept.Id === "number" ? String(dept.Id) : "");
    const nameCandidate =
      clean(typeof dept.Name === "string" ? dept.Name : "") ||
      clean(typeof dept.FullyQualifiedName === "string" ? dept.FullyQualifiedName : "");
    const active =
      typeof dept.Active === "boolean"
        ? dept.Active
        : String(dept.Active || "").trim().toLowerCase() !== "false";
    if (!id || !nameCandidate || !active) continue;
    mapped.push({ id, name: nameCandidate });
  }
  return mapped;
}

function resolveQuickBooksDepartmentsByName(
  departments: QuickBooksDepartment[],
  targetDepartmentNames: string[],
): QuickBooksDepartment[] {
  const targets = Array.from(new Set(targetDepartmentNames.map((name) => clean(name).toLowerCase()).filter(Boolean)));
  if (targets.length === 0) return [];
  return departments.filter((dept) => {
    const lower = dept.name.toLowerCase();
    return targets.some((target) => lower === target || lower.includes(target));
  });
}

function resolveQuickBooksDepartmentsById(
  departments: QuickBooksDepartment[],
  targetDepartmentIds: string[],
): QuickBooksDepartment[] {
  const targets = new Set(targetDepartmentIds.map((id) => clean(id)).filter(Boolean));
  if (targets.size === 0) return [];
  return departments.filter((dept) => targets.has(dept.id));
}

async function listQuickBooksExpenseAccounts(connection: QuickBooksConnection): Promise<QuickBooksExpenseAccount[]> {
  const response = await runQuickBooksQueryForConnection(
    connection,
    "SELECT Id, Name, FullyQualifiedName, AccountType, SubAccount, Active FROM Account WHERE AccountType = 'Expense' MAXRESULTS 1000",
  );
  const queryResponse = response.queryResponse as { Account?: unknown[] } | null;
  const rows = Array.isArray(queryResponse?.Account) ? queryResponse?.Account || [] : [];
  const mapped: QuickBooksExpenseAccount[] = [];

  for (const row of rows) {
    const account = (row || {}) as QuickBooksQueryAccount;
    const id = clean(typeof account.Id === "string" || typeof account.Id === "number" ? String(account.Id) : "");
    const name = clean(typeof account.Name === "string" ? account.Name : "");
    const fullyQualifiedName = clean(
      typeof account.FullyQualifiedName === "string" ? account.FullyQualifiedName : "",
    );
    const accountType = clean(typeof account.AccountType === "string" ? account.AccountType : "");
    const subAccount =
      typeof account.SubAccount === "boolean"
        ? account.SubAccount
        : String(account.SubAccount || "").trim().toLowerCase() === "true";
    const active =
      typeof account.Active === "boolean"
        ? account.Active
        : String(account.Active || "").trim().toLowerCase() !== "false";

    if (!id || !name || !active) continue;
    mapped.push({
      id,
      name,
      fullyQualifiedName: fullyQualifiedName || name,
      accountType: accountType || "Expense",
      subAccount,
      active,
    });
  }

  mapped.sort((a, b) => {
    const aLabel = (a.fullyQualifiedName || a.name).toLowerCase();
    const bLabel = (b.fullyQualifiedName || b.name).toLowerCase();
    return aLabel.localeCompare(bLabel);
  });
  return mapped;
}

function validateDateRange(startDate: string, endDate: string) {
  const start = parseDateOnly(startDate);
  if (!start) throw new Error("Invalid startDate. Expected YYYY-MM-DD.");
  const end = parseDateOnly(endDate);
  if (!end) throw new Error("Invalid endDate. Expected YYYY-MM-DD.");
  if (end.getTime() < start.getTime()) throw new Error("endDate must be >= startDate.");
  return { start, end };
}

function getQuickBooksConfig(): QuickBooksConfig {
  const env = resolveQuickBooksEnv();
  const clientId = mustReadEnv(
    "QuickBooks client id",
    "QUICKBOOKS_CLIENT_ID",
    "INTUIT_CLIENT_ID",
    "QB_CLIENT_ID",
    "CLIENT_ID",
  );
  const clientSecret = mustReadEnv(
    "QuickBooks client secret",
    "QUICKBOOKS_CLIENT_SECRET",
    "INTUIT_CLIENT_SECRET",
    "QB_CLIENT_SECRET",
    "CLIENT_SECRET",
  );
  const redirectUri = mustReadEnv(
    "QuickBooks redirect URI",
    "QUICKBOOKS_REDIRECT_URI",
    "INTUIT_REDIRECT_URI",
    "QB_REDIRECT_URI",
    "REDIRECT_URI",
  );
  const scopes = parseScopes(readFirstEnv("QUICKBOOKS_SCOPES", "INTUIT_SCOPES"));
  const minorVersion = readFirstEnv("QUICKBOOKS_MINOR_VERSION") || "75";
  const apiBaseUrl =
    readFirstEnv("QUICKBOOKS_API_BASE_URL") ||
    (env === "sandbox" ? QUICKBOOKS_API_BASE_SANDBOX : QUICKBOOKS_API_BASE_PROD);

  return {
    clientId,
    clientSecret,
    redirectUri,
    scopes,
    minorVersion,
    apiBaseUrl,
  };
}

function basicAuthHeader(clientId: string, clientSecret: string) {
  const token = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

async function parseTokenResponse(res: Response): Promise<QuickBooksTokenResponse> {
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    if (!res.ok) {
      throw new Error(`QuickBooks OAuth error (${res.status}): ${text || "empty response"}`);
    }
    throw new Error("QuickBooks OAuth returned invalid JSON");
  }

  if (!res.ok) {
    throw new Error(`QuickBooks OAuth error (${res.status}): ${text || "empty response"}`);
  }

  const payload = (json || {}) as Partial<QuickBooksTokenResponse>;
  if (
    typeof payload.access_token !== "string" ||
    typeof payload.refresh_token !== "string" ||
    typeof payload.expires_in !== "number"
  ) {
    throw new Error("QuickBooks OAuth response is missing required token fields");
  }

  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    token_type: typeof payload.token_type === "string" ? payload.token_type : "Bearer",
    scope: typeof payload.scope === "string" ? payload.scope : "",
    expires_in: payload.expires_in,
    x_refresh_token_expires_in:
      typeof payload.x_refresh_token_expires_in === "number"
        ? payload.x_refresh_token_expires_in
        : 100 * 24 * 60 * 60,
  };
}

async function exchangeTokens(params: URLSearchParams) {
  const config = getQuickBooksConfig();
  const res = await fetch(QUICKBOOKS_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(config.clientId, config.clientSecret),
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
    cache: "no-store",
  });
  return parseTokenResponse(res);
}

function toConnection(
  realmId: string,
  tokens: QuickBooksTokenResponse,
  previous: QuickBooksConnection | null,
): QuickBooksConnection {
  const now = Date.now();
  return {
    realmId: clean(realmId),
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenType: clean(tokens.token_type || "Bearer"),
    scope: clean(tokens.scope || previous?.scope || ""),
    accessTokenExpiresAt: now + Math.max(1, Number(tokens.expires_in || 0)) * 1000,
    refreshTokenExpiresAt:
      now + Math.max(1, Number(tokens.x_refresh_token_expires_in || 0)) * 1000,
    connectedAt: previous?.connectedAt || now,
    updatedAt: now,
  };
}

async function refreshConnection(connection: QuickBooksConnection) {
  const tokens = await exchangeTokens(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: connection.refreshToken,
    }),
  );
  const refreshed = toConnection(connection.realmId, tokens, connection);
  await saveQuickBooksConnection(refreshed);
  return refreshed;
}

async function ensureValidConnections() {
  const { connections, storage } = await loadQuickBooksConnections();
  if (!connections.length) {
    throw new Error("QuickBooks is not connected. Start with /api/quickbooks/connect.");
  }

  const validated = await Promise.all(
    connections.map(async (connection) => {
      const now = Date.now();
      if (connection.accessTokenExpiresAt - now > ACCESS_TOKEN_REFRESH_BUFFER_MS) return connection;
      return refreshConnection(connection);
    }),
  );

  return {
    connections: validated.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)),
    storage,
  };
}

async function ensureValidConnection() {
  const { connections, storage } = await ensureValidConnections();
  return { connection: connections[0], storage };
}

async function parseApiPayload(res: Response) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function quickBooksGetJsonForConnection(
  connection: QuickBooksConnection,
  pathnameWithQuery: string,
  retryOnUnauthorized = true,
) {
  const config = getQuickBooksConfig();
  const url = new URL(pathnameWithQuery, `${config.apiBaseUrl}/`);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `${connection.tokenType || "Bearer"} ${connection.accessToken}`,
    },
    cache: "no-store",
  });

  if (res.status === 401 && retryOnUnauthorized) {
    const refreshed = await refreshConnection(connection);
    return quickBooksGetJsonForConnection(refreshed, pathnameWithQuery, false);
  }

  const payload = await parseApiPayload(res);
  if (!res.ok) {
    const details = typeof payload === "string" ? payload : JSON.stringify(payload);
    throw new Error(`QuickBooks API error (${res.status}): ${details}`);
  }
  return payload;
}

export function buildQuickBooksAuthorizeUrl(state: string) {
  const config = getQuickBooksConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    scope: config.scopes.join(" "),
    redirect_uri: config.redirectUri,
    state,
  });
  return `${QUICKBOOKS_AUTHORIZE_URL}?${params.toString()}`;
}

export async function connectQuickBooksFromOAuthCallback(code: string, realmId: string) {
  const config = getQuickBooksConfig();
  const { connections } = await loadQuickBooksConnections();
  const normalizedRealmId = clean(realmId);
  const previous =
    connections.find((connection) => clean(connection.realmId) === normalizedRealmId) ||
    null;
  const tokens = await exchangeTokens(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
    }),
  );
  const next = toConnection(realmId, tokens, previous);
  await saveQuickBooksConnection(next);
  return next;
}

export async function disconnectQuickBooks() {
  await clearQuickBooksConnection();
}

export async function getQuickBooksStatus(): Promise<{
  connected: boolean;
  storage: QuickBooksStorageKind;
  realmId?: string;
  realmIds?: string[];
  scope?: string;
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
  updatedAt?: number;
  connections?: Array<{
    realmId: string;
    scope: string;
    accessTokenExpiresAt: number;
    refreshTokenExpiresAt: number;
    updatedAt: number;
  }>;
  statusError?: string;
  needsReconnect?: boolean;
}> {
  try {
    const { connections, storage } = await ensureValidConnections();
    const primary = connections[0];
    return {
      connected: connections.length > 0,
      storage,
      realmId: primary?.realmId,
      realmIds: connections.map((connection) => connection.realmId),
      scope: primary?.scope,
      accessTokenExpiresAt: primary?.accessTokenExpiresAt,
      refreshTokenExpiresAt: primary?.refreshTokenExpiresAt,
      updatedAt: primary?.updatedAt,
      connections: connections.map((connection) => ({
        realmId: connection.realmId,
        scope: connection.scope,
        accessTokenExpiresAt: connection.accessTokenExpiresAt,
        refreshTokenExpiresAt: connection.refreshTokenExpiresAt,
        updatedAt: connection.updatedAt,
      })),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const lower = message.toLowerCase();
    const isReconnectError =
      lower.includes("invalid_grant") ||
      lower.includes("not connected") ||
      lower.includes("refresh token") ||
      lower.includes("token has been revoked") ||
      lower.includes("token expired");

    try {
      const { connections, storage } = await loadQuickBooksConnections();
      if (!connections.length) {
        return {
          connected: false,
          storage,
          statusError: message,
          needsReconnect: isReconnectError || lower.includes("not connected"),
        };
      }
      const primary = connections[0];
      return {
        connected: !isReconnectError,
        storage,
        realmId: primary.realmId,
        realmIds: connections.map((connection) => connection.realmId),
        scope: primary.scope,
        accessTokenExpiresAt: primary.accessTokenExpiresAt,
        refreshTokenExpiresAt: primary.refreshTokenExpiresAt,
        updatedAt: primary.updatedAt,
        connections: connections.map((connection) => ({
          realmId: connection.realmId,
          scope: connection.scope,
          accessTokenExpiresAt: connection.accessTokenExpiresAt,
          refreshTokenExpiresAt: connection.refreshTokenExpiresAt,
          updatedAt: connection.updatedAt,
        })),
        statusError: message,
        needsReconnect: isReconnectError,
      };
    } catch {
      return {
        connected: false,
        storage: quickBooksStorageKind(),
        statusError: message,
        needsReconnect: isReconnectError,
      };
    }
  }
}

export async function fetchQuickBooksCompanyInfo() {
  const { connections } = await ensureValidConnections();
  const { minorVersion } = getQuickBooksConfig();
  const companies = await Promise.all(
    connections.map(async (connection) => {
      const realmId = encodeURIComponent(connection.realmId);
      const payload = await quickBooksGetJsonForConnection(
        connection,
        `/v3/company/${realmId}/companyinfo/${realmId}?minorversion=${encodeURIComponent(minorVersion)}`,
      );
      const companyInfo = (payload as { CompanyInfo?: unknown } | null)?.CompanyInfo;
      return {
        realmId: connection.realmId,
        companyInfo: companyInfo || null,
        raw: payload,
      };
    }),
  );
  const primary = companies[0];
  return {
    realmId: primary?.realmId || "",
    companyInfo: primary?.companyInfo || null,
    raw: primary?.raw || null,
    companies,
  };
}

export async function fetchQuickBooksExpenseAccounts() {
  const companyInfoPayload = await fetchQuickBooksCompanyInfo();
  const companyNameByRealm = new Map<string, string>(
    (companyInfoPayload.companies || []).map((company) => [
      clean(company.realmId),
      companyNameFromCompanyInfo(company.companyInfo),
    ]),
  );
  const { connections } = await ensureValidConnections();
  const accounts = (
    await Promise.all(
      connections.map(async (connection) => {
        const realmId = clean(connection.realmId);
        const companyName = companyNameByRealm.get(realmId) || `Realm ${realmId}`;
        const rows = await listQuickBooksExpenseAccounts(connection);
        return rows.map((row) => ({
          ...row,
          id: accountScopedId(realmId, row.id),
          sourceAccountId: row.id,
          realmId,
          companyName,
          fullyQualifiedName: `${companyName}: ${row.fullyQualifiedName || row.name || row.id}`,
        }));
      }),
    )
  ).flat();
  accounts.sort((a, b) => (a.fullyQualifiedName || a.name).localeCompare(b.fullyQualifiedName || b.name));
  return {
    realmId: connections[0]?.realmId || "",
    realmIds: connections.map((connection) => connection.realmId),
    accounts,
  };
}

export async function fetchQuickBooksSalesMarketingCostsByMonth(
  startDate: string,
  endDate: string,
  options?: { selectedAccountIds?: string[]; selectedAccountNames?: string[] },
) {
  const { start, end } = validateDateRange(startDate, endDate);
  const { connections } = await ensureValidConnections();
  const primaryRealmId = connections[0]?.realmId || "";
  const { minorVersion } = getQuickBooksConfig();
  const selectedAccountIds = normalizeIdList(options?.selectedAccountIds || []);
  const selectedAccountNames = Array.from(
    new Set(
      (options?.selectedAccountNames || [])
        .map((value) => clean(value).toLowerCase())
        .filter(Boolean),
    ),
  );

  const configuredDepartmentIds = Array.from(
    new Set(parseCsvListRaw(process.env.QUICKBOOKS_CAC_DEPARTMENT_IDS || "")),
  );
  const configuredDepartmentNames = Array.from(
    new Set(parseCsvList(process.env.QUICKBOOKS_CAC_DEPARTMENT_NAMES || "sales,marketing")),
  );
  const matchedDepartments: QuickBooksDepartment[] = [];
  const departmentIds = new Set<string>();

  const configuredAccountNames = parseCsvList(process.env.QUICKBOOKS_CAC_EXPENSE_ACCOUNT_NAMES || "");
  const configuredKeywords = parseCsvList(process.env.QUICKBOOKS_CAC_EXPENSE_KEYWORDS || "");
  const keywordMatchers =
    configuredKeywords.length > 0
      ? configuredKeywords
      : ["sales", "marketing", "advertising", "promotion", "promo"];
  const accountMatchMode =
    selectedAccountIds.length > 0 || selectedAccountNames.length > 0
      ? "selected_accounts"
      : configuredDepartmentIds.length > 0 || configuredDepartmentNames.length > 0
        ? "department"
        : configuredAccountNames.length > 0
          ? "exact_names"
          : "keywords";

  const accountingMethod = clean(process.env.QUICKBOOKS_CAC_ACCOUNTING_METHOD || "Accrual");
  const pointsByMonth = new Map<
    string,
    {
      key: string;
      label: string;
      periodStart: string;
      periodEnd: string;
      totalCost: number;
      matchedAccounts: Set<string>;
      accountCostsByAccountId: Map<string, number>;
      costByCurrency: Map<string, number>;
    }
  >();
  const matchedAccounts = new Set<string>();
  const currencies = new Set<string>();
  const realmCurrencyByRealmId = new Map<string, string>();
  const accountCurrencyByAccountId = new Map<string, string>();
  let reportCurrency = "";
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));

  while (cursor.getTime() <= end.getTime()) {
    const monthStart = cursor;
    const monthEnd = endOfUtcMonth(monthStart);
    const boundedStart = monthStart.getTime() < start.getTime() ? start : monthStart;
    const boundedEnd = monthEnd.getTime() > end.getTime() ? end : monthEnd;
    const monthKey = isoMonthKey(monthStart);
    if (!pointsByMonth.has(monthKey)) {
      pointsByMonth.set(monthKey, {
        key: monthKey,
        label: monthKey,
        periodStart: isoDateOnly(boundedStart),
        periodEnd: isoDateOnly(boundedEnd),
        totalCost: 0,
        matchedAccounts: new Set<string>(),
        accountCostsByAccountId: new Map<string, number>(),
        costByCurrency: new Map<string, number>(),
      });
    }

    cursor = startOfNextUtcMonth(cursor);
  }

  for (const connection of connections) {
    const realmId = clean(connection.realmId);
    const scopedSelectedAccountIds = selectedAccountIds
      .map((id) => splitScopedAccountId(id))
      .filter(({ realmId: scopedRealmId, accountId }) => {
        if (!accountId) return false;
        if (!scopedRealmId) return true;
        return clean(scopedRealmId) === realmId;
      })
      .map(({ accountId }) => accountId);
    const useSelectedAccounts = scopedSelectedAccountIds.length > 0 || selectedAccountNames.length > 0;

    let matchedDepartmentsForRealm: QuickBooksDepartment[] = [];
    let departmentIdsForRealm: string[] = [];
    if (!useSelectedAccounts) {
      const allDepartments = await listQuickBooksDepartments(connection);
      matchedDepartmentsForRealm =
        configuredDepartmentIds.length > 0
          ? resolveQuickBooksDepartmentsById(allDepartments, configuredDepartmentIds)
          : resolveQuickBooksDepartmentsByName(allDepartments, configuredDepartmentNames);
      departmentIdsForRealm = Array.from(
        new Set(
          (configuredDepartmentIds.length > 0 ? configuredDepartmentIds : matchedDepartmentsForRealm.map((dept) => dept.id))
            .map((id) => clean(id))
            .filter(Boolean),
        ),
      );
      for (const departmentId of departmentIdsForRealm) {
        departmentIds.add(accountScopedId(realmId, departmentId));
      }
      for (const department of matchedDepartmentsForRealm) {
        matchedDepartments.push({
          id: accountScopedId(realmId, department.id),
          name: `${realmId}: ${department.name}`,
        });
      }
    }
    const useDepartmentFilter = !useSelectedAccounts && departmentIdsForRealm.length > 0;
    const effectiveExactAccountNames = useSelectedAccounts ? selectedAccountNames : configuredAccountNames;
    const effectiveKeywords = useSelectedAccounts ? [] : keywordMatchers;

    let monthCursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    while (monthCursor.getTime() <= end.getTime()) {
      const monthStart = monthCursor;
      const monthEnd = endOfUtcMonth(monthStart);
      const boundedStart = monthStart.getTime() < start.getTime() ? start : monthStart;
      const boundedEnd = monthEnd.getTime() > end.getTime() ? end : monthEnd;
      const monthKey = isoMonthKey(monthStart);

      const qs = new URLSearchParams({
        start_date: isoDateOnly(boundedStart),
        end_date: isoDateOnly(boundedEnd),
        accounting_method: accountingMethod,
        minorversion: minorVersion,
      });
      if (useDepartmentFilter) {
        qs.set("department", departmentIdsForRealm.join(","));
      }

      const reportPayload = await quickBooksGetJsonForConnection(
        connection,
        `/v3/company/${encodeURIComponent(realmId)}/reports/ProfitAndLoss?${qs.toString()}`,
      );
      const rawRealmCurrency = clean(
        (
          reportPayload as {
            Header?: { Currency?: string };
          } | null
        )?.Header?.Currency,
      );
      if (rawRealmCurrency) {
        realmCurrencyByRealmId.set(realmId, rawRealmCurrency.toUpperCase());
      }
      const realmCurrency = (
        realmCurrencyByRealmId.get(realmId) ||
        rawRealmCurrency ||
        reportCurrency ||
        "USD"
      ).toUpperCase();
      if (!reportCurrency && realmCurrency) {
        reportCurrency = realmCurrency;
      }
      currencies.add(realmCurrency);

      const parsed = parseSalesMarketingCostsFromProfitAndLoss(
        reportPayload,
        useDepartmentFilter,
        scopedSelectedAccountIds,
        effectiveExactAccountNames,
        effectiveKeywords,
        {
          accountIdTransform: (accountId) => accountScopedId(realmId, accountId),
          matchedAccountTransform: (accountName) => `${realmId}: ${accountName}`,
        },
      );

      const monthBucket = pointsByMonth.get(monthKey)!;
      monthBucket.totalCost = Math.round((monthBucket.totalCost + parsed.total) * 100) / 100;
      monthBucket.costByCurrency.set(
        realmCurrency,
        Math.round(((monthBucket.costByCurrency.get(realmCurrency) || 0) + parsed.total) * 100) / 100,
      );
      for (const accountName of parsed.matchedAccounts) {
        matchedAccounts.add(accountName);
        monthBucket.matchedAccounts.add(accountName);
      }
      for (const [accountId, amount] of Object.entries(parsed.accountCostsByAccountId || {})) {
        if (!accountCurrencyByAccountId.has(accountId)) {
          accountCurrencyByAccountId.set(accountId, realmCurrency);
        }
        monthBucket.accountCostsByAccountId.set(
          accountId,
          Math.round(((monthBucket.accountCostsByAccountId.get(accountId) || 0) + Number(amount || 0)) * 100) / 100,
        );
      }

      monthCursor = startOfNextUtcMonth(monthCursor);
    }
  }

  const points: QuickBooksSalesMarketingCostPoint[] = Array.from(pointsByMonth.values())
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((point) => ({
      key: point.key,
      label: point.label,
      periodStart: point.periodStart,
      periodEnd: point.periodEnd,
      totalCost: Math.round(point.totalCost * 100) / 100,
      matchedAccounts: Array.from(point.matchedAccounts).sort(),
      accountCostsByAccountId: Object.fromEntries(point.accountCostsByAccountId.entries()),
      costByCurrency: Object.fromEntries(point.costByCurrency.entries()),
    }));

  return {
    realmId: primaryRealmId,
    realmIds: connections.map((connection) => connection.realmId),
    accountMatchMode,
    selectedAccountIds,
    departmentIds: Array.from(departmentIds),
    departmentNames: configuredDepartmentNames,
    matchedDepartments: matchedDepartments.length
      ? matchedDepartments
      : configuredDepartmentIds.map((id) => ({ id, name: id })),
    accountNames: configuredAccountNames,
    keywords: keywordMatchers,
    accountingMethod,
    currency: reportCurrency || "USD",
    currencies: Array.from(currencies).sort(),
    realmCurrencyByRealmId: Object.fromEntries(realmCurrencyByRealmId.entries()),
    accountCurrencyByAccountId: Object.fromEntries(accountCurrencyByAccountId.entries()),
    points,
    matchedAccounts: Array.from(matchedAccounts).sort(),
  };
}

export async function runQuickBooksQueryForConnection(connection: QuickBooksConnection, query: string) {
  const trimmed = clean(query);
  if (!trimmed) throw new Error("Query is required");
  if (trimmed.length > 20_000) throw new Error("Query is too long (max 20000 characters)");

  const { minorVersion } = getQuickBooksConfig();
  const qs = new URLSearchParams({
    query: trimmed,
    minorversion: minorVersion,
  });
  const payload = await quickBooksGetJsonForConnection(
    connection,
    `/v3/company/${encodeURIComponent(connection.realmId)}/query?${qs.toString()}`,
  );

  const queryResponse = (payload as { QueryResponse?: unknown } | null)?.QueryResponse;
  return {
    realmId: connection.realmId,
    query: trimmed,
    queryResponse: queryResponse || null,
    raw: payload,
  };
}

export async function runQuickBooksQuery(query: string) {
  const { connection } = await ensureValidConnection();
  return runQuickBooksQueryForConnection(connection, query);
}
