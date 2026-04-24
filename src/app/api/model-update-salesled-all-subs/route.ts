import { NextResponse } from "next/server";
import { generateReport } from "@/lib/report";
import { batchReadCompanies } from "@/lib/hubspot";
import { getOrSetCache, readTtlMs, stableStringify } from "@/lib/serverResponseCache";
import type { HubspotPlan } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 180;

const CACHE_TTL_MS = readTtlMs("API_MODEL_UPDATE_SALESLED_ALL_SUBS_CACHE_TTL_MS", 300_000);
const HISTORY_START_MONTH = "2023-10";
const HISTORY_START_DATE = `${HISTORY_START_MONTH}-01`;

const ORDERED_OPPORTUNITY_NAMES: string[] = [
  "Instar Research",
  "PTW",
  "OnRobot",
  "Tribunal Constitucional de la República Dominicana",
  "Hostifai",
  "Mewah Group",
  "Hub People",
  "Yanzo",
  "Conectcar",
  "Crossvue",
  "Tax Cambodia",
  "TUI",
  "Opswat",
  "American Heart Association",
  "PM International",
  "Domseeds (Les Domaines)",
  "VML",
  "REF (formerly lg2)",
  "Extendly",
  "Fortis",
  "Dah Reply - UEM",
  "Ableapp",
  "Interhome Group",
  "TU Dortmund",
  "SoftMarketing (Softinova)",
  "Zain",
  "Pisteyo",
  "Upskillist",
  "Point Loma Nazarene University (PLNU)",
  "Waiver Group",
  "Bluerock",
  "SBE Global",
  "Schenectady County",
  "Pedidos Ya",
  "Philippine Department of Labor and Employment",
  "Ingenico",
  "Ledvance",
  "Solventa",
  "Meerkat Enterprise",
  "Durham County Government",
  "Sojern",
  "Three Link Solutions",
  "Highlevel",
  "MTN.com",
  "The Executive Centre",
  "Uniti",
  "Cashfree Payments",
  "GE Healthcare",
  "Essentia Analytics",
  "ISOC-ZA",
  "MCD Global Health",
  "Curious Learning",
  "Cyncly",
  "Bauverein der Elbgemeinden",
  "Puertos Canarios",
  "Credit Hub Australia",
  "Dassault Systèmes",
  "K-ID",
  "Konkrd Holdings Pty Ltd",
  "Wazu",
  "QuintoAndar",
  "Fashion Group",
  "ELCHK",
  "Tekion",
  "American Eagle",
  "Vietjet Air",
  "Catchpoint",
  "Gavin Euro-Sportring",
  "Omniae App",
  "TAICA",
  "Aprende Institute",
  "Billie",
  "Taager",
  "Accademia Italiana Fitness",
  "Forest Lawn",
  "Floodsimple",
  "Monjur",
  "NS Consulting",
  "UTSA - The University of Texas at San Antonio",
  "Satispay",
  "Converse Mexico",
  "May Mobility",
  "Alibware",
  "Furnisure",
  "Circuit Board Medics",
  "eLearning Industry",
  "Paylink Solutions",
  "iolo",
  "Greenstone FCs",
  "GLDS",
  "IQI",
  "Scalex",
  "Brawn",
  "Dr Michael's Dental Clinic",
  "Zambia Electricity Supply Corporation Limited",
  "Voyage Privé FR",
  "Epsylon",
  "Grupo Veniu",
  "Libertex",
  "A.M. Best Company",
  "Estrelar",
  "Fab-Consult",
  "ReadySpaces",
  "Mouratoglou Tennis Academy",
  "Zing",
  "The Higher Education Assistance Group",
  "Rentola",
  "Quallege",
  "Polestar",
  "IMED Hospitales",
  "Turbi",
  "Etraveli Group",
  "Eduzz",
  "Certified Rate",
  "NBM GRP",
  "HouseAccount",
  "Webarts Digital Agency",
  "Perpemo",
  "Yamaha Motor",
];

type ApiBody = {
  startDate?: unknown;
  endDate?: unknown;
};

type OpportunityAggregate = {
  key: string;
  opportunityName: string;
  companyId: string;
  valuesByMonth: Record<string, number>;
  plan: HubspotPlan | "";
};

type ResponsePayload = {
  startDate: string;
  endDate: string;
  header: string[];
  rows: string[][];
  summary: {
    totalRows: number;
    monthCount: number;
  };
};

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function parsePayload(raw: ApiBody) {
  const startDate = String(raw.startDate || "").trim();
  const endDate = String(raw.endDate || "").trim();
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    throw new Error("Invalid startDate/endDate");
  }
  if (endDate < startDate) {
    throw new Error("endDate must be >= startDate");
  }
  return { startDate, endDate };
}

function round2(n: number) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function normalizeNameForSort(value: string) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function buildMonthKeys(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) return [];
  const keys: string[] = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor <= endMonth) {
    const year = cursor.getUTCFullYear();
    const month = String(cursor.getUTCMonth() + 1).padStart(2, "0");
    keys.push(`${year}-${month}`);
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return keys;
}

function isCloudDeploymentType(value: unknown) {
  return String(value || "").trim().toLowerCase() === "cloud";
}

function companyIdFromAccountId(rawValue: unknown) {
  const value = String(rawValue || "").trim();
  if (!value) return "";
  const token = value
    .split(/[,\s;|]+/)
    .map((part) => part.trim())
    .find((part) => /^\d+$/.test(part));
  return token || "";
}

function aggregateKey(accountId: unknown, accountName: unknown, dealId: unknown) {
  const rawAccountId = String(accountId || "").trim();
  if (rawAccountId) {
    const companyId = companyIdFromAccountId(rawAccountId);
    if (companyId) return `id:${companyId}`;
    return `id:${rawAccountId.toLowerCase()}`;
  }
  const rawName = String(accountName || "").trim();
  if (rawName) return `name:${normalizeNameForSort(rawName)}`;
  return `deal:${String(dealId || "").trim()}`;
}

function planRank(value: HubspotPlan | "") {
  if (value === "enterprise") return 4;
  if (value === "managed") return 3;
  if (value === "team") return 2;
  if (value === "other") return 1;
  return 0;
}

function mergePlan(current: HubspotPlan | "", next: HubspotPlan | "") {
  return planRank(next) > planRank(current) ? next : current;
}

function formatPlan(value: HubspotPlan | "") {
  if (value === "enterprise") return "Enterprise";
  if (value === "managed") return "Managed";
  if (value === "team") return "Team";
  if (value === "other") return "Other";
  return "";
}

function asFiniteNumber(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asEmployeeCountValue(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return n;
}

async function buildSalesledAllSubs(startDate: string, endDate: string): Promise<ResponsePayload> {
  const queryStartDate = endDate >= HISTORY_START_DATE ? HISTORY_START_DATE : startDate;
  const historyMonthKeys = buildMonthKeys(queryStartDate, endDate);
  const selectedMonthKeys = buildMonthKeys(startDate, endDate).filter((key) => historyMonthKeys.includes(key));

  const report = await generateReport({
    startDate: queryStartDate,
    endDate,
    mode: "contracted",
    grain: "monthly",
  });

  const aggregates = new Map<string, OpportunityAggregate>();
  for (const row of report.rows || []) {
    if (!isCloudDeploymentType(row.deploymentType)) continue;
    const key = aggregateKey(row.accountId, row.accountName, row.dealId);
    if (!key) continue;
    if (!aggregates.has(key)) {
      aggregates.set(key, {
        key,
        opportunityName:
          String(row.accountName || "").trim() ||
          String(row.dealName || "").trim() ||
          String(row.accountId || "").trim() ||
          String(row.dealId || "").trim(),
        companyId: companyIdFromAccountId(row.accountId),
        valuesByMonth: Object.fromEntries(historyMonthKeys.map((monthKey) => [monthKey, 0])),
        plan: "",
      });
    }

    const entry = aggregates.get(key)!;
    if (!entry.companyId) entry.companyId = companyIdFromAccountId(row.accountId);
    const nextPlan = (row.plan || "") as HubspotPlan | "";
    entry.plan = mergePlan(entry.plan, nextPlan);

    for (const monthKey of historyMonthKeys) {
      const value = asFiniteNumber(row.valuesByPeriod?.[monthKey]);
      if (!value) continue;
      entry.valuesByMonth[monthKey] = round2((entry.valuesByMonth[monthKey] || 0) + value);
    }
  }

  const filtered = Array.from(aggregates.values()).filter((entry) => {
    const keysToCheck = selectedMonthKeys.length ? selectedMonthKeys : historyMonthKeys;
    return keysToCheck.some((monthKey) => Math.abs(asFiniteNumber(entry.valuesByMonth[monthKey])) > 1e-9);
  });

  const companyIds = Array.from(new Set(filtered.map((entry) => entry.companyId).filter(Boolean)));
  const companyEmployeeCounts = new Map<string, number>();
  if (companyIds.length) {
    const companies = await batchReadCompanies(
      companyIds,
      ["numberofemployees", "clay_employee_count", "number_of_employees__c"],
    );
    for (const companyId of companyIds) {
      const company = companies.get(companyId);
      const props = (company?.properties || {}) as Record<string, unknown>;
      const numberOfEmployees =
        asEmployeeCountValue(props.numberofemployees) ??
        asEmployeeCountValue(props.number_of_employees__c) ??
        0;
      const clayEmployeeCount = asEmployeeCountValue(props.clay_employee_count) ?? 0;
      companyEmployeeCounts.set(companyId, Math.max(numberOfEmployees, clayEmployeeCount));
    }
  }

  const explicitOrder = new Map<string, number>();
  ORDERED_OPPORTUNITY_NAMES.forEach((name, idx) => {
    explicitOrder.set(normalizeNameForSort(name), idx);
  });

  filtered.sort((a, b) => {
    const leftOrder = explicitOrder.get(normalizeNameForSort(a.opportunityName));
    const rightOrder = explicitOrder.get(normalizeNameForSort(b.opportunityName));
    const leftRank = leftOrder == null ? Number.MAX_SAFE_INTEGER : leftOrder;
    const rightRank = rightOrder == null ? Number.MAX_SAFE_INTEGER : rightOrder;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return a.opportunityName.localeCompare(b.opportunityName);
  });

  const header = ["OpportunityName", "Employee Count", ...historyMonthKeys, "Plan"];
  const rows = filtered.map((entry) => {
    const employeeCount = entry.companyId ? companyEmployeeCounts.get(entry.companyId) : undefined;
    const monthValues = historyMonthKeys.map((monthKey) => String(round2(asFiniteNumber(entry.valuesByMonth[monthKey]))));
    return [
      entry.opportunityName,
      employeeCount != null ? String(employeeCount) : "",
      ...monthValues,
      formatPlan(entry.plan),
    ];
  });

  return {
    startDate,
    endDate,
    header,
    rows,
    summary: {
      totalRows: rows.length,
      monthCount: historyMonthKeys.length,
    },
  };
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as ApiBody;
    const { startDate, endDate } = parsePayload(body);
    const key = `api:model-update-salesled-all-subs:${stableStringify({
      startDate,
      endDate,
      historyStartMonth: HISTORY_START_MONTH,
    })}`;
    const payload = await getOrSetCache(key, CACHE_TTL_MS, () => buildSalesledAllSubs(startDate, endDate));
    return NextResponse.json(payload);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      message.includes("Invalid startDate/endDate") ||
      message.includes("endDate must be >= startDate")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
