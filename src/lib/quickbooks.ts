import { Buffer } from "node:buffer";
import {
  clearQuickBooksConnection,
  loadQuickBooksConnection,
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

async function ensureValidConnection() {
  const { connection, storage } = await loadQuickBooksConnection();
  if (!connection) {
    throw new Error("QuickBooks is not connected. Start with /api/quickbooks/connect.");
  }

  const now = Date.now();
  if (connection.accessTokenExpiresAt - now > ACCESS_TOKEN_REFRESH_BUFFER_MS) {
    return { connection, storage };
  }

  const refreshed = await refreshConnection(connection);
  return { connection: refreshed, storage };
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

async function quickBooksGetJson(pathnameWithQuery: string, retryOnUnauthorized = true) {
  const { connection } = await ensureValidConnection();
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
    await refreshConnection(connection);
    return quickBooksGetJson(pathnameWithQuery, false);
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
  const { connection: previous } = await loadQuickBooksConnection();
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
  scope?: string;
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
  updatedAt?: number;
}> {
  const { connection, storage } = await loadQuickBooksConnection();
  if (!connection) return { connected: false, storage };

  return {
    connected: true,
    storage,
    realmId: connection.realmId,
    scope: connection.scope,
    accessTokenExpiresAt: connection.accessTokenExpiresAt,
    refreshTokenExpiresAt: connection.refreshTokenExpiresAt,
    updatedAt: connection.updatedAt,
  };
}

export async function fetchQuickBooksCompanyInfo() {
  const { connection } = await ensureValidConnection();
  const { minorVersion } = getQuickBooksConfig();
  const realmId = encodeURIComponent(connection.realmId);
  const payload = await quickBooksGetJson(
    `/v3/company/${realmId}/companyinfo/${realmId}?minorversion=${encodeURIComponent(minorVersion)}`,
  );

  const companyInfo = (payload as { CompanyInfo?: unknown } | null)?.CompanyInfo;
  return {
    realmId: connection.realmId,
    companyInfo: companyInfo || null,
    raw: payload,
  };
}

export async function runQuickBooksQuery(query: string) {
  const trimmed = clean(query);
  if (!trimmed) throw new Error("Query is required");
  if (trimmed.length > 20_000) throw new Error("Query is too long (max 20000 characters)");

  const { connection } = await ensureValidConnection();
  const { minorVersion } = getQuickBooksConfig();
  const qs = new URLSearchParams({
    query: trimmed,
    minorversion: minorVersion,
  });
  const payload = await quickBooksGetJson(
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
