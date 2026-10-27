"use strict";

const crypto = require("crypto");
const vscode = require("vscode");
const { dashboardHtml } = require("./dashboard");
const { allowKeychainPrompt, readAuth } = require("./session");
const { RANGES, defaultRange, openSettings, pollMs } = require("./settings");
const { loadSnapshot, loadUsageDetails, publicCode, statusText, tooltipMarkdown } = require("./usage");

function activate(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, Number.MIN_SAFE_INTEGER);
  item.command = "cursorPlanUsage.openDashboard";
  item.name = "Cursor Plan Usage";
  item.text = "$(pulse) Cursor …";
  item.tooltip = "Загрузка тарифа и процентов";
  item.show();

  let panel = null;
  let panelSeenVisible = false;
  let range = defaultRange();
  let timer = null;
  let refreshing = false;
  let refreshQueued = false;
  let refreshQueuedByUser = false;

  function applySnapshot(snapshot) {
    item.text = `$(pulse) ${statusText(snapshot)}`;
    item.tooltip = tooltipMarkdown(snapshot);
    item.backgroundColor = undefined;
    const levels = [snapshot.autoPercentUsed, snapshot.apiPercentUsed, snapshot.onDemand && snapshot.onDemand.percent]
      .filter((value) => value !== null && value !== undefined);
    const peak = levels.length === 0 ? null : Math.max(...levels);
    if (peak !== null && peak >= 100) {
      item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    } else if (peak !== null && peak >= 80) {
      item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    }
  }

  function postDashboard(payload) {
    if (panel) {
      panel.webview.postMessage(payload);
    }
  }

  function showRefreshError(code) {
    item.text = "$(pulse) Cursor usage";
    item.tooltip = `Не удалось прочитать тариф (${code}).`;
    item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    if (panel && panel.visible) {
      postDashboard({
        error: `Не удалось загрузить дашборд (${code}).`,
        range,
        snapshot: null,
        days: [],
        models: [],
        events: [],
        eventCount: 0,
        loadingEvents: false,
        updatedAt: Date.now(),
      });
    }
  }

  async function pushDashboard(auth, snapshot) {
    postDashboard({
      snapshot,
      range,
      days: [],
      models: [],
      events: [],
      eventCount: 0,
      loadingEvents: true,
      updatedAt: Date.now(),
    });
    postDashboard(await loadUsageDetails(range, snapshot, auth));
  }

  async function refresh(options = {}) {
    const userInitiated = Boolean(options.userInitiated);
    if (refreshing) {
      if (options.mustRun) {
        refreshQueued = true;
        refreshQueuedByUser = refreshQueuedByUser || userInitiated;
      }
      return;
    }
    refreshing = true;
    try {
      if (!userInitiated && !vscode.window.state.focused) {
        return;
      }
      if (userInitiated) {
        allowKeychainPrompt();
      }
      const auth = await readAuth();
      const snapshot = await loadSnapshot(auth);
      applySnapshot(snapshot);
      if (panel && (userInitiated || panel.visible)) {
        await pushDashboard(auth, snapshot);
      }
    } catch (error) {
      showRefreshError(publicCode(error));
    } finally {
      refreshing = false;
      if (refreshQueued) {
        const again = refreshQueuedByUser;
        refreshQueued = false;
        refreshQueuedByUser = false;
        void refresh({ userInitiated: again, mustRun: true });
      }
    }
  }

  function restartTimer() {
    if (timer) {
      clearInterval(timer);
    }
    timer = setInterval(() => {
      void refresh();
    }, pollMs());
  }

  function openDashboard() {
    if (panel) {
      panel.reveal(vscode.ViewColumn.Active);
      void refresh({ userInitiated: true, mustRun: true });
      return;
    }
    panel = vscode.window.createWebviewPanel("cursorPlanUsage", "Cursor Plan Usage", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panelSeenVisible = true;
    const nonce = crypto.randomBytes(16).toString("hex");
    panel.webview.onDidReceiveMessage((message) => {
      if (!message || typeof message.type !== "string") {
        return;
      }
      if (message.type === "ready") {
        void refresh({ userInitiated: true });
        return;
      }
      if (message.type === "refresh") {
        void refresh({ userInitiated: true, mustRun: true });
        return;
      }
      if (message.type === "settings") {
        void openSettings();
        return;
      }
      if (message.type === "range" && RANGES.has(message.range)) {
        range = message.range;
        void refresh({ userInitiated: true, mustRun: true });
      }
    });
    panel.onDidChangeViewState((event) => {
      const visible = event.webviewPanel.visible;
      const becameVisible = visible && !panelSeenVisible;
      panelSeenVisible = visible;
      if (becameVisible) {
        void refresh();
      }
    });
    panel.onDidDispose(() => {
      panel = null;
      panelSeenVisible = false;
    });
    panel.webview.html = dashboardHtml(panel.webview, nonce);
    context.subscriptions.push(panel);
    void refresh({ userInitiated: true });
  }

  restartTimer();
  context.subscriptions.push(item, { dispose: () => clearInterval(timer) });
  context.subscriptions.push(
    vscode.commands.registerCommand("cursorPlanUsage.openDashboard", openDashboard),
    vscode.commands.registerCommand("cursorPlanUsage.refresh", () => {
      void refresh({ userInitiated: true, mustRun: true });
    }),
    vscode.commands.registerCommand("cursorPlanUsage.openSettings", openSettings),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        void refresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("cursorPlanUsage")) {
        return;
      }
      if (event.affectsConfiguration("cursorPlanUsage.dashboardDefaultRange")) {
        range = defaultRange();
      }
      restartTimer();
      void refresh();
    })
  );
  void refresh();
}

function deactivate() {}

module.exports = { activate, deactivate };
