# Reversy — память о проекте (для будущего продукта)

Записано 21 Oct 2026, после Daytona HackSprint NYC (16 Oct 2026, с Arize AI).
Репозиторий: https://github.com/AnalystTom/daytona_hack · живой сайт: https://reversy.thomasmann2001.workers.dev
Команда: Julia (оркестрация, Daytona, Firstmate, память), Thomas / AnalystTom (бэкенд, UI, Cloudflare, финальная интеграция).

## 1. Что это за продукт

**Reversy разбирает чужой артефакт и показывает, из чего он сделан.** Два режима:

1. **Report mode (главное для финансов).** Даёшь ссылку на открытый отчёт (Goldman Sachs, Morgan Stanley, Bloomberg…).
   Агент:
   - вытаскивает каждую цифру вместе с точной фразой, где она стоит, и ссылкой прямо на это место (`#:~:text=`);
   - находит, на каких источниках и базах данных отчёт построен (названные и подразумеваемые), и как их получить;
   - ищет первоисточники онлайн (OpenAI web search, ограниченный бюджет поиска);
   - **проверяет каждую цифру**: «matches» только если в источнике то же значение, единица, масштаб и валюта; всё сомнительное получает «unverified», и обе цитаты видны; непроверяемое помечается «not observed», ничего не досочиняется;
   - пересчитывает, что может, из первичных данных. Пример: капекс гиперскейлеров по SEC EDGAR XBRL. MSFT, GOOGL, AMZN, META и ORCL за календарный 2025 = $411.5bn; H1 2026 = $329.9bn. Отсюда видно, что прогноз GS в $800bn требует, чтобы H2 превысил H1 на 42.5%;
   - собирает дашборд на канвасе: сводка, разбивка инвестиций из встроенной диаграммы, таблица цифр с источниками. Его можно редактировать, правки хранятся отдельно, оригинал не меняется.
2. **Website mode.** Ссылка на сайт → скриншоты и HTML как доказательства → спека → план задач → параллельные coding-агенты в песочнице Daytona → ревью → merge → превью → независимый верификатор.

Ценность для финансов: аналитик видит, **на чём держится чужой вывод**, какие цифры подтверждаются первичными данными, а какие нет. И сразу получает «что ещё видно сверх отчёта».

## 2. Архитектура (как оно работает сейчас)

- **Cloudflare Workers.**
  - `reversy`: UI и API, front door `/api/v1/...`, вход через Cloudflare Access, посетители могут запускать без токена, у каждого свои запуски и лимиты.
  - `reversy-orchestrator`: приватный, вызывается через service binding. **Один Durable Object на один запуск.** Фазы: brief → inspecting → planning → planned → building → done; цикл на alarm-таймере.
- **Daytona.** Песочницы для кода: snapshot `daytona-medium`, регион eu, публичные preview-URL `https://3000-{id}.daytonaproxy01.eu`. Агенты — Codex CLI в песочнице (`codex exec --dangerously-bypass-approvals-and-sandbox`, `< /dev/null`); изоляция обеспечивается самой песочницей Daytona.
- **Firstmate** (kunchenguid/firstmate): вторая, «тяжёлая» оркестрация внутри песочницы, в демо не используется.
  - Состав: tmux, treehouse worktrees, fleet ledger, no-mistakes; Gitea вместо Forgejo.
  - Merge guard требует зелёный commit status, поэтому мы написали свой `ci.mjs`.
  - bridge.mjs переводит ledger в события UI.
- **SurrealDB.**
  - Записи запусков и отчётов.
  - **Agent Memory с разным доступом для разных участников.** Каждой роли (оркестратор, воркер задачи, верификатор) выдаётся attenuated-ключ (`POST /keys` с `grants`) на свои scopes. Воркер видит только свою задачу и общий контекст запуска. Для вложенных scopes нужны паттерны `/*`. Это ключевая фишка для финансов: аналитики, клиенты и комплаенс видят разные срезы одной памяти.
  - Факты пишутся с `infer: full` / `triples`, есть `asOf` (что было известно на дату).
- **Anchor Browser:** скриншоты и fetch страниц, в том числе через редиректы и защиту от ботов.
- **Arize:** трейсинг через OTLP/HTTP JSON (`otlp.arize.com/v1/traces`), один трейс на запуск, trace id = id запуска.
- **LLM:** сейчас OpenAI `gpt-6-luna` (PR #34). Неделю раньше пробовали шлюз Nicrron, но там кончились кредиты (402).
- **REA** (rea-agents): разбор JS-бандлов сайта во временной песочнице.

## 3. Где что лежит на GitHub

- `main`: актуальный продукт. Report mode в коде: `orchestrator/src/dissection.ts`, `report-capture.ts`, `report-store.ts`, `report.ts`, `run.ts`.
- Ветка `orchestrator` (не слита в main, но запушена) — моя исходная работа:
  - `sandbox/*`: bootstrap, Firstmate, Gitea, bridge, CLI `reversy`, `ci.mjs`;
  - `orchestrator/src/memory.ts`: ролевые ключи SurrealDB;
  - `docs/devpost.md`, `docs/orchestrator/handoff.md`.
- Ветка `fix/review-diff`, PR #11: первая версия report mode и фикс ревью. Её содержимое вошло в main через PR #26, сам PR можно закрыть.
- Ветка `archive/python-prototype`: утренний Python-прототип в `prototype/` (fetch → extract → verify → memory → voice) и `HACKATHON.md` с требованиями хакатона. Там же лежит этот файл.

## 4. Уроки (что сработало и где обожглись)

- Ссылку в бриф вставлять **одной строкой**: перенос строки обрезает URL, захватывается «Page Not Found», и в той же сессии это уже не исправить. Нужна новая сессия. Это баг: правка адреса в чате не перезахватывает страницу.
- Дефолтный пример на `/workspace` — неудачная сборка daytona.io («1 merged, 2 failed»). Для показа его надо заменить удачным запуском отчёта: `POST /api/v1/example {runId}` с operator token.
- Параллельная сборка сайта агентами хрупкая: зависимые задачи блокируются, если упала базовая. Report mode надёжнее и полезнее для показа.
- Ревьюер отклонял работу из-за обрезанного diff (30 KB) и абсолютных путей во владении файлами. Исправлено: diff по файлам с лимитом 5 KB на файл.
- `observed_at` в SurrealDB работает только с `infer: full`/`triples`.
- Daytona: на тарифе ниже Tier 3 у песочниц нет полного интернета; полный доступ есть только у песочниц, созданных уже после включения Tier 3.
- Секреты, которые вставлялись в чат во время хакатона, надо считать скомпрометированными и **перевыпустить**: OpenAI, Daytona, Arize, SurrealDB, Anchor, ElevenLabs, Cloudflare.

## 5. Идеи для будущего продукта

- **Provenance-граф для любых финансовых документов**: отчёты брокеров, investor decks, 10-K и earnings call → цифра → цитата → первоисточник → статус проверки. Хранить как граф в SurrealDB, где каждая цифра — узел со связями и историей (`asOf`).
- **Коннекторы первичных данных** вместо одного SEC: FRED (макро), ECB/Eurostat, company IR, World Bank. Каждая проверка воспроизводима, у неё есть URL датасета и метод расчёта.
- **«Что изменилось»**: при новой версии отчёта сравнивать с прошлой (supersession фактов в памяти) и показывать, какие цифры и допущения сдвинулись.
- **Ролевой доступ к памяти как продуктовая фича**: аналитик видит всё, клиент видит проверенные выводы, комплаенс видит журнал источников. Attenuated-ключи уже работают.
- **Сравнение конкурентов**: один и тот же вопрос (например, капекс на ИИ) в отчётах GS, MS и JPM → где оценки расходятся и почему (разные источники или допущения).
- Arize evals на качество извлечения: доля цифр с точной цитатой, доля ложных «matches».

## 6. Как поднять всё на новом компьютере

1. `git clone https://github.com/AnalystTom/daytona_hack && cd daytona_hack && npm ci` (и `cd orchestrator && npm ci`).
2. Создать `.env` по `prototype/.env.example` из ветки archive и по списку ниже. Сам `.env` на GitHub не лежит, и так и должно быть.
   Ключи: `OPENAI_API_KEY`, `DAYTONA_API_KEY` (+`DAYTONA_TARGET=eu`), `ARIZE_API_KEY`/`ARIZE_SPACE_ID`, `SPECTRON_URL`/`SPECTRON_API_KEY` (SurrealDB Agent Memory), `SURREALDB_*` (SurrealDB Cloud instance), `ANCHORBROWSER_API_KEY`, `CLOUDFLARE_API_TOKEN`, `OPERATOR_TOKEN`/`REVERSY_OPERATOR_TOKEN`, `REVERSY_BRIDGE_TOKEN`.
3. Деплой (если нужен свой): `npm run deploy` в корне и в `orchestrator/`. Секреты Worker'ов задаются через `printf '%s' "$VALUE" | npx wrangler secret put NAME`: printf без перевода строки, иначе токены не совпадают.
4. Python-прототип: `cd prototype && uv sync && uv run python -m app.server`.
