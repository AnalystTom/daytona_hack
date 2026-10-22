# Reversy — полная память проекта

Обновлено 21 Oct 2026. Этот файл нужен, чтобы восстановить контекст проекта на новом компьютере (себе или Claude) и думать, как встроить его в будущий продукт.
**Ключей и паролей здесь нет.** Только названия, где их взять и где они используются.

---

## 0. Как загрузить эту память обратно в Claude на новом компьютере

1. `git clone https://github.com/AnalystTom/daytona_hack && cd daytona_hack && git checkout archive/python-prototype`. Этот файл лежит там в `docs/reversy-memory.md`; копия есть в Google Drive.
2. Запустить Claude Code в папке проекта и сказать: «прочитай docs/reversy-memory.md, это память проекта».
3. Если нужно, чтобы Claude помнил это всегда: попросить «сохрани ключевое из этого файла в память». Он разложит факты в `~/.claude/projects/<папка>/memory/`.

---

## 1. Контекст

- **Хакатон:** Daytona HackSprint NYC с Arize AI, 16 Oct 2026, AWS JFK27 (12 W 39th St).
  - Дедлайн Devpost 15:30 EDT.
  - Требования: публичный GitHub, видео до 2 минут, описание и список всех спонсорских инструментов.
  - Критерии: impact, техника, креативность и презентация, по 25% каждый; плюс бонус за осмысленное использование спонсорских инструментов.
  - Призы «Best use of» были у Daytona, Arize, Anchor, SurrealDB и ElevenLabs.
- **Команда:**
  - Julia: оркестрация, песочницы Daytona, Firstmate, ролевая память SurrealDB, report mode v1, Devpost.
  - Thomas / AnalystTom (thomasmann2001): бэкенд, UI, Cloudflare-аккаунт, финальная интеграция; после хакатона много PR через свой Firstmate.
- **Репозиторий:** https://github.com/AnalystTom/daytona_hack (владелец Thomas).
- **Живой сайт:** https://reversy.thomasmann2001.workers.dev (Cloudflare-аккаунт Thomas).
  - После отзыва ключей Julia 21 Oct сайт частично не работает (хранилище, память, скриншоты, сборка), пока Thomas не поставит свои.
- **Спеки в репо:** `docs/spec.md` (продукт), `docs/orchestrator/spec.md` (система агентов).

## 2. Идея и как она эволюционировала

1. **Утро 16 Oct, Python-прототип** (`prototype/` в ветке `archive/python-prototype`). Конвейер «reverse-engineering финансовых отчётов»: взять открытый отчёт конкурента (GS, MS, Bloomberg), извлечь цифры с цитатами, найти базы, новости и отчёты, на которых он построен, проверить, сохранить в SurrealDB Agent Memory и дать голосовую сводку через ElevenLabs.
   Вдохновение: https://surrealdb.com/explore/agent-memory-for-financial-services. Там claims, память, обновление документа и «что изменилось».
2. **Командный продукт Reversy** (спека Thomas): «Take it apart. Make it yours.» Берёшь сайт и получаешь спеку, доказательства (скриншоты, HTML) и пересборку агентами в песочнице с ревью и верификацией. Julia взяла на себя оркестрацию.
3. **Report mode**: идея Julia, встроенная в Reversy (PR #11). Thomas развил её в главный сценарий демо (PR #26, #32): дашборд происхождения цифр на канвасе.

## 3. Что умеет продукт сейчас (main)

### Report mode (главный сценарий)
Бриф: `<URL отчёта> Reconstruct this report: rebuild its key figures and the investment breakdown as an editable page, link every number to where it appears in the source, and mark anything not observed.`
**URL вставлять одной строкой.** Если перенос строки обрежет ссылку, захватится «Page Not Found», а в той же сессии это уже не исправить.

Что делает:
- захватывает статью и встроенные диаграммы (Anchor; есть запасные пути на случай, когда code execution выключен);
- извлекает цифры: короткая метка, значение, единицы, период и точная цитата. Отбрасывает boilerplate («157 Years of Excellence»), годы и даты; повторы одной цифры склеивает, сохраняя все места;
- ищет первоисточники онлайн (OpenAI web search, бюджет около 4 вызовов и 6 загрузок);
- **строгое сопоставление**: «matches» только при том же значении, единице, масштабе и валюте; сомнительное идёт в «unverified» с обеими цитатами; непроверяемое помечается «not observed»;
- дашборд на канвасе: сводка (Figures read / Not observed / Sources in the article / Traced online / Named, not found), разбивка инвестиций из диаграммы (US / Global ex-US × public / private / non-US), таблица ключевых цифр и раздел «Sources and datasets»;
- редактирование: правки помечены, оригиналы хранятся в SurrealDB.

Пример на статье GS «Global AI Investment Is Forecast to Exceed $1 Trillion in 2026»:
- 25 цифр;
- разбивка из диаграммы: US 530/35/15, Global ex-US 234/67/138 ($bn);
- цифры $1T, $800bn (капекс гиперскейлеров), $581bn (AI-инвестиции США).

Версия Julia (PR #11, v1) дополнительно пересчитывала капекс по **SEC EDGAR XBRL** (companyconcept API):
- MSFT, GOOGL, META и ORCL: `PaymentsToAcquirePropertyPlantAndEquipment`; AMZN: `PaymentsToAcquireProductiveAssets`;
- кварталы получены разностью year-to-date отчётов;
- календарный 2025: $411.5bn (MSFT 83.1, GOOGL 91.4, AMZN 131.8, META 69.7, ORCL 35.5); H1 2026: $329.9bn;
- вывод: прогноз $800bn на 2026 требует, чтобы H2 превысил H1 на 42.5%. Цифры $1T и $581bn по SEC не проверяемы, и это объяснено.
**Хорошая идея для будущего: вернуть пересчёт из первичных данных в основной продукт.**

### Website mode
URL сайта → захват (скриншоты и HTML как доказательства со статусами observed / inferred / not_observed) → спека, согласуемая в чате → план задач с зависимостями и владением файлами → параллельные Codex-воркеры в песочнице Daytona (до 12, reasoning medium) → ревьюер → merge → превью → верификатор по каждой задаче и финальный.
Ещё есть REA (PR #29): разбор JS-бандлов сайта во временной песочнице и карточка «Code evidence».
Демо на daytona.io (запуск 03b191c5): t01 (фундамент) слит, t02 и t03 упали на ревью, t04–t08 так и не стартовали. Этот запуск до сих пор стоит дефолтным примером на `/workspace`, и для показа его лучше заменить.

### Доступ
- Вход через Cloudflare Access (PR #20).
- Посетители и судьи запускают без operator token, у каждого свои запуски и лимит в день (PR #25).
- Операторские маршруты защищены `OPERATOR_TOKEN`.

## 4. Архитектура

```
Браузер ── reversy (Cloudflare Worker: UI + API /api/v1, Access, лимиты)
              │ service binding ORCHESTRATOR
              ▼
         reversy-orchestrator (приватный Worker, workers_dev=false)
              Durable Object «Run» на каждый запуск, цикл на alarm
              фазы: brief → inspecting → planning → planned → building → done
              ├─ Anchor Browser: скриншоты / fetch
              ├─ OpenAI: чат, план, ревью, верификатор (сейчас gpt-6-luna), web search для отчётов
              ├─ Daytona: песочница (daytona-medium, регион eu), Codex-воркеры, превью :3000
              ├─ SurrealDB Cloud: записи запусков, отчётов, правок, пример
              ├─ SurrealDB Agent Memory: ролевые ключи на участника
              └─ Arize: OTLP-трейсы, один трейс на запуск
```

### Ключевые технические детали (то, что не очевидно)
- **Daytona.**
  - REST `app.daytona.io/api`; toolbox через `proxy.app-eu.daytona.io/toolbox/{id}`; `process/execute` и асинхронные сессии.
  - Превью: `https://3000-{id}.daytonaproxy01.eu` с `public: true`.
  - Регион us был недоступен, используем eu.
  - Со стандартным snapshot нельзя задавать свои ресурсы, поэтому берём `daytona-medium`.
  - Полный интернет только на Tier 3, и только у песочниц, созданных после его включения.
- **Codex в песочнице.**
  - Запуск: `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -m <model> -c model_reasoning_effort=medium < /dev/null`. Без `< /dev/null` он зависает; собственный sandbox Codex в контейнере не работает, изоляция обеспечивается самой песочницей Daytona.
  - Для git worktree нужен trust в конфиге.
  - Воркеру прямо сказано: исходный сайт недоступен, серверы не запускать; `timeout 900`.
- **Ревью.** Diff по файлам, до 5 KB на файл и 70 KB всего. Владение файлами нормализует абсолютные пути. Без этого ревьюер отклонял нормальную работу.
- **Firstmate** (kunchenguid/firstmate): вторая, «тяжёлая» оркестрация внутри песочницы, в демо не используется.
  - Устройство: tmux, treehouse worktrees, `state/fleet-ledger.jsonl`, реестр `data/projects.md`, no-mistakes с агентом codex.
  - Gitea 28.1 вместо Forgejo: Codeberg был заблокирован, а Gitea проще и быстрее. Нужны INTERNAL_TOKEN и LOCAL_ROOT_URL; запуск через `setsid nohup`.
  - tea ставить из модуля `gitea.dev/tea@v0.16.0`: `@latest` даёт тег 2019 года. `tea login` неидемпотентен, поэтому сначала delete, потом add.
  - Merge guard требует зелёный combined commit status, отсюда свой `sandbox/ci.mjs`.
  - `sandbox/bridge.mjs` переводит ledger в события UI; CLI `sandbox/reversy` даёт агентам capture, remember, recall и say.
- **SurrealDB Agent Memory.**
  - Bearer-ключи `sp-…`. API: `<SPECTRON_URL>/api/v1/<CONTEXT_ID>/{facts,query,context,scopes,keys}`.
  - **Ролевой доступ:** `POST /keys` с attenuated `grants` (verb → список scopes). Оркестратор, воркер задачи и верификатор получают разные ключи; воркер видит только свою задачу и общий контекст запуска.
  - Для вложенных scopes нужны паттерны `${run}/*`, иначе 403.
  - `observed_at` работает только с `infer: full|triples`. Чтобы факты разных авторов не вытесняли друг друга, сущность заводится на пару (автор, метрика).
  - `asOf`: что было известно на дату.
- **Arize.** OTLP/HTTP JSON на `otlp.arize.com/v1/traces` с заголовками `space_id` и `api_key`; trace id = id запуска без дефисов.
- **Cloudflare secrets** ставить только через `printf '%s' "$V" | npx wrangler secret put NAME`. С переводом строки токены не совпадали, на этом потеряли время.
- **Bridge-авторизация** у Thomas: `HMAC-SHA256(BRIDGE_TOKEN, runId)`.
- **UI** опрашивает события раз в 2 секунды, а в простое и в фазе brief — раз в 15 секунд. Результаты отчёта приходят через 1,5–3 минуты, их нужно подождать или обновить страницу.

## 5. Хронология PR (main)

- #4–#9 (16 Oct): лендинг, канбан, run API с SurrealDB и SSE, песочница с Firstmate, Anchor. #9 закрепил решение: **демо-движок — Cloudflare-оркестратор**, Firstmate остаётся вторым движком.
- #10, #12: приватный оркестратор за front door с operator token, сессионная cookie, подписанные ссылки на превью.
- #11 (Julia, открыт, но по сути влит в #26): report mode v1 и фикс ревью.
- #14, #18, #22, #27, #28, #30, #31: надёжность захвата (Anchor, редиректы, отказ code execution, бюджет поиска, User-Agent).
- #15, #21: сессии, канвас с зумом и перетаскиванием, сохранённый пример по умолчанию.
- #16, #17: scope запуска из брифа, ссылки без протокола.
- #20, #25: Access-вход, лимиты, запуски без токена.
- #26, #32: report dissection и дашборд происхождения цифр.
- #29: REA.
- #33 (18 Oct): шлюз Nicrron и кнопки 44px для телефона.
- #34 (20 Oct): возврат на OpenAI, модель `gpt-6-luna`, потому что у Nicrron кончились кредиты (402).

Ветки Julia на GitHub:
- `orchestrator`: песочница, Firstmate, память, `docs/devpost.md`, `docs/orchestrator/handoff.md`. В main не слита, часть кода оттуда Thomas переписал.
- `fix/review-diff`: PR #11.
- `archive/python-prototype`: прототип и этот файл.

## 6. Уроки и известные баги

- Перенос строки в URL брифа ломает запуск. Если поправить адрес в чате, бот пишет «updated the target», но **страницу заново не снимает**. Нужна новая сессия. Это баг, о нём надо сказать Thomas.
- Дефолтный пример на `/workspace` — неудачная сборка. Заменить можно через `POST /api/v1/example {runId}` с operator token.
- Сборка сайта агентами хрупкая: падение базовой задачи блокирует всё дерево зависимостей. Report mode надёжнее, и для финансов ценнее.
- Python с python.org на macOS не видит сертификаты. Помогает `truststore.inject_into_ssl()` или `SSL_CERT_FILE` на бандл certifi.
- Во время хакатона ключи пересылались через чат. 21 Oct Julia отозвала Daytona, Anchor, Arize и SurrealDB Agent Memory (проверено: 401/403). OpenAI и ElevenLabs оставлены. Cloudflare-токен принадлежит Thomas, его должен отозвать он. Пользователя SurrealDB Cloud `reversy_api` (инстанс `zealous-falcon`) проверить в Studio и удалить.

## 7. Ключи: шаблон (без значений)

Значения хранить в менеджере паролей, не в Drive и не в git. Файл `.env` в корне репозитория лежит в gitignore.

| Переменная | Где взять | Где используется | Статус 21 Oct |
|---|---|---|---|
| `OPENAI_API_KEY`, `LLM_MODEL` | platform.openai.com → API keys | оркестратор, верификатор, web search, Codex | действует |
| `DAYTONA_API_KEY`, `DAYTONA_TARGET=eu` | app.daytona.io → Keys | песочницы | отозван |
| `ANCHORBROWSER_API_KEY` | app.anchorbrowser.io → API keys | скриншоты и fetch | отозван |
| `ARIZE_API_KEY`, `ARIZE_SPACE_ID`, `ARIZE_SPACE`, `ARIZE_DEFAULT_PROJECT` | app.arize.com → Settings → API Keys | трейсинг | отозван |
| `SPECTRON_URL`, `SPECTRON_CONTEXT_ID`, `SPECTRON_API_KEY` | SurrealDB Studio → Agent Memory → context | ролевая память | отозван |
| `SURREALDB_URL`, `SURREALDB_NAMESPACE`, `SURREALDB_DATABASE`, `SURREALDB_USER`, `SURREALDB_PASSWORD` | SurrealDB Cloud → инстанс → Authentication (пользователь с правами на ns/db) | хранилище запусков и отчётов | проверить или удалить `reversy_api` |
| `ELEVENLABS_API_KEY` | elevenlabs.io → API Keys | голос в прототипе | действует |
| `CLOUDFLARE_API_TOKEN` | у Thomas | деплой Worker'ов | токен Thomas |
| `OPERATOR_TOKEN`, `GATEWAY_TOKEN`, `REVERSY_OPERATOR_TOKEN`, `REVERSY_BRIDGE_TOKEN` | генерируются (`openssl rand -hex 32`) и ставятся как secret на Worker | front door и bridge | сменить при новом деплое |
| `REVERSY_API_URL`, `REVERSY_GATEWAY_URL` | URL Worker'ов | скрипты песочницы | — |

Кредиты хакатона (промокоды) лежат в `prototype/.env.example`. Скорее всего, они уже истекли.

## 8. Как поднять на новом компьютере

1. Поставить Node 22+, `uv` (Python), git и gh; войти: `gh auth login`.
2. `git clone https://github.com/AnalystTom/daytona_hack && cd daytona_hack && npm ci && (cd orchestrator && npm ci)`.
3. Создать `.env` по таблице выше, взяв значения из менеджера паролей.
4. Свой деплой: `npm run deploy` в корне и в `orchestrator/` (нужен свой Cloudflare-аккаунт), затем secrets через `printf … | wrangler secret put`.
5. Прототип: `git checkout archive/python-prototype && cd prototype && uv sync`.

## 9. Идеи для будущего продукта

- **Граф происхождения цифр** для любых финансовых документов: sell-side отчёты, investor decks, 10-K/10-Q, earnings calls. Цепочка «цифра → цитата → первоисточник → проверка», каждая цифра — узел в SurrealDB с историей (`asOf`).
- **Коннекторы к первичным данным:** SEC XBRL (уже работало), FRED, ECB/Eurostat, World Bank, IR компаний. Каждая проверка воспроизводима: URL датасета, метод и пересчёт.
- **«Что изменилось»:** новая версия отчёта сравнивается с прошлой (supersession фактов), видно, какие цифры и допущения сдвинулись.
- **Ролевой доступ к памяти как фича:** аналитик видит всё, клиент видит проверенные выводы, комплаенс видит журнал источников. Attenuated-ключи уже работают.
- **Сравнение домов:** один вопрос (например, капекс на ИИ) в отчётах GS, MS и JPM; где расходятся и почему (разные источники или допущения).
- **Evals в Arize:** доля цифр с точной цитатой, доля ложных «matches», полнота найденных источников.
- **Безопасность:** текст сайтов и отчётов — данные, а не инструкции (защита от prompt injection). Изоляция в песочнице. Верификатор независим от исполнителя.
