"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  aggregate,
  dashboardFromEvents,
  fillDays,
  onDemandFrom,
  publicCode,
  rangeStart,
  selectOwnEvents,
  snapshotFrom,
  statusText,
} = require("../usage-model");

function noon(year, month, day) {
  return new Date(year, month - 1, day, 12).getTime();
}

test("on-demand stays hidden without spend", () => {
  assert.equal(onDemandFrom(null), null);
  assert.equal(onDemandFrom({
    individualUsed: 0,
    individualLimit: 1000,
    pooledUsed: 0,
    pooledLimit: 1000,
  }), null);
});

test("on-demand prefers individual spend over pooled", () => {
  const demand = onDemandFrom({
    individualUsed: 2500,
    individualLimit: 5000,
    pooledUsed: 1000,
    pooledLimit: 4000,
  });
  assert.deepEqual(demand, { usedCents: 2500, limitCents: 5000, percent: 50 });
});

test("on-demand uses pooled when individual spend is zero", () => {
  const demand = onDemandFrom({
    individualUsed: 0,
    individualLimit: 5000,
    pooledUsed: 1000,
    pooledLimit: 4000,
  });
  assert.deepEqual(demand, { usedCents: 1000, limitCents: 4000, percent: 25 });
});

test("on-demand without a positive limit has no percent", () => {
  const demand = onDemandFrom({ overallUsed: 150, overallLimit: 0 });
  assert.equal(demand.percent, null);
  assert.equal(demand.usedCents, 150);
});

test("status text hides a zero OD meter and the mixed percent", () => {
  const snapshot = snapshotFrom(
    { planInfo: { planName: "Team", price: "$40" } },
    {
      planUsage: { autoPercentUsed: 10, apiPercentUsed: 0, totalPercentUsed: 99 },
      spendLimitUsage: {},
    }
  );
  assert.equal(statusText(snapshot), "Team | $(plan-grok) 10.0 | $(symbol-misc) 0.0");
  assert.equal(statusText(snapshot).includes("99"), false);
});

test("status text appends the OD percent", () => {
  const snapshot = snapshotFrom(
    { planInfo: { planName: "Team" } },
    {
      planUsage: { autoPercentUsed: 100, apiPercentUsed: 26.1 },
      spendLimitUsage: { individualUsed: 1429, individualLimit: 10000 },
    }
  );
  assert.equal(statusText(snapshot), "Team | $(plan-grok) 100.0 | $(symbol-misc) 26.1 | $(credit-card) 14.3");
  assert.equal(statusText({
    planName: "Team",
    autoPercentUsed: 30.6,
    apiPercentUsed: 0.4,
    onDemand: null,
  }), "Team | $(plan-grok) 30.6 | $(symbol-misc) 0.4");
});

test("events with emails keep only the signed-in account", () => {
  const events = [
    { email: "Me@Example.com", timestamp: 1 },
    { email: "other@example.com", timestamp: 2 },
  ];
  assert.equal(selectOwnEvents(events, "me@example.com").length, 1);
  assert.deepEqual(selectOwnEvents(events, null), []);
  assert.equal(selectOwnEvents([{ email: null, timestamp: 1 }], null).length, 1);
});

test("aggregate sums tokens of one day and one model", () => {
  const day = noon(2026, 10, 26);
  const summary = aggregate([
    { timestamp: day, model: "grok", totalTokens: 10, requests: 1, spendCents: 5 },
    { timestamp: day + 1000, model: "grok", totalTokens: 3, requests: 2, spendCents: 1 },
  ]);
  assert.equal(summary.days.length, 1);
  assert.equal(summary.days[0].tokens, 13);
  assert.equal(summary.models[0].requests, 3);
});

test("range start follows the selected window", () => {
  const now = noon(2026, 10, 26);
  assert.equal(rangeStart("1d", {}, now), now - 86400000);
  assert.equal(rangeStart("7d", {}, now), now - 7 * 86400000);
  assert.equal(rangeStart("30d", {}, now), now - 30 * 86400000);
  assert.equal(rangeStart("billingCycle", { billingCycleStartMs: 50 }, now), 50);
  assert.equal(rangeStart("billingCycle", {}, now), now - 30 * 86400000);
});

test("fillDays inserts an empty day and keeps only the last 62", () => {
  const start = noon(2026, 10, 24);
  const end = noon(2026, 10, 26);
  const filled = fillDays(
    [{ day: "2026-10-25", tokens: 4, requests: 1, spendCents: 2 }],
    start,
    end
  );
  assert.deepEqual(filled.map((day) => day.day), ["2026-10-24", "2026-10-25", "2026-10-26"]);
  assert.equal(filled[0].tokens, 0);
  assert.equal(filled[1].tokens, 4);
  const long = fillDays([], noon(2020, 1, 1), end);
  assert.equal(long.length, 62);
  assert.equal(long[long.length - 1].day, "2026-10-26");
});

test("a full event page fills empty days, a truncated page stays sparse", () => {
  const now = noon(2026, 10, 26);
  const snapshot = { billingCycleStartMs: noon(2026, 10, 24) };
  const event = {
    timestamp: now,
    model: "grok",
    totalTokens: 8,
    requests: 1,
    spendCents: 3,
    email: null,
  };
  const full = dashboardFromEvents(snapshot, "billingCycle", { events: [event], truncated: false }, null, now);
  assert.equal(full.days.length, 3);
  const partial = dashboardFromEvents(snapshot, "billingCycle", { events: [event], truncated: true }, null, now);
  assert.equal(partial.days.length, 1);
  assert.equal(partial.truncated, true);
  assert.equal(Object.hasOwn(partial.events[0], "email"), false);
});

test("publicCode keeps short codes and hides response text", () => {
  assert.equal(publicCode(new Error("http-401")), "http-401");
  assert.equal(publicCode(new Error("keychain")), "keychain");
  assert.equal(publicCode(new Error("Unexpected token '<'")), "unknown");
});
