# Страница агента: простота

Изменения внесены поверх исходной рабочей папки. Коммитов и публикации нет.
Публичный `/paper-agent` и серверная торговая логика в этой сессии не менялись.

Первый экран отвечает на три вопроса: работает ли агент, сколько капитала и что открыто.
Настройки доступны на `/agent/settings` только ADMIN; Pro видит обзор и вкладку подготовки LIVE.

## До и после по задачам

Снимки сделаны в Chrome на одинаковых демонстрационных данных: PAPER $1 070,
PnL $70, две позиции, 406 сигналов/24ч. Это данные для проверки интерфейса,
не текущий баланс пользователя. «До» снято перед редактированием; «после» —
с готового статического экспорта. Ширины 390 и 1280 px, высоты окна 844 и 900 px.
Снимки overview/live/settings показывают полную страницу; scrolled/viewport/Pro — окно браузера.
Для связанных задач используются одни и те же исходные и итоговые снимки.

| Задача | Результат | Снимки | Файлы этой сессии |
|---|---|---|---|
| 1. Единый статус | Статус, канал, сигналы, позиции и выход в одной строке. Отдельная строка LIVE открывает подготовку. | 390px: [до](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/before-overview-390.png) / [после](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/after-overview-390.png) · 1280px: [до](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/before-overview-1280.png) / [после](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/after-overview-1280.png) | [agent-screen.tsx](/Users/myrotec/Desktop/memex-dex/apps/web/app/agent/agent-screen.tsx), [page.tsx](/Users/myrotec/Desktop/memex-dex/apps/web/app/agent/page.tsx), [agent-page.test.tsx](/Users/myrotec/Desktop/memex-dex/apps/web/app/agent/agent-page.test.tsx) |
| 2. Подготовка LIVE | Пополнение, подпись, devnet и Semi-Auto перенесены во вкладку. Диагностика администратора видна только ему. | 390px: [до](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/before-overview-390.png) / [после](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/after-live-390.png) · 1280px: [до](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/before-overview-1280.png) / [после](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/after-live-1280.png) | [agent-screen.tsx](/Users/myrotec/Desktop/memex-dex/apps/web/app/agent/agent-screen.tsx), [agent-page.test.tsx](/Users/myrotec/Desktop/memex-dex/apps/web/app/agent/agent-page.test.tsx), [deposit-status.contract.test.ts](/Users/myrotec/Desktop/memex-dex/apps/web/app/agent/deposit-status.contract.test.ts) |
| 3. Капитал и позиции | В обзоре до пяти компактных позиций; раскрытие строки показывает полную карточку. Пустое состояние — одна строка. | 390px: [до](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/before-overview-390.png) / [после](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/after-overview-390.png) · 1280px: [до](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/before-overview-1280.png) / [после](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/after-overview-1280.png) | [agent-screen.tsx](/Users/myrotec/Desktop/memex-dex/apps/web/app/agent/agent-screen.tsx), [agent-page.test.tsx](/Users/myrotec/Desktop/memex-dex/apps/web/app/agent/agent-page.test.tsx) |
| 4. Живой лог | До пяти строк: входы, выходы, частичные продажи и группа пропусков с причинами. Источник — текущая выборка API. | 390px: [до](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/before-overview-390.png) / [после](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/after-overview-390.png) · 1280px: [до](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/before-overview-1280.png) / [после](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/after-overview-1280.png) | [agent-screen.tsx](/Users/myrotec/Desktop/memex-dex/apps/web/app/agent/agent-screen.tsx), [agent-page.test.tsx](/Users/myrotec/Desktop/memex-dex/apps/web/app/agent/agent-page.test.tsx) |
| 5. Настройки | Отдельный маршрут ADMIN, три шага, проверка ввода и итог перед применением. Start/Stop/Panic в липкой панели. | 390px: [до](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/before-settings-390.png) / [после](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/after-settings-3-390.png) · 1280px: [до](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/before-settings-1280.png) / [после](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/after-settings-3-1280.png) | [agent-screen.tsx](/Users/myrotec/Desktop/memex-dex/apps/web/app/agent/agent-screen.tsx), [page.tsx](/Users/myrotec/Desktop/memex-dex/apps/web/app/agent/settings/page.tsx), [route-access.ts](/Users/myrotec/Desktop/memex-dex/packages/core/src/route-access.ts), [route-access.test.ts](/Users/myrotec/Desktop/memex-dex/packages/core/src/route-access.test.ts), [agent-page.test.tsx](/Users/myrotec/Desktop/memex-dex/apps/web/app/agent/agent-page.test.tsx), [retired-calls.contract.test.ts](/Users/myrotec/Desktop/memex-dex/apps/web/app/retired-calls.contract.test.ts) |
| 6. Мобильный | Шапка 194,5 px из 844 px (23%). После прокрутки появляется нижняя панель капитала, PnL и статуса. | 390px: [до](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/before-overview-390.png) / [после](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/after-scrolled-390.png) · 1280px: [до](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/before-overview-1280.png) / [после](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/after-scrolled-1280.png) | [agent-screen.tsx](/Users/myrotec/Desktop/memex-dex/apps/web/app/agent/agent-screen.tsx), [agent-page.test.tsx](/Users/myrotec/Desktop/memex-dex/apps/web/app/agent/agent-page.test.tsx) |
| 7. Тексты | Причины представлены словами, неизвестные коды имеют нейтральную подпись. Публичные подписи упрощены. | 390px: [до](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/before-overview-390.png) / [после](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/after-live-390.png) · 1280px: [до](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/before-overview-1280.png) / [после](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/after-live-1280.png) | [agent-screen.tsx](/Users/myrotec/Desktop/memex-dex/apps/web/app/agent/agent-screen.tsx), [SemiAutoProposals.tsx](/Users/myrotec/Desktop/memex-dex/apps/web/components/SemiAutoProposals.tsx), [agent-page.test.tsx](/Users/myrotec/Desktop/memex-dex/apps/web/app/agent/agent-page.test.tsx) |

## Все шаги мастера

| Ширина | До | Шаг 1: капитал | Шаг 2: выход | Шаг 3: подтверждение |
|---|---|---|---|---|
| 390px | [Настройки](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/before-settings-390.png) | [Шаг 1](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/after-settings-1-390.png) | [Шаг 2](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/after-settings-2-390.png) | [Шаг 3](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/after-settings-3-390.png) |
| 1280px | [Настройки](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/before-settings-1280.png) | [Шаг 1](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/after-settings-1-1280.png) | [Шаг 2](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/after-settings-2-1280.png) | [Шаг 3](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/after-settings-3-1280.png) |

Первый экран Pro: [390px](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/after-pro-390.png) · [1280px](/Users/myrotec/Desktop/memex-dex/artifacts/agent-simplicity/after-pro-1280.png).

## Проверка

Все семь задач проверены общим итоговым прогоном:

- `npm run db:generate` выполнен до изменений.
- Исходный прогон после обновления сборки ядра: core 2029, API 1677, web 415 — успешно.
- Итоговый `npm test`: core **2033**, API **1677**, web **429** — успешно.
- `DEPLOY_TARGET=pages npm run build -w @memex/web` — успешно, включая `/agent/settings/`.
- 390/1280 px: нет горизонтального переполнения; проверены вкладка LIVE и все шаги мастера.
- На 390 px нижний баланс появляется после ухода капитала из видимой области.
- Прямой вход Pro на `/agent/settings` не открывает управление; ссылка настроек у Pro отсутствует.
- `prefers-reduced-motion`: контракт проходит, в браузере анимация шапки отключена.
- `git diff --check` — без ошибок.

Первый запуск обнаружил устаревший `packages/core/dist`; сборка ядра обновлена.
После добавления тестов доступа контроль свежести также потребовал пересборку.
Итоговый прогон выполнен после неё. В логах веб-тестов остаётся прежнее сообщение
jsdom о неподдерживаемой навигации в тестах AccessStatusControl; тесты проходят.

Новые проверки покрывают прямой доступ к настройкам, отсутствие LIVE-блоков в
обзоре, старый API без плана выхода, неизвестные причины, группировку пропусков,
частичные продажи, ограничение ленты, клавиатуру, шаги мастера, сохранение ввода,
валидацию и соответствие итогового текста отправляемым параметрам.

## Решения по предложениям

A–G и J приняты: единый статус, отдельная подготовка LIVE, компактные позиции,
лента, мастер, мобильная панель, краткие причины и сохранение тёмной темы.

H пока не добавлен: дневной реализованный результат и число прибыльных сделок
не вычисляются из неполной выборки. API не расширялся. Шапка честно показывает
PnL «За всё время»; существующее изменение за 24ч доступно в подробностях капитала.

I принят частично: кольцо и постоянно видимая полоса просадки убраны, расчёты и
кривая собраны в раскрытии «Капитал подробнее». Информация доступна по нажатию.

По оставшимся вопросам использованы заявленные в начале допущения: мобильный
приоритет, подготовка LIVE доступна Pro, пять строк в ленте. Счётчик пропусков
относится к последним решениям, а не ко всем сигналам за сутки.

Строка `PAPER · АКТИВНЫЙ КОНТУР` сохранена для совместимости во вкладке LIVE
как текст для программ чтения с экрана; визуальная подпись — «PAPER · ВИРТУАЛЬНЫЙ СЧЁТ».
Обязательные тексты, USDC mint и атрибуты состояния сохранены. Новых обязательных
полей API нет. Прежние изменения API, Prisma и режимов выхода оставлены на месте.

## Изменённые файлы

- [apps/web/app/agent/agent-screen.tsx](/Users/myrotec/Desktop/memex-dex/apps/web/app/agent/agent-screen.tsx)
- [apps/web/app/agent/page.tsx](/Users/myrotec/Desktop/memex-dex/apps/web/app/agent/page.tsx)
- [apps/web/app/agent/settings/page.tsx](/Users/myrotec/Desktop/memex-dex/apps/web/app/agent/settings/page.tsx)
- [apps/web/app/agent/agent-page.test.tsx](/Users/myrotec/Desktop/memex-dex/apps/web/app/agent/agent-page.test.tsx)
- [apps/web/app/agent/deposit-status.contract.test.ts](/Users/myrotec/Desktop/memex-dex/apps/web/app/agent/deposit-status.contract.test.ts)
- [apps/web/app/retired-calls.contract.test.ts](/Users/myrotec/Desktop/memex-dex/apps/web/app/retired-calls.contract.test.ts)
- [apps/web/components/SemiAutoProposals.tsx](/Users/myrotec/Desktop/memex-dex/apps/web/components/SemiAutoProposals.tsx)
- [packages/core/src/route-access.ts](/Users/myrotec/Desktop/memex-dex/packages/core/src/route-access.ts)
- [packages/core/src/route-access.test.ts](/Users/myrotec/Desktop/memex-dex/packages/core/src/route-access.test.ts)
- [docs/paper-agent.md](/Users/myrotec/Desktop/memex-dex/docs/paper-agent.md)

Дополнительно созданы этот отчёт и PNG в `artifacts/agent-simplicity`.
`globals.css` уже был изменён до этой сессии: новые компоненты используют его
существующие анимации, дополнительных правок CSS не понадобилось.

## Что убрано с первого экрана

| Элемент | Куда переехал |
|---|---|
| Карточки PAPER/LIVE | «Подготовка LIVE»; в обзоре краткая строка LIVE |
| Пополнение, подпись, devnet, Semi-Auto | «Подготовка LIVE» |
| Настройки, Start/Stop, Panic, Learning | `/agent/settings`, только ADMIN |
| Кольцо капитала, расходы, резерв, просадка, кривая | «Капитал подробнее»; кольцо удалено |
| Четыре плитки «Путь решения» | Заменены лентой последних событий |
| Полные карточки позиций | Раскрытие строки или вкладка «Позиции» |
