import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { buildQuickBooksAuthorizeUrl } from "@/lib/quickbooks";

export const runtime = "nodejs";

const OAUTH_STATE_COOKIE = "qb_oauth_state";
const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;

export async function GET() {
  try {
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
    return response;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
