const REGION_DISPLAY_NAMES = new Intl.DisplayNames(["en"], { type: "region" });

const ISO3_TO_ISO2: Record<string, string> = {
  USA: "US",
  GBR: "GB",
  ARE: "AE",
  KOR: "KR",
  PRK: "KP",
  CZE: "CZ",
  RUS: "RU",
  VNM: "VN",
};

const COUNTRY_LOOKUP_ALIASES: Record<string, string> = {
  us: "US",
  usa: "US",
  unitedstates: "US",
  unitedstatesofamerica: "US",
  uk: "GB",
  unitedkingdom: "GB",
  greatbritain: "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  uae: "AE",
  unitedarabemirates: "AE",
  czechrepublic: "CZ",
  southkorea: "KR",
  northkorea: "KP",
  russia: "RU",
  vietnam: "VN",
  laos: "LA",
  syria: "SY",
  tanzania: "TZ",
  venezuela: "VE",
  moldova: "MD",
  bolivia: "BO",
  palestine: "PS",
  ivorycoast: "CI",
  coteivoire: "CI",
};

const TERRITORY_ALIASES: Record<string, string> = {
  na: "North America",
  nam: "North America",
  namer: "North America",
  northamerica: "North America",
  americas: "North America",
  uscanada: "North America",
  latam: "Latin America",
  latinamerica: "Latin America",
  latinamericacaribbean: "Latin America",
  southamerica: "Latin America",
  centralamerica: "Latin America",
  apac: "Asia Pacific",
  asiapacific: "Asia Pacific",
  asia: "Asia Pacific",
  anz: "Asia Pacific",
  europe: "Europe",
  eu: "Europe",
  emea: "Europe",
  europemiddleeastafrica: "Europe",
  mea: "Middle East",
  middleeast: "Middle East",
  middleeastafrica: "Middle East",
  gcc: "Middle East",
  africa: "Africa",
  af: "Africa",
};

const TERRITORY_KEYS_SPLIT_BY_COUNTRY = new Set(["emea", "europemiddleeastafrica", "middleeastafrica", "mea"]);

const NORTH_AMERICA_CODES = new Set(["US", "CA", "GL", "PM"]);

const LATAM_CODES = new Set([
  "AG",
  "AI",
  "AR",
  "AW",
  "BB",
  "BL",
  "BO",
  "BQ",
  "BR",
  "BS",
  "BZ",
  "CL",
  "CO",
  "CR",
  "CU",
  "CW",
  "DM",
  "DO",
  "EC",
  "FK",
  "GD",
  "GF",
  "GP",
  "GT",
  "GY",
  "HN",
  "HT",
  "JM",
  "KN",
  "KY",
  "LC",
  "MF",
  "MQ",
  "MS",
  "MX",
  "NI",
  "PA",
  "PE",
  "PR",
  "PY",
  "SR",
  "SV",
  "SX",
  "TC",
  "TT",
  "UY",
  "VC",
  "VE",
  "VG",
  "VI",
]);

const APAC_CODES = new Set([
  "AF",
  "AS",
  "AU",
  "BD",
  "BN",
  "BT",
  "CC",
  "CK",
  "CN",
  "CX",
  "FJ",
  "FM",
  "GU",
  "HK",
  "ID",
  "IN",
  "JP",
  "KG",
  "KH",
  "KI",
  "KP",
  "KR",
  "KZ",
  "LA",
  "LK",
  "MH",
  "MM",
  "MN",
  "MO",
  "MP",
  "MV",
  "MY",
  "NC",
  "NF",
  "NP",
  "NR",
  "NU",
  "NZ",
  "PF",
  "PG",
  "PH",
  "PK",
  "PW",
  "SB",
  "SG",
  "TH",
  "TJ",
  "TK",
  "TL",
  "TM",
  "TO",
  "TV",
  "TW",
  "UZ",
  "VN",
  "VU",
  "WS",
]);

const MIDDLE_EAST_CODES = new Set([
  "AE",
  "BH",
  "CY",
  "EG",
  "IL",
  "IQ",
  "IR",
  "JO",
  "KW",
  "LB",
  "OM",
  "PS",
  "QA",
  "SA",
  "SY",
  "TR",
  "YE",
]);

const AFRICA_CODES = new Set([
  "AO",
  "BF",
  "BI",
  "BJ",
  "BW",
  "CD",
  "CF",
  "CG",
  "CI",
  "CM",
  "CV",
  "DJ",
  "DZ",
  "EH",
  "ER",
  "ET",
  "GA",
  "GH",
  "GM",
  "GN",
  "GQ",
  "GW",
  "KE",
  "KM",
  "LR",
  "LS",
  "LY",
  "MA",
  "MG",
  "ML",
  "MR",
  "MU",
  "MW",
  "MZ",
  "NA",
  "NE",
  "NG",
  "RE",
  "RW",
  "SC",
  "SD",
  "SH",
  "SL",
  "SN",
  "SO",
  "SS",
  "ST",
  "SZ",
  "TD",
  "TG",
  "TN",
  "TZ",
  "UG",
  "YT",
  "ZA",
  "ZM",
  "ZW",
]);

let countryCodeToLabelCache: Map<string, string> | null = null;
let countryNameKeyToCodeCache: Map<string, string> | null = null;
let countryNameKeyToCodeEntriesCache: Array<{ key: string; code: string }> | null = null;
let countryCodeToTerritoryEntriesCache: Array<{ code: string; territory: string }> | null = null;

function normalizeLookupKey(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function regionNameForCode(code: string) {
  try {
    const text = String(REGION_DISPLAY_NAMES.of(code) || "").trim();
    if (!text || text.toUpperCase() === code) return "";
    return text;
  } catch {
    return "";
  }
}

function buildCountryMaps() {
  const codeToLabel = new Map<string, string>();
  const nameKeyToCode = new Map<string, string>();

  for (let i = 65; i <= 90; i++) {
    for (let j = 65; j <= 90; j++) {
      const code = String.fromCharCode(i, j);
      const name = regionNameForCode(code);
      if (!name) continue;
      codeToLabel.set(code, name);
      const nameKey = normalizeLookupKey(name);
      if (nameKey && !nameKeyToCode.has(nameKey)) {
        nameKeyToCode.set(nameKey, code);
      }
    }
  }

  for (const [key, code] of Object.entries(COUNTRY_LOOKUP_ALIASES)) {
    nameKeyToCode.set(key, code);
  }

  return { codeToLabel, nameKeyToCode };
}

function countryMaps() {
  if (!countryCodeToLabelCache || !countryNameKeyToCodeCache) {
    const built = buildCountryMaps();
    countryCodeToLabelCache = built.codeToLabel;
    countryNameKeyToCodeCache = built.nameKeyToCode;
  }
  return {
    codeToLabel: countryCodeToLabelCache,
    nameKeyToCode: countryNameKeyToCodeCache,
  };
}

function territoryFromCountryCode(code: string) {
  const upper = String(code || "").trim().toUpperCase();
  if (!upper) return "";
  if (NORTH_AMERICA_CODES.has(upper)) return "North America";
  if (LATAM_CODES.has(upper)) return "Latin America";
  if (APAC_CODES.has(upper)) return "Asia Pacific";
  if (MIDDLE_EAST_CODES.has(upper)) return "Middle East";
  if (AFRICA_CODES.has(upper)) return "Africa";
  return "Europe";
}

export function countryCodeFromValue(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const upper = raw.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return upper;

  if (/^[A-Z]{3}$/.test(upper) && ISO3_TO_ISO2[upper]) {
    return ISO3_TO_ISO2[upper];
  }

  const key = normalizeLookupKey(raw);
  if (!key) return "";
  return countryMaps().nameKeyToCode.get(key) || "";
}

export function canonicalCountryLabel(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw === "(blank)" || raw.toUpperCase() === "N/A") return raw;
  const code = countryCodeFromValue(raw);
  if (!code) return raw;
  return countryMaps().codeToLabel.get(code) || code;
}

export function canonicalCountryKey(value: string) {
  const label = canonicalCountryLabel(value);
  if (!label) return "";
  if (label === "(blank)") return "(blank)";
  if (label.toUpperCase() === "N/A") return "n/a";
  return normalizeLookupKey(label);
}

export function territoryFromCountry(country: string) {
  const code = countryCodeFromValue(country);
  if (!code) return "";
  return territoryFromCountryCode(code);
}

export function canonicalTerritoryLabel(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.toUpperCase() === "N/A") return "N/A";
  const key = normalizeLookupKey(raw);
  return TERRITORY_ALIASES[key] || raw;
}

export function resolveTerritoryLabel(rawTerritory: string, country: string) {
  const territoryKey = normalizeLookupKey(rawTerritory);
  const inferredFromCountry = territoryFromCountry(country);
  if (TERRITORY_KEYS_SPLIT_BY_COUNTRY.has(territoryKey) && inferredFromCountry) {
    return inferredFromCountry;
  }
  const explicit = canonicalTerritoryLabel(rawTerritory);
  if (explicit) return explicit;
  if (inferredFromCountry) return inferredFromCountry;
  if (TERRITORY_KEYS_SPLIT_BY_COUNTRY.has(territoryKey)) return "Europe";
  return "";
}

export function countryNameKeyToCodeEntries() {
  if (!countryNameKeyToCodeEntriesCache) {
    countryNameKeyToCodeEntriesCache = Array.from(countryMaps().nameKeyToCode.entries())
      .map(([key, code]) => ({ key, code }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }
  return countryNameKeyToCodeEntriesCache;
}

export function countryCodeToTerritoryEntries() {
  if (!countryCodeToTerritoryEntriesCache) {
    countryCodeToTerritoryEntriesCache = Array.from(countryMaps().codeToLabel.keys())
      .map((code) => ({ code, territory: territoryFromCountryCode(code) }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }
  return countryCodeToTerritoryEntriesCache;
}
