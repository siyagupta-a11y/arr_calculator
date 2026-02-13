import { NextResponse } from "next/server";
import { generateReport } from "@/lib/report";
import {
  getPreviousMonthWindow,
  periodTotal,
  buildDealBreakdown,
  buildExcelCompatibleXmlWorkbook,
  sendReportToSlack,
} from "@/lib/monthlySlackReport";

export const runtime = "nodejs";

type RequestBody = {
  channelId?: string;
  force?: boolean;
};

function isAuthorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;

  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${secret}`;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    body = {};
  }

  const now = new Date();
  const force = !!body.force;
  if (now.getDate() !== 1 && !force) {
    return NextResponse.json(
      { error: "This endpoint runs on the 1st of each month. Pass { force: true } for manual runs." },
      { status: 400 },
    );
  }

  const channelId = String(body.channelId || process.env.SLACK_CHANNEL_ID || "").trim();
  if (!channelId) {
    return NextResponse.json({ error: "Missing SLACK_CHANNEL_ID (or provide channelId in request body)" }, { status: 400 });
  }

  const month = getPreviousMonthWindow(now);

  const [arrReport, carrReport] = await Promise.all([
    generateReport({
      startDate: month.startDate,
      endDate: month.endDate,
      mode: "arr",
      grain: "monthly",
    }),
    generateReport({
      startDate: month.startDate,
      endDate: month.endDate,
      mode: "contracted",
      grain: "monthly",
    }),
  ]);

  const arrTotal = periodTotal(arrReport, month.periodKey);
  const carrTotal = periodTotal(carrReport, month.periodKey);
  const arrRows = buildDealBreakdown(arrReport, month.periodKey);
  const carrRows = buildDealBreakdown(carrReport, month.periodKey);

  const file = buildExcelCompatibleXmlWorkbook({
    periodLabel: month.periodLabel,
    arrTotal,
    carrTotal,
    arrRows,
    carrRows,
  });

  const filename = `arr_c-arr_${month.filenamePart}.xls`;
  const summary =
    `*ARR & C-ARR monthly report - ${month.periodLabel}*\n` +
    `ARR total: ${arrTotal.toFixed(2)} USD\n` +
    `C-ARR total: ${carrTotal.toFixed(2)} USD\n` +
    `ARR deals: ${arrRows.length}\n` +
    `C-ARR deals: ${carrRows.length}`;

  await sendReportToSlack({
    channelId,
    filename,
    fileContent: file,
    title: `ARR & C-ARR - ${month.periodLabel}`,
    message: summary,
  });

  return NextResponse.json({
    ok: true,
    channelId,
    month: month.periodLabel,
    filename,
    arrTotal,
    carrTotal,
    arrDeals: arrRows.length,
    carrDeals: carrRows.length,
  });
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
