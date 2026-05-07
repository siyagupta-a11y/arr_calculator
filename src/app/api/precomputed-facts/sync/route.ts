import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { assertAdmin, syncPrecomputedFacts, type PrecomputedFactsSyncRequest } from "@/lib/precomputedFacts";

export const runtime = "nodejs";
export const maxDuration = 800;

export async function POST(req: NextRequest) {
  try {
    await assertAdmin(req);
    let body: PrecomputedFactsSyncRequest = {};
    try {
      body = (await req.json()) as PrecomputedFactsSyncRequest;
    } catch {
      body = {};
    }
    const result = await syncPrecomputedFacts(body);
    const ok = result.steps.every((step) => step.ok);
    return NextResponse.json({ ok, ...result }, { status: ok ? 200 : 500 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
