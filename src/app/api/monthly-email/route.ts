import { NextResponse } from "next/server";
import { generateReport } from "@/lib/report";
import {
  getPreviousMonthWindow,
  parseRecipients,
  periodTotal,
  buildDealBreakdown,
  buildExcelCompatibleXmlWorkbook,
  sendReportEmail,
} from "@/lib/monthlyEmailReport";

export const runtime = "nodejs";

type RequestBody = {
  recipients?: string[];
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

  const defaultRecipients = parseRecipients(process.env.MONTHLY_REPORT_RECIPIENTS);
  const recipients = body.recipients?.length ? body.recipients : defaultRecipients;
  if (!recipients.length) {
    return NextResponse.json({ error: "No recipients configured" }, { status: 400 });
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
  const subject = `ARR & C-ARR monthly report - ${month.periodLabel}`;
  const text =
    `Attached is the ARR and C-ARR report for ${month.periodLabel}.\n` +
    `ARR total: ${arrTotal.toFixed(2)} USD\n` +
    `C-ARR total: ${carrTotal.toFixed(2)} USD\n` +
    `ARR deals: ${arrRows.length}\n` +
    `C-ARR deals: ${carrRows.length}`;

  const html =
    `<p>Attached is the ARR and C-ARR report for <strong>${month.periodLabel}</strong>.</p>` +
    `<ul>` +
    `<li>ARR total: ${arrTotal.toFixed(2)} USD</li>` +
    `<li>C-ARR total: ${carrTotal.toFixed(2)} USD</li>` +
    `<li>ARR deals: ${arrRows.length}</li>` +
    `<li>C-ARR deals: ${carrRows.length}</li>` +
    `</ul>`;

  await sendReportEmail({
    recipients,
    subject,
    text,
    html,
    filename,
    fileContent: file,
  });

  return NextResponse.json({
    ok: true,
    recipients,
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
