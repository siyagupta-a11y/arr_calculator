import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/auth";

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
];

function isPublicApiPath(pathname: string) {
  return PUBLIC_API_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export default auth((request: NextRequest & { auth?: unknown }) => {
  const pathname = request.nextUrl.pathname;

  if (PUBLIC_PAGE_PATHS.has(pathname)) return NextResponse.next();
  if (pathname.startsWith("/api/") && isPublicApiPath(pathname)) return NextResponse.next();
  if (request.auth) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.nextUrl.origin);
  const callbackUrl = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  loginUrl.searchParams.set("callbackUrl", callbackUrl);
  return NextResponse.redirect(loginUrl);
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
