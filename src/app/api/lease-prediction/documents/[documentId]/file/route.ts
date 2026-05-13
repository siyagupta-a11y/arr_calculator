import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { assertAdmin } from "@/lib/precomputedFacts";
import { readLeaseDocumentFile } from "@/lib/leasePredictionStore";

type RouteParams = {
  params: Promise<{ documentId: string }>;
};

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: NextRequest, context: RouteParams) {
  try {
    await assertAdmin(req);
    const { documentId } = await context.params;
    const file = await readLeaseDocumentFile(documentId);
    const body = new Uint8Array(file.data);
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": file.contentType || "application/pdf",
        "Content-Disposition": `inline; filename="${file.fileName.replace(/"/g, "")}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message === "Forbidden" ? 403 : message.includes("not found") ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
