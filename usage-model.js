"use strict";

const MAX_FILL_DAYS = 62;

function asNumber(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function publicCode(error) {
  const raw = error instanceof Error ? error.message : "unknown";
  return /^[a-z][a-z0-9-]{0,31}$/.test(raw) ? raw : "unknown";
}

function formatPercent(value) {
  return value === null || value === undefined ? "—" : `${value.toFixed(1)}%`;
}

function formatStatusPercent(value) {
  return value === null || value === undefined ? "—" : value.toFixed(1);
}

function formatDollars(cents) {
  if (cents === null || cents === undefined) {
    return "—";
  }
  return `$${(cents / 100).toFixed(2)}`;
}

function formatReset(epochMs) {
  if (epochMs === null || epochMs === undefined) {
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
  const grok = `$(plan-grok) ${formatStatusPercent(snapshot.autoPercentUsed)}`;
  const other = `$(symbol-misc) ${formatStatusPercent(snapshot.apiPercentUsed)}`;
  const base = `${snapshot.planName} | ${grok} | ${other}`;
  if (!snapshot.onDemand) {
    return base;
  }
  const demand = snapshot.onDemand.percent === null
    ? formatDollars(snapshot.onDemand.usedCents)
    : formatStatusPercent(snapshot.onDemand.percent);
  return `${base} | $(credit-card) ${demand}`;
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
    const key = dayKey(event.timestamp);
    const day = days.get(key) || { day: key, tokens: 0, requests: 0, spendCents: 0 };
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

function startOfLocalDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addLocalDays(date, count) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + count);
  return next;
}

function fillDays(days, startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
    return days.slice();
  }
  const end = startOfLocalDay(endMs);
  let cursor = startOfLocalDay(startMs);
  const earliest = addLocalDays(end, -(MAX_FILL_DAYS - 1));
  if (cursor < earliest) {
    cursor = earliest;
  }
  const byDay = new Map(days.map((day) => [day.day, day]));
  const filled = [];
  while (cursor.getTime() <= end.getTime() && filled.length < MAX_FILL_DAYS) {
    const key = dayKey(cursor.getTime());
    filled.push(byDay.get(key) || { day: key, tokens: 0, requests: 0, spendCents: 0 });
    cursor = addLocalDays(cursor, 1);
  }
  return filled;
}

function rangeStart(range, snapshot, now) {
  if (range === "1d") return now - 86400000;
  if (range === "7d") return now - 7 * 86400000;
  if (range === "30d") return now - 30 * 86400000;
  return snapshot.billingCycleStartMs || now - 30 * 86400000;
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

function dashboardFromEvents(snapshot, range, loaded, email, now) {
  const own = selectOwnEvents(loaded.events, email);
  const summary = aggregate(own);
  const events = own
    .slice()
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, 200)
    .map(({ email: _email, ...event }) => event);
  const days = loaded.truncated
    ? summary.days
    : fillDays(summary.days, rangeStart(range, snapshot, now), now);
  return {
    snapshot,
    range,
    days,
    models: summary.models,
    events,
    eventCount: own.length,
    truncated: loaded.truncated,
    loadingEvents: false,
    updatedAt: now,
  };
}

module.exports = {
  aggregate,
  dashboardFromEvents,
  fillDays,
  formatDollars,
  formatPercent,
  formatReset,
  modelsFromAggregations,
  normalizeEvent,
  onDemandFrom,
  publicCode,
  rangeStart,
  selectOwnEvents,
  snapshotFrom,
  statusText,
  tooltipMarkdown,
};
