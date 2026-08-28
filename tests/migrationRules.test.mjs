import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateMigrationMetrics,
  isExplicitV3ToV4Migration,
  migrationPlanVersion,
  migrationReportWindow,
} from "../src/lib/migrationRules.ts";

test("uses an April fiscal-year start with an April 2026 reporting floor", () => {
  assert.deepEqual(migrationReportWindow("2026-08-27"), {
    asOfDate: "2026-08-27",
    fiscalYearStart: "2026-04-01",
    currentMonthStart: "2026-08-01",
  });
  assert.deepEqual(migrationReportWindow("2027-02-03"), {
    asOfDate: "2027-02-03",
    fiscalYearStart: "2026-04-01",
    currentMonthStart: "2027-02-01",
  });
  assert.deepEqual(migrationReportWindow("2027-04-01"), {
    asOfDate: "2027-04-01",
    fiscalYearStart: "2027-04-01",
    currentMonthStart: "2027-04-01",
  });
});

test("recognizes v4 plan lines and treats unversioned legacy plans as v3", () => {
  assert.equal(migrationPlanVersion(["Plan - Plus monthly (v4)"]), "v4");
  assert.equal(migrationPlanVersion(["Plan - Team annual (v3)"]), "v3");
  assert.equal(migrationPlanVersion(["Plan - Managed annual"]), "v3");
  assert.equal(migrationPlanVersion(["Plan - Managed annual"], "v4"), "v4");
  assert.equal(migrationPlanVersion(["Plan - Managed annual (v3)"], "v4"), "v3");
  assert.equal(migrationPlanVersion(["Plan - Team monthly (v2)"]), null);
  assert.equal(migrationPlanVersion(["Add-on - Conversation Sessions monthly (v4)"]), null);
  assert.equal(migrationPlanVersion(["AI Tokens (v4)"]), null);
});

test("recognizes explicit HubSpot migration deal names", () => {
  assert.equal(isExplicitV3ToV4Migration(["Circuit Board Medics - v3 to v4 upsell"]), true);
  assert.equal(isExplicitV3ToV4Migration(["Corel - Migration"]), true);
  assert.equal(isExplicitV3ToV4Migration(["Opswat Renewal 2026"]), false);
});

test("calculates ARR and logo totals for an inclusive date range", () => {
  const rows = [
    { migratedAt: "2026-04-01", migratedArr: 12000 },
    { migratedAt: "2026-08-14", migratedArr: 30000 },
    { migratedAt: "2026-09-01", migratedArr: 50000 },
  ];
  assert.deepEqual(calculateMigrationMetrics(rows, "2026-04-01", "2026-08-31"), {
    logosMigrated: 2,
    arrMigrated: 42000,
  });
});
