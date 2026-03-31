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
  fullTimeEquivalent: number | null;
};

export type BambooHeadcountSnapshot = {
  count: number;
  employeeNames: string[];
};

function clean(value: string | undefined | null) {
  return String(value || "").trim();
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
    fullTimeEquivalent,
  };
}

function extractRows(payload: unknown): unknown[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;
  if (Array.isArray(obj.employees)) return obj.employees as unknown[];
  if (Array.isArray(obj.results)) return obj.results as unknown[];
  if (Array.isArray(obj.data)) return obj.data as unknown[];
  if (obj.employees && typeof obj.employees === "object") {
    const nested = obj.employees as Record<string, unknown>;
    if (Array.isArray(nested.employee)) return nested.employee as unknown[];
  }
  return [];
}

function normalizeBaseUrl(value: string) {
  return clean(value).replace(/\/+$/, "");
}

function isActiveOnDate(employee: BambooEmployeeRecord, snapshotDate: Date) {
  const hire = parseIsoDateOnly(employee.hireDate);
  const term = parseIsoDateOnly(employee.terminationDate);
  if (hire && hire.getTime() > snapshotDate.getTime()) return false;
  if (term && term.getTime() < snapshotDate.getTime()) return false;
  return true;
}

function isFullTimeEmployee(employee: BambooEmployeeRecord) {
  const statusText = `${employee.employmentStatus} ${employee.employmentType} ${employee.payType} ${employee.jobTitle} ${employee.department} ${employee.division} ${employee.location} ${employee.rawText}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (/\bintern(ship)?\b/.test(statusText)) return false;
  if (/\btemporary\b|\btemp\b/.test(statusText)) return false;
  if (/\bcontract(or)?\b|\bcontingent\b/.test(statusText)) return true;
  if (/part[- ]?time|pt\b/.test(statusText)) return false;

  const isFullTime = /\bfull[- ]?time\b|\bfulltime\b|\bft\b/.test(statusText);
  if (isFullTime) return true;

  if (employee.fullTimeEquivalent != null && employee.fullTimeEquivalent >= 0.99) return true;
  return false;
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
  const subdomain = clean(process.env.BAMBOOHR_SUBDOMAIN);
  const apiKey = clean(process.env.BAMBOOHR_API_KEY);
  if (!subdomain || !apiKey) {
    throw new Error("BambooHR is not configured. Set BAMBOOHR_SUBDOMAIN and BAMBOOHR_API_KEY.");
  }

  const baseUrl = normalizeBaseUrl(clean(process.env.BAMBOOHR_BASE_URL || "https://api.bamboohr.com"));
  const authHeader = basicAuthHeader(apiKey);
  const reportUrlBase = `${baseUrl}/api/gateway.php/${encodeURIComponent(subdomain)}/v1/reports/custom?format=JSON`;
  const reportBodies: Array<Record<string, unknown>> = [
    {
      fields: [
        "id",
        "employmentStatus",
        "employmentType",
        "hireDate",
        "terminationDate",
        "fullTimeEquivalent",
        "payType",
      ],
    },
    {
      fields: [
        "id",
        "status",
        "type",
        "dateOfHire",
        "dateOfTermination",
        "FTE",
        "payType",
      ],
    },
  ];

  const fetchDirectoryRows = async () => {
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
        const rows = extractRows(payload).map(normalizeEmployeeRow).filter((row): row is BambooEmployeeRecord => !!row);
        if (rows.length) {
          // Custom reports contain the employment fields we need for classification.
          // Enrich names/details from directory rows when available.
          try {
            const directoryRows = await fetchDirectoryRows();
            if (!directoryRows.length) return rows;
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
                rawText: `${row.rawText} ${extra.rawText}`.trim(),
              };
            });
          } catch {
            return rows;
          }
        }
      } catch {
        // Try next variant.
      }
    }
  }

  // Fallback to directory endpoint if custom report is unavailable.
  return fetchDirectoryRows();
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
  for (const dateText of uniqueDates) {
    const snapshot = parseIsoDateOnly(dateText);
    if (!snapshot) continue;
    const fullTimeEmployees = employees.filter((employee) => {
      if (!isActiveOnDate(employee, snapshot)) return false;
      if (!isFullTimeEmployee(employee)) return false;
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
