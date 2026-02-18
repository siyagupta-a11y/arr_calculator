import { NextResponse } from "next/server";
import type { Grain } from "@/lib/types";
import { generateStripeReport, type StripeGroupField } from "@/lib/stripeReport";

export const runtime = "nodejs";
export const maxDuration = 300;

type StripeApiRequest = {
  startDate: string;
  endDate: string;
  grain: Grain;
  filterCustomerName?: string;
  filterCustomerId?: string;
  filterLineItemDescription?: string;
  filterLineItemDescriptionPrefix?: string;
  groupByFields?: StripeGroupField[];
  sortByPeriodKey?: string;
  page?: number;
};

function validateAndRun(body: Partial<StripeApiRequest>) {
  const payload: StripeApiRequest = {
    startDate: String(body.startDate || ""),
    endDate: String(body.endDate || ""),
    grain: (body.grain as Grain) || "monthly",
    filterCustomerName: String(body.filterCustomerName || ""),
    filterCustomerId: String(body.filterCustomerId || ""),
    filterLineItemDescription: String(body.filterLineItemDescription || ""),
    filterLineItemDescriptionPrefix: String(body.filterLineItemDescriptionPrefix || ""),
    groupByFields: Array.isArray(body.groupByFields)
      ? body.groupByFields.filter((v): v is StripeGroupField => typeof v === "string")
      : [],
    sortByPeriodKey: String(body.sortByPeriodKey || "none"),
    page: Number(body.page || 1),
  };
  return generateStripeReport(payload);
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Partial<StripeApiRequest>;
    const report = await validateAndRun(body);
    return NextResponse.json(report);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") ||
      message.includes("endDate must be >= startDate")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const body: Partial<StripeApiRequest> = {
      startDate: searchParams.get("startDate") || "",
      endDate: searchParams.get("endDate") || "",
      grain: (searchParams.get("grain") as Grain) || "monthly",
      filterCustomerName: searchParams.get("filterCustomerName") || "",
      filterCustomerId: searchParams.get("filterCustomerId") || "",
      filterLineItemDescription: searchParams.get("filterLineItemDescription") || "",
      filterLineItemDescriptionPrefix: searchParams.get("filterLineItemDescriptionPrefix") || "",
      sortByPeriodKey: searchParams.get("sortByPeriodKey") || "none",
      groupByFields: (searchParams.get("groupByFields") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as StripeGroupField[],
      page: Number(searchParams.get("page") || 1),
    };
    const report = await validateAndRun(body);
    return NextResponse.json(report);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") ||
      message.includes("endDate must be >= startDate")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
