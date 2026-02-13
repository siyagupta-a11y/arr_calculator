import type { ReportResponse } from "@/lib/types";
import { round2 } from "@/lib/logic";

export type MonthlyWindow = {
  startDate: string;
  endDate: string;
  periodKey: string;
  periodLabel: string;
  filenamePart: string;
};

type DealBreakdownRow = {
  dealId: string;
  dealName: string;
  value: number;
};

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function formatYyyyMmDd(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function getPreviousMonthWindow(now = new Date()): MonthlyWindow {
  const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const periodKey = `${monthStart.getFullYear()}-${pad2(monthStart.getMonth() + 1)}`;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const periodLabel = `${months[monthStart.getMonth()]} ${monthStart.getFullYear()}`;

  return {
    startDate: formatYyyyMmDd(monthStart),
    endDate: formatYyyyMmDd(monthEnd),
    periodKey,
    periodLabel,
    filenamePart: `${monthStart.getFullYear()}_${pad2(monthStart.getMonth() + 1)}`,
  };
}

export function parseRecipients(raw: string | undefined | null): string[] {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => !!s);
}

export function periodTotal(report: ReportResponse, periodKey: string): number {
  const t = report.totalsByPeriod.find((x) => x.key === periodKey)?.total || 0;
  return round2(t);
}

export function buildDealBreakdown(report: ReportResponse, periodKey: string): DealBreakdownRow[] {
  const map = new Map<string, DealBreakdownRow>();

  for (const row of report.rows) {
    const value = Number(row.valuesByPeriod?.[periodKey] || 0);
    if (!value) continue;

    const dealId = String(row.dealId || "");
    const dealName = String(row.dealName || "");
    const key = `${dealId}|${dealName}`;
    const current = map.get(key);

    if (!current) {
      map.set(key, { dealId, dealName, value });
      continue;
    }

    current.value = round2(current.value + value);
  }

  return Array.from(map.values()).sort((a, b) => b.value - a.value);
}

function xmlEscape(v: string) {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cellString(v: string) {
  return `<Cell><Data ss:Type=\"String\">${xmlEscape(v)}</Data></Cell>`;
}

function cellNumber(v: number) {
  return `<Cell><Data ss:Type=\"Number\">${Number(v) || 0}</Data></Cell>`;
}

function rowXml(cells: string[]) {
  return `<Row>${cells.join("")}</Row>`;
}

function worksheetXml(
  sheetName: string,
  periodLabel: string,
  metricLabel: string,
  total: number,
  rows: DealBreakdownRow[],
) {
  const lines: string[] = [];

  lines.push(rowXml([cellString("Month"), cellString(periodLabel)]));
  lines.push(rowXml([cellString("Total (USD)"), cellNumber(round2(total))]));
  lines.push(rowXml([cellString("")]));
  lines.push(rowXml([cellString("Deal ID"), cellString("Deal Name"), cellString(`${metricLabel} (USD)`)]));

  for (const row of rows) {
    lines.push(rowXml([cellString(row.dealId), cellString(row.dealName), cellNumber(round2(row.value))]));
  }

  return `<Worksheet ss:Name=\"${xmlEscape(sheetName)}\"><Table>${lines.join("")}</Table></Worksheet>`;
}

export function buildExcelCompatibleXmlWorkbook(args: {
  periodLabel: string;
  arrTotal: number;
  carrTotal: number;
  arrRows: DealBreakdownRow[];
  carrRows: DealBreakdownRow[];
}): Buffer {
  const header =
    `<?xml version=\"1.0\"?>` +
    `<?mso-application progid=\"Excel.Sheet\"?>` +
    `<Workbook xmlns=\"urn:schemas-microsoft-com:office:spreadsheet\" ` +
    `xmlns:o=\"urn:schemas-microsoft-com:office:office\" ` +
    `xmlns:x=\"urn:schemas-microsoft-com:office:excel\" ` +
    `xmlns:ss=\"urn:schemas-microsoft-com:office:spreadsheet\" ` +
    `xmlns:html=\"http://www.w3.org/TR/REC-html40\">`;

  const arrSheet = worksheetXml("ARR", args.periodLabel, "ARR", args.arrTotal, args.arrRows);
  const carrSheet = worksheetXml("C-ARR", args.periodLabel, "C-ARR", args.carrTotal, args.carrRows);

  const xml = `${header}${arrSheet}${carrSheet}</Workbook>`;
  return Buffer.from(xml, "utf8");
}

export async function sendReportEmail(params: {
  recipients: string[];
  subject: string;
  text: string;
  html: string;
  filename: string;
  fileContent: Buffer;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MONTHLY_REPORT_FROM_EMAIL;

  if (!apiKey) throw new Error("Missing env var: RESEND_API_KEY");
  if (!from) throw new Error("Missing env var: MONTHLY_REPORT_FROM_EMAIL");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: params.recipients,
      subject: params.subject,
      text: params.text,
      html: params.html,
      attachments: [
        {
          filename: params.filename,
          content: params.fileContent.toString("base64"),
          type: "application/vnd.ms-excel",
        },
      ],
    }),
  });

  const data = await res.text();
  if (!res.ok) {
    throw new Error(`Resend API error ${res.status}: ${data}`);
  }

  return data;
}
