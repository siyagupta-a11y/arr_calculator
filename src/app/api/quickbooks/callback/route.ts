import { NextResponse, type NextRequest } from "next/server";
import { connectQuickBooksFromOAuthCallback } from "@/lib/quickbooks";

export const runtime = "nodejs";

const OAUTH_STATE_COOKIE = "qb_oauth_state";

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

function redirectToQuickBooksPage(request: NextRequest, status: "connected" | "error", reason = "", realmId = "") {
  const url = request.nextUrl.clone();
  url.pathname = "/quickbooks";
  url.searchParams.set("status", status);
  if (reason) url.searchParams.set("reason", reason);
  if (realmId) url.searchParams.set("realmId", realmId);
  return NextResponse.redirect(url);
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
    const response = redirectToQuickBooksPage(request, "connected", "", realmId);
    return clearStateCookie(response);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const response = redirectToQuickBooksPage(request, "error", message);
    return clearStateCookie(response);
  }
}
