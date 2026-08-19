export type CommissionRiskType = "churn" | "downgrade";

export type CommissionDealRuleInput = {
  dealId: string;
  ownerId: string;
  workspaceId: string;
  closeDate: string;
  effectiveStartDate: string;
  termMonths: number;
  dealAmount: number;
  grossCommission: number;
};

export type CommissionPaymentRuleInput = {
  paymentId: string;
  workspaceId: string;
  paidDate: string;
  amount: number;
};

export type CommissionRiskRuleInput = {
  eventId: string;
  workspaceId: string;
  occurredAt: string;
  type: CommissionRiskType;
};

export type CommissionDealRuleResult = {
  dealId: string;
  allocatedPaidAmount: number;
  protectedAmount: number;
  protectedUntil: string;
  fullyProtectedAt: string;
  riskEventId: string;
  riskEventDate: string;
  riskType: CommissionRiskType | "";
  paidBeforeRisk: number;
  clawback: number;
};

export type CommissionPlanPaymentInput = {
  invoiceAmountPaid: number;
  amountRefunded: number;
  planLineAmount: number;
  totalPositiveLineAmount: number;
};

function round2(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function dateMs(value: string) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function addMonthsIso(value: string, months: number) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const day = parsed.getUTCDate();
  const result = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + months, 1));
  const monthEndDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, monthEndDay));
  return result.toISOString();
}

function monthKey(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}`;
}

function normalizedWorkspace(value: string) {
  return String(value || "").trim().toLowerCase();
}

function normalizedWords(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

export function isCommissionPlanLineDescription(value: string) {
  const normalized = normalizedWords(value);
  if (!normalized || normalized === "refund" || normalized === "discount") return false;
  if (/\badd\s*ons?\b/.test(normalized)) return false;
  if (/\bai\s+tokens?\b/.test(normalized)) return false;
  if (normalized.includes("web search and crawl")) return false;
  return true;
}

export function calculateNetCommissionPlanPayment(input: CommissionPlanPaymentInput) {
  const invoiceAmountPaid = Math.max(0, Number(input.invoiceAmountPaid || 0));
  const amountRefunded = Math.max(0, Number(input.amountRefunded || 0));
  const planLineAmount = Math.max(0, Number(input.planLineAmount || 0));
  const totalPositiveLineAmount = Math.max(0, Number(input.totalPositiveLineAmount || 0));
  if (!invoiceAmountPaid || !planLineAmount || !totalPositiveLineAmount) return 0;

  const netInvoicePayment = Math.max(0, invoiceAmountPaid - amountRefunded);
  const planShare = Math.min(1, planLineAmount / totalPositiveLineAmount);
  return round2(netInvoicePayment * planShare);
}

export function shouldIncludeCommissionDeal(input: {
  dealType: string;
  ownerIdentities: string[];
  existingBusinessOwnerNames: string[];
}) {
  const dealType = normalizedWords(input.dealType).replace(/\s+/g, "");
  if (dealType === "newbusiness") return true;
  if (dealType !== "existingbusiness") return false;

  const allowedOwners = new Set(input.existingBusinessOwnerNames.map(normalizedWords).filter(Boolean));
  return input.ownerIdentities.some((identity) => allowedOwners.has(normalizedWords(identity)));
}

function sortedWorkspaceDeals(deals: CommissionDealRuleInput[]) {
  const byWorkspace = new Map<string, CommissionDealRuleInput[]>();
  for (const deal of deals) {
    const workspaceId = normalizedWorkspace(deal.workspaceId);
    if (!workspaceId) continue;
    if (!byWorkspace.has(workspaceId)) byWorkspace.set(workspaceId, []);
    byWorkspace.get(workspaceId)!.push(deal);
  }
  for (const values of byWorkspace.values()) {
    values.sort((a, b) => {
      const effectiveDiff = dateMs(a.effectiveStartDate) - dateMs(b.effectiveStartDate);
      if (effectiveDiff) return effectiveDiff;
      const closeDiff = dateMs(a.closeDate) - dateMs(b.closeDate);
      if (closeDiff) return closeDiff;
      return a.dealId.localeCompare(b.dealId);
    });
  }
  return byWorkspace;
}

function choosePaymentDeal(deals: CommissionDealRuleInput[], paidAtMs: number) {
  let chosen: CommissionDealRuleInput | null = null;
  for (const deal of deals) {
    const closeAtMs = dateMs(deal.closeDate);
    if (!Number.isFinite(closeAtMs) || closeAtMs > paidAtMs) continue;
    if (!chosen || closeAtMs >= dateMs(chosen.closeDate)) chosen = deal;
  }
  return chosen;
}

function chooseRiskDeal(deals: CommissionDealRuleInput[], eventAtMs: number) {
  let chosen: CommissionDealRuleInput | null = null;
  for (const deal of deals) {
    const effectiveAtMs = dateMs(deal.effectiveStartDate);
    const closeAtMs = dateMs(deal.closeDate);
    if (!Number.isFinite(effectiveAtMs) || !Number.isFinite(closeAtMs)) continue;
    // A downgrade event at the exact instant a replacement starts belongs to the prior deal.
    if (effectiveAtMs >= eventAtMs || closeAtMs > eventAtMs) continue;
    if (!chosen || effectiveAtMs >= dateMs(chosen.effectiveStartDate)) chosen = deal;
  }
  return chosen;
}

export function calculateCommissionClawbacks(
  deals: CommissionDealRuleInput[],
  payments: CommissionPaymentRuleInput[],
  riskEvents: CommissionRiskRuleInput[],
): CommissionDealRuleResult[] {
  const byWorkspace = sortedWorkspaceDeals(deals);
  const paymentsByDeal = new Map<string, CommissionPaymentRuleInput[]>();
  const risksByDeal = new Map<string, CommissionRiskRuleInput[]>();

  for (const payment of payments) {
    const workspaceDeals = byWorkspace.get(normalizedWorkspace(payment.workspaceId)) || [];
    const paidAtMs = dateMs(payment.paidDate);
    if (!Number.isFinite(paidAtMs) || Number(payment.amount || 0) <= 0) continue;
    const deal = choosePaymentDeal(workspaceDeals, paidAtMs);
    if (!deal) continue;
    if (!paymentsByDeal.has(deal.dealId)) paymentsByDeal.set(deal.dealId, []);
    paymentsByDeal.get(deal.dealId)!.push(payment);
  }

  const uniqueRiskEvents = new Map<string, CommissionRiskRuleInput>();
  for (const event of riskEvents) {
    const workspaceId = normalizedWorkspace(event.workspaceId);
    const eventAtMs = dateMs(event.occurredAt);
    if (!workspaceId || !Number.isFinite(eventAtMs)) continue;
    const fingerprint = `${workspaceId}|${eventAtMs}`;
    const current = uniqueRiskEvents.get(fingerprint);
    if (!current || event.type === "downgrade") uniqueRiskEvents.set(fingerprint, event);
  }

  for (const event of uniqueRiskEvents.values()) {
    const workspaceDeals = byWorkspace.get(normalizedWorkspace(event.workspaceId)) || [];
    const deal = chooseRiskDeal(workspaceDeals, dateMs(event.occurredAt));
    if (!deal) continue;
    if (!risksByDeal.has(deal.dealId)) risksByDeal.set(deal.dealId, []);
    risksByDeal.get(deal.dealId)!.push(event);
  }

  return deals.map((deal) => {
    const termMonths = Math.max(1, Number(deal.termMonths || 12));
    const dealAmount = Math.max(0, Number(deal.dealAmount || 0));
    const protectedAmount = round2(Math.min(dealAmount, dealAmount * (Math.min(3, termMonths) / termMonths)));
    const protectedUntil = addMonthsIso(deal.effectiveStartDate, 3);
    const dealPayments = (paymentsByDeal.get(deal.dealId) || [])
      .slice()
      .sort((a, b) => dateMs(a.paidDate) - dateMs(b.paidDate) || a.paymentId.localeCompare(b.paymentId));

    let cumulativePaid = 0;
    let fullyProtectedAt = "";
    for (const payment of dealPayments) {
      cumulativePaid = round2(cumulativePaid + Math.max(0, Number(payment.amount || 0)));
      if (!fullyProtectedAt && protectedAmount > 0 && cumulativePaid + 0.005 >= protectedAmount) {
        fullyProtectedAt = payment.paidDate;
      }
    }

    const fullProtectionMs = fullyProtectedAt ? dateMs(fullyProtectedAt) : Number.POSITIVE_INFINITY;
    const eligibleRisk = (risksByDeal.get(deal.dealId) || [])
      .filter((event) => dateMs(event.occurredAt) < fullProtectionMs)
      .sort((a, b) => dateMs(a.occurredAt) - dateMs(b.occurredAt) || a.eventId.localeCompare(b.eventId))[0];

    let paidBeforeRisk = 0;
    if (eligibleRisk) {
      const riskAtMs = dateMs(eligibleRisk.occurredAt);
      paidBeforeRisk = dealPayments
        .filter((payment) => dateMs(payment.paidDate) <= riskAtMs)
        .reduce((sum, payment) => sum + Math.max(0, Number(payment.amount || 0)), 0);
    }
    paidBeforeRisk = round2(Math.min(dealAmount, paidBeforeRisk));

    const effectiveRate = dealAmount > 0 ? Math.max(0, Number(deal.grossCommission || 0)) / dealAmount : 0;
    const earnedCommission = round2(paidBeforeRisk * effectiveRate);
    const grossCommission = Math.max(0, Number(deal.grossCommission || 0));
    const clawback = eligibleRisk
      ? round2(Math.min(grossCommission, Math.max(0, grossCommission - earnedCommission)))
      : 0;

    return {
      dealId: deal.dealId,
      allocatedPaidAmount: round2(Math.min(dealAmount, cumulativePaid)),
      protectedAmount,
      protectedUntil,
      fullyProtectedAt,
      riskEventId: eligibleRisk?.eventId || "",
      riskEventDate: eligibleRisk?.occurredAt || "",
      riskType: eligibleRisk?.type || "",
      paidBeforeRisk,
      clawback,
    };
  });
}

export function commissionMonthKey(value: string) {
  return monthKey(value);
}
