import assert from "node:assert/strict";
import test from "node:test";
import {
  TEAM_SCORECARD_DEFINITIONS,
  TEAM_SCORECARD_KEYS,
  getTeamScorecardDefinition,
  isTeamScorecardKey,
} from "../src/lib/teamScorecardDefinitions.ts";

test("preserves the seven V2 team scorecards and all 47 metrics", () => {
  assert.deepEqual(TEAM_SCORECARD_DEFINITIONS.map((team) => team.key), [...TEAM_SCORECARD_KEYS]);
  assert.deepEqual(TEAM_SCORECARD_DEFINITIONS.map((team) => team.metrics.length), [9, 7, 10, 4, 7, 4, 6]);
  assert.equal(TEAM_SCORECARD_DEFINITIONS.reduce((sum, team) => sum + team.metrics.length, 0), 47);
});

test("keeps workbook targets blank except for the six Marketing targets", () => {
  const marketing = getTeamScorecardDefinition("marketing");
  assert.equal(marketing.metrics.filter((metric) => metric.target).length, 6);
  assert.equal(marketing.metrics[0].target, "0% → 25%+ by EOQ4");
  assert.equal(marketing.metrics[5].target, "6 by EOQ3");
  assert.equal(
    TEAM_SCORECARD_DEFINITIONS.filter((team) => team.key !== "marketing")
      .flatMap((team) => team.metrics)
      .every((metric) => metric.target === ""),
    true,
  );
});

test("validates team route keys", () => {
  assert.equal(isTeamScorecardKey("sales"), true);
  assert.equal(isTeamScorecardKey("account-management"), true);
  assert.equal(isTeamScorecardKey("Account-Management"), true);
  assert.equal(isTeamScorecardKey("finance"), false);
});
