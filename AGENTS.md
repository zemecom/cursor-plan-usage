# AGENTS.md — cursor-plan-usage

Локальное расширение Cursor. Источник поведения — `extension.js`, `session.js`, `usage.js`, `dashboard.js` и `package.json`. Репозиторий: `https://github.com/zemecom/cursor-plan-usage`.

## 1. Стек и запуск

- CommonJS, без `npm` и без сборки. Хост — процесс расширений Cursor (`engines.vscode` в `package.json`).
- Код выполняется на хосте, не в Docker. Сессия читается через `/usr/bin/sqlite3` из `state.vscdb` в режиме `mode=ro`. Значение `cursor-safe-storage:v1:` на macOS расшифровывается ключом связки `Cursor Safe Storage` до любого запроса.
- Установка: симлинк `~/.cursor/extensions/local.cursor-plan-usage` на корень этого репозитория. Имя каталога без суффикса версии.
- После правки кода подними `version` в `package.json` и то же значение у `local.cursor-plan-usage` в `~/.cursor/extensions/extensions.json`. Cursor следит за `extensions.json`: запись ключуется идентификатором и версией. Смена версии в профиле заставляет заново прочитать расширение с диска. Если версия в `package.json` отличается от уже загруженной хостом, в карточке появляется Restart Extensions. Хост сам не перезапускай.

## 2. Инварианты

- В статусбаре и карточках только тариф, Grok (`autoPercentUsed`) и Other (`apiPercentUsed`). `totalPercentUsed` в интерфейс не выводить.
- Статусбар: `StatusBarAlignment.Left` и `Number.MIN_SAFE_INTEGER`, чтобы строка стояла у правого края левой группы.
- Токен, cookie и почту не писать в репозиторий, логи и ответы. В базе только `SELECT`. События без своей почты не показывать, если в ответе почта есть.
- Запросы к `cursor.com` для списка событий ограничивать дедлайном. Сбой событий не должен прятать модели, уже полученные с `api2.cursor.sh`.
- Слушатель сообщений webview регистрировать до присвоения `webview.html`.

## 3. Проверка

Перед сдачей правки:

```bash
node --check extension.js && node --check session.js && node --check usage.js && node --check dashboard.js
```

Тестового набора нет. Поведение дашборда проверяется в открытой панели Cursor, а не отдельным раннером.

## 4. Git

Ветка по умолчанию — `main`. Коммит и push только по явной команде. Секреты и дампы `state.vscdb` не коммитить.
