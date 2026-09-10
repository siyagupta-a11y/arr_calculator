import assert from "node:assert/strict";
import test from "node:test";
import {
  isTvDashboardPath,
  verifyTvDashboardAuthorization,
} from "../src/lib/tvDashboardAuth.ts";

function basic(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

test("limits TV authentication to performance dashboard paths", () => {
  assert.equal(isTvDashboardPath("/tv/scorecards"), true);
  assert.equal(isTvDashboardPath("/tv/scorecards/sales"), true);
  assert.equal(isTvDashboardPath("/api/tv/team-scorecards"), true);
  assert.equal(isTvDashboardPath("/api/tv/team-scorecards/details"), true);
  assert.equal(isTvDashboardPath("/tv"), false);
  assert.equal(isTvDashboardPath("/tv/scorecards-other"), false);
  assert.equal(isTvDashboardPath("/api/team-scorecards"), false);
});

test("accepts only the configured Basic Auth credentials", () => {
  const credentials = { username: "yodeck", password: "tv-secret:with-colon" };
  assert.equal(
    verifyTvDashboardAuthorization(basic(credentials.username, credentials.password), credentials),
    true,
  );
  assert.equal(verifyTvDashboardAuthorization(basic("wrong", credentials.password), credentials), false);
  assert.equal(verifyTvDashboardAuthorization(basic(credentials.username, "wrong"), credentials), false);
  assert.equal(verifyTvDashboardAuthorization("Bearer token", credentials), false);
  assert.equal(verifyTvDashboardAuthorization("Basic not-base64%%%", credentials), false);
  assert.equal(verifyTvDashboardAuthorization(null, credentials), false);
});
