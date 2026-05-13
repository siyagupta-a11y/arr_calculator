import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { assertAdmin } from "@/lib/precomputedFacts";
import { deleteLeaseDocument, updateLeaseDocumentTerms } from "@/lib/leasePredictionStore";

type RouteParams = {
  params: Promise<{ documentId: string }>;
};

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

export const runtime = "nodejs";
export const maxDuration = 300;

export async function PATCH(req: NextRequest, context: RouteParams) {
  try {
    await assertAdmin(req);
    const { documentId } = await context.params;
    const body = (await req.json().catch(() => ({}))) as {
      leaseStartDate?: unknown;
      leaseEndDate?: unknown;
      monthlyExpense?: unknown;
      annualEscalationPct?: unknown;
      confidence?: unknown;
      summary?: unknown;
    };

    const patch = {
      leaseStartDate: isIsoDate(String(body.leaseStartDate || "")) ? String(body.leaseStartDate) : "",
      leaseEndDate: isIsoDate(String(body.leaseEndDate || "")) ? String(body.leaseEndDate) : "",
      monthlyExpense: Math.max(0, Number(body.monthlyExpense || 0)),
      annualEscalationPct: Math.max(0, Number(body.annualEscalationPct || 0)),
      confidence: Math.max(0, Math.min(1, Number(body.confidence || 0))),
      summary: String(body.summary || "").trim(),
      extractionSource: "manual" as const,
    };

    const result = await updateLeaseDocumentTerms(documentId, patch);
    return NextResponse.json({ ok: true, ...result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message === "Forbidden" ? 403 : message === "Document not found" ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

export async function DELETE(req: NextRequest, context: RouteParams) {
  try {
    await assertAdmin(req);
    const { documentId } = await context.params;
    const result = await deleteLeaseDocument(documentId);
    return NextResponse.json({ ok: true, ...result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message === "Forbidden" ? 403 : message === "Document not found" ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
