import { NextResponse } from "next/server";
import { syncWebsiteCache } from "@/lib/siteCacheSync";

export const runtime = "nodejs";
export const maxDuration = 800;

function isAuthorized(req: Request) {
  if (req.headers.get("x-vercel-cron")) return true;
  const secret = String(process.env.CRON_SECRET || "").trim();
  if (!secret) return true;
  const auth = String(req.headers.get("authorization") || "");
  return auth === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  try {
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const result = await syncWebsiteCache({ warmup: true });
    return NextResponse.json({ ok: true, ...result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return GET(req);
}
