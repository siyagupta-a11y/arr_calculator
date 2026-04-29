import {
  fetchDealsInStage,
  fetchDealStageIdToLabelMap,
  fetchLineItemIdsForDeals,
  batchReadCompanies,
  batchReadLineItems,
} from "@/lib/hubspot";
import { getMonthlyAverageFxRateForCloseMonth } from "@/lib/fx";
import {
  LI_PROPS,
  FX_TARGET_CURRENCY,
  parseDate,
  firstOfMonth,
  computeWindowForLineItem,
  computeCalculatedArrForLineItem,
  isOneTimeLineItem,
  buildMonthlyPeriods,
  aggregatePeriodsFromMonthly,
  round2,
} from "@/lib/logic";
import type {
  ReportRequest,
  ReportResponse,
  ReportRow,
  HubspotCompany,
  HubspotLineItem,
  HubspotPlan,
} from "@/lib/types";

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

type DealMeta = {
  dealId: string;
  dealName: string;
  deploymentType: string;
  accountId: string;
  accountName: string;
  workspaceId: string;
  deliveryStage: string;
  territory: string;
  country: string;
  companyCountry: string;
  industry: string;
  companySegment: string;
  primaryProjectType: string;
  customerSupportApplication: string;
  closeDate: Date | null;
  closeMonth: Date | null;
  closeDateInRange: boolean;
  dealCurrency: string;
  dealType: string;
};

function firstNonEmptyProp(properties: Record<string, unknown>, candidates: string[]) {
  for (const key of candidates) {
    const value = String(properties[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function candidatePropertyNames(primary: string, extras: string[] = []) {
  const cleanPrimary = String(primary || "").trim();
  const withSuffix = cleanPrimary && !cleanPrimary.endsWith("__c") ? `${cleanPrimary}__c` : "";
  return Array.from(new Set([cleanPrimary, withSuffix, ...extras].map((value) => String(value || "").trim()).filter(Boolean)));
}

function parsePrimaryCompanyId(raw: string) {
  return (
    raw
      .split(/[,\s;|]+/)
      .map((part) => part.trim())
      .find((part) => /^\d+$/.test(part)) || ""
  );
}

function inferDealPlan(liIds: string[], lineItemsById: Map<string, HubspotLineItem>): HubspotPlan {
  let hasEnterprise = false;
  let hasManaged = false;
  let hasTeam = false;

  for (const liId of liIds) {
    const p = (lineItemsById.get(liId)?.properties || {}) as Record<string, unknown>;
    const searchable = [p.name, p.hs_product_name, p.description, p.hs_sku]
      .map((v) => String(v || "").trim().toLowerCase())
      .filter((v) => !!v)
      .join(" ");
    if (!searchable) continue;

    if (/\b(midmarket|smb|enterprise)\b/.test(searchable)) hasEnterprise = true;
    if (searchable.includes("managed")) hasManaged = true;
    if (searchable.includes("team")) hasTeam = true;
  }

  if (hasEnterprise) return "enterprise";
  if (hasManaged) return "managed";
  if (hasTeam) return "team";
  return "other";
}

function isDeskEarlyAccessLineItem(properties: Record<string, unknown>) {
  const searchable = [properties.name, properties.hs_product_name, properties.description, properties.hs_sku]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
  if (!searchable) return false;
  return searchable.includes("desk - early access") || searchable.includes("desk early access");
}

function dealHasDeskEarlyAccessLineItem(liIds: string[], lineItemsById: Map<string, HubspotLineItem>) {
  for (const liId of liIds) {
    const properties = (lineItemsById.get(liId)?.properties || {}) as Record<string, unknown>;
    if (isDeskEarlyAccessLineItem(properties)) return true;
  }
  return false;
}

function isCompanyScopesError(err: unknown) {
  if (!(err instanceof Error)) return false;
  const msg = err.message || "";
  return (
    msg.includes("HubSpot API error 403") &&
    (msg.includes("\"category\":\"MISSING_SCOPES\"") ||
      msg.includes("requiredGranularScopes") ||
      msg.includes("crm.objects.companies"))
  );
}

function isUnknownPropertyError(err: unknown) {
  if (!(err instanceof Error)) return false;
  const msg = String(err.message || "").toLowerCase();
  return (
    msg.includes("property") &&
    (msg.includes("does not exist") ||
      msg.includes("no property found") ||
      msg.includes("not a valid property"))
  );
}

function mapStageIdToLabel(value: string, stageIdToLabel: Map<string, string>) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return stageIdToLabel.get(raw) || raw;
}

function formatDayKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function buildDailyPeriods(start: Date, end: Date) {
  const periods: Array<{ key: string; label: string; day: Date }> = [];
  for (
    let day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    day <= end;
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  ) {
    const d = new Date(day);
    const key = formatDayKey(d);
    periods.push({ key, label: key, day: d });
  }
  return periods;
}

function findEarliestNonOneTimeLineItemStart(
  liIds: string[],
  lineItemsById: Map<string, HubspotLineItem>,
) {
  let bestStart: Date | null = null;
  let bestLiIds = new Set<string>();

  for (const liId of liIds) {
    const li = lineItemsById.get(liId);
    const p = li?.properties || {};

    if (isOneTimeLineItem(p)) continue;

    const arr = computeCalculatedArrForLineItem(p);
    if (!arr || arr <= 0) continue;

    const w = computeWindowForLineItem(p);
    const start = w?.start ? new Date(w.start) : null;
    if (!start || isNaN(start.getTime())) continue;

    if (!bestStart || start < bestStart) {
      bestStart = start;
      bestLiIds = new Set([liId]);
      continue;
    }

    if (bestStart && start.getTime() === bestStart.getTime()) {
      bestLiIds.add(liId);
    }
  }

  if (!bestStart) return null;
  return { start: bestStart, liIds: Array.from(bestLiIds) };
}

export async function generateReport(
  body: ReportRequest & { startMonth?: string; endMonth?: string },
): Promise<ReportResponse> {
  const includedStage = mustEnv("INCLUDED_DEALSTAGE");

  const rawStart = body.startDate || body.startMonth;
  const rawEnd = body.endDate || body.endMonth;
  const startVal = parseDate(rawStart);
  const endVal = parseDate(rawEnd);
  if (!startVal || !endVal || isNaN(startVal.getTime()) || isNaN(endVal.getTime())) {
    throw new Error("Invalid startDate/endDate");
  }

  const rangeStart = new Date(startVal.getFullYear(), startVal.getMonth(), startVal.getDate(), 0, 0, 0, 0);
  const rangeEnd = new Date(endVal.getFullYear(), endVal.getMonth(), endVal.getDate(), 23, 59, 59, 999);
  if (rangeEnd < rangeStart) {
    throw new Error("endDate must be >= startDate");
  }

  const monthlyPeriods = buildMonthlyPeriods(firstOfMonth(rangeStart), firstOfMonth(rangeEnd));
  const dailyPeriods = buildDailyPeriods(rangeStart, rangeEnd);
  const aggregated = aggregatePeriodsFromMonthly(monthlyPeriods, body.grain);
  const outputPeriods =
    body.grain === "daily"
      ? dailyPeriods.map((p) => ({ key: p.key, label: p.label }))
      : aggregated.map((p) => ({ key: p.key, label: p.label }));

  const DEPLOYMENT_TYPE_PROP = "deployment_type__c";
  const ACCOUNT_ID_PROP = "hs_primary_associated_company";
  const DEAL_WORKSPACE_ID_PROP = String(process.env.DEAL_WORKSPACE_ID_PROP || "workspace_id").trim();
  const DEAL_DELIVERY_STAGE_PROP = String(process.env.DEAL_DELIVERY_STAGE_PROP || "delivery_stage").trim();
  const TERRITORY_PROP = process.env.DEAL_TERRITORY_PROP || "territory";
  const COUNTRY_PROP = process.env.DEAL_COUNTRY_PROP || "country";
  const INDUSTRY_PROP = process.env.DEAL_INDUSTRY_PROP || "industry";
  const DEAL_COMPANY_SEGMENT_PROP = process.env.DEAL_COMPANY_SEGMENT_PROP || "company_segment";
  const DEAL_PRIMARY_PROJECT_TYPE_PROP = process.env.DEAL_PRIMARY_PROJECT_TYPE_PROP || "primary_project_type";
  const DEAL_CUSTOMER_SUPPORT_APPLICATION_PROP =
    process.env.DEAL_CUSTOMER_SUPPORT_APPLICATION_PROP || "customer_support_application";
  const COMPANY_COUNTRY_PROP = process.env.COMPANY_COUNTRY_PROP || "country";
  const COMPANY_NAME_PROP = process.env.COMPANY_NAME_PROP || "name";
  const COMPANY_INDUSTRY_PROP = process.env.COMPANY_INDUSTRY_PROP || INDUSTRY_PROP;
  const COMPANY_SEGMENT_PROP = process.env.COMPANY_SEGMENT_PROP || DEAL_COMPANY_SEGMENT_PROP;
  const COMPANY_PRIMARY_PROJECT_TYPE_PROP = process.env.COMPANY_PRIMARY_PROJECT_TYPE_PROP || DEAL_PRIMARY_PROJECT_TYPE_PROP;
  const COMPANY_CUSTOMER_SUPPORT_APPLICATION_PROP =
    process.env.COMPANY_CUSTOMER_SUPPORT_APPLICATION_PROP || DEAL_CUSTOMER_SUPPORT_APPLICATION_PROP;
  const dealCountryProps = Array.from(new Set([COUNTRY_PROP, "country", "hs_country_region", "hs_country_region_code"]));
  const dealCompanySegmentProps = candidatePropertyNames(DEAL_COMPANY_SEGMENT_PROP, [
    "company_segment",
    "segment",
  ]);
  const dealPrimaryProjectTypeProps = candidatePropertyNames(DEAL_PRIMARY_PROJECT_TYPE_PROP, [
    "primary_project_type",
    "primaryprojecttype",
    "project_type",
    "hs_primary_project_type",
  ]);
  const dealCustomerSupportApplicationProps = candidatePropertyNames(DEAL_CUSTOMER_SUPPORT_APPLICATION_PROP, [
    "customer_support_application",
    "customersupportapplication",
    "support_application",
    "support_app",
  ]);
  const companyCountryProps = Array.from(
    new Set([COMPANY_COUNTRY_PROP, "country", "hs_country_region", "hs_country_region_code"]),
  );
  const companyNameProps = Array.from(new Set([COMPANY_NAME_PROP, "name", "hs_name"]));
  const companyIndustryProps = candidatePropertyNames(COMPANY_INDUSTRY_PROP, [
    INDUSTRY_PROP,
    "industry",
  ]);
  const companySegmentProps = candidatePropertyNames(COMPANY_SEGMENT_PROP, [
    DEAL_COMPANY_SEGMENT_PROP,
    "company_segment",
    "segment",
  ]);
  const companyPrimaryProjectTypeProps = candidatePropertyNames(COMPANY_PRIMARY_PROJECT_TYPE_PROP, [
    DEAL_PRIMARY_PROJECT_TYPE_PROP,
    "primary_project_type",
    "primaryprojecttype",
    "project_type",
    "hs_primary_project_type",
  ]);
  const companyCustomerSupportApplicationProps = candidatePropertyNames(COMPANY_CUSTOMER_SUPPORT_APPLICATION_PROP, [
    DEAL_CUSTOMER_SUPPORT_APPLICATION_PROP,
    "customer_support_application",
    "customersupportapplication",
    "support_application",
    "support_app",
  ]);

  const baseDealProps = [
    "dealname",
    "dealtype",
    "deal_currency_code",
    "closedate",
    DEPLOYMENT_TYPE_PROP,
    ACCOUNT_ID_PROP,
    TERRITORY_PROP,
    COUNTRY_PROP,
    INDUSTRY_PROP,
    ...dealCompanySegmentProps,
    ...dealPrimaryProjectTypeProps,
    ...dealCustomerSupportApplicationProps,
    "dealstage",
  ];
  const optionalDealProps = Array.from(new Set([DEAL_WORKSPACE_ID_PROP, DEAL_DELIVERY_STAGE_PROP])).filter(Boolean);
  const dealProps = Array.from(new Set([...baseDealProps, ...optionalDealProps]));

  let deals = [] as Awaited<ReturnType<typeof fetchDealsInStage>>;
  try {
    deals = await fetchDealsInStage(dealProps, includedStage);
  } catch (err) {
    if (optionalDealProps.length > 0 && isUnknownPropertyError(err)) {
      console.warn(
        `Retrying HubSpot deal fetch without optional properties (${optionalDealProps.join(",")}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      deals = await fetchDealsInStage(baseDealProps, includedStage);
    } else {
      throw err;
    }
  }

  const dealWorkspaceProps = Array.from(new Set([DEAL_WORKSPACE_ID_PROP, "workspace_id"])).filter(Boolean);
  const deliveryStageProps = Array.from(new Set([DEAL_DELIVERY_STAGE_PROP, "delivery_stage", "dealstage"])).filter(Boolean);

  if (!deals.length) {
    return { periods: outputPeriods, totalsByPeriod: [], rows: [] };
  }

  const allDealMeta: DealMeta[] = deals.map((d) => {
    const pDeal = d.properties || {};
    const closeDate = parseDate(pDeal.closedate);
    const closeMonth = closeDate ? firstOfMonth(closeDate) : null;
    const closeDateInRange =
      !!closeDate &&
      closeDate.getTime() >= rangeStart.getTime() &&
      closeDate.getTime() <= rangeEnd.getTime();

    return {
      dealId: String(d.id),
      dealName: String(pDeal.dealname || ""),
      deploymentType: String(pDeal[DEPLOYMENT_TYPE_PROP] || ""),
      accountId: String(pDeal[ACCOUNT_ID_PROP] || ""),
      accountName: "",
      workspaceId: firstNonEmptyProp(pDeal, dealWorkspaceProps),
      deliveryStage: firstNonEmptyProp(pDeal, deliveryStageProps),
      territory: String(pDeal[TERRITORY_PROP] || ""),
      country: firstNonEmptyProp(pDeal, dealCountryProps),
      companyCountry: "",
      industry: String(pDeal[INDUSTRY_PROP] || ""),
      companySegment: firstNonEmptyProp(pDeal, dealCompanySegmentProps),
      primaryProjectType: firstNonEmptyProp(pDeal, dealPrimaryProjectTypeProps),
      customerSupportApplication: firstNonEmptyProp(pDeal, dealCustomerSupportApplicationProps),
      closeDate,
      closeMonth,
      closeDateInRange,
      dealCurrency: String(pDeal.deal_currency_code || FX_TARGET_CURRENCY).trim().toUpperCase(),
      dealType: String(pDeal.dealtype || "").trim(),
    };
  });

  try {
    const stageIdToLabel = await fetchDealStageIdToLabelMap();
    if (stageIdToLabel.size > 0) {
      for (const meta of allDealMeta) {
        meta.deliveryStage = mapStageIdToLabel(meta.deliveryStage, stageIdToLabel);
      }
    }
  } catch (err) {
    console.warn(
      `Failed to resolve HubSpot delivery stage labels from pipelines: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const COMPANY_WORKSPACE_ID_PROP = String(process.env.COMPANY_WORKSPACE_ID_PROP || "workspace_id").trim();
  const companyWorkspaceProps = Array.from(new Set([COMPANY_WORKSPACE_ID_PROP, "workspace_id"])).filter(Boolean);

  const companyPropsToRead = Array.from(
    new Set([
      ...companyCountryProps,
      ...companyNameProps,
      ...companyIndustryProps,
      ...companySegmentProps,
      ...companyPrimaryProjectTypeProps,
      ...companyCustomerSupportApplicationProps,
      ...companyWorkspaceProps,
    ]),
  );

  const companyIds = Array.from(
    new Set(
      allDealMeta
        .map((m) => parsePrimaryCompanyId(m.accountId))
        .filter((id) => !!id),
    ),
  );
  let companiesById: Map<string, HubspotCompany> = new Map<string, HubspotCompany>();

  if (companyIds.length) {
    try {
      companiesById = await batchReadCompanies(companyIds, companyPropsToRead);
    } catch (err) {
      if (isUnknownPropertyError(err)) {
        const fallbackProps = Array.from(
          new Set([
            ...companyCountryProps,
            ...companyNameProps,
            ...companyIndustryProps,
            ...companySegmentProps,
            ...companyPrimaryProjectTypeProps,
            ...companyCustomerSupportApplicationProps,
          ]),
        );
        console.warn(
          `Retrying HubSpot company batch read without optional workspace property (${COMPANY_WORKSPACE_ID_PROP}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        companiesById = await batchReadCompanies(companyIds, fallbackProps);
      } else if (!isCompanyScopesError(err)) {
        throw err;
      } else {
        console.warn("Skipping company-country enrichment: missing HubSpot company read scopes.");
      }
    }
  }

  for (const meta of allDealMeta) {
    const companyId = parsePrimaryCompanyId(meta.accountId);
    if (!companyId) continue;
    const company = companiesById.get(companyId);
    const companyProps = (company?.properties || {}) as Record<string, unknown>;
    const companyName = firstNonEmptyProp(companyProps, companyNameProps);
    const companyCountry = firstNonEmptyProp(companyProps, companyCountryProps);
    const companyIndustry = firstNonEmptyProp(companyProps, companyIndustryProps);
    const companySegment = firstNonEmptyProp(companyProps, companySegmentProps);
    const primaryProjectType = firstNonEmptyProp(companyProps, companyPrimaryProjectTypeProps);
    const customerSupportApplication = firstNonEmptyProp(companyProps, companyCustomerSupportApplicationProps);
    const companyWorkspaceId = firstNonEmptyProp(companyProps, companyWorkspaceProps);
    if (companyName) meta.accountName = companyName;
    if (!meta.workspaceId && companyWorkspaceId) meta.workspaceId = companyWorkspaceId;
    if (!meta.industry && companyIndustry) meta.industry = companyIndustry;
    if (!meta.companySegment && companySegment) meta.companySegment = companySegment;
    if (!meta.primaryProjectType && primaryProjectType) meta.primaryProjectType = primaryProjectType;
    if (!meta.customerSupportApplication && customerSupportApplication) {
      meta.customerSupportApplication = customerSupportApplication;
    }
    if (!companyCountry) continue;
    meta.companyCountry = companyCountry;
    if (!meta.country) meta.country = companyCountry;
  }

  const dealMeta = allDealMeta;
  if (!dealMeta.length) {
    return { periods: outputPeriods, totalsByPeriod: [], rows: [] };
  }

  const dealToLineItemIds = new Map<string, string[]>();
  const allLineItemIds = new Set<string>();

  const dealIdResults = await fetchLineItemIdsForDeals(dealMeta.map((m) => m.dealId));
  for (const { dealId, ids } of dealIdResults) {
    dealToLineItemIds.set(dealId, ids);
    ids.forEach((id) => allLineItemIds.add(id));
  }

  const lineItemsById = await batchReadLineItems(Array.from(allLineItemIds), LI_PROPS);

  const includedDealMeta = dealMeta.filter((meta) => {
    const liIds = dealToLineItemIds.get(meta.dealId) || [];
    if (!liIds.length) return false;
    return !dealHasDeskEarlyAccessLineItem(liIds, lineItemsById);
  });

  if (!includedDealMeta.length) {
    return { periods: outputPeriods, totalsByPeriod: [], rows: [] };
  }

  const fxByKey = new Map<string, Awaited<ReturnType<typeof getMonthlyAverageFxRateForCloseMonth>>>();
  const fxPromises = new Map<string, Promise<Awaited<ReturnType<typeof getMonthlyAverageFxRateForCloseMonth>>>>();

  for (const m of includedDealMeta) {
    const monthKey = m.closeDate
      ? `${m.closeDate.getFullYear()}-${String(m.closeDate.getMonth() + 1).padStart(2, "0")}`
      : "current";
    const key = `${m.dealCurrency}|${monthKey}`;
    if (!fxPromises.has(key)) {
      fxPromises.set(key, getMonthlyAverageFxRateForCloseMonth(m.dealCurrency, FX_TARGET_CURRENCY, m.closeDate));
    }
  }

  await Promise.all(
    Array.from(fxPromises.entries()).map(async ([key, p]) => {
      fxByKey.set(key, await p);
    }),
  );

  const rows: ReportRow[] = [];

  for (const m of includedDealMeta) {
    const {
      dealId,
      dealName,
      deploymentType,
      accountId,
      accountName,
      workspaceId,
      deliveryStage,
      territory,
      country,
      companyCountry,
      industry,
      companySegment,
      primaryProjectType,
      customerSupportApplication,
      closeDate,
      closeMonth,
      dealCurrency,
      dealType,
    } = m;

    const monthKey = closeDate
      ? `${closeDate.getFullYear()}-${String(closeDate.getMonth() + 1).padStart(2, "0")}`
      : "current";
    const fx = fxByKey.get(`${dealCurrency}|${monthKey}`) || { rate: 0, dateUsed: "" };

    const liIds = dealToLineItemIds.get(dealId) || [];
    if (!liIds.length) continue;
    const plan = inferDealPlan(liIds, lineItemsById);

    const t = dealType.toLowerCase();
    const isExistingBusiness = t === "existingbusiness" || t === "upsell";

    const earliest =
      body.mode === "contracted" ? findEarliestNonOneTimeLineItemStart(liIds, lineItemsById) : null;

    const earliestLiIdSet = new Set(earliest?.liIds || []);
    const earliestStart = earliest?.start || null;

    const allowCarry =
      body.mode === "contracted" &&
      !isExistingBusiness &&
      closeDate &&
      closeMonth &&
      earliestStart &&
      closeDate < earliestStart;

    for (const liId of liIds) {
      const li = lineItemsById.get(liId);
      const p = li?.properties || {};
      const w = computeWindowForLineItem(p);

      const liArr = computeCalculatedArrForLineItem(p);
      const liArrFx = fx.rate && liArr ? round2(liArr * fx.rate) : 0;
      const isEarliestRecurring = earliestLiIdSet.has(liId);
      const earliestStartDay = earliestStart
        ? new Date(earliestStart.getFullYear(), earliestStart.getMonth(), earliestStart.getDate())
        : null;
      const closeDay = closeDate
        ? new Date(closeDate.getFullYear(), closeDate.getMonth(), closeDate.getDate())
        : null;

      const valuesMonthly: Record<string, number> = {};
      for (const mp of monthlyPeriods) {
        if (!w || !liArrFx) {
          valuesMonthly[mp.key] = 0;
          continue;
        }

        const monthEndPoint = new Date(mp.end.getFullYear(), mp.end.getMonth(), mp.end.getDate());
        const coversMonthEnd = w.start <= monthEndPoint && w.end >= monthEndPoint;

        if (body.mode === "arr") {
          valuesMonthly[mp.key] = coversMonthEnd ? liArrFx : 0;
          continue;
        }

        if (isExistingBusiness) {
          valuesMonthly[mp.key] = coversMonthEnd ? liArrFx : 0;
          continue;
        }

        if (!isEarliestRecurring) {
          valuesMonthly[mp.key] = coversMonthEnd ? liArrFx : 0;
          continue;
        }

        const inCarryRange =
          !!allowCarry &&
          !!closeDay &&
          !!earliestStartDay &&
          monthEndPoint.getTime() >= closeDay.getTime() &&
          monthEndPoint.getTime() <= earliestStartDay.getTime();

        valuesMonthly[mp.key] = inCarryRange || coversMonthEnd ? liArrFx : 0;
      }

      const valuesByPeriod: Record<string, number> = {};
      if (body.grain === "monthly") {
        for (const mp of monthlyPeriods) valuesByPeriod[mp.key] = valuesMonthly[mp.key] || 0;
      } else if (body.grain === "quarterly" || body.grain === "annually") {
        for (const ap of aggregated as Array<{ key: string; members?: string[] }>) {
          const members: string[] = ap.members || [];
          const sum = members.reduce((acc, k) => acc + (valuesMonthly[k] || 0), 0);
          valuesByPeriod[ap.key] = round2(sum);
        }
      } else {
        const closeDayKey = closeDate ? formatDayKey(closeDate) : null;

        for (const dp of dailyPeriods) {
          const dayPoint = dp.day;
          const coversDay = !!w && !!liArrFx && w.start <= dayPoint && w.end >= dayPoint;

          if (body.mode === "arr") {
            valuesByPeriod[dp.key] = coversDay ? liArrFx : 0;
            continue;
          }

          if (isExistingBusiness) {
            valuesByPeriod[dp.key] = coversDay ? liArrFx : 0;
            continue;
          }

          if (!isEarliestRecurring) {
            valuesByPeriod[dp.key] = coversDay ? liArrFx : 0;
            continue;
          }

          const isCloseDay = closeDayKey ? dp.key === closeDayKey : false;
          const inCarryRange =
            !!allowCarry &&
            !!closeDay &&
            !!earliestStartDay &&
            dayPoint.getTime() >= closeDay.getTime() &&
            dayPoint.getTime() <= earliestStartDay.getTime();

          valuesByPeriod[dp.key] = isCloseDay || inCarryRange || coversDay ? liArrFx : 0;
        }
      }

      rows.push({
        dealName,
        dealId,
        lineItemId: liId,

        valueUsd: liArrFx,
        dealCurrency,
        fxRate: fx.rate || null,
        fxDateUsed: fx.dateUsed || "",

        dealType,
        plan,
        closeDate: closeDate ? closeDate.toISOString().slice(0, 10) : "",

        windowStart: w?.start ? w.start.toISOString().slice(0, 10) : "",
        windowEnd: w ? (w.endIsOpenEnded ? "OPEN" : w.end.toISOString().slice(0, 10)) : "",
        isOpenEnded: w?.endIsOpenEnded ? true : false,

        recurringbillingfrequency: String(p.recurringbillingfrequency || ""),
        termMonths: p.hs_term_in_months ? Number(p.hs_term_in_months) : null,
        amount: p.amount ? Number(p.amount) : null,
        netPrice: p.net_price ? Number(p.net_price) : null,
        quantity: p.quantity ? Number(p.quantity) : 1,

        valuesByPeriod,
        deploymentType,
        accountId,
        accountName,
        workspaceId,
        deliveryStage,
        territory,
        country,
        companyCountry,
        industry,
        companySegment,
        primaryProjectType,
        customerSupportApplication,
      });
    }
  }

  const totalsByPeriod = outputPeriods.map((p) => {
    const total = round2(rows.reduce((acc, r) => acc + (r.valuesByPeriod[p.key] || 0), 0));
    return { ...p, total };
  });

  return {
    periods: outputPeriods,
    totalsByPeriod,
    rows,
  };
}

export type CurrentDealMetrics = {
  asOfDate: string;
  dealId: string;
  currentArr: number;
  currentCarr: number;
};

function sumByDealForPeriod(report: ReportResponse, periodKey: string) {
  const byDeal = new Map<string, number>();
  for (const row of report.rows) {
    const current = byDeal.get(row.dealId) || 0;
    byDeal.set(row.dealId, round2(current + (row.valuesByPeriod[periodKey] || 0)));
  }
  return byDeal;
}

export async function generateCurrentDealMetrics(asOfDate?: string): Promise<CurrentDealMetrics[]> {
  const includedStage = mustEnv("INCLUDED_DEALSTAGE");
  const asOf = asOfDate || new Date().toISOString().slice(0, 10);
  const deals = await fetchDealsInStage(["dealname"], includedStage);
  if (!deals.length) return [];

  const [arrReport, carrReport] = await Promise.all([
    generateReport({
      startDate: asOf,
      endDate: asOf,
      mode: "arr",
      grain: "daily",
    }),
    generateReport({
      startDate: asOf,
      endDate: asOf,
      mode: "contracted",
      grain: "daily",
      contractedIncludeAllDeals: true,
    }),
  ]);

  const arrByDeal = sumByDealForPeriod(arrReport, asOf);
  const carrByDeal = sumByDealForPeriod(carrReport, asOf);

  return deals.map((deal) => {
    const dealId = String(deal.id || "");
    return {
      asOfDate: asOf,
      dealId,
      currentArr: round2(arrByDeal.get(dealId) || 0),
      currentCarr: round2(carrByDeal.get(dealId) || 0),
    };
  });
}
