"use strict";

const https = require("https");
const { readAuth } = require("./session");

const PLAN_INFO_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo";
const PERIOD_USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const AGGREGATED_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetAggregatedUsageEvents";
const STRIPE_URL = "https://cursor.com/api/auth/stripe";
const EVENTS_URL = "https://cursor.com/api/dashboard/get-filtered-usage-events";
const EVENTS_PAGE_SIZE = 200;
const EVENTS_MAX_PAGES = 8;
const TABLE_EVENT_LIMIT = 200;

function sessionFromToken(token) {
  const part = token.split(".")[1];
  if (!part) {
    throw new Error("bad-session");
  }
  const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
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
            finish(reject, parseError);
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
    req.on("error", (error) => finish(reject, signal && signal.aborted ? new Error("timeout") : error));
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

function asNumber(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatPercent(value) {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function formatDollars(cents) {
  if (cents === null) {
    return "—";
  }
  return `$${(cents / 100).toFixed(2)}`;
}

function formatReset(epochMs) {
  if (epochMs === null) {
    return "—";
  }
  return new Date(epochMs).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
}

function onDemandFrom(spend) {
  if (!spend || typeof spend !== "object") {
    return null;
  }
  const buckets = [
    [asNumber(spend.individualUsed), asNumber(spend.individualLimit)],
    [asNumber(spend.pooledUsed), asNumber(spend.pooledLimit)],
    [asNumber(spend.overallUsed), asNumber(spend.overallLimit)],
  ];
  const active = buckets.find(([used]) => used > 0);
  if (!active) {
    return null;
  }
  const [usedCents, limitCents] = active;
  const percent = limitCents > 0 ? Math.min((usedCents / limitCents) * 100, 100) : null;
  return { usedCents, limitCents, percent };
}

function snapshotFrom(planInfoResponse, periodResponse) {
  const planInfo = planInfoResponse && planInfoResponse.planInfo ? planInfoResponse.planInfo : {};
  const planUsage = periodResponse && periodResponse.planUsage ? periodResponse.planUsage : {};
  const cycleEnd = asNumber(periodResponse && periodResponse.billingCycleEnd) ?? asNumber(planInfo.billingCycleEnd);
  const cycleStart = asNumber(periodResponse && periodResponse.billingCycleStart);
  return {
    planName: typeof planInfo.planName === "string" && planInfo.planName.trim() !== "" ? planInfo.planName.trim() : "Plan",
    price: typeof planInfo.price === "string" ? planInfo.price : null,
    totalPercentUsed: asNumber(planUsage.totalPercentUsed),
    autoPercentUsed: asNumber(planUsage.autoPercentUsed),
    apiPercentUsed: asNumber(planUsage.apiPercentUsed),
    totalSpendCents: asNumber(planUsage.totalSpend),
    includedSpendCents: asNumber(planUsage.includedSpend),
    bonusSpendCents: asNumber(planUsage.bonusSpend),
    limitCents: asNumber(planUsage.limit),
    onDemand: onDemandFrom(periodResponse && periodResponse.spendLimitUsage),
    billingCycleStartMs: cycleStart,
    billingCycleEndMs: cycleEnd,
  };
}

function statusText(snapshot) {
  const base = `${snapshot.planName} | Grok ${formatPercent(snapshot.autoPercentUsed)} | Other ${formatPercent(snapshot.apiPercentUsed)}`;
  if (!snapshot.onDemand) {
    return base;
  }
  const demand = snapshot.onDemand.percent === null
    ? formatDollars(snapshot.onDemand.usedCents)
    : formatPercent(snapshot.onDemand.percent);
  return `${base} | OD ${demand}`;
}

function tooltipMarkdown(snapshot) {
  const price = snapshot.price ? ` (${snapshot.price})` : "";
  return [
    `Тариф: ${snapshot.planName}${price}`,
    `Grok: ${formatPercent(snapshot.autoPercentUsed)}`,
    `Other: ${formatPercent(snapshot.apiPercentUsed)}`,
    ...(snapshot.onDemand ? [
      `OD: ${formatDollars(snapshot.onDemand.usedCents)} из ${formatDollars(snapshot.onDemand.limitCents)} (${formatPercent(snapshot.onDemand.percent)})`,
    ] : []),
    `Потрачено: ${formatDollars(snapshot.totalSpendCents)} (включено ${formatDollars(snapshot.includedSpendCents)}, бонус ${formatDollars(snapshot.bonusSpendCents)}, лимит ${formatDollars(snapshot.limitCents)})`,
    `Цикл до: ${formatReset(snapshot.billingCycleEndMs)}`,
    "",
    "Клик открывает дашборд.",
  ].join("\n");
}

function mapKind(kind) {
  if (kind === "USAGE_EVENT_KIND_USAGE_BASED") return "On-demand";
  if (kind === "USAGE_EVENT_KIND_ERRORED_NOT_CHARGED") return "Ошибка";
  if (kind === "USAGE_EVENT_KIND_ABORTED_NOT_CHARGED") return "Отмена";
  return "Включено";
}

function normalizeEvent(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const tokens = source.tokenUsage && typeof source.tokenUsage === "object" ? source.tokenUsage : {};
  const totalTokens = ["inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens"]
    .reduce((sum, key) => sum + (asNumber(tokens[key]) || 0), 0);
  return {
    timestamp: asNumber(source.timestamp) || 0,
    model: typeof source.model === "string" && source.model ? source.model : "unknown",
    kind: mapKind(typeof source.kind === "string" ? source.kind : ""),
    totalTokens,
    requests: asNumber(source.requestsCosts) ?? asNumber(source.numRequests) ?? 1,
    spendCents: asNumber(source.chargedCents) ?? 0,
    maxMode: Boolean(source.maxMode),
    email: typeof source.userEmail === "string" ? source.userEmail : null,
  };
}

function selectOwnEvents(events, email) {
  const tagged = events.filter((event) => event.email);
  if (tagged.length === 0) {
    return events;
  }
  if (!email) {
    return [];
  }
  const needle = email.toLowerCase();
  return events.filter((event) => event.email && event.email.toLowerCase() === needle);
}

function dayKey(timestamp) {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function aggregate(events) {
  const days = new Map();
  const models = new Map();
  for (const event of events) {
    const day = days.get(dayKey(event.timestamp)) || { day: dayKey(event.timestamp), tokens: 0, requests: 0, spendCents: 0 };
    day.tokens += event.totalTokens;
    day.requests += event.requests;
    day.spendCents += event.spendCents;
    days.set(day.day, day);

    const model = models.get(event.model) || { model: event.model, tokens: 0, requests: 0, spendCents: 0 };
    model.tokens += event.totalTokens;
    model.requests += event.requests;
    model.spendCents += event.spendCents;
    models.set(event.model, model);
  }
  return {
    days: [...days.values()].sort((left, right) => left.day.localeCompare(right.day)),
    models: [...models.values()].sort((left, right) => right.tokens - left.tokens || right.spendCents - left.spendCents),
  };
}

function rangeStart(range, snapshot, now) {
  if (range === "1d") return now - 86400000;
  if (range === "7d") return now - 7 * 86400000;
  if (range === "30d") return now - 30 * 86400000;
  return snapshot.billingCycleStartMs || now - 30 * 86400000;
}

function runWithin(ms, start) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return Promise.resolve()
    .then(() => start(controller.signal))
    .finally(() => clearTimeout(timer));
}

function modelsFromAggregations(data) {
  const rows = Array.isArray(data && data.aggregations) ? data.aggregations : [];
  return rows.map((row) => {
    const tokens = ["inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens"]
      .reduce((sum, key) => sum + (asNumber(row[key]) || 0), 0);
    return {
      model: typeof row.modelIntent === "string" && row.modelIntent ? row.modelIntent : "unknown",
      tokens,
      requests: null,
      spendCents: asNumber(row.totalCents) || 0,
    };
  }).sort((left, right) => right.spendCents - left.spendCents);
}

async function loadModelBreakdown() {
  const { token } = await readAuth();
  return modelsFromAggregations(await postBearer(AGGREGATED_URL, token));
}

async function loadSnapshot() {
  const { token } = await readAuth();
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

function dashboardFromEvents(snapshot, range, loaded, email, now) {
  const own = selectOwnEvents(loaded.events, email);
  const summary = aggregate(own);
  const events = own
    .slice()
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, TABLE_EVENT_LIMIT)
    .map(({ email: _email, ...event }) => event);
  return {
    snapshot,
    range,
    days: summary.days,
    models: summary.models,
    events,
    eventCount: own.length,
    truncated: loaded.truncated,
    loadingEvents: false,
    updatedAt: now,
  };
}

async function loadUsageDetails(range, snapshot) {
  const { token, email } = await readAuth();
  const session = sessionFromToken(token);
  const aggregatedPromise = postBearer(AGGREGATED_URL, token).then(modelsFromAggregations).catch(() => []);
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
    eventsError = error instanceof Error ? error.message : "unknown";
  }
  const fallbackModels = details && details.models.length > 0 ? details.models : await aggregatedPromise;
  return {
    snapshot,
    range,
    days: details ? details.days : [],
    models: fallbackModels,
    events: details ? details.events : [],
    eventCount: details ? details.eventCount : 0,
    truncated: details ? details.truncated : false,
    loadingEvents: false,
    updatedAt: Date.now(),
    error: eventsError ? `События не загрузились (${eventsError}). Модели показаны за текущий цикл.` : undefined,
  };
}

module.exports = {
  aggregate,
  formatDollars,
  formatPercent,
  formatReset,
  loadModelBreakdown,
  loadSnapshot,
  loadUsageDetails,
  normalizeEvent,
  rangeStart,
  selectOwnEvents,
  snapshotFrom,
  statusText,
  tooltipMarkdown,
};
