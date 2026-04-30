import { getToken } from "next-auth/jwt";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { syncWebsiteCache } from "@/lib/siteCacheSync";

export const runtime = "nodejs";
export const maxDuration = 300;

type Body = {
  warmup?: boolean;
};

function parseBool(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "y";
}

export async function POST(req: NextRequest) {
  try {
    const token = await getToken({
      req,
      secret: process.env.AUTH_SECRET,
    });
    const isAdmin = String(token?.role || "viewer").trim().toLowerCase() === "admin";
    if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    let body: Body = {};
    try {
      body = (await req.json()) as Body;
    } catch {
      body = {};
    }
    const warmup = parseBool(body.warmup, true);
    const result = await syncWebsiteCache({ warmup });
    return NextResponse.json({ ok: true, ...result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
