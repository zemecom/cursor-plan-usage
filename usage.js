"use strict";

const https = require("https");
const { readAuth } = require("./session");
const {
  eventsInRange,
  prepareEventCache,
  addCoverage,
  mergeEvents,
  readEventCache,
  writeEventCache,
} = require("./event-cache");
const {
  dashboardFromEvents,
  eventLoadProgress,
  eventTimeoutNotice,
  normalizeEvent,
  partialEventLoad,
  publicCode,
  rangeStart,
  snapshotFrom,
} = require("./usage-model");

const PLAN_INFO_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo";
const PERIOD_USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const STRIPE_URL = "https://cursor.com/api/auth/stripe";
const EVENTS_URL = "https://cursor.com/api/dashboard/get-filtered-usage-events";
const EVENTS_PAGE_SIZE = 200;
const EVENTS_MAX_PAGES = 8;
const EVENTS_DEADLINE_MS = 180000;
const EVENTS_REQUEST_TIMEOUT_MS = 30000;

function sessionFromToken(token) {
  const part = token.split(".")[1];
  if (!part) {
    throw new Error("bad-session");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch (error) {
    throw new Error("bad-session");
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("bad-session");
  }
  const userId = String(payload.sub || "").split("|").pop();
  if (!userId) {
    throw new Error("bad-session");
  }
  return { userId, cookie: `${userId}%3A%3A${token}` };
}

function requestJson(url, { method, headers, body, timeout = 20000, signal }) {
  if (signal && signal.aborted) {
    return Promise.reject(new Error("timeout"));
  }
  const target = new URL(url);
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      settle(value);
    };
    const req = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          ...headers,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            finish(reject, new Error(`http-${res.statusCode}`));
            return;
          }
          try {
            finish(resolve, JSON.parse(raw));
          } catch (parseError) {
            finish(reject, new Error("bad-response"));
          }
        });
      }
    );
    const onAbort = () => {
      finish(reject, new Error("timeout"));
      req.destroy();
    };
    if (signal) {
      signal.addEventListener("abort", onAbort);
    }
    req.on("error", () => finish(reject, new Error(signal && signal.aborted ? "timeout" : "network")));
    req.on("timeout", () => {
      finish(reject, new Error("timeout"));
      req.destroy();
    });
    if (payload) {
      req.write(payload);
    }
    req.end();
    if (signal && signal.aborted) {
      onAbort();
    }
  });
}

function postBearer(url, token) {
  return requestJson(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Connect-Protocol-Version": "1",
    },
    body: {},
  });
}

function cookieHeaders(cookie) {
  return {
    Cookie: `WorkosCursorSessionToken=${cookie}`,
    Origin: "https://cursor.com",
    Referer: "https://cursor.com/dashboard",
  };
}

function runWithin(ms, start) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return Promise.resolve()
    .then(() => start(controller.signal))
    .finally(() => clearTimeout(timer));
}

async function loadSnapshot(auth) {
  const token = (auth || await readAuth()).token;
  const [planInfo, period] = await Promise.all([
    postBearer(PLAN_INFO_URL, token),
    postBearer(PERIOD_USAGE_URL, token),
  ]);
  return snapshotFrom(planInfo, period);
}

function keepPartialEvents(error, events) {
  return partialEventLoad(publicCode(error), events);
}

function reportEventPage(onPage, page, events, finished) {
  if (typeof onPage !== "function" || finished) {
    return;
  }
  onPage({
    page,
    events,
    progress: eventLoadProgress(page, false),
  });
}

async function loadEvents(cookie, teamId, startMs, endMs, signal, onPage) {
  const events = [];
  let truncated = false;
  for (let page = 1; page <= EVENTS_MAX_PAGES; page += 1) {
    if (signal && signal.aborted) {
      const partial = partialEventLoad("timeout", events);
      if (partial) {
        return partial;
      }
      throw new Error("timeout");
    }
    let data;
    try {
      data = await requestJson(EVENTS_URL, {
        method: "POST",
        headers: cookieHeaders(cookie),
        timeout: EVENTS_REQUEST_TIMEOUT_MS,
        signal,
        body: {
          teamId: teamId || 0,
          startDate: String(startMs),
          endDate: String(endMs),
          page,
          pageSize: EVENTS_PAGE_SIZE,
        },
      });
    } catch (error) {
      const partial = keepPartialEvents(error, events);
      if (partial) {
        return partial;
      }
      throw error;
    }
    const list = Array.isArray(data.usageEventsDisplay) ? data.usageEventsDisplay : [];
    events.push(...list.map(normalizeEvent));
    const pageFull = list.length >= EVENTS_PAGE_SIZE;
    reportEventPage(onPage, page, events.slice(), !pageFull || page === EVENTS_MAX_PAGES);
    if (!pageFull) {
      return { events, truncated: false, timedOut: false };
    }
    truncated = page === EVENTS_MAX_PAGES;
  }
  return { events, truncated, timedOut: false };
}

async function loadCachedEvents(cookie, teamId, rangeStartMs, rangeEndMs, signal, onPage, cacheFile) {
  const cached = readEventCache(cacheFile);
  const prepared = prepareEventCache(cached, rangeStartMs, rangeEndMs);
  let savedAt = Number.isFinite(cached.savedAt) ? cached.savedAt : null;
  if (prepared.gaps.length === 0) {
    return {
      events: eventsInRange(prepared.events, rangeStartMs, rangeEndMs),
      truncated: false,
      timedOut: false,
      stale: false,
      savedAt,
    };
  }
  let events = prepared.events;
  let covered = prepared.covered;
  let timedOut = false;
  let truncated = false;
  let gotNew = false;
  const publish = (pageEvents, page, finished) => {
    reportEventPage(onPage, page, eventsInRange(mergeEvents(events, pageEvents), rangeStartMs, rangeEndMs), finished);
  };
  for (const gap of prepared.gaps) {
    let loaded;
    try {
      loaded = await loadEvents(cookie, teamId, gap.startMs, gap.endMs, signal, (pageState) => {
        publish(pageState.events, pageState.page, false);
      });
    } catch (error) {
      if (publicCode(error) !== "timeout") {
        throw error;
      }
      timedOut = true;
      break;
    }
    if (loaded.events.length > 0) {
      gotNew = true;
    }
    events = mergeEvents(events, loaded.events);
    if (loaded.timedOut) {
      timedOut = true;
    } else if (loaded.truncated) {
      truncated = true;
    } else {
      covered = addCoverage(covered, gap.startMs, gap.endMs);
    }
    if (loaded.timedOut) {
      break;
    }
  }
  if (!timedOut && !truncated) {
    savedAt = Date.now();
  }
  const kept = prepareEventCache({ events, covered }, rangeStartMs, rangeEndMs);
  writeEventCache(cacheFile, { events: kept.events, covered: kept.covered, savedAt });
  const ranged = eventsInRange(kept.events, rangeStartMs, rangeEndMs);
  return {
    events: ranged,
    truncated,
    timedOut,
    stale: timedOut && !gotNew,
    savedAt,
  };
}

async function loadUsageDetails(range, snapshot, auth, onProgress, cacheFile) {
  const sessionAuth = auth || await readAuth();
  const { token, email } = sessionAuth;
  const session = sessionFromToken(token);
  let details = null;
  let eventsError = null;
  let eventsStarted = false;
  try {
    const stripe = await runWithin(8000, (signal) => requestJson(STRIPE_URL, {
      method: "GET",
      headers: cookieHeaders(session.cookie),
      timeout: 8000,
      signal,
    }));
    const now = Date.now();
    const startMs = rangeStart(range, snapshot, now);
    eventsStarted = true;
    const loaded = await runWithin(EVENTS_DEADLINE_MS, (signal) => (
      loadCachedEvents(session.cookie, stripe && stripe.teamId, startMs, now, signal, (pageState) => {
        if (typeof onProgress !== "function") {
          return;
        }
        const partial = dashboardFromEvents(snapshot, range, {
          events: pageState.events,
          truncated: true,
          timedOut: false,
        }, email, now);
        onProgress({
          ...partial,
          loadingEvents: true,
          progress: pageState.progress,
          progressLabel: `${pageState.events.length} событий`,
        });
      }, cacheFile)
    ));
    details = dashboardFromEvents(snapshot, range, loaded, email, now);
  } catch (error) {
    eventsError = publicCode(error);
  }
  if (eventsError === "timeout" && eventsStarted) {
    return {
      snapshot,
      range,
      retain: true,
      stale: true,
      timedOut: true,
      loadingEvents: false,
      error: eventTimeoutNotice(true),
    };
  }
  if (eventsError) {
    return {
      snapshot,
      range,
      retain: true,
      loadingEvents: false,
      updatedAt: Date.now(),
      error: `События не загрузились (${eventsError}).`,
    };
  }
  if (details.timedOut && details.eventCount === 0) {
    return {
      snapshot,
      range,
      retain: true,
      stale: true,
      timedOut: true,
      loadingEvents: false,
      error: eventTimeoutNotice(true),
    };
  }
  return {
    snapshot,
    range: details.range,
    days: details.days,
    models: details.models,
    events: details.events,
    eventCount: details.eventCount,
    truncated: details.truncated,
    timedOut: details.timedOut,
    stale: details.stale,
    loadingEvents: false,
    updatedAt: details.updatedAt,
    error: details.timedOut ? eventTimeoutNotice(details.stale) : undefined,
  };
}

module.exports = {
  loadSnapshot,
  loadUsageDetails,
  ...require("./usage-model"),
};
