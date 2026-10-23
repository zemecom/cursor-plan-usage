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
    button, .range button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; border-radius: 4px; padding: 6px 10px; cursor: pointer; }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 12px 0 20px; }
    .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); border-radius: 8px; padding: 12px; }
    .card .label { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .card .value { font-size: 22px; margin-top: 4px; }
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
  <div id="banner" class="banner"></div>
  <div id="cards" class="cards"></div>
  <section>
    <div class="section-head">
      <h2>По дням</h2>
      <div class="range" id="range">
        <button type="button" data-range="billingCycle">Цикл</button>
        <button type="button" data-range="30d">30 дней</button>
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
  </section>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const cards = document.getElementById("cards");
    const bars = document.getElementById("bars");
    const models = document.getElementById("models");
    const events = document.getElementById("events");
    const banner = document.getElementById("banner");
    const updated = document.getElementById("updated");
    const eventNote = document.getElementById("event-note");

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
    function card(label, value) {
      const box = el("div", null, "card");
      box.append(el("div", label, "label"), el("div", value, "value"));
      return box;
    }
    function emptyRow(columns, text) {
      const row = document.createElement("tr");
      const cell = el("td", text);
      cell.colSpan = columns;
      row.append(cell);
      return row;
    }
    function render(payload) {
      banner.classList.toggle("show", Boolean(payload.error));
      banner.textContent = payload.error || "";
      const snapshot = payload.snapshot || {};
      const price = snapshot.price ? " (" + snapshot.price + ")" : "";
      cards.replaceChildren(
        card("Тариф", (snapshot.planName || "—") + price),
        card("Grok", percent(snapshot.autoPercentUsed)),
        card("Other", percent(snapshot.apiPercentUsed))
      );
      document.querySelectorAll("#range button").forEach((button) => {
        button.classList.toggle("active", button.dataset.range === payload.range);
      });
      const dayRows = payload.days || [];
      const maxTokens = dayRows.reduce((max, day) => Math.max(max, day.tokens), 0) || 1;
      bars.replaceChildren(...(dayRows.length ? dayRows.map((day) => {
        const column = el("div", null, "bar");
        const fill = el("div", null, "fill");
        fill.style.height = Math.max(2, Math.round((day.tokens / maxTokens) * 120)) + "px";
        fill.title = day.day + ": " + tokens(day.tokens) + " токенов, " + dollars(day.spendCents);
        column.append(fill, el("span", String(day.day || "").slice(5)));
        return column;
      }) : [el("span", "За выбранный период событий нет", "muted")]));
      const modelRows = payload.models || [];
      models.replaceChildren(...(modelRows.length ? modelRows.map((row) => {
        const tr = document.createElement("tr");
        tr.append(el("td", row.model), el("td", tokens(row.tokens), "num"), el("td", row.requests == null ? "—" : tokens(row.requests), "num"), el("td", dollars(row.spendCents), "num"));
        return tr;
      }) : [emptyRow(4, "Нет данных")]));
      const eventRows = payload.events || [];
      events.replaceChildren(...(eventRows.length ? eventRows.map((row) => {
        const tr = document.createElement("tr");
        const model = row.maxMode ? row.model + " MAX" : row.model;
        tr.append(el("td", when(row.timestamp)), el("td", row.kind), el("td", model), el("td", tokens(row.totalTokens), "num"), el("td", tokens(row.requests), "num"), el("td", dollars(row.spendCents), "num"));
        return tr;
      }) : [emptyRow(6, "Нет событий")]));
      const hidden = Math.max(0, (payload.eventCount || 0) - eventRows.length);
      eventNote.textContent = payload.truncated
        ? "Показана только часть периода: событий слишком много."
        : hidden > 0 ? "В таблице последние " + eventRows.length + ", всего " + payload.eventCount + "." : (payload.eventCount ? "Всего " + payload.eventCount : "");
      updated.textContent = payload.loadingEvents
        ? "Тариф на месте, события ещё считаются…"
        : payload.updatedAt ? "Обновлено " + when(payload.updatedAt) : "Нет данных";
    }
    document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    document.getElementById("settings").addEventListener("click", () => vscode.postMessage({ type: "settings" }));
    document.getElementById("range").addEventListener("click", (event) => {
      const range = event.target && event.target.dataset && event.target.dataset.range;
      if (range) vscode.postMessage({ type: "range", range });
    });
    window.addEventListener("message", (event) => {
      if (!event.data) return;
      try {
        render(event.data);
      } catch (error) {
        updated.textContent = "Ошибка отрисовки: " + (error && error.message ? error.message : "unknown");
      }
    });
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}

module.exports = { dashboardHtml };
