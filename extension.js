"use strict";

const crypto = require("crypto");
const vscode = require("vscode");
const { dashboardHtml } = require("./dashboard");
const { loadModelBreakdown, loadSnapshot, loadUsageDetails, statusText, tooltipMarkdown } = require("./usage");

const RANGES = new Set(["billingCycle", "30d", "7d", "1d"]);

function pollMs() {
  const minutes = vscode.workspace.getConfiguration("cursorPlanUsage").get("pollIntervalMinutes", 1);
  const safe = Number.isFinite(Number(minutes)) ? Math.min(60, Math.max(1, Number(minutes))) : 1;
  return safe * 60 * 1000;
}

function defaultRange() {
  const range = vscode.workspace.getConfiguration("cursorPlanUsage").get("dashboardDefaultRange", "billingCycle");
  return RANGES.has(range) ? range : "billingCycle";
}

function activate(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, Number.MIN_SAFE_INTEGER);
  item.command = "cursorPlanUsage.openDashboard";
  item.name = "Cursor Plan Usage";
  item.text = "$(pulse) Cursor …";
  item.tooltip = "Загрузка тарифа и процентов";
  item.show();

  let panel = null;
  let range = defaultRange();
  let timer = null;
  let refreshingStatus = false;
  let refreshingDashboard = false;

  function applySnapshot(snapshot) {
    item.text = `$(pulse) ${statusText(snapshot)}`;
    item.tooltip = tooltipMarkdown(snapshot);
    item.backgroundColor = undefined;
    const levels = [snapshot.autoPercentUsed, snapshot.apiPercentUsed].filter((value) => value !== null);
    const peak = levels.length === 0 ? null : Math.max(...levels);
    if (peak !== null && peak >= 100) {
      item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    } else if (peak !== null && peak >= 80) {
      item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    }
  }

  async function refreshStatus() {
    if (refreshingStatus) {
      return;
    }
    refreshingStatus = true;
    try {
      applySnapshot(await loadSnapshot());
    } catch (error) {
      const code = error instanceof Error ? error.message : "unknown";
      item.text = "$(pulse) Cursor usage";
      item.tooltip = `Не удалось прочитать тариф (${code}).`;
      item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } finally {
      refreshingStatus = false;
    }
  }

  function postDashboard(payload) {
    if (panel) {
      panel.webview.postMessage(payload);
    }
  }

  async function refreshDashboard() {
    if (!panel || refreshingDashboard) {
      return;
    }
    refreshingDashboard = true;
    let snapshot = null;
    try {
      snapshot = await loadSnapshot();
      applySnapshot(snapshot);
      const models = await loadModelBreakdown().catch(() => []);
      postDashboard({
        snapshot,
        range,
        days: [],
        models,
        events: [],
        eventCount: 0,
        loadingEvents: true,
        updatedAt: Date.now(),
      });
      postDashboard(await loadUsageDetails(range, snapshot));
    } catch (error) {
      const code = error instanceof Error ? error.message : "unknown";
      postDashboard({
        error: snapshot ? `События не загрузились (${code}).` : `Не удалось загрузить дашборд (${code}).`,
        range,
        snapshot,
        days: [],
        models: [],
        events: [],
        eventCount: 0,
        loadingEvents: false,
        updatedAt: Date.now(),
      });
    } finally {
      refreshingDashboard = false;
    }
  }

  function restartTimer() {
    if (timer) {
      clearInterval(timer);
    }
    timer = setInterval(() => {
      void refreshStatus();
      void refreshDashboard();
    }, pollMs());
  }

  function openSettings() {
    return vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "@id:cursorPlanUsage.pollIntervalMinutes,cursorPlanUsage.dashboardDefaultRange"
    );
  }

  function openDashboard() {
    if (panel) {
      panel.reveal(vscode.ViewColumn.Active);
      void refreshDashboard();
      return;
    }
    panel = vscode.window.createWebviewPanel("cursorPlanUsage", "Cursor Plan Usage", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    const nonce = crypto.randomBytes(16).toString("hex");
    panel.webview.onDidReceiveMessage((message) => {
      if (!message || typeof message.type !== "string") {
        return;
      }
      if (message.type === "ready" || message.type === "refresh") {
        void refreshDashboard();
        return;
      }
      if (message.type === "settings") {
        openSettings();
        return;
      }
      if (message.type === "range" && RANGES.has(message.range)) {
        range = message.range;
        void refreshDashboard();
      }
    });
    panel.onDidDispose(() => {
      panel = null;
    });
    panel.webview.html = dashboardHtml(panel.webview, nonce);
    context.subscriptions.push(panel);
    void refreshDashboard();
  }

  restartTimer();
  context.subscriptions.push(item, { dispose: () => clearInterval(timer) });
  context.subscriptions.push(
    vscode.commands.registerCommand("cursorPlanUsage.openDashboard", openDashboard),
    vscode.commands.registerCommand("cursorPlanUsage.refresh", () => {
      void refreshStatus();
      void refreshDashboard();
    }),
    vscode.commands.registerCommand("cursorPlanUsage.openSettings", openSettings),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("cursorPlanUsage")) {
        return;
      }
      if (event.affectsConfiguration("cursorPlanUsage.dashboardDefaultRange")) {
        range = defaultRange();
      }
      restartTimer();
      void refreshStatus();
      void refreshDashboard();
    })
  );
  void refreshStatus();
}

function deactivate() {}

module.exports = { activate, deactivate };
