import assert from "node:assert/strict";
import test from "node:test";
import {
  canViewCommissions,
  isAccountManagementAllowedApplicationPath,
  isAccountManagementOnlyRole,
  isSalesAllowedApplicationPath,
  isSalesOnlyRole,
  normalizeAppRole,
} from "../src/lib/accessRoles.ts";

test("normalizes supported application roles", () => {
  assert.equal(normalizeAppRole(" ADMIN "), "admin");
  assert.equal(normalizeAppRole("Sales"), "sales");
  assert.equal(normalizeAppRole("Account Management"), "account_management");
  assert.equal(normalizeAppRole("account-management"), "account_management");
  assert.equal(normalizeAppRole("viewer"), "viewer");
  assert.equal(normalizeAppRole("unknown"), "viewer");
  assert.equal(normalizeAppRole(undefined), "viewer");
});

test("allows admins and sales users to view commissions", () => {
  assert.equal(canViewCommissions("admin"), true);
  assert.equal(canViewCommissions("sales"), true);
  assert.equal(canViewCommissions("viewer"), false);
  assert.equal(canViewCommissions("account_management"), false);
});

test("identifies the account-management-only role", () => {
  assert.equal(isAccountManagementOnlyRole("account_management"), true);
  assert.equal(isAccountManagementOnlyRole("Account Management"), true);
  assert.equal(isAccountManagementOnlyRole("admin"), false);
});

test("identifies the sales-only role", () => {
  assert.equal(isSalesOnlyRole("sales"), true);
  assert.equal(isSalesOnlyRole("admin"), false);
  assert.equal(isSalesOnlyRole("viewer"), false);
});

test("restricts sales users to the commissions page and API", () => {
  assert.equal(isSalesAllowedApplicationPath("/commissions"), true);
  assert.equal(isSalesAllowedApplicationPath("/commissions/details"), true);
  assert.equal(isSalesAllowedApplicationPath("/api/commissions"), true);
  assert.equal(isSalesAllowedApplicationPath("/api/commissions/export"), true);

  assert.equal(isSalesAllowedApplicationPath("/"), false);
  assert.equal(isSalesAllowedApplicationPath("/combined-all-subs"), false);
  assert.equal(isSalesAllowedApplicationPath("/hubspot"), false);
  assert.equal(isSalesAllowedApplicationPath("/api/combined-all-subs-report"), false);
  assert.equal(isSalesAllowedApplicationPath("/commissions-other"), false);
});

test("restricts account management users to the migration page and API", () => {
  assert.equal(isAccountManagementAllowedApplicationPath("/migration"), true);
  assert.equal(isAccountManagementAllowedApplicationPath("/migration/details"), true);
  assert.equal(isAccountManagementAllowedApplicationPath("/api/migration"), true);
  assert.equal(isAccountManagementAllowedApplicationPath("/api/migration/export"), true);

  assert.equal(isAccountManagementAllowedApplicationPath("/"), false);
  assert.equal(isAccountManagementAllowedApplicationPath("/account-management"), false);
  assert.equal(isAccountManagementAllowedApplicationPath("/commissions"), false);
  assert.equal(isAccountManagementAllowedApplicationPath("/api/account-management"), false);
  assert.equal(isAccountManagementAllowedApplicationPath("/migration-other"), false);
});
