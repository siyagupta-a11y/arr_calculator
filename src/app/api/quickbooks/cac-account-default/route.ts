import { NextResponse } from "next/server";
import {
  loadQuickBooksCacDefaultSelection,
  saveQuickBooksCacDefaultSelection,
} from "@/lib/quickbooksCacDefaultsStore";

export const runtime = "nodejs";
export const maxDuration = 60;

type SaveBody = {
  accountIds?: string[];
};

function normalizeIds(values: unknown) {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

export async function GET() {
  try {
    const payload = await loadQuickBooksCacDefaultSelection();
    return NextResponse.json(payload);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const body = (raw ? JSON.parse(raw) : {}) as SaveBody;
    const accountIds = normalizeIds(body.accountIds);
    const payload = await saveQuickBooksCacDefaultSelection(accountIds);
    return NextResponse.json(payload);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
