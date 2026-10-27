"use strict";

const https = require("https");
const { readAuth } = require("./session");
const {
  dashboardFromEvents,
  modelsFromAggregations,
  normalizeEvent,
  publicCode,
  rangeStart,
  snapshotFrom,
} = require("./usage-model");

const PLAN_INFO_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo";
const PERIOD_USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const AGGREGATED_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetAggregatedUsageEvents";
const STRIPE_URL = "https://cursor.com/api/auth/stripe";
const EVENTS_URL = "https://cursor.com/api/dashboard/get-filtered-usage-events";
const EVENTS_PAGE_SIZE = 200;
const EVENTS_MAX_PAGES = 8;

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

async function loadModelBreakdown(auth) {
  const token = (auth || await readAuth()).token;
  return modelsFromAggregations(await postBearer(AGGREGATED_URL, token));
}

async function loadSnapshot(auth) {
  const token = (auth || await readAuth()).token;
  const [planInfo, period] = await Promise.all([
    postBearer(PLAN_INFO_URL, token),
    postBearer(PERIOD_USAGE_URL, token),
  ]);
  return snapshotFrom(planInfo, period);
}

async function loadEvents(cookie, teamId, startMs, endMs, signal) {
  if (signal && signal.aborted) {
    throw new Error("timeout");
  }
  const events = [];
  let truncated = false;
  for (let page = 1; page <= EVENTS_MAX_PAGES; page += 1) {
    if (signal && signal.aborted) {
      throw new Error("timeout");
    }
    const data = await requestJson(EVENTS_URL, {
      method: "POST",
      headers: cookieHeaders(cookie),
      timeout: 15000,
      signal,
      body: {
        teamId: teamId || 0,
        startDate: String(startMs),
        endDate: String(endMs),
        page,
        pageSize: EVENTS_PAGE_SIZE,
      },
    });
    const list = Array.isArray(data.usageEventsDisplay) ? data.usageEventsDisplay : [];
    events.push(...list.map(normalizeEvent));
    if (list.length < EVENTS_PAGE_SIZE) {
      return { events, truncated: false };
    }
    truncated = page === EVENTS_MAX_PAGES;
  }
  return { events, truncated };
}

async function loadUsageDetails(range, snapshot, auth) {
  const sessionAuth = auth || await readAuth();
  const { token, email } = sessionAuth;
  const session = sessionFromToken(token);
  let details = null;
  let eventsError = null;
  try {
    const stripe = await runWithin(8000, (signal) => requestJson(STRIPE_URL, {
      method: "GET",
      headers: cookieHeaders(session.cookie),
      timeout: 8000,
      signal,
    }));
    const now = Date.now();
    const loaded = await runWithin(8000, (signal) => (
      loadEvents(session.cookie, stripe && stripe.teamId, rangeStart(range, snapshot, now), now, signal)
    ));
    details = dashboardFromEvents(snapshot, range, loaded, email, now);
  } catch (error) {
    eventsError = publicCode(error);
  }
  const models = eventsError
    ? await loadModelBreakdown(sessionAuth).catch(() => [])
    : (details ? details.models : []);
  const errorText = !eventsError
    ? undefined
    : (models.length
      ? `События не загрузились (${eventsError}). Модели показаны за текущий цикл.`
      : `События не загрузились (${eventsError}).`);
  return {
    snapshot,
    range,
    days: details ? details.days : [],
    models,
    events: details ? details.events : [],
    eventCount: details ? details.eventCount : 0,
    truncated: details ? details.truncated : false,
    loadingEvents: false,
    updatedAt: Date.now(),
    error: errorText,
  };
}

module.exports = {
  loadModelBreakdown,
  loadSnapshot,
  loadUsageDetails,
  ...require("./usage-model"),
};
