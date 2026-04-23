type BambooEmployeeRecord = {
  id: string;
  firstName: string;
  lastName: string;
  preferredName: string;
  displayName: string;
  fullName: string;
  jobTitle: string;
  department: string;
  division: string;
  location: string;
  rawText: string;
  hireDate: string;
  terminationDate: string;
  employmentStatus: string;
  employmentType: string;
  payType: string;
  salary: string;
  fullTimeEquivalent: number | null;
};

type BambooClientConfig = {
  subdomain: string;
  authHeader: string;
  baseUrls: string[];
};

type BambooEmploymentStatusTimelineRow = {
  effectiveDate: Date;
  status: string;
};

export type BambooHeadcountSnapshot = {
  count: number;
  employeeNames: string[];
};

export type BambooNewHireRow = {
  department: string;
  jobTitle: string;
  type: string;
  qc: boolean;
  greySkyBaseline: string;
  categorization: string;
  name: string;
  startDate: string;
  salary: string;
};

function clean(value: string | undefined | null) {
  return String(value || "").trim();
}

function normalizeLoose(value: string | undefined | null) {
  return clean(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeFieldKey(value: string) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseIsoDateOnly(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean(value));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

function toIsoDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function basicAuthHeader(apiKey: string) {
  return `Basic ${Buffer.from(`${apiKey}:x`).toString("base64")}`;
}

function parseRetryAfterMs(raw: string | null) {
  if (!raw) return null;
  const asSeconds = Number(raw);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return Math.round(asSeconds * 1000);
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) {
    const delta = parsed - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

async function fetchJsonWithRetry(url: string, init: RequestInit, maxAttempts = 4): Promise<unknown> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetch(url, init);
    if (res.ok) {
      const text = await res.text();
      if (!text) return null;
      return JSON.parse(text) as unknown;
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= maxAttempts) {
      const text = await res.text().catch(() => "");
      throw new Error(`BambooHR request failed (${res.status}): ${text || res.statusText}`);
    }
    const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
    const backoffMs = 250 * Math.pow(2, attempt - 1);
    const waitMs = Math.max(retryAfterMs ?? 0, backoffMs);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastError = new Error(`Retrying BambooHR request after ${waitMs}ms`);
  }
  throw lastError instanceof Error ? lastError : new Error("BambooHR request failed");
}

function firstValue(obj: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = obj[key];
      if (value != null && clean(String(value)) !== "") return value;
    }
  }
  const aliasToField = new Map<string, string>();
  for (const field of Object.keys(obj)) {
    const normalized = normalizeFieldKey(field);
    if (!normalized || aliasToField.has(normalized)) continue;
    aliasToField.set(normalized, field);
  }
  for (const alias of keys.map(normalizeFieldKey)) {
    const field = aliasToField.get(alias);
    if (!field) continue;
    const value = obj[field];
    if (value != null && clean(String(value)) !== "") return value;
  }
  return null;
}

function firstString(obj: Record<string, unknown>, keys: string[]) {
  const value = firstValue(obj, keys);
  return value == null ? "" : clean(String(value));
}

function parseNumber(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeEmployeeRow(input: unknown): BambooEmployeeRecord | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;
  const id = firstString(row, ["id", "employeeId", "employee_id", "employee id"]);
  const firstName = firstString(row, ["firstName", "first name", "givenName", "given name"]);
  const lastName = firstString(row, ["lastName", "last name", "familyName", "family name", "surname"]);
  const preferredName = firstString(row, ["preferredName", "preferred name", "nickname", "nick name"]);
  const displayName = firstString(row, ["displayName", "display name"]);
  const fullName = firstString(row, ["fullName", "full name", "name"]);
  const jobTitle = firstString(row, ["jobTitle", "job title", "title", "position", "job"]);
  const department = firstString(row, ["department", "dept"]);
  const division = firstString(row, ["division", "business unit", "team"]);
  const location = firstString(row, ["location", "office", "work location"]);
  const hireDate = firstString(row, ["hireDate", "dateOfHire", "hiredDate", "employmentStartDate", "hire date"]);
  const terminationDate = firstString(row, ["terminationDate", "dateOfTermination", "employmentEndDate", "termination date"]);
  const employmentStatus = firstString(row, [
    "employmentStatus",
    "employeeStatus",
    "status",
    "employment status",
    "employee status",
  ]);
  const employmentType = firstString(row, ["employmentType", "type", "employment type", "employee type"]);
  const payType = firstString(row, ["payType", "pay type"]);
  const salary = firstString(row, [
    "payRate",
    "pay rate",
    "salary",
    "annualSalary",
    "annual salary",
    "baseSalary",
    "base salary",
    "compensation",
  ]);
  const fullTimeEquivalent = parseNumber(
    firstValue(row, ["fullTimeEquivalent", "FTE", "fte", "full time equivalent"]),
  );
  const rawText = Object.values(row)
    .map((value) => clean(String(value)))
    .filter(Boolean)
    .join(" ");
  return {
    id,
    firstName,
    lastName,
    preferredName,
    displayName,
    fullName,
    jobTitle,
    department,
    division,
    location,
    rawText,
    hireDate,
    terminationDate,
    employmentStatus,
    employmentType,
    payType,
    salary,
    fullTimeEquivalent,
  };
}

function extractRows(payload: unknown): unknown[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;
  if (Array.isArray(obj.rows)) return obj.rows as unknown[];
  if (Array.isArray(obj.table)) return obj.table as unknown[];
  if (Array.isArray(obj.employees)) return obj.employees as unknown[];
  if (Array.isArray(obj.results)) return obj.results as unknown[];
  if (Array.isArray(obj.data)) return obj.data as unknown[];
  if (obj.table && typeof obj.table === "object") {
    const nested = obj.table as Record<string, unknown>;
    if (Array.isArray(nested.rows)) return nested.rows as unknown[];
    if (Array.isArray(nested.row)) return nested.row as unknown[];
    const objectRows = Object.values(nested).filter((value) => !!value && typeof value === "object");
    if (objectRows.length) return objectRows;
  }
  if (obj.employees && typeof obj.employees === "object") {
    const nested = obj.employees as Record<string, unknown>;
    if (Array.isArray(nested.employee)) return nested.employee as unknown[];
    const objectRows = Object.values(nested).filter((value) => !!value && typeof value === "object");
    if (objectRows.length) return objectRows;
  }
  if (obj.results && typeof obj.results === "object") {
    const objectRows = Object.values(obj.results as Record<string, unknown>).filter(
      (value) => !!value && typeof value === "object",
    );
    if (objectRows.length) return objectRows;
  }
  if (obj.data && typeof obj.data === "object") {
    const objectRows = Object.values(obj.data as Record<string, unknown>).filter((value) => !!value && typeof value === "object");
    if (objectRows.length) return objectRows;
  }
  return [];
}

function normalizeBaseUrl(value: string) {
  return clean(value).replace(/\/+$/, "");
}

function resolveBambooClientConfig(): BambooClientConfig {
  const subdomain = clean(process.env.BAMBOOHR_SUBDOMAIN);
  const apiKey = clean(process.env.BAMBOOHR_API_KEY);
  if (!subdomain || !apiKey) {
    throw new Error("BambooHR is not configured. Set BAMBOOHR_SUBDOMAIN and BAMBOOHR_API_KEY.");
  }
  const authHeader = basicAuthHeader(apiKey);
  const configuredBase = normalizeBaseUrl(clean(process.env.BAMBOOHR_BASE_URL || ""));
  const canonicalBase = normalizeBaseUrl(`https://${subdomain}.bamboohr.com`);
  const apiBase = normalizeBaseUrl("https://api.bamboohr.com");
  const baseUrls = Array.from(new Set([canonicalBase, configuredBase, apiBase].filter(Boolean)));
  return { subdomain, authHeader, baseUrls };
}

function isActiveOnDate(employee: BambooEmployeeRecord, snapshotDate: Date) {
  const hire = parseIsoDateOnly(employee.hireDate);
  const term = parseIsoDateOnly(employee.terminationDate);
  if (hire && hire.getTime() > snapshotDate.getTime()) return false;
  if (term && term.getTime() <= snapshotDate.getTime()) return false;
  return true;
}

function isIncludedEmploymentStatus(status: string) {
  const normalized = normalizeLoose(status);
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  if (normalized.includes("contractor")) return true;
  if (compact.includes("employeepermft")) return true;
  return false;
}

function isInactiveEmploymentStatus(status: string) {
  const normalized = normalizeLoose(status);
  return normalized.includes("terminated") || normalized.includes("inactive");
}

function parseEmploymentStatusTimelineRows(payload: unknown): BambooEmploymentStatusTimelineRow[] {
  const rows = extractRows(payload);
  const parsed: BambooEmploymentStatusTimelineRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const obj = row as Record<string, unknown>;
    const effectiveDateText = firstString(obj, ["date", "effectiveDate", "effective_date"]);
    const status = firstString(obj, ["employmentStatus", "status", "value", "label", "name"]);
    const effectiveDate = parseIsoDateOnly(effectiveDateText);
    if (!effectiveDate || !status) continue;
    parsed.push({ effectiveDate, status });
  }
  parsed.sort((a, b) => a.effectiveDate.getTime() - b.effectiveDate.getTime());
  return parsed;
}

function pickEmploymentStatusAsOf(
  timeline: BambooEmploymentStatusTimelineRow[],
  snapshotDate: Date,
): string {
  let best: BambooEmploymentStatusTimelineRow | null = null;
  for (const row of timeline) {
    if (row.effectiveDate.getTime() > snapshotDate.getTime()) continue;
    if (isInactiveEmploymentStatus(row.status)) continue;
    if (!best || row.effectiveDate.getTime() > best.effectiveDate.getTime()) {
      best = row;
    }
  }
  return best ? best.status : "";
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  handler: (item: T) => Promise<void>,
): Promise<void> {
  if (!items.length) return;
  const queue = [...items];
  const workers: Promise<void>[] = [];
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(
      (async () => {
        while (queue.length) {
          const item = queue.shift();
          if (item == null) return;
          await handler(item);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

function employeeDisplayName(employee: BambooEmployeeRecord) {
  const display = clean(employee.displayName);
  if (display) return display;
  const full = clean(employee.fullName);
  if (full) return full;

  const preferred = clean(employee.preferredName);
  const first = clean(employee.firstName);
  const last = clean(employee.lastName);
  if (preferred && last) return `${preferred} ${last}`;
  if (preferred) return preferred;
  if (first && last) return `${first} ${last}`;
  if (first) return first;
  if (last) return last;
  if (employee.id) return `Employee ${employee.id}`;
  return "Unknown Employee";
}

async function fetchEmployeeRoster(): Promise<BambooEmployeeRecord[]> {
  const { subdomain, authHeader, baseUrls } = resolveBambooClientConfig();
  const reportBodies: Array<Record<string, unknown>> = [
    {
      title: "Current employees with employment fields",
      fields: [
        "id",
        "employmentStatus",
        "employmentType",
        "status",
        "type",
        "hireDate",
        "dateOfHire",
        "terminationDate",
        "dateOfTermination",
        "fullTimeEquivalent",
        "FTE",
        "payType",
        "payRate",
        "salary",
        "annualSalary",
        "baseSalary",
        "displayName",
      ],
    },
    {
      title: "Current employees with alternative employment fields",
      fields: [
        "id",
        "status",
        "type",
        "dateOfHire",
        "dateOfTermination",
        "FTE",
        "payType",
        "payRate",
        "salary",
        "annualSalary",
        "baseSalary",
        "displayName",
      ],
    },
  ];

  const fetchDirectoryRows = async (baseUrl: string) => {
    const directoryUrl = `${baseUrl}/api/gateway.php/${encodeURIComponent(subdomain)}/v1/employees/directory`;
    const directoryPayload = await fetchJsonWithRetry(directoryUrl, {
      method: "GET",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
      },
    });
    return extractRows(directoryPayload)
      .map(normalizeEmployeeRow)
      .filter((row): row is BambooEmployeeRecord => !!row);
  };

  const pickBestRoster = (existing: BambooEmployeeRecord[], candidate: BambooEmployeeRecord[]) => {
    if (candidate.length > existing.length) return candidate;
    return existing;
  };
  const dedupeByIdOrName = (rows: BambooEmployeeRecord[]) => {
    const out: BambooEmployeeRecord[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const id = clean(row.id);
      const nameKey = clean(employeeDisplayName(row)).toLowerCase();
      const key = id ? `id:${id}` : `name:${nameKey}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
    return out;
  };
  const mergeWithDirectory = (rows: BambooEmployeeRecord[], directoryRows: BambooEmployeeRecord[]) => {
    if (!rows.length || !directoryRows.length) return rows;
    const byId = new Map<string, BambooEmployeeRecord>();
    for (const directoryRow of directoryRows) {
      const id = clean(directoryRow.id);
      if (!id || byId.has(id)) continue;
      byId.set(id, directoryRow);
    }
    return rows.map((row) => {
      const id = clean(row.id);
      const extra = id ? byId.get(id) : undefined;
      if (!extra) return row;
      return {
        ...row,
        firstName: clean(extra.firstName) || row.firstName,
        lastName: clean(extra.lastName) || row.lastName,
        preferredName: clean(extra.preferredName) || row.preferredName,
        displayName: clean(extra.displayName) || row.displayName,
        fullName: clean(extra.fullName) || row.fullName,
        jobTitle: clean(extra.jobTitle) || row.jobTitle,
        department: clean(extra.department) || row.department,
        division: clean(extra.division) || row.division,
        location: clean(extra.location) || row.location,
        payType: clean(extra.payType) || row.payType,
        salary: clean(extra.salary) || row.salary,
        rawText: `${row.rawText} ${extra.rawText}`.trim(),
      };
    });
  };

  let bestReportRows: BambooEmployeeRecord[] = [];
  let bestDirectoryRows: BambooEmployeeRecord[] = [];
  for (const baseUrl of baseUrls) {
    try {
      const directoryRows = dedupeByIdOrName(await fetchDirectoryRows(baseUrl));
      bestDirectoryRows = pickBestRoster(bestDirectoryRows, directoryRows);
    } catch {
      // Try next source.
    }

    const reportUrlBase = `${baseUrl}/api/gateway.php/${encodeURIComponent(subdomain)}/v1/reports/custom?format=JSON`;
    for (const suffix of ["&onlyCurrent=false", ""]) {
      for (const body of reportBodies) {
        try {
          const payload = await fetchJsonWithRetry(`${reportUrlBase}${suffix}`, {
            method: "POST",
            headers: {
              Authorization: authHeader,
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });
          const rows = dedupeByIdOrName(
            extractRows(payload).map(normalizeEmployeeRow).filter((row): row is BambooEmployeeRecord => !!row),
          );
          bestReportRows = pickBestRoster(bestReportRows, rows);
        } catch {
          // Try next variant.
        }
      }
    }
  }
  if (bestReportRows.length) {
    return dedupeByIdOrName(mergeWithDirectory(bestReportRows, bestDirectoryRows));
  }
  if (bestDirectoryRows.length) return bestDirectoryRows;

  // Fallback to directory endpoint if custom report is unavailable.
  for (const baseUrl of baseUrls) {
    try {
      const rows = await fetchDirectoryRows(baseUrl);
      if (rows.length) return rows;
    } catch {
      // Try next base URL.
    }
  }
  return [];
}

async function fetchEmploymentStatusTimelineByEmployee(
  employeeIds: string[],
): Promise<Map<string, BambooEmploymentStatusTimelineRow[]>> {
  const { subdomain, authHeader, baseUrls } = resolveBambooClientConfig();
  const out = new Map<string, BambooEmploymentStatusTimelineRow[]>();
  const uniqueIds = Array.from(
    new Set(
      employeeIds
        .map((id) => clean(id))
        .filter(Boolean),
    ),
  );
  await mapWithConcurrency(uniqueIds, 8, async (employeeId) => {
    let best: BambooEmploymentStatusTimelineRow[] = [];
    for (const baseUrl of baseUrls) {
      const url = `${baseUrl}/api/gateway.php/${encodeURIComponent(subdomain)}/v1/employees/${encodeURIComponent(employeeId)}/tables/employmentStatus?format=JSON`;
      try {
        const payload = await fetchJsonWithRetry(url, {
          method: "GET",
          headers: {
            Authorization: authHeader,
            Accept: "application/json",
          },
        });
        const parsed = parseEmploymentStatusTimelineRows(payload);
        if (parsed.length > best.length) best = parsed;
      } catch {
        // Try next base URL.
      }
    }
    out.set(employeeId, best);
  });
  return out;
}

export async function queryBambooHrFullTimeHeadcountByDate(dates: string[]): Promise<Map<string, number>> {
  const snapshots = await queryBambooHrFullTimeRosterByDate(dates);
  const out = new Map<string, number>();
  for (const [dateText, snapshot] of snapshots.entries()) {
    out.set(dateText, snapshot.count);
  }
  return out;
}

export async function queryBambooHrFullTimeRosterByDate(dates: string[]): Promise<Map<string, BambooHeadcountSnapshot>> {
  const uniqueDates = Array.from(
    new Set(
      (dates || [])
        .map((value) => clean(value))
        .filter((value) => !!parseIsoDateOnly(value)),
    ),
  ).sort();
  const out = new Map<string, BambooHeadcountSnapshot>();
  if (!uniqueDates.length) return out;

  const employees = await fetchEmployeeRoster();
  if (!employees.length) return out;
  const snapshots = uniqueDates
    .map((value) => parseIsoDateOnly(value))
    .filter((value): value is Date => !!value)
    .sort((a, b) => a.getTime() - b.getTime());
  if (!snapshots.length) return out;
  const minSnapshot = snapshots[0];
  const maxSnapshot = snapshots[snapshots.length - 1];
  const candidateEmployees = employees.filter((employee) => {
    const hire = parseIsoDateOnly(employee.hireDate);
    const term = parseIsoDateOnly(employee.terminationDate);
    if (hire && hire.getTime() > maxSnapshot.getTime()) return false;
    if (term && term.getTime() <= minSnapshot.getTime()) return false;
    return true;
  });
  const employmentStatusByEmployee = await fetchEmploymentStatusTimelineByEmployee(
    candidateEmployees.map((employee) => employee.id),
  );

  for (const dateText of uniqueDates) {
    const snapshot = parseIsoDateOnly(dateText);
    if (!snapshot) continue;
    const fullTimeEmployees = candidateEmployees.filter((employee) => {
      if (!isActiveOnDate(employee, snapshot)) return false;
      const timeline = employmentStatusByEmployee.get(clean(employee.id)) || [];
      const asOfStatus = pickEmploymentStatusAsOf(timeline, snapshot) || employee.employmentStatus;
      if (!isIncludedEmploymentStatus(asOfStatus)) return false;
      return true;
    });
    const employeeNames = fullTimeEmployees
      .map((employee) => employeeDisplayName(employee))
      .sort((a, b) => a.localeCompare(b));
    out.set(toIsoDateOnly(snapshot), {
      count: fullTimeEmployees.length,
      employeeNames,
    });
  }
  return out;
}

function isBasedInQuebec(employee: BambooEmployeeRecord) {
  const location = normalizeLoose(employee.location);
  const raw = normalizeLoose(employee.rawText);
  if (location.includes("quebec") || location.includes("québec") || location.includes("montreal")) return true;
  if (raw.includes("quebec") || raw.includes("québec") || raw.includes("montreal")) return true;
  if (/(^|[^a-z])qc([^a-z]|$)/.test(location)) return true;
  return false;
}

export async function queryBambooHrNewHiresByDateRange(startDate: string, endDate: string): Promise<BambooNewHireRow[]> {
  const start = parseIsoDateOnly(startDate);
  const end = parseIsoDateOnly(endDate);
  if (!start || !end) throw new Error("Invalid startDate/endDate");
  if (end.getTime() < start.getTime()) throw new Error("endDate must be >= startDate");

  const employees = await fetchEmployeeRoster();
  const hires: BambooNewHireRow[] = [];
  for (const employee of employees) {
    const hireDate = parseIsoDateOnly(employee.hireDate);
    if (!hireDate) continue;
    if (hireDate.getTime() < start.getTime() || hireDate.getTime() > end.getTime()) continue;
    hires.push({
      department: clean(employee.department),
      jobTitle: clean(employee.jobTitle),
      type: "",
      qc: isBasedInQuebec(employee),
      greySkyBaseline: "",
      categorization: "",
      name: employeeDisplayName(employee),
      startDate: toIsoDateOnly(hireDate),
      salary: clean(employee.salary),
    });
  }

  hires.sort((a, b) => {
    if (a.startDate !== b.startDate) return a.startDate.localeCompare(b.startDate);
    return a.name.localeCompare(b.name);
  });
  return hires;
}
