import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

const PUBLIC_PAGE_PATHS = new Set<string>(["/login", "/privacy-policy", "/eula"]);
const PUBLIC_API_PATH_PREFIXES = [
  "/api/auth",
  "/api/quickbooks/callback",
  "/api/quickbooks/keepalive",
  "/api/slack/daily-arr-summary",
  "/api/stripe-sync",
  "/api/stripe-sync/status",
  "/api/stripe-upcoming-sync",
  "/api/stripe-upcoming-snapshots-cleanup",
  "/api/stripe-bigquery-refresh",
  "/api/hubspot-current-metrics-sync",
  "/api/cache/nightly-sync",
];
const ADMIN_PAGE_PATH_PREFIXES = ["/model-update", "/lease-prediction"];
const ADMIN_API_PATH_PREFIXES = ["/api/model-update", "/api/lease-prediction"];

function isPublicApiPath(pathname: string) {
  return PUBLIC_API_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function matchesAnyPrefix(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (PUBLIC_PAGE_PATHS.has(pathname)) return NextResponse.next();
  if (pathname.startsWith("/api/") && isPublicApiPath(pathname)) return NextResponse.next();

  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
  });
  if (!token) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const loginUrl = new URL("/login", request.nextUrl.origin);
    const callbackUrl = `${request.nextUrl.pathname}${request.nextUrl.search}`;
    loginUrl.searchParams.set("callbackUrl", callbackUrl);
    return NextResponse.redirect(loginUrl);
  }

  const isAdmin = String(token.role || "viewer").trim().toLowerCase() === "admin";
  const requiresAdminPage = matchesAnyPrefix(pathname, ADMIN_PAGE_PATH_PREFIXES);
  const requiresAdminApi = pathname.startsWith("/api/")
    ? matchesAnyPrefix(pathname, ADMIN_API_PATH_PREFIXES)
    : false;
  if ((requiresAdminPage || requiresAdminApi) && !isAdmin) {
    if (requiresAdminApi) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.redirect(new URL("/combined-all-subs?error=admin_required", request.nextUrl.origin));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
