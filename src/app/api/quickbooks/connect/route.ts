import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { buildQuickBooksAuthorizeUrl } from "@/lib/quickbooks";

export const runtime = "nodejs";

const OAUTH_STATE_COOKIE = "qb_oauth_state";
const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;
const OAUTH_MODE_COOKIE = "qb_oauth_mode";
const OAUTH_CONTEXT_COOKIE = "qb_oauth_ctx";
const OAUTH_MODE_MAX_AGE_SECONDS = 30 * 60;

function clearCookie(response: NextResponse, name: string) {
  response.cookies.set({
    name,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(0),
  });
}

export async function GET(request: NextRequest) {
  try {
    const mode = String(request.nextUrl.searchParams.get("mode") || "").trim().toLowerCase();
    const shouldEnsureRequired = mode === "ensure_required";
    const isContinue = String(request.nextUrl.searchParams.get("continue") || "").trim() === "1";
    const state = randomBytes(24).toString("hex");
    const url = buildQuickBooksAuthorizeUrl(state);
    const response = NextResponse.redirect(url);
    response.cookies.set({
      name: OAUTH_STATE_COOKIE,
      value: state,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
    });

    if (shouldEnsureRequired) {
      response.cookies.set({
        name: OAUTH_MODE_COOKIE,
        value: "ensure_required",
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: OAUTH_MODE_MAX_AGE_SECONDS,
      });
      if (!isContinue) {
        response.cookies.set({
          name: OAUTH_CONTEXT_COOKIE,
          value: JSON.stringify({ attempts: 0, startedAt: Date.now() }),
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          path: "/",
          maxAge: OAUTH_MODE_MAX_AGE_SECONDS,
        });
      }
    } else {
      clearCookie(response, OAUTH_MODE_COOKIE);
      clearCookie(response, OAUTH_CONTEXT_COOKIE);
    }

    return response;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
