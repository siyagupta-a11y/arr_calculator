import { NextResponse, type NextRequest } from "next/server";
import { connectQuickBooksFromOAuthCallback } from "@/lib/quickbooks";
import { loadQuickBooksConnections } from "@/lib/quickbooksStore";

export const runtime = "nodejs";

const OAUTH_STATE_COOKIE = "qb_oauth_state";
const OAUTH_MODE_COOKIE = "qb_oauth_mode";
const OAUTH_CONTEXT_COOKIE = "qb_oauth_ctx";
const OAUTH_MODE_MAX_ATTEMPTS = 6;

function clearStateCookie(response: NextResponse) {
  response.cookies.set({
    name: OAUTH_STATE_COOKIE,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(0),
  });
  return response;
}

function clearFlowCookies(response: NextResponse) {
  const base = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    expires: new Date(0),
  };
  response.cookies.set({ name: OAUTH_MODE_COOKIE, value: "", ...base });
  response.cookies.set({ name: OAUTH_CONTEXT_COOKIE, value: "", ...base });
  return response;
}

function redirectToQuickBooksPage(request: NextRequest, status: "connected" | "error", reason = "", realmId = "") {
  const url = request.nextUrl.clone();
  url.pathname = "/quickbooks";
  url.searchParams.set("status", status);
  if (reason) url.searchParams.set("reason", reason);
  if (realmId) url.searchParams.set("realmId", realmId);
  return NextResponse.redirect(url);
}

function parseRequiredRealmIds() {
  const raw = String(
    process.env.QUICKBOOKS_AUTO_CONNECT_REALM_IDS ||
      "193514808072134,123146516901064",
  ).trim();
  return Array.from(
    new Set(
      raw
        .split(/[,\s]+/)
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

function parseContextAttempts(rawValue: string) {
  if (!rawValue) return 0;
  try {
    const parsed = JSON.parse(rawValue) as { attempts?: unknown };
    const attempts = Number(parsed?.attempts || 0);
    return Number.isFinite(attempts) && attempts > 0 ? attempts : 0;
  } catch {
    return 0;
  }
}

export async function GET(request: NextRequest) {
  const oauthError = request.nextUrl.searchParams.get("error") || "";
  const oauthErrorDescription = request.nextUrl.searchParams.get("error_description") || "";
  if (oauthError) {
    const response = redirectToQuickBooksPage(
      request,
      "error",
      oauthErrorDescription || oauthError,
    );
    return clearStateCookie(response);
  }

  const state = request.nextUrl.searchParams.get("state") || "";
  const code = request.nextUrl.searchParams.get("code") || "";
  const realmId = request.nextUrl.searchParams.get("realmId") || "";
  const expectedState = request.cookies.get(OAUTH_STATE_COOKIE)?.value || "";
  const oauthMode = String(request.cookies.get(OAUTH_MODE_COOKIE)?.value || "").trim().toLowerCase();
  const isEnsureRequiredMode = oauthMode === "ensure_required";
  const requiredRealmIds = isEnsureRequiredMode ? parseRequiredRealmIds() : [];

  if (!state || !expectedState || state !== expectedState) {
    const response = redirectToQuickBooksPage(request, "error", "Invalid OAuth state");
    return clearStateCookie(response);
  }

  if (!code || !realmId) {
    const response = redirectToQuickBooksPage(
      request,
      "error",
      "Missing required OAuth callback fields (code or realmId)",
    );
    return clearStateCookie(response);
  }

  try {
    await connectQuickBooksFromOAuthCallback(code, realmId);
    if (isEnsureRequiredMode && requiredRealmIds.length > 0) {
      const { connections } = await loadQuickBooksConnections();
      const connectedRealmIds = new Set(
        (connections || [])
          .map((connection) => String(connection.realmId || "").trim())
          .filter(Boolean),
      );
      const missingRealmIds = requiredRealmIds.filter((requiredRealmId) => !connectedRealmIds.has(requiredRealmId));
      if (missingRealmIds.length > 0) {
        const previousAttempts = parseContextAttempts(request.cookies.get(OAUTH_CONTEXT_COOKIE)?.value || "");
        const nextAttempts = previousAttempts + 1;
        if (nextAttempts >= OAUTH_MODE_MAX_ATTEMPTS) {
          const response = redirectToQuickBooksPage(
            request,
            "error",
            `Missing required QuickBooks companies after ${nextAttempts} attempts. Missing realm IDs: ${missingRealmIds.join(", ")}`,
            realmId,
          );
          clearFlowCookies(response);
          return clearStateCookie(response);
        }

        const continueUrl = request.nextUrl.clone();
        continueUrl.pathname = "/api/quickbooks/connect";
        continueUrl.searchParams.set("mode", "ensure_required");
        continueUrl.searchParams.set("continue", "1");
        const response = NextResponse.redirect(continueUrl);
        response.cookies.set({
          name: OAUTH_MODE_COOKIE,
          value: "ensure_required",
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          path: "/",
          maxAge: 30 * 60,
        });
        response.cookies.set({
          name: OAUTH_CONTEXT_COOKIE,
          value: JSON.stringify({ attempts: nextAttempts, lastRealmId: realmId, updatedAt: Date.now() }),
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          path: "/",
          maxAge: 30 * 60,
        });
        clearStateCookie(response);
        return response;
      }
    }

    const response = redirectToQuickBooksPage(request, "connected", "", realmId);
    clearFlowCookies(response);
    return clearStateCookie(response);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const response = redirectToQuickBooksPage(request, "error", message);
    clearFlowCookies(response);
    return clearStateCookie(response);
  }
}
