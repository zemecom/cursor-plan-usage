"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  aggregate,
  dashboardFromEvents,
  fillDays,
  onDemandFrom,
  eventLoadProgress,
  eventTimeoutNotice,
  publicCode,
  partialEventLoad,
  rangeStart,
  selectOwnEvents,
  percentAlertLevel,
  snapshotFrom,
  statusSegments,
  statusText,
} = require("../usage-model");
const { addCoverage, mergeEvents, missingWindows, nextEventSlice, prepareEventCache } = require("../event-cache");

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
  assert.equal(statusText(snapshot), "| $(plan-grok) 10.0 $(symbol-misc) 0.0 |");
  assert.equal(statusText(snapshot).includes("99"), false);
  assert.equal(statusText(snapshot).includes("Team"), false);
});

test("status text appends the OD percent", () => {
  const snapshot = snapshotFrom(
    { planInfo: { planName: "Team" } },
    {
      planUsage: { autoPercentUsed: 100, apiPercentUsed: 26.1 },
      spendLimitUsage: { individualUsed: 1429, individualLimit: 10000 },
    }
  );
  assert.equal(statusText(snapshot), "| $(plan-grok) 100.0 $(symbol-misc) 26.1 $(credit-card) 14.3 |");
  assert.equal(statusText({
    planName: "Team",
    autoPercentUsed: 30.6,
    apiPercentUsed: 0.4,
    onDemand: null,
  }), "| $(plan-grok) 30.6 $(symbol-misc) 0.4 |");
});

test("each status meter gets its own alert level", () => {
  assert.equal(percentAlertLevel(79.9), null);
  assert.equal(percentAlertLevel(80), "warning");
  assert.equal(percentAlertLevel(99.6), "warning");
  assert.equal(percentAlertLevel(100), "error");
  assert.equal(percentAlertLevel(null), null);

  const segments = statusSegments({
    planName: "Team",
    autoPercentUsed: 42.8,
    apiPercentUsed: 100,
    onDemand: { usedCents: 1243, limitCents: 0, percent: null },
  });
  assert.deepEqual(segments.map((segment) => [segment.id, segment.level]), [
    ["grok", null],
    ["other", "error"],
    ["od", "error"],
  ]);
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
  assert.equal(partial.timedOut, false);
  assert.equal(Object.hasOwn(partial.events[0], "email"), false);
  const timedOut = dashboardFromEvents(snapshot, "30d", { events: [event], truncated: true, timedOut: true }, null, now);
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.range, "30d");
});

test("dashboard keeps every event so the table can page", () => {
  const now = noon(2026, 10, 26);
  const events = Array.from({ length: 201 }, (_, index) => ({
    timestamp: now - index * 1000,
    model: "grok",
    totalTokens: 1,
    requests: 1,
    spendCents: 0,
    email: null,
  }));
  const view = dashboardFromEvents({}, "30d", { events, truncated: true }, null, now);
  assert.equal(view.eventCount, 201);
  assert.equal(view.events.length, 201);
  assert.equal(view.events[0].timestamp, now);
});
test("event progress moves with each full page and completes at the end", () => {
  assert.equal(eventLoadProgress(0, false), null);
  assert.equal(eventLoadProgress(1, false), 1 / 2);
  assert.equal(eventLoadProgress(2, false), 2 / 3);
  assert.equal(eventLoadProgress(3, true), 1);
});

test("timeout keeps pages already loaded and drops an empty attempt", () => {
  assert.equal(partialEventLoad("timeout", []), null);
  assert.equal(partialEventLoad("http-500", [{ timestamp: 1 }]), null);
  assert.deepEqual(partialEventLoad("timeout", [{ timestamp: 1 }]), {
    events: [{ timestamp: 1 }],
    truncated: true,
    timedOut: true,
  });
});

test("event cache refetches only the gaps", () => {
  const event = (timestamp) => ({
    timestamp,
    model: "grok",
    kind: "Включено",
    totalTokens: 1,
    requests: 1,
    spendCents: 0,
    maxMode: false,
    email: null,
  });
  assert.deepEqual(missingWindows([], 10, 40), [{ startMs: 10, endMs: 40 }]);
  assert.deepEqual(missingWindows([{ startMs: 10, endMs: 40 }], 10, 40), []);
  assert.deepEqual(missingWindows([{ startMs: 10, endMs: 20 }], 10, 40), [{ startMs: 20, endMs: 40 }]);
  assert.deepEqual(missingWindows([{ startMs: 20, endMs: 30 }], 10, 40), [
    { startMs: 10, endMs: 20 },
    { startMs: 30, endMs: 40 },
  ]);
  assert.deepEqual(addCoverage([{ startMs: 10, endMs: 20 }], 20, 30), [{ startMs: 10, endMs: 30 }]);
  const merged = mergeEvents([event(2), event(2)], [event(1)]);
  assert.deepEqual(merged.map((item) => item.timestamp), [1, 2]);
  const prepared = prepareEventCache({
    events: [event(15)],
    covered: [{ startMs: 10, endMs: 20 }],
  }, 10, 40);
  assert.deepEqual(prepared.gaps, [{ startMs: 20, endMs: 40 }]);
  assert.equal(prepared.events.length, 1);
});
test("timed-out rows keep the saved time and say nothing new arrived", () => {
  const now = noon(2026, 10, 26);
  const savedAt = now - 60 * 60 * 1000;
  const view = dashboardFromEvents({}, "30d", {
    events: [{
      timestamp: savedAt,
      model: "grok",
      totalTokens: 1,
      requests: 1,
      spendCents: 0,
      email: null,
    }],
    truncated: true,
    timedOut: true,
    stale: true,
    savedAt,
  }, null, now);
  assert.equal(view.stale, true);
  assert.equal(view.eventCount, 1);
  assert.equal(view.updatedAt, savedAt);
  assert.equal(eventTimeoutNotice(true), "События устарели. Новых нет: загрузка оборвалась по таймауту.");
  assert.match(eventTimeoutNotice(false), /частично/);
});
test("ordered pages close only the newer side of a full slice", () => {
  const pages = [[5, 4], [4, 3]].map((page) => page.map((timestamp) => ({ timestamp })));
  assert.deepEqual(nextEventSlice(pages, 0, 10), { action: "boundary", coverStart: 4, coverEnd: 10 });
  const unordered = [[5, 1], [4, 3]].map((page) => page.map((timestamp) => ({ timestamp })));
  const split = nextEventSlice(unordered, 0, 10);
  assert.equal(split.action, "split");
  assert.deepEqual(split.left, { startMs: 0, endMs: 5 });
  assert.deepEqual(split.right, { startMs: 5, endMs: 10 });
  assert.equal(nextEventSlice([[{ timestamp: 9 }]], 0, 10).action, "stall");
});

test("chart keeps zero days only inside closed coverage", () => {
  const end = new Date(2026, 10, 5, 23, 59, 59, 999).getTime();
  const view = dashboardFromEvents({}, "30d", {
    events: [{
      timestamp: noon(2026, 11, 4),
      model: "grok",
      totalTokens: 8,
      requests: 1,
      spendCents: 0,
      email: null,
    }],
    covered: [{ startMs: new Date(2026, 10, 3).getTime(), endMs: end }],
    backfilling: true,
  }, null, end);
  assert.deepEqual(view.days.map((day) => day.day), ["2026-11-03", "2026-11-04", "2026-11-05"]);
  assert.equal(view.days[0].tokens, 0);
  assert.equal(view.days[1].tokens, 8);
  assert.equal(view.days[2].tokens, 0);
  assert.equal(view.backfilling, true);
});

test("publicCode keeps short codes and hides response text", () => {
  assert.equal(publicCode(new Error("http-401")), "http-401");
  assert.equal(publicCode(new Error("keychain")), "keychain");
  assert.equal(publicCode(new Error("Unexpected token '<'")), "unknown");
});
