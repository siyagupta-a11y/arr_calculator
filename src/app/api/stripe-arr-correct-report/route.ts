import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

function disabledResponse() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function GET() {
  return disabledResponse();
}

export async function POST() {
  return disabledResponse();
}
