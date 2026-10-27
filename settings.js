"use strict";

const vscode = require("vscode");
const { publicCode } = require("./usage-model");

const RANGES = new Set(["billingCycle", "30d", "7d", "1d"]);
const RANGE_LABELS = [
  ["billingCycle", "Текущий цикл"],
  ["30d", "30 дней"],
  ["7d", "7 дней"],
  ["1d", "24 часа"],
];
const POLL_CHOICES = [1, 2, 5, 10, 15, 30, 60];

function pollMinutes() {
  const minutes = Number(vscode.workspace.getConfiguration("cursorPlanUsage").get("pollIntervalMinutes", 1));
  return Number.isFinite(minutes) ? Math.min(60, Math.max(1, Math.round(minutes))) : 1;
}

function rangeLabel(range) {
  const found = RANGE_LABELS.find(([value]) => value === range);
  return found ? found[1] : range;
}

function pollMs() {
  return pollMinutes() * 60 * 1000;
}

function defaultRange() {
  const range = vscode.workspace.getConfiguration("cursorPlanUsage").get("dashboardDefaultRange", "billingCycle");
  return RANGES.has(range) ? range : "billingCycle";
}

async function pickPollInterval() {
  const current = pollMinutes();
  const values = POLL_CHOICES.includes(current) ? POLL_CHOICES : [current, ...POLL_CHOICES];
  const picked = await vscode.window.showQuickPick(
    values.map((minutes) => ({
      label: `${minutes} мин`,
      description: minutes === current ? "сейчас" : undefined,
      minutes,
    })),
    { title: "Интервал обновления" }
  );
  if (!picked || picked.minutes === current) {
    return;
  }
  await vscode.workspace.getConfiguration("cursorPlanUsage").update(
    "pollIntervalMinutes",
    picked.minutes,
    vscode.ConfigurationTarget.Global
  );
}

async function pickDefaultRange() {
  const current = defaultRange();
  const picked = await vscode.window.showQuickPick(
    RANGE_LABELS.map(([value, label]) => ({
      label,
      description: value === current ? "сейчас" : undefined,
      value,
    })),
    { title: "Период дашборда" }
  );
  if (!picked || picked.value === current) {
    return;
  }
  await vscode.workspace.getConfiguration("cursorPlanUsage").update(
    "dashboardDefaultRange",
    picked.value,
    vscode.ConfigurationTarget.Global
  );
}

async function openSettings() {
  try {
    const choice = await vscode.window.showQuickPick(
      [
        { label: "Интервал обновления", description: `${pollMinutes()} мин`, setting: "interval" },
        { label: "Период дашборда", description: rangeLabel(defaultRange()), setting: "range" },
      ],
      { title: "Cursor Plan Usage", placeHolder: "Что изменить" }
    );
    if (!choice) {
      return;
    }
    if (choice.setting === "interval") {
      await pickPollInterval();
      return;
    }
    await pickDefaultRange();
  } catch (error) {
    void vscode.window.showErrorMessage(`Не удалось сохранить настройку (${publicCode(error)}).`);
  }
}

module.exports = { RANGES, defaultRange, openSettings, pollMs };
