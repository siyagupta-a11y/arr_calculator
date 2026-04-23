"use client";

import Link from "next/link";
import React, { useMemo, useState } from "react";

type AnalyticsBlock = {
  status: "ok" | "not_configured" | "error";
  value: number | null;
  details?: string;
};

type AnalyticsResponse = {
  startDate: string;
  endDate: string;
  mixpanelMetrics: {
    dauLastDay: AnalyticsBlock;
    wauLastDay: AnalyticsBlock;
    mauLastDay: AnalyticsBlock;
    signupsInMonth: AnalyticsBlock;
    productionMessagesInMonth: AnalyticsBlock;
    highVolumeWorkspacesInMonth: AnalyticsBlock;
    activeBuilders10of30: AnalyticsBlock;
  };
  googleAnalytics: AnalyticsBlock;
};

type UploadFieldKey =
  | "stripeMrrPerCustomer"
  | "stripeMrrChanges"
  | "stripeSubscriptionMetrics"
  | "salesAssistWorkspaceIds"
  | "salesledArrFromHibob";

type UploadField = {
  key: UploadFieldKey;
  label: string;
  hint: string;
};

const UPLOAD_FIELDS: UploadField[] = [
  {
    key: "stripeMrrPerCustomer",
    label: "Stripe MRR per customer",
    hint: "CSV or XLSX export",
  },
  {
    key: "stripeMrrChanges",
    label: "Stripe MRR changes",
    hint: "CSV or XLSX export",
  },
  {
    key: "stripeSubscriptionMetrics",
    label: "Stripe subscription metrics",
    hint: "CSV or XLSX export",
  },
  {
    key: "salesAssistWorkspaceIds",
    label: "Sales assist workspace IDs",
    hint: "CSV or TXT list",
  },
  {
    key: "salesledArrFromHibob",
    label: "Sales-led ARR from Hibob",
    hint: "CSV or XLSX export",
  },
];

function defaultDateRange() {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end,
  };
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatBytes(value: number) {
  const size = Number(value || 0);
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

function normalizeHeader(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function parseDelimitedLine(line: string, delimiter: "," | "\t") {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === delimiter && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function detectDelimiter(line: string): "," | "\t" {
  const commaCount = (line.match(/,/g) || []).length;
  const tabCount = (line.match(/\t/g) || []).length;
  return tabCount > commaCount ? "\t" : ",";
}

function parseDelimitedRows(text: string) {
  const nonEmptyLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!nonEmptyLines.length) {
    throw new Error("CSV is empty.");
  }
  const delimiter = detectDelimiter(nonEmptyLines[0]);
  const rows = nonEmptyLines.map((line) => parseDelimitedLine(line, delimiter));
  return { rows, delimiter };
}

function parseMoneyLike(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  const negativeParens = raw.startsWith("(") && raw.endsWith(")");
  const cleaned = raw.replace(/[$,\s()]/g, "");
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return 0;
  return negativeParens ? -parsed : parsed;
}

function normalizeCustomerIdToken(value: string) {
  return String(value || "").trim().toLowerCase();
}

function csvEscape(value: string | number | null | undefined) {
  const str = value == null ? "" : String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function downloadCsv(filename: string, rows: string[][]) {
  const lines = rows.map((row) => row.map((cell) => csvEscape(cell)).join(","));
  const blob = new Blob([`${lines.join("\n")}\n`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

type StripeMrrCustomerRow = {
  customerId: string;
  email: string;
  signedUp: string;
  firstMonthOfMrr: string;
  mrr: string;
};

type ParsedStripeMrr = {
  monthColumn: string;
  rows: StripeMrrCustomerRow[];
};

function parseStripeMrrPerCustomerCsv(text: string): ParsedStripeMrr {
  const { rows } = parseDelimitedRows(text);
  if (rows.length < 2) {
    throw new Error("Stripe MRR per customer file must include header and at least one data row.");
  }
  const header = rows[0];
  const normalizedHeader = header.map((cell) => normalizeHeader(cell));
  const customerIdIdx = normalizedHeader.findIndex((h) => h === "customerid");
  const customerEmailIdx = normalizedHeader.findIndex((h) => h === "customeremail");
  const customerStartDateIdx = normalizedHeader.findIndex((h) => h === "customerstartdate");

  if (customerIdIdx < 0) throw new Error("Stripe MRR file missing required column: Customer ID.");
  if (customerEmailIdx < 0) throw new Error("Stripe MRR file missing required column: Customer Email.");
  if (customerStartDateIdx < 0) throw new Error("Stripe MRR file missing required column: Customer Start Date.");

  let monthColumnIdx = -1;
  for (let i = normalizedHeader.length - 1; i >= 0; i -= 1) {
    if (/^\d{4}\d{2}$/.test(normalizedHeader[i])) {
      monthColumnIdx = i;
      break;
    }
  }
  if (monthColumnIdx < 0) {
    throw new Error("Stripe MRR file missing month column (expected header like YYYY-MM).");
  }
  const monthColumn = String(header[monthColumnIdx] || "").trim();

  const byCustomerId = new Map<string, StripeMrrCustomerRow>();
  for (let i = 1; i < rows.length; i += 1) {
    const line = rows[i];
    const customerId = String(line[customerIdIdx] || "").trim();
    if (!customerId) continue;
    const email = String(line[customerEmailIdx] || "").trim();
    const signedUp = String(line[customerStartDateIdx] || "").trim();
    const firstMonthOfMrr = /^\d{4}-\d{2}-\d{2}$/.test(signedUp) ? signedUp.slice(0, 7) : "";
    const mrrNumber = parseMoneyLike(String(line[monthColumnIdx] || ""));
    const existing = byCustomerId.get(customerId);
    if (!existing) {
      byCustomerId.set(customerId, {
        customerId,
        email,
        signedUp,
        firstMonthOfMrr,
        mrr: String(mrrNumber),
      });
      continue;
    }
    const mergedMrr = parseMoneyLike(existing.mrr) + mrrNumber;
    byCustomerId.set(customerId, {
      ...existing,
      email: existing.email || email,
      signedUp: existing.signedUp || signedUp,
      firstMonthOfMrr: existing.firstMonthOfMrr || firstMonthOfMrr,
      mrr: String(mergedMrr),
    });
  }

  return {
    monthColumn,
    rows: Array.from(byCustomerId.values()).sort((a, b) => a.customerId.localeCompare(b.customerId)),
  };
}

function extractWorkspaceIdsFromSalesAssistCsv(text: string) {
  const { rows } = parseDelimitedRows(text);
  if (!rows.length) return [];
  const headerNorm = rows[0].map((cell) => normalizeHeader(cell));
  const workspaceIdIdx = findHeaderIndex(headerNorm, [
    "What is the primary workspace ID?",
    "Primary workspace ID",
    "workspace_id",
    "workspace id",
    "workspaceid",
  ]);
  const startRow = workspaceIdIdx >= 0 ? 1 : 0;
  const out = new Set<string>();

  for (let i = startRow; i < rows.length; i += 1) {
    const source = workspaceIdIdx >= 0 ? String(rows[i]?.[workspaceIdIdx] || "").trim() : rows[i].join(" ").trim();
    if (!source) continue;
    const strictMatches = source.match(/wkspace_[a-z0-9]+/gi);
    if (strictMatches?.length) {
      for (const match of strictMatches) out.add(match.trim().toLowerCase());
      continue;
    }
    const tokens = source.split(/[,\s|;\n\r\t]+/).map((token) => token.trim()).filter(Boolean);
    for (const token of tokens) {
      if (token.toLowerCase().startsWith("wkspace_")) out.add(token.toLowerCase());
    }
  }

  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

function buildReformattedStripeRows(parsed: ParsedStripeMrr) {
  const header = [
    "Customer ID",
    "First Month of MRR",
    "Signed up",
    "Initial Subscription $",
    "Email",
    "New Enterprise",
    "Sales-Assist",
    "Opp name",
    "Employee Count",
    parsed.monthColumn,
  ];
  const body = parsed.rows.map((row) => [
    row.customerId,
    row.firstMonthOfMrr,
    row.signedUp,
    "",
    row.email,
    "",
    "",
    "",
    "",
    row.mrr,
  ]);
  return [header, ...body];
}

function findHeaderIndex(normalizedHeader: string[], aliases: string[]) {
  const aliasSet = new Set(aliases.map((alias) => normalizeHeader(alias)));
  for (let i = 0; i < normalizedHeader.length; i += 1) {
    if (aliasSet.has(normalizedHeader[i])) return i;
  }
  return -1;
}

function toColumnA1(index: number) {
  let value = index + 1;
  let column = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    column = String.fromCharCode(65 + remainder) + column;
    value = Math.floor((value - 1) / 26);
  }
  return column;
}

function parseMonthKey(month: string) {
  const trimmed = String(month || "").trim();
  if (!/^\d{4}-\d{2}$/.test(trimmed)) return null;
  return trimmed;
}

function parseIsoDate(dateText: string) {
  const text = String(dateText || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return text;
}

function sampleDatePattern(rows: string[][], columnIdx: number) {
  if (columnIdx < 0) return null;
  for (let i = 1; i < rows.length; i += 1) {
    const value = String(rows[i]?.[columnIdx] || "").trim();
    if (!value) continue;
    if (/^\d{4}-\d{2}$/.test(value)) return "yyyy-mm";
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "yyyy-mm-dd";
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value)) return "m/d/yyyy";
    if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(value)) return "m-d-yyyy";
  }
  return null;
}

function formatDateLikeSample(sourceIsoDate: string, pattern: string | null, forMonthOnly: boolean) {
  const iso = parseIsoDate(sourceIsoDate);
  if (!iso) return forMonthOnly ? sourceIsoDate.slice(0, 7) : sourceIsoDate;
  const [year, month, day] = iso.split("-");
  if (pattern === "yyyy-mm") return `${year}-${month}`;
  if (pattern === "yyyy-mm-dd") return forMonthOnly ? `${year}-${month}-01` : iso;
  if (pattern === "m/d/yyyy") return forMonthOnly ? `${Number(month)}/1/${year}` : `${Number(month)}/${Number(day)}/${year}`;
  if (pattern === "m-d-yyyy") return forMonthOnly ? `${Number(month)}-1-${year}` : `${Number(month)}-${Number(day)}-${year}`;
  return forMonthOnly ? `${year}-${month}` : iso;
}

function isMonthWithinSelectedRange(month: string, startDate: string, endDate: string) {
  const monthKey = parseMonthKey(month);
  if (!monthKey) return false;
  const startMonth = startDate.slice(0, 7);
  const endMonth = endDate.slice(0, 7);
  return monthKey >= startMonth && monthKey <= endMonth;
}

function mergeIntoSelfserveAllSubsCsv(
  selfserveCsvText: string,
  parsedStripe: ParsedStripeMrr,
  startDate: string,
  endDate: string,
  salesAssistCustomerIds: Set<string>,
): string[][] {
  const { rows } = parseDelimitedRows(selfserveCsvText);
  if (rows.length < 1) throw new Error("Current selfserve-all-subs file is empty.");

  const header = [...rows[0]];
  const normalizedHeader = header.map((cell) => normalizeHeader(cell));
  const customerIdIdx = findHeaderIndex(normalizedHeader, ["Customer ID", "customer_id", "customerid"]);
  if (customerIdIdx < 0) {
    throw new Error("Current selfserve-all-subs file missing Customer ID column.");
  }
  let salesAssistIdx = findHeaderIndex(normalizedHeader, ["Sales-Assist", "Sales Assist", "sales_assist", "salesassist"]);
  if (salesAssistIdx < 0) {
    header.push("Sales-Assist");
    salesAssistIdx = header.length - 1;
  }
  const monthColumn = parsedStripe.monthColumn;
  let monthColumnIdx = header.findIndex((h) => normalizeHeader(h) === normalizeHeader(monthColumn));
  if (monthColumnIdx < 0) {
    header.push(monthColumn);
    monthColumnIdx = header.length - 1;
  }

  const firstMonthIdx = findHeaderIndex(normalizedHeader, ["First Month of MRR"]);
  const signedUpIdx = findHeaderIndex(normalizedHeader, ["Signed up", "signed_up"]);
  const initialSubIdx = findHeaderIndex(normalizedHeader, ["Initial Subscription $", "initial_subscription"]);
  const emailIdx = findHeaderIndex(normalizedHeader, ["Email", "Customer Email"]);
  const monthColumnIndexes = header
    .map((cell, idx) => ({ idx, month: parseMonthKey(String(cell || "").trim()) }))
    .filter((entry): entry is { idx: number; month: string } => entry.month !== null)
    .map((entry) => entry.idx);
  const firstMonthColumnIdx = monthColumnIndexes.length ? Math.min(...monthColumnIndexes) : -1;
  const lastMonthColumnIdx = monthColumnIndexes.length ? Math.max(...monthColumnIndexes) : -1;
  const firstMonthPattern = sampleDatePattern(rows, firstMonthIdx);
  const signedUpPattern = sampleDatePattern(rows, signedUpIdx);

  const stripeByCustomer = new Map(parsedStripe.rows.map((row) => [row.customerId, row]));
  const seenCustomerIds = new Set<string>();
  const outputRows: string[][] = [header];

  for (let i = 1; i < rows.length; i += 1) {
    const row = [...rows[i]];
    while (row.length < header.length) row.push("");
    const customerId = String(row[customerIdIdx] || "").trim();
    if (!customerId) {
      outputRows.push(row);
      continue;
    }
    if (salesAssistIdx >= 0 && salesAssistCustomerIds.has(normalizeCustomerIdToken(customerId))) {
      row[salesAssistIdx] = "Yes";
    }
    const stripeMatch = stripeByCustomer.get(customerId);
    if (stripeMatch) {
      row[monthColumnIdx] = stripeMatch.mrr;
      if (firstMonthIdx >= 0 && !String(row[firstMonthIdx] || "").trim()) row[firstMonthIdx] = stripeMatch.firstMonthOfMrr;
      if (signedUpIdx >= 0 && !String(row[signedUpIdx] || "").trim()) row[signedUpIdx] = stripeMatch.signedUp;
      if (initialSubIdx >= 0 && !String(row[initialSubIdx] || "").trim()) row[initialSubIdx] = "";
      if (emailIdx >= 0 && !String(row[emailIdx] || "").trim()) row[emailIdx] = stripeMatch.email;
      seenCustomerIds.add(customerId);
    }
    outputRows.push(row);
  }

  for (const stripeRow of parsedStripe.rows) {
    if (seenCustomerIds.has(stripeRow.customerId)) continue;
    if (!isMonthWithinSelectedRange(stripeRow.firstMonthOfMrr, startDate, endDate)) continue;

    const newRow = new Array(header.length).fill("");
    newRow[customerIdIdx] = stripeRow.customerId;
    for (const idx of monthColumnIndexes) {
      const monthHeader = parseMonthKey(String(header[idx] || "").trim());
      if (monthHeader && monthHeader < monthColumn) newRow[idx] = "0";
    }
    newRow[monthColumnIdx] = stripeRow.mrr;
    if (firstMonthIdx >= 0) {
      newRow[firstMonthIdx] = formatDateLikeSample(
        `${stripeRow.firstMonthOfMrr}-01`,
        firstMonthPattern,
        true,
      );
    }
    if (signedUpIdx >= 0) newRow[signedUpIdx] = formatDateLikeSample(stripeRow.signedUp, signedUpPattern, false);
    if (initialSubIdx >= 0 && firstMonthColumnIdx >= 0 && lastMonthColumnIdx >= firstMonthColumnIdx) {
      const rowNumber = outputRows.length + 1;
      const startRef = `${toColumnA1(firstMonthColumnIdx)}${rowNumber}`;
      const endRef = `${toColumnA1(lastMonthColumnIdx)}${rowNumber}`;
      newRow[initialSubIdx] = `=IFERROR(INDEX(FILTER(${startRef}:${endRef},${startRef}:${endRef}<>0),1),0)`;
    }
    if (salesAssistIdx >= 0 && salesAssistCustomerIds.has(normalizeCustomerIdToken(stripeRow.customerId))) {
      newRow[salesAssistIdx] = "Yes";
    }
    if (emailIdx >= 0) newRow[emailIdx] = stripeRow.email;
    outputRows.push(newRow);
  }

  return outputRows;
}

export default function ModelUpdatePage() {
  const defaults = useMemo(() => defaultDateRange(), []);
  const [startDate, setStartDate] = useState(defaults.startDate);
  const [endDate, setEndDate] = useState(defaults.endDate);
  const [files, setFiles] = useState<Partial<Record<UploadFieldKey, File>>>({});
  const [error, setError] = useState<string | null>(null);
  const [readyMessage, setReadyMessage] = useState<string | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [analyticsData, setAnalyticsData] = useState<AnalyticsResponse | null>(null);
  const [currentSelfserveAllSubsFile, setCurrentSelfserveAllSubsFile] = useState<File | null>(null);
  const [transformError, setTransformError] = useState<string | null>(null);
  const [transformSuccess, setTransformSuccess] = useState<string | null>(null);

  const missingFields = UPLOAD_FIELDS.filter((field) => !files[field.key]);

  function onFileChange(field: UploadFieldKey, file: File | null) {
    setFiles((prev) => {
      const next = { ...prev };
      if (file) next[field] = file;
      else delete next[field];
      return next;
    });
    setError(null);
    setReadyMessage(null);
    if (field === "stripeMrrPerCustomer") {
      setTransformError(null);
      setTransformSuccess(null);
    }
  }

  function onSelfserveFileChange(file: File | null) {
    setCurrentSelfserveAllSubsFile(file);
    setTransformError(null);
    setTransformSuccess(null);
  }

  function validateInputs() {
    if (!startDate || !endDate) {
      setError("Start date and end date are required.");
      setReadyMessage(null);
      return;
    }
    if (endDate < startDate) {
      setError("End date must be greater than or equal to start date.");
      setReadyMessage(null);
      return;
    }
    if (missingFields.length > 0) {
      setError(`Missing file uploads: ${missingFields.map((field) => field.label).join(", ")}`);
      setReadyMessage(null);
      return;
    }

    setError(null);
    setReadyMessage(
      `Inputs ready for model update run. Date range: ${startDate} to ${endDate}. Uploaded files: ${UPLOAD_FIELDS.length}/${UPLOAD_FIELDS.length}.`,
    );
  }

  async function fetchAnalytics() {
    setAnalyticsLoading(true);
    setAnalyticsError(null);
    try {
      const res = await fetch("/api/model-update-analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate, endDate }),
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        if (json && typeof json === "object" && "error" in json) {
          throw new Error(String((json as { error?: unknown }).error || "Analytics request failed"));
        }
        throw new Error(text || `HTTP ${res.status}`);
      }
      if (!json || typeof json !== "object") throw new Error("Invalid analytics response");
      setAnalyticsData(json as AnalyticsResponse);
    } catch (e: unknown) {
      setAnalyticsError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setAnalyticsLoading(false);
    }
  }

  async function downloadReformattedStripeMrrCsv() {
    setTransformError(null);
    setTransformSuccess(null);
    try {
      const stripeFile = files.stripeMrrPerCustomer;
      if (!stripeFile) throw new Error("Upload Stripe MRR per customer file first.");
      const parsed = parseStripeMrrPerCustomerCsv(await stripeFile.text());
      const csvRows = buildReformattedStripeRows(parsed);
      downloadCsv(`stripe-mrr-per-customer-reformatted-${parsed.monthColumn}.csv`, csvRows);
      setTransformSuccess(`Downloaded reformatted Stripe MRR CSV for ${parsed.monthColumn} (${parsed.rows.length} customers).`);
    } catch (e: unknown) {
      setTransformError(e instanceof Error ? e.message : "Failed to reformat Stripe MRR CSV.");
    }
  }

  async function downloadMergedSelfserveAllSubsCsv() {
    setTransformError(null);
    setTransformSuccess(null);
    try {
      const stripeFile = files.stripeMrrPerCustomer;
      if (!stripeFile) throw new Error("Upload Stripe MRR per customer file first.");
      if (!currentSelfserveAllSubsFile) throw new Error("Upload current selfserve-all-subs file.");
      const salesAssistFile = files.salesAssistWorkspaceIds;
      if (!salesAssistFile) throw new Error("Upload sales assist workspace IDs file first.");
      const parsedStripe = parseStripeMrrPerCustomerCsv(await stripeFile.text());
      const workspaceIds = extractWorkspaceIdsFromSalesAssistCsv(await salesAssistFile.text());
      const salesAssistCustomerIds = new Set<string>();
      if (workspaceIds.length) {
        const res = await fetch("/api/model-update-sales-assist-customers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceIds }),
        });
        const text = await res.text();
        const json = text ? (JSON.parse(text) as { customerIds?: string[]; error?: string }) : {};
        if (!res.ok) {
          throw new Error(json.error || `Failed to map workspace IDs (${res.status})`);
        }
        for (const customerId of Array.isArray(json.customerIds) ? json.customerIds : []) {
          const normalized = normalizeCustomerIdToken(customerId);
          if (normalized) salesAssistCustomerIds.add(normalized);
        }
      }
      const merged = mergeIntoSelfserveAllSubsCsv(
        await currentSelfserveAllSubsFile.text(),
        parsedStripe,
        startDate,
        endDate,
        salesAssistCustomerIds,
      );
      downloadCsv(`selfserve-all-subs-month-${parsedStripe.monthColumn}.csv`, merged);
      setTransformSuccess(
        `Downloaded merged selfserve-all-subs CSV for ${parsedStripe.monthColumn}. Sales-assist customers marked: ${salesAssistCustomerIds.size}.`,
      );
    } catch (e: unknown) {
      setTransformError(e instanceof Error ? e.message : "Failed to build merged selfserve-all-subs CSV.");
    }
  }

  return (
    <div className="stripe-ui">
      <section className="stripe-ui__hero ui-reveal">
        <div className="stripe-ui__eyebrow">Model operations</div>
        <div className="stripe-ui__hero-row">
          <div>
            <h1 className="stripe-ui__title">Model Update</h1>
            <p className="stripe-ui__subtitle">
              Upload required source files and date range for model refresh input packaging.
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <Link href="/combined-all-subs" className="stripe-ui__hero-link">
              Open Combined All Subs
            </Link>
            <Link href="/combined-billing-overview" className="stripe-ui__hero-link">
              Open Combined Billing Overview
            </Link>
            <Link href="/stripe-through-mrr" className="stripe-ui__hero-link">
              Open Stripe through MRR
            </Link>
          </div>
        </div>
      </section>

      <section className="stripe-ui__panel ui-reveal ui-reveal-1">
        <h2 className="stripe-ui__panel-title">Inputs</h2>
        <p className="stripe-ui__panel-subtitle">
          Provide date range and upload all 5 files. Files are currently validated client-side.
        </p>

        <div className="stripe-ui__control-grid" style={{ gridTemplateColumns: "repeat(3, minmax(180px, 1fr))" }}>
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="model-update-start-date">
              Start date
            </label>
            <input
              id="model-update-start-date"
              className="stripe-ui__control"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="model-update-end-date">
              End date
            </label>
            <input
              id="model-update-end-date"
              className="stripe-ui__control"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="model-update-validate">
              Validate
            </label>
            <button
              id="model-update-validate"
              className="stripe-ui__btn stripe-ui__btn--primary"
              onClick={validateInputs}
            >
              Validate inputs
            </button>
          </div>
        </div>

        <div className="stripe-ui__table-wrap" style={{ marginTop: "0.9rem" }}>
          <table className="stripe-ui__table" aria-label="Model update file uploads">
            <thead>
              <tr>
                <th>Input</th>
                <th>Upload</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {UPLOAD_FIELDS.map((field) => {
                const file = files[field.key];
                return (
                  <tr key={field.key}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{field.label}</div>
                      <div className="stripe-ui__hint">{field.hint}</div>
                    </td>
                    <td>
                      <input
                        className="stripe-ui__control"
                        type="file"
                        onChange={(e) => onFileChange(field.key, e.target.files?.[0] || null)}
                      />
                    </td>
                    <td>
                      {file ? (
                        <span>
                          {file.name} ({formatBytes(file.size)})
                        </span>
                      ) : (
                        <span style={{ opacity: 0.75 }}>Missing</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {error && (
          <p className="stripe-ui__panel-subtitle" style={{ color: "#fca5a5", marginTop: "0.75rem", marginBottom: 0 }}>
            {error}
          </p>
        )}
        {readyMessage && (
          <p className="stripe-ui__panel-subtitle" style={{ color: "#86efac", marginTop: "0.75rem", marginBottom: 0 }}>
            {readyMessage}
          </p>
        )}
      </section>

      <section className="stripe-ui__panel ui-reveal ui-reveal-2">
        <h2 className="stripe-ui__panel-title">Selfserve All Subs Month Builder</h2>
        <p className="stripe-ui__panel-subtitle">
          Uses uploaded Stripe MRR per customer CSV, reformats it, and optionally merges it into current selfserve-all-subs by Customer ID.
        </p>
        <div className="stripe-ui__control-grid" style={{ gridTemplateColumns: "repeat(2, minmax(220px, 1fr))" }}>
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="model-update-selfserve-all-subs-file">
              Current selfserve-all-subs file (CSV)
            </label>
            <input
              id="model-update-selfserve-all-subs-file"
              className="stripe-ui__control"
              type="file"
              accept=".csv,text/csv,.txt,text/plain"
              onChange={(e) => onSelfserveFileChange(e.target.files?.[0] || null)}
            />
            <div className="stripe-ui__hint">
              {currentSelfserveAllSubsFile
                ? `${currentSelfserveAllSubsFile.name} (${formatBytes(currentSelfserveAllSubsFile.size)})`
                : "Optional for merge. Required for selfserve-all-subs output."}
            </div>
          </div>
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label">Build files</label>
            <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
              <button className="stripe-ui__btn stripe-ui__btn--secondary" onClick={() => void downloadReformattedStripeMrrCsv()}>
                Download reformatted Stripe MRR CSV
              </button>
              <button className="stripe-ui__btn stripe-ui__btn--primary" onClick={() => void downloadMergedSelfserveAllSubsCsv()}>
                Download selfserve-all-subs-month CSV
              </button>
            </div>
          </div>
        </div>

        {transformError ? (
          <p className="stripe-ui__panel-subtitle" style={{ color: "#fca5a5", marginTop: "0.75rem", marginBottom: 0 }}>
            {transformError}
          </p>
        ) : null}
        {transformSuccess ? (
          <p className="stripe-ui__panel-subtitle" style={{ color: "#86efac", marginTop: "0.75rem", marginBottom: 0 }}>
            {transformSuccess}
          </p>
        ) : null}
      </section>

      <section className="stripe-ui__panel ui-reveal ui-reveal-3">
        <h2 className="stripe-ui__panel-title">Analytics (Mixpanel + Google Analytics)</h2>
        <p className="stripe-ui__panel-subtitle">
          Mixpanel metrics are shown for the selected range (DAU/WAU/MAU on last day, plus monthly totals).
        </p>
        <div className="stripe-ui__control-grid" style={{ gridTemplateColumns: "repeat(3, minmax(180px, 1fr))" }}>
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label">Mixpanel endpoint env(s)</label>
            <div className="stripe-ui__hint">`MODEL_UPDATE_MIXPANEL_ENDPOINT` or metric-specific endpoint vars</div>
          </div>
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label">Google Analytics endpoint env</label>
            <div className="stripe-ui__hint">`MODEL_UPDATE_GA_ENDPOINT`</div>
          </div>
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="model-update-fetch-analytics">
              Fetch
            </label>
            <button
              id="model-update-fetch-analytics"
              className="stripe-ui__btn stripe-ui__btn--ghost"
              onClick={() => void fetchAnalytics()}
              disabled={analyticsLoading}
            >
              {analyticsLoading ? "Fetching..." : "Fetch analytics"}
            </button>
          </div>
        </div>

        {analyticsError && (
          <p className="stripe-ui__panel-subtitle" style={{ color: "#fca5a5", marginTop: "0.75rem", marginBottom: 0 }}>
            {analyticsError}
          </p>
        )}

        {analyticsData && (
          <div className="stripe-ui__stats-grid" style={{ marginTop: "0.9rem", marginBottom: "0.9rem" }}>
            <div className="stripe-ui__stat">
              <p className="stripe-ui__stat-label">DAU (last day)</p>
              <p className="stripe-ui__stat-value">
                {analyticsData.mixpanelMetrics.dauLastDay.value != null ? formatNumber(analyticsData.mixpanelMetrics.dauLastDay.value) : "—"}
              </p>
              <p className="stripe-ui__hint">
                {analyticsData.mixpanelMetrics.dauLastDay.status}
                {analyticsData.mixpanelMetrics.dauLastDay.details ? `: ${analyticsData.mixpanelMetrics.dauLastDay.details}` : ""}
              </p>
            </div>
            <div className="stripe-ui__stat">
              <p className="stripe-ui__stat-label">WAU (last day)</p>
              <p className="stripe-ui__stat-value">
                {analyticsData.mixpanelMetrics.wauLastDay.value != null ? formatNumber(analyticsData.mixpanelMetrics.wauLastDay.value) : "—"}
              </p>
              <p className="stripe-ui__hint">
                {analyticsData.mixpanelMetrics.wauLastDay.status}
                {analyticsData.mixpanelMetrics.wauLastDay.details ? `: ${analyticsData.mixpanelMetrics.wauLastDay.details}` : ""}
              </p>
            </div>
            <div className="stripe-ui__stat">
              <p className="stripe-ui__stat-label">MAU (last day)</p>
              <p className="stripe-ui__stat-value">
                {analyticsData.mixpanelMetrics.mauLastDay.value != null ? formatNumber(analyticsData.mixpanelMetrics.mauLastDay.value) : "—"}
              </p>
              <p className="stripe-ui__hint">
                {analyticsData.mixpanelMetrics.mauLastDay.status}
                {analyticsData.mixpanelMetrics.mauLastDay.details ? `: ${analyticsData.mixpanelMetrics.mauLastDay.details}` : ""}
              </p>
            </div>
            <div className="stripe-ui__stat">
              <p className="stripe-ui__stat-label">Signups (month)</p>
              <p className="stripe-ui__stat-value">
                {analyticsData.mixpanelMetrics.signupsInMonth.value != null ? formatNumber(analyticsData.mixpanelMetrics.signupsInMonth.value) : "—"}
              </p>
              <p className="stripe-ui__hint">
                {analyticsData.mixpanelMetrics.signupsInMonth.status}
                {analyticsData.mixpanelMetrics.signupsInMonth.details ? `: ${analyticsData.mixpanelMetrics.signupsInMonth.details}` : ""}
              </p>
            </div>
            <div className="stripe-ui__stat">
              <p className="stripe-ui__stat-label">Production messages (month)</p>
              <p className="stripe-ui__stat-value">
                {analyticsData.mixpanelMetrics.productionMessagesInMonth.value != null ? formatNumber(analyticsData.mixpanelMetrics.productionMessagesInMonth.value) : "—"}
              </p>
              <p className="stripe-ui__hint">
                {analyticsData.mixpanelMetrics.productionMessagesInMonth.status}
                {analyticsData.mixpanelMetrics.productionMessagesInMonth.details ? `: ${analyticsData.mixpanelMetrics.productionMessagesInMonth.details}` : ""}
              </p>
            </div>
            <div className="stripe-ui__stat">
              <p className="stripe-ui__stat-label">High Volume Workspaces (1k incoming)</p>
              <p className="stripe-ui__stat-value">
                {analyticsData.mixpanelMetrics.highVolumeWorkspacesInMonth.value != null ? formatNumber(analyticsData.mixpanelMetrics.highVolumeWorkspacesInMonth.value) : "—"}
              </p>
              <p className="stripe-ui__hint">
                {analyticsData.mixpanelMetrics.highVolumeWorkspacesInMonth.status}
                {analyticsData.mixpanelMetrics.highVolumeWorkspacesInMonth.details
                  ? `: ${analyticsData.mixpanelMetrics.highVolumeWorkspacesInMonth.details}`
                  : ""}
              </p>
            </div>
            <div className="stripe-ui__stat">
              <p className="stripe-ui__stat-label">Active Builders (10 of 30 days)</p>
              <p className="stripe-ui__stat-value">
                {analyticsData.mixpanelMetrics.activeBuilders10of30.value != null ? formatNumber(analyticsData.mixpanelMetrics.activeBuilders10of30.value) : "—"}
              </p>
              <p className="stripe-ui__hint">
                {analyticsData.mixpanelMetrics.activeBuilders10of30.status}
                {analyticsData.mixpanelMetrics.activeBuilders10of30.details ? `: ${analyticsData.mixpanelMetrics.activeBuilders10of30.details}` : ""}
              </p>
            </div>
            <div className="stripe-ui__stat">
              <p className="stripe-ui__stat-label">Google Analytics</p>
              <p className="stripe-ui__stat-value">
                {analyticsData.googleAnalytics.value != null ? formatNumber(analyticsData.googleAnalytics.value) : "—"}
              </p>
              <p className="stripe-ui__hint">
                {analyticsData.googleAnalytics.status}
                {analyticsData.googleAnalytics.details ? `: ${analyticsData.googleAnalytics.details}` : ""}
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
