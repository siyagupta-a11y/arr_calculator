export type TvDashboardCredentials = {
  username: string;
  password: string;
};

const TV_PAGE_PREFIX = "/tv/scorecards";
const TV_API_PREFIX = "/api/tv/team-scorecards";

function constantTimeEqual(left: string, right: string) {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;

  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return mismatch === 0;
}

export function isTvDashboardPath(pathname: string) {
  const normalized = String(pathname || "").trim();
  return (
    normalized === TV_PAGE_PREFIX ||
    normalized.startsWith(`${TV_PAGE_PREFIX}/`) ||
    normalized === TV_API_PREFIX ||
    normalized.startsWith(`${TV_API_PREFIX}/`)
  );
}

export function readTvDashboardCredentials(): TvDashboardCredentials | null {
  const username = String(process.env.TV_DASHBOARD_USERNAME || "").trim();
  const password = String(process.env.TV_DASHBOARD_PASSWORD || "");
  if (!username || !password) return null;
  return { username, password };
}

export function verifyTvDashboardAuthorization(
  authorizationHeader: string | null | undefined,
  credentials: TvDashboardCredentials,
) {
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(String(authorizationHeader || "").trim());
  if (!match) return false;

  try {
    const decoded = atob(match[1]);
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex < 1) return false;

    const username = decoded.slice(0, separatorIndex);
    const password = decoded.slice(separatorIndex + 1);
    return (
      constantTimeEqual(username, credentials.username) &&
      constantTimeEqual(password, credentials.password)
    );
  } catch {
    return false;
  }
}
