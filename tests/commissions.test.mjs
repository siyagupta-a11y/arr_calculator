import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateCommissionClawbacks,
  calculateNetCommissionPlanPayment,
  commissionMonthKey,
  isCommissionPlanLineDescription,
  shouldIncludeCommissionDeal,
} from "../src/lib/commissionRules.ts";

function deal(overrides = {}) {
  return {
    dealId: "deal-old",
    ownerId: "owner-1",
    workspaceId: "workspace-1",
    closeDate: "2026-01-01T00:00:00.000Z",
    effectiveStartDate: "2026-01-01T00:00:00.000Z",
    termMonths: 12,
    dealAmount: 1200,
    grossCommission: 96,
    ...overrides,
  };
}

test("monthly churn claws back the unpaid commission once", () => {
  const [result] = calculateCommissionClawbacks(
    [deal()],
    [{ paymentId: "inv-1", workspaceId: "workspace-1", paidDate: "2026-01-02T00:00:00.000Z", amount: 100 }],
    [{ eventId: "churn-1", workspaceId: "workspace-1", occurredAt: "2026-02-15T00:00:00.000Z", type: "churn" }],
  );

  assert.equal(result.paidBeforeRisk, 100);
  assert.equal(result.clawback, 88);
  assert.equal(commissionMonthKey(result.riskEventDate), "2026-02");
});

test("risk after three full monthly payments does not claw back", () => {
  const [result] = calculateCommissionClawbacks(
    [deal()],
    [
      { paymentId: "inv-1", workspaceId: "workspace-1", paidDate: "2026-01-02T00:00:00.000Z", amount: 100 },
      { paymentId: "inv-2", workspaceId: "workspace-1", paidDate: "2026-02-02T00:00:00.000Z", amount: 100 },
      { paymentId: "inv-3", workspaceId: "workspace-1", paidDate: "2026-03-02T00:00:00.000Z", amount: 100 },
    ],
    [{ eventId: "churn-1", workspaceId: "workspace-1", occurredAt: "2026-03-20T00:00:00.000Z", type: "churn" }],
  );

  assert.equal(result.protectedAmount, 300);
  assert.equal(result.fullyProtectedAt, "2026-03-02T00:00:00.000Z");
  assert.equal(result.clawback, 0);
  assert.equal(result.riskEventId, "");
});

test("replacement deal receives new payments while the downgrade claws back only the prior deal", () => {
  const results = calculateCommissionClawbacks(
    [
      deal(),
      deal({
        dealId: "deal-new",
        closeDate: "2026-02-10T00:00:00.000Z",
        effectiveStartDate: "2026-02-15T00:00:00.000Z",
        dealAmount: 600,
        grossCommission: 48,
      }),
    ],
    [
      { paymentId: "team-month", workspaceId: "workspace-1", paidDate: "2026-01-02T00:00:00.000Z", amount: 100 },
      { paymentId: "plus-month", workspaceId: "workspace-1", paidDate: "2026-02-15T00:00:00.000Z", amount: 50 },
    ],
    [
      { eventId: "end-same-time", workspaceId: "workspace-1", occurredAt: "2026-02-15T00:00:00.000Z", type: "churn" },
      { eventId: "downgrade-same-time", workspaceId: "workspace-1", occurredAt: "2026-02-15T00:00:00.000Z", type: "downgrade" },
    ],
  );
  const oldDeal = results.find((result) => result.dealId === "deal-old");
  const newDeal = results.find((result) => result.dealId === "deal-new");

  assert.equal(oldDeal?.riskType, "downgrade");
  assert.equal(oldDeal?.paidBeforeRisk, 100);
  assert.equal(oldDeal?.clawback, 88);
  assert.equal(newDeal?.allocatedPaidAmount, 50);
  assert.equal(newDeal?.clawback, 0);
});

test("a late churn remains monitored until the first-three-month payment threshold is met", () => {
  const [result] = calculateCommissionClawbacks(
    [deal()],
    [{ paymentId: "inv-1", workspaceId: "workspace-1", paidDate: "2026-01-02T00:00:00.000Z", amount: 100 }],
    [{ eventId: "late-churn", workspaceId: "workspace-1", occurredAt: "2026-05-01T00:00:00.000Z", type: "churn" }],
  );

  assert.equal(result.riskEventId, "late-churn");
  assert.equal(result.clawback, 88);
});

test("commission payments exclude add-ons and AI tokens and use the refund-adjusted plan share", () => {
  assert.equal(isCommissionPlanLineDescription("Team Plan"), true);
  assert.equal(isCommissionPlanLineDescription("AI Tokens"), false);
  assert.equal(isCommissionPlanLineDescription("Extra seats Add-On"), false);
  assert.equal(isCommissionPlanLineDescription("Refund"), false);

  assert.equal(
    calculateNetCommissionPlanPayment({
      invoiceAmountPaid: 150,
      amountRefunded: 30,
      planLineAmount: 100,
      totalPositiveLineAmount: 150,
    }),
    80,
  );
  assert.equal(
    calculateNetCommissionPlanPayment({
      invoiceAmountPaid: 100,
      amountRefunded: 150,
      planLineAmount: 100,
      totalPositiveLineAmount: 100,
    }),
    0,
  );
});

test("Existing Business is limited to the approved New Business reps", () => {
  const approvedOwners = ["Tyler", "Luca", "Evan", "Felipe", "Antonin", "Sarah"];

  assert.equal(
    shouldIncludeCommissionDeal({
      dealType: "newbusiness",
      ownerIdentities: ["Someone Else"],
      existingBusinessOwnerNames: approvedOwners,
    }),
    true,
  );
  assert.equal(
    shouldIncludeCommissionDeal({
      dealType: "existing_business",
      ownerIdentities: ["Sarah", "Sarah Example"],
      existingBusinessOwnerNames: approvedOwners,
    }),
    true,
  );
  assert.equal(
    shouldIncludeCommissionDeal({
      dealType: "existingbusiness",
      ownerIdentities: ["Someone Else"],
      existingBusinessOwnerNames: approvedOwners,
    }),
    false,
  );
});

test("a clawback never exceeds the commission originally paid", () => {
  const [result] = calculateCommissionClawbacks(
    [deal({ dealAmount: 1200, grossCommission: 96 })],
    [],
    [{ eventId: "churn-1", workspaceId: "workspace-1", occurredAt: "2026-02-01T00:00:00.000Z", type: "churn" }],
  );

  assert.equal(result.clawback, 96);
});
