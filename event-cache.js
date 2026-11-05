"use strict";

const fs = require("fs");
const path = require("path");

const CACHE_KEEP_MS = 120 * 24 * 60 * 60 * 1000;

function eventKey(event) {
  return [
    event.timestamp,
    event.model,
    event.kind,
    event.totalTokens,
    event.requests,
    event.spendCents,
    event.maxMode ? 1 : 0,
    event.email || "",
  ].join("|");
}

function mergeEvents(existing, incoming) {
  const byKey = new Map();
  for (const event of [...existing, ...incoming]) {
    if (!event || typeof event !== "object") {
      continue;
    }
    byKey.set(eventKey(event), event);
  }
  return [...byKey.values()].sort((left, right) => left.timestamp - right.timestamp);
}

function eventsInRange(events, rangeStart, rangeEnd) {
  return events.filter((event) => event.timestamp >= rangeStart && event.timestamp <= rangeEnd);
}

function addCoverage(covered, startMs, endMs) {
  const spans = [...(covered || [])];
  if (endMs > startMs) {
    spans.push({ startMs, endMs });
  }
  spans.sort((left, right) => left.startMs - right.startMs);
  const merged = [];
  for (const span of spans) {
    if (!(span.endMs > span.startMs)) {
      continue;
    }
    const last = merged[merged.length - 1];
    if (!last || span.startMs > last.endMs) {
      merged.push({ startMs: span.startMs, endMs: span.endMs });
    } else if (span.endMs > last.endMs) {
      last.endMs = span.endMs;
    }
  }
  return merged;
}

function missingWindows(covered, rangeStart, rangeEnd) {
  if (!(rangeEnd > rangeStart)) {
    return [];
  }
  const spans = addCoverage(covered, rangeStart, rangeStart);
  const gaps = [];
  let cursor = rangeStart;
  for (const span of spans) {
    const startMs = Math.max(span.startMs, rangeStart);
    const endMs = Math.min(span.endMs, rangeEnd);
    if (endMs <= rangeStart || startMs >= rangeEnd) {
      continue;
    }
    if (startMs > cursor) {
      gaps.push({ startMs: cursor, endMs: startMs });
    }
    if (endMs > cursor) {
      cursor = endMs;
    }
  }
  if (cursor < rangeEnd) {
    gaps.push({ startMs: cursor, endMs: rangeEnd });
  }
  return gaps;
}

function newestFirstOldest(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    return null;
  }
  let previousOldest = Infinity;
  for (const page of pages) {
    if (!Array.isArray(page) || page.length === 0) {
      return null;
    }
    for (let index = 1; index < page.length; index += 1) {
      if (!(page[index].timestamp <= page[index - 1].timestamp)) {
        return null;
      }
    }
    const newest = page[0].timestamp;
    const oldest = page[page.length - 1].timestamp;
    if (!Number.isFinite(newest) || !Number.isFinite(oldest) || newest > previousOldest) {
      return null;
    }
    previousOldest = oldest;
  }
  return previousOldest;
}

function nextEventSlice(pages, gapStart, gapEnd) {
  if (!(gapEnd > gapStart)) {
    return { action: "stall" };
  }
  const oldest = newestFirstOldest(pages);
  if (oldest == null) {
    const mid = gapStart + Math.floor((gapEnd - gapStart) / 2);
    if (mid <= gapStart || mid >= gapEnd) {
      return { action: "stall" };
    }
    return {
      action: "split",
      left: { startMs: gapStart, endMs: mid },
      right: { startMs: mid, endMs: gapEnd },
    };
  }
  const coverStart = oldest + 1;
  if (!(coverStart > gapStart && coverStart < gapEnd)) {
    return { action: "stall" };
  }
  return { action: "boundary", coverStart, coverEnd: gapEnd };
}

function pruneEventCache(cache, now) {
  const cutoff = now - CACHE_KEEP_MS;
  const events = mergeEvents([], (cache && cache.events) || []).filter((event) => event.timestamp >= cutoff);
  const covered = addCoverage((cache && cache.covered) || [], cutoff, cutoff)
    .filter((span) => span.endMs > cutoff)
    .map((span) => ({ startMs: Math.max(span.startMs, cutoff), endMs: span.endMs }));
  return { events, covered };
}

function prepareEventCache(cache, rangeStart, rangeEnd) {
  const pruned = pruneEventCache(cache || { events: [], covered: [] }, rangeEnd);
  return {
    events: pruned.events,
    covered: pruned.covered,
    gaps: missingWindows(pruned.covered, rangeStart, rangeEnd),
  };
}

function readEventCache(file) {
  if (!file) {
    return { events: [], covered: [] };
  }
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { events: [], covered: [] };
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { events: [], covered: [] };
    }
    throw error;
  }
  if (!parsed || typeof parsed !== "object") {
    return { events: [], covered: [] };
  }
  return {
    events: Array.isArray(parsed.events) ? parsed.events : [],
    covered: Array.isArray(parsed.covered) ? parsed.covered : [],
    savedAt: Number.isFinite(parsed.savedAt) ? parsed.savedAt : null,
  };
}

function writeEventCache(file, cache) {
  if (!file) {
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    events: cache.events || [],
    covered: cache.covered || [],
    savedAt: Number.isFinite(cache.savedAt) ? cache.savedAt : null,
  }));
}

module.exports = {
  CACHE_KEEP_MS,
  addCoverage,
  eventsInRange,
  mergeEvents,
  missingWindows,
  nextEventSlice,
  prepareEventCache,
  pruneEventCache,
  readEventCache,
  writeEventCache,
};
