import type { Grain } from "@/lib/types";
import { generateStripeReportCsv, type StripeGroupField, type StripeReportRequest } from "@/lib/stripeReport";

export const runtime = "nodejs";
export const maxDuration = 300;

const STRIPE_ARR_CORRECT_OPTIONS = {
  forceSource: "bigquery",
  bigQueryProfile: "stripe_arr_correct",
} as const;

function buildRequestFromSearchParams(searchParams: URLSearchParams): StripeReportRequest {
  return {
    startDate: searchParams.get("startDate") || "",
    endDate: searchParams.get("endDate") || "",
    grain: (searchParams.get("grain") as Grain) || "monthly",
    filterCustomerId: searchParams.get("filterCustomerId") || "",
    filterLineItemDescription: searchParams.get("filterLineItemDescription") || "",
    filterLineItemDescriptionPrefix: searchParams.get("filterLineItemDescriptionPrefix") || "",
    sortByPeriodKey: searchParams.get("sortByPeriodKey") || "none",
    groupByFields: (searchParams.get("groupByFields") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) as StripeGroupField[],
    page: 1,
  };
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const request = buildRequestFromSearchParams(searchParams);
    const csv = await generateStripeReportCsv(request, STRIPE_ARR_CORRECT_OPTIONS);
    const stamp = new Date().toISOString().slice(0, 10);

    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="stripe-arr-correct-breakdown-full-${stamp}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") ||
      message.includes("endDate must be >= startDate")
        ? 400
        : 500;
    return Response.json({ error: message }, { status });
  }
}
