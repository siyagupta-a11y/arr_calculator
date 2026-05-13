import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { assertAdmin } from "@/lib/precomputedFacts";
import { createLeaseDocument, listLeaseDocuments } from "@/lib/leasePredictionStore";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  try {
    await assertAdmin(req);
    const result = await listLeaseDocuments();
    return NextResponse.json({ ok: true, ...result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

export async function POST(req: NextRequest) {
  try {
    await assertAdmin(req);
    const formData = await req.formData();
    const maybeFile = formData.get("file");
    if (!(maybeFile instanceof File)) {
      return NextResponse.json({ ok: false, error: "Missing file" }, { status: 400 });
    }

    const contentType = String(maybeFile.type || "application/pdf").trim() || "application/pdf";
    if (!contentType.toLowerCase().includes("pdf")) {
      return NextResponse.json({ ok: false, error: "Only PDF files are supported" }, { status: 400 });
    }

    const bytes = Buffer.from(await maybeFile.arrayBuffer());
    if (!bytes.length) {
      return NextResponse.json({ ok: false, error: "Empty file" }, { status: 400 });
    }

    const uploadedByEmail = String(formData.get("uploadedByEmail") || "").trim();
    const result = await createLeaseDocument({
      fileName: maybeFile.name || "lease.pdf",
      contentType,
      fileBytes: bytes,
      uploadedByEmail,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
