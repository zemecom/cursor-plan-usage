"use strict";

function dashboardHtml(webview, nonce) {
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cursor Plan Usage</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; padding: 20px 24px 40px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 16px; }
    h1 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
    h2 { font-size: 14px; margin: 0; }
    .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .actions { display: flex; gap: 8px; }
    button, .range button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; border-radius: 4px; padding: 6px 10px; cursor: pointer; transition: transform 80ms ease, opacity 80ms ease; }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button:active:not(:disabled), .range button:active { transform: scale(0.96); }
    button.primary.busy { transform: scale(0.96); outline: 1px solid var(--vscode-focusBorder); background: var(--vscode-button-hoverBackground, var(--vscode-button-secondaryBackground)); }
    button:disabled { cursor: progress; }
    button.busy::before { content: ""; display: inline-block; width: 10px; height: 10px; margin-right: 6px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; vertical-align: -1px; animation: refresh-spin 0.7s linear infinite; }
    @keyframes refresh-spin { to { transform: rotate(360deg); } }
    .cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 12px 0 20px; }
    .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); border-radius: 8px; padding: 12px; }
    .card .label { display: flex; align-items: center; min-height: 16px; font-size: 12px; color: var(--vscode-descriptionForeground); }
    .mark { width: 16px; height: 16px; display: block; fill: currentColor; }
    .card .value { font-size: 22px; margin-top: 4px; }
    .card .value.warning { color: var(--vscode-charts-orange); }
    .card .value.error { color: var(--vscode-charts-red); }
    section { margin-top: 22px; }
    .section-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 12px; }
    .range { display: flex; gap: 6px; }
    .range button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .bars { display: flex; align-items: flex-end; gap: 6px; min-height: 140px; overflow-x: auto; padding-top: 8px; }
    .bar { flex: 1 0 28px; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 4px; min-width: 28px; }
    .bar .fill { width: 100%; background: var(--vscode-charts-blue, #4f8cff); border-radius: 3px 3px 0 0; min-height: 2px; }
    .bar span { font-size: 10px; color: var(--vscode-descriptionForeground); }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,.25)); }
    th { color: var(--vscode-descriptionForeground); font-weight: 500; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    .banner { display: none; margin-bottom: 12px; padding: 8px 10px; border-radius: 6px; background: var(--vscode-inputValidation-errorBackground); }
    .banner.show { display: block; }
    .banner.warning { background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-inputValidation-warningForeground, inherit); }
    .progress { height: 6px; margin: -8px 0 12px; border-radius: 999px; background: var(--vscode-scrollbarSlider-background, rgba(127,127,127,.35)); overflow: hidden; }
    .progress[hidden] { display: none; }
    .progress .fill { height: 100%; width: 0; background: var(--vscode-progressBar-background, var(--vscode-button-background)); transition: width 180ms ease; }
    .progress .fill.indeterminate { width: 35%; animation: progress-slide 1.1s ease-in-out infinite; }
    @keyframes progress-slide { from { transform: translateX(-120%); } to { transform: translateX(320%); } }
    .pager { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
    .pager[hidden] { display: none; }
    .pager button:disabled { opacity: 0.45; cursor: default; }
    @media (max-width: 800px) { .cards { grid-template-columns: 1fr 1fr; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Cursor Plan Usage</h1>
      <div id="updated" class="muted">Загрузка…</div>
    </div>
    <div class="actions">
      <button id="settings" type="button">Настройки</button>
      <button id="refresh" class="primary" type="button">Обновить</button>
    </div>
  </header>
  <div id="progress" class="progress" hidden><div id="progress-fill" class="fill"></div></div>
  <div id="banner" class="banner"></div>
  <div id="cards" class="cards"></div>
  <section>
    <div class="section-head">
      <h2>По дням</h2>
      <div class="range" id="range">
        <button type="button" data-range="billingCycle">Цикл</button>
        <button type="button" data-range="30d" class="active">30 дней</button>
        <button type="button" data-range="7d">7 дней</button>
        <button type="button" data-range="1d">24 часа</button>
      </div>
    </div>
    <div id="bars" class="bars"></div>
  </section>
  <section>
    <div class="section-head"><h2>По моделям</h2></div>
    <table>
      <thead><tr><th>Модель</th><th class="num">Токены</th><th class="num">Запросы</th><th class="num">$</th></tr></thead>
      <tbody id="models"></tbody>
    </table>
  </section>
  <section>
    <div class="section-head"><h2>События</h2><span id="event-note" class="muted"></span></div>
    <table>
      <thead><tr><th>Время</th><th>Тип</th><th>Модель</th><th class="num">Токены</th><th class="num">Запросы</th><th class="num">$</th></tr></thead>
      <tbody id="events"></tbody>
    </table>
    <div class="pager" id="event-pager" hidden>
      <button type="button" id="event-first">В начало</button>
      <button type="button" id="event-back">−3</button>
      <button type="button" id="event-prev">Назад</button>
      <span id="event-page-label" class="muted"></span>
      <button type="button" id="event-next">Дальше</button>
      <button type="button" id="event-forward">+3</button>
      <button type="button" id="event-last">В конец</button>
    </div>
  </section>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const saved = vscode.getState() || {};
    let selectedRange = saved.range || "30d";
    let rangePinned = Boolean(saved.range);
    let seenEpoch = 0;
    const cards = document.getElementById("cards");
    const bars = document.getElementById("bars");
    const models = document.getElementById("models");
    const events = document.getElementById("events");
    const banner = document.getElementById("banner");
    const updated = document.getElementById("updated");
    const eventNote = document.getElementById("event-note");
    const refreshButton = document.getElementById("refresh");
    const progress = document.getElementById("progress");
    const progressFill = document.getElementById("progress-fill");

    const EVENT_PAGE_SIZE = 50;
    const EVENT_PAGE_JUMP = 3;
    let eventPage = 1;
    let eventList = [];
    let busyToken = 0;
    let busySince = 0;
    function applyBusy(on) {
      refreshButton.classList.toggle("busy", on);
      refreshButton.disabled = on;
      refreshButton.setAttribute("aria-busy", on ? "true" : "false");
      refreshButton.textContent = on ? "Обновление…" : "Обновить";
    }
    function setRefreshing(on) {
      if (on) {
        busyToken += 1;
        if (!refreshButton.classList.contains("busy")) {
          busySince = Date.now();
        }
        applyBusy(true);
        return;
      }
      const token = busyToken;
      const wait = Math.max(0, 700 - (Date.now() - busySince));
      setTimeout(() => {
        if (token !== busyToken) {
          return;
        }
        applyBusy(false);
      }, wait);
    }

    function el(tag, text, className) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    }
    function percent(value) { return value == null ? "—" : value.toFixed(1) + "%"; }
    function dollars(cents) { return cents == null ? "—" : "$" + (cents / 100).toFixed(2); }
    function tokens(value) { return Math.round(value || 0).toLocaleString("ru-RU"); }
    function when(value) { return value ? new Date(value).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "—"; }
    function limitLevel(value) {
      if (value == null || Number.isNaN(value)) return "";
      if (value >= 100) return "error";
      if (value >= 80) return "warning";
      return "";
    }
    function card(label, value, level) {
      const box = el("div", null, "card");
      const caption = el("div", null, "label");
      if (typeof label === "string") caption.textContent = label;
      else caption.append(label);
      const figure = el("div", value, "value");
      if (level) figure.classList.add(level);
      box.append(caption, figure);
      return box;
    }
    function grokMark() {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("class", "mark");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", "Grok");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M6.469 8.776L16.512 23h-4.464L2.005 8.776H6.47zm-.004 7.9l2.233 3.164L6.467 23H2l4.465-6.324zM22 2.582V23h-3.659V7.764L22 2.582zM22 1l-9.952 14.095-2.233-3.163L17.533 1H22z");
      svg.append(path);
      return svg;
    }
    function emptyRow(columns, text) {
      const row = document.createElement("tr");
      const cell = el("td", text);
      cell.colSpan = columns;
      row.append(cell);
      return row;
    }
    let shown = null;
    function frameFrom(payload) {
      return {
        snapshot: payload.snapshot || null,
        days: payload.days || [],
        models: payload.models || [],
        events: payload.events || [],
        eventCount: payload.eventCount || 0,
        truncated: Boolean(payload.truncated),
        timedOut: Boolean(payload.timedOut),
        stale: Boolean(payload.stale),
        updatedAt: payload.updatedAt || null,
      };
    }
    function eventTableRow(row) {
      const tr = document.createElement("tr");
      const model = row.maxMode ? row.model + " MAX" : row.model;
      tr.append(el("td", when(row.timestamp)), el("td", row.kind), el("td", model), el("td", tokens(row.totalTokens), "num"), el("td", tokens(row.requests), "num"), el("td", dollars(row.spendCents), "num"));
      return tr;
    }
    function renderEventPage() {
      const pager = document.getElementById("event-pager");
      const total = eventList.length;
      const pages = Math.max(1, Math.ceil(total / EVENT_PAGE_SIZE));
      if (eventPage > pages) eventPage = pages;
      if (eventPage < 1) eventPage = 1;
      const start = (eventPage - 1) * EVENT_PAGE_SIZE;
      const slice = eventList.slice(start, start + EVENT_PAGE_SIZE);
      events.replaceChildren(...(slice.length ? slice.map(eventTableRow) : [emptyRow(6, "Нет событий")]));
      pager.hidden = total <= EVENT_PAGE_SIZE;
      document.getElementById("event-page-label").textContent = eventPage + " / " + pages;
      const atStart = eventPage <= 1;
      const atEnd = eventPage >= pages;
      document.getElementById("event-first").disabled = atStart;
      document.getElementById("event-back").disabled = atStart;
      document.getElementById("event-prev").disabled = atStart;
      document.getElementById("event-next").disabled = atEnd;
      document.getElementById("event-forward").disabled = atEnd;
      document.getElementById("event-last").disabled = atEnd;
    }
    function highlightRange(range) {
      document.querySelectorAll("#range button").forEach((button) => {
        button.classList.toggle("active", button.dataset.range === range);
      });
    }
    function renderProgress(payload) {
      const loading = Boolean(payload.loadingEvents);
      progress.hidden = !loading;
      if (!loading) {
        progressFill.style.width = "0";
        progressFill.classList.remove("indeterminate");
        return;
      }
      if (typeof payload.progress !== "number") {
        progressFill.classList.add("indeterminate");
        progressFill.style.width = "35%";
        return;
      }
      progressFill.classList.remove("indeterminate");
      const width = Math.max(0, Math.min(100, Math.round(payload.progress * 100)));
      progressFill.style.width = width + "%";
    }
    function render(payload) {
      if (typeof payload.epoch === "number" && payload.epoch < seenEpoch) {
        return;
      }
      if (typeof payload.epoch === "number") {
        seenEpoch = payload.epoch;
      }
      if (rangePinned && payload.range && payload.range !== selectedRange) {
        return;
      }
      if (payload.range) {
        selectedRange = payload.range;
        rangePinned = true;
        vscode.setState({ range: selectedRange });
        highlightRange(selectedRange);
      }
      const incoming = Array.isArray(payload.days);
      const hold = Boolean(shown) && (payload.retain || (payload.loadingEvents && !incoming));
      const frame = hold ? shown : frameFrom(payload);
      const snapshot = payload.snapshot || (hold && shown.snapshot) || {};
      const markStale = Boolean(payload.stale) || Boolean(!hold && frame.stale);
      banner.classList.toggle("show", Boolean(payload.error));
      banner.classList.toggle("warning", Boolean(payload.stale || payload.timedOut));
      banner.textContent = payload.error || "";
      renderProgress(payload);
      const price = snapshot.price ? " (" + snapshot.price + ")" : "";
      const summary = [
        card("Тариф", (snapshot.planName || "—") + price),
        card(grokMark(), percent(snapshot.autoPercentUsed), limitLevel(snapshot.autoPercentUsed)),
        card("Other", percent(snapshot.apiPercentUsed), limitLevel(snapshot.apiPercentUsed)),
      ];
      if (snapshot.onDemand) {
        const demand = snapshot.onDemand.percent == null
          ? dollars(snapshot.onDemand.usedCents)
          : percent(snapshot.onDemand.percent);
        summary.push(card("OD", demand, "error"));
      }
      cards.replaceChildren(...summary);
      const dayRows = frame.days;
      const waiting = Boolean(payload.loadingEvents) && !incoming && !shown;
      const maxTokens = dayRows.reduce((max, day) => Math.max(max, day.tokens), 0) || 1;
      bars.replaceChildren(...(waiting
        ? [el("span", "Загрузка…", "muted")]
        : dayRows.length ? dayRows.map((day) => {
        const column = el("div", null, "bar");
        const fill = el("div", null, "fill");
        fill.style.height = Math.max(2, Math.round((day.tokens / maxTokens) * 120)) + "px";
        fill.title = day.day + ": " + tokens(day.tokens) + " токенов, " + dollars(day.spendCents);
        column.append(fill, el("span", String(day.day || "").slice(5)));
        return column;
      }) : [el("span", "За выбранный период событий нет", "muted")]));
      const modelRows = frame.models;
      models.replaceChildren(...(waiting
        ? [emptyRow(4, "Загрузка…")]
        : modelRows.length ? modelRows.map((row) => {
        const tr = document.createElement("tr");
        tr.append(el("td", row.model), el("td", tokens(row.tokens), "num"), el("td", row.requests == null ? "—" : tokens(row.requests), "num"), el("td", dollars(row.spendCents), "num"));
        return tr;
      }) : [emptyRow(4, "Нет данных")]));
      const eventRows = frame.events || [];
      if (waiting) {
        events.replaceChildren(emptyRow(6, "Загрузка…"));
        document.getElementById("event-pager").hidden = true;
      } else {
        eventList = eventRows;
        renderEventPage();
      }
      eventNote.textContent = payload.loadingEvents
        ? ""
        : markStale
        ? "Новых событий нет из-за таймаута."
        : frame.timedOut
        ? "Хвост периода не догрузился из-за таймаута."
        : frame.truncated
        ? "Показана только часть периода: событий слишком много."
        : (frame.eventCount ? "Всего " + frame.eventCount : "");
      const stamp = payload.loadingEvents ? null : (hold ? shown.updatedAt : payload.updatedAt);
      updated.textContent = payload.loadingEvents
        ? (payload.progressLabel || "Тариф на месте, события ещё считаются…")
        : markStale
        ? (stamp ? "События устарели, снимок от " + when(stamp) : "События устарели")
        : stamp ? "Обновлено " + when(stamp) : "Нет данных";
      if (!payload.retain && (!payload.loadingEvents || incoming)) {
        shown = frameFrom(payload);
      } else if (shown && payload.snapshot) {
        shown.snapshot = payload.snapshot;
      }
      setRefreshing(Boolean(payload.loadingEvents));
    }
    function beginProgress() {
      eventPage = 1;
      progress.hidden = false;
      progressFill.classList.add("indeterminate");
      progressFill.style.width = "35%";
      updated.textContent = "Загрузка событий…";
    }
    refreshButton.addEventListener("click", () => {
      setRefreshing(true);
      beginProgress();
      vscode.postMessage({ type: "refresh", range: selectedRange });
    });
    document.getElementById("settings").addEventListener("click", () => vscode.postMessage({ type: "settings" }));
    document.getElementById("range").addEventListener("click", (event) => {
      const next = event.target && event.target.dataset && event.target.dataset.range;
      if (!next) {
        return;
      }
      selectedRange = next;
      rangePinned = true;
      vscode.setState({ range: next });
      highlightRange(next);
      setRefreshing(true);
      beginProgress();
      vscode.postMessage({ type: "range", range: next });
    });
    function moveEventPage(nextPage) {
      eventPage = nextPage;
      renderEventPage();
    }
    document.getElementById("event-first").addEventListener("click", () => moveEventPage(1));
    document.getElementById("event-back").addEventListener("click", () => moveEventPage(eventPage - EVENT_PAGE_JUMP));
    document.getElementById("event-prev").addEventListener("click", () => moveEventPage(eventPage - 1));
    document.getElementById("event-next").addEventListener("click", () => moveEventPage(eventPage + 1));
    document.getElementById("event-forward").addEventListener("click", () => moveEventPage(eventPage + EVENT_PAGE_JUMP));
    document.getElementById("event-last").addEventListener("click", () => moveEventPage(Number.MAX_SAFE_INTEGER));
    window.addEventListener("message", (event) => {
      if (!event.data) return;
      try {
        render(event.data);
      } catch (error) {
        updated.textContent = "Ошибка отрисовки: " + (error && error.message ? error.message : "unknown");
        setRefreshing(false);
      }
    });
    highlightRange(selectedRange);
    vscode.postMessage({ type: "ready", range: selectedRange });
  </script>
</body>
</html>`;
}

module.exports = { dashboardHtml };
