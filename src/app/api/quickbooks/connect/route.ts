import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { buildQuickBooksAuthorizeUrl } from "@/lib/quickbooks";
import { loadQuickBooksConnections } from "@/lib/quickbooksStore";

export const runtime = "nodejs";

const OAUTH_STATE_COOKIE = "qb_oauth_state";
const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;
const OAUTH_MODE_COOKIE = "qb_oauth_mode";
const OAUTH_CONTEXT_COOKIE = "qb_oauth_ctx";
const OAUTH_MODE_MAX_AGE_SECONDS = 30 * 60;
const DEFAULT_REQUIRED_REALM_IDS = "193514808072134,123146516901064";

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

function parseRequiredRealmIds() {
  const raw = String(process.env.QUICKBOOKS_AUTO_CONNECT_REALM_IDS || DEFAULT_REQUIRED_REALM_IDS).trim();
  return Array.from(
    new Set(
      raw
        .split(/[,\s]+/)
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

function parseContext(rawValue: string) {
  if (!rawValue) return { attempts: 0, startedAt: Date.now(), targetRealmId: "" };
  try {
    const parsed = JSON.parse(rawValue) as {
      attempts?: unknown;
      startedAt?: unknown;
      targetRealmId?: unknown;
    };
    const attempts = Number(parsed?.attempts || 0);
    const startedAt = Number(parsed?.startedAt || Date.now());
    const targetRealmId = String(parsed?.targetRealmId || "").trim();
    return {
      attempts: Number.isFinite(attempts) && attempts > 0 ? attempts : 0,
      startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : Date.now(),
      targetRealmId,
    };
  } catch {
    return { attempts: 0, startedAt: Date.now(), targetRealmId: "" };
  }
}

export async function GET(request: NextRequest) {
  try {
    const mode = String(request.nextUrl.searchParams.get("mode") || "").trim().toLowerCase();
    const shouldEnsureRequired = mode === "ensure_required";
    const isContinue = String(request.nextUrl.searchParams.get("continue") || "").trim() === "1";
    const requestedTargetRealmId = String(request.nextUrl.searchParams.get("targetRealmId") || "").trim();
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
      const requiredRealmIds = parseRequiredRealmIds();
      const { connections } = await loadQuickBooksConnections();
      const connectedRealmIds = new Set(
        (connections || [])
          .map((connection) => String(connection.realmId || "").trim())
          .filter(Boolean),
      );
      const missingRealmIds = requiredRealmIds.filter((requiredRealmId) => !connectedRealmIds.has(requiredRealmId));
      const previousContext = parseContext(request.cookies.get(OAUTH_CONTEXT_COOKIE)?.value || "");
      const targetRealmId =
        (requestedTargetRealmId && requiredRealmIds.includes(requestedTargetRealmId) && requestedTargetRealmId) ||
        (previousContext.targetRealmId && requiredRealmIds.includes(previousContext.targetRealmId)
          ? previousContext.targetRealmId
          : "") ||
        missingRealmIds[0] ||
        requiredRealmIds[0] ||
        "";

      response.cookies.set({
        name: OAUTH_MODE_COOKIE,
        value: "ensure_required",
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: OAUTH_MODE_MAX_AGE_SECONDS,
      });
      response.cookies.set({
        name: OAUTH_CONTEXT_COOKIE,
        value: JSON.stringify({
          attempts: isContinue ? previousContext.attempts : 0,
          startedAt: isContinue ? previousContext.startedAt : Date.now(),
          targetRealmId,
          requiredRealmIds,
          updatedAt: Date.now(),
        }),
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: OAUTH_MODE_MAX_AGE_SECONDS,
      });
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
