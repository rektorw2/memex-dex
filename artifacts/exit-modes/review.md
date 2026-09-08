# Карточки правил выхода — иллюстрированные, с анимацией

Изменения внесены поверх рабочей папки. Коммитов и публикации нет. API и торговая
механика не менялись: сцена каждой карточки считается тем же `evaluatePaperExit`
из `@memex/core`, что ведёт настоящие позиции.

## Что получилось

Пять карточек на `/agent/settings`, шаг «2. Выход». У каждой три слоя:

1. **Авторский фон** — программно нарисованный графит с одним образом на режим:
   цель (кольца), защита (плита и шкала времени), ступени (три блока), сопровождение
   после фиксации (волны и лесенка после точки), сопровождение с входа (лента и лесенка
   от начала). Сжат в WebP/AVIF, два кадрирования: телефон и десктоп. 90 892 байта (≈91 КБ) на все 20 файлов.
2. **Текст** — настоящий HTML: название, тег, одно объяснение, до четырёх параметров,
   «Подробнее» с полным описанием правила из ядра.
3. **Сцена** — SVG по одной и той же условной траектории (вход → 1.6× → 2× → 2.4× → откат):
   линия цены, уровни ступеней/цели, лесенка стопа, отметки продаж, точка закрытия,
   подпись «закрыто · сценарий завершён». Все числа — из пресетов ядра.

Что видно на одной траектории:

| Режим | Что произошло на сцене |
|---|---|
| Цель 2× | закрыто целиком на 2.02× — выход по цели; защиты нет |
| Защищённый | стоп 0.65× не задет; закрыто целиком на 2.02× — выход по цели |
| Лестница | 40% на 1.62×, 30% на 2.02×, стоп → безубыток → трейлинг; остаток закрыт на 1.77× (трейлинг 1.81×) |
| Трейлинг | стоп 0.5× до 2×; 50% на 2.02×; остаток закрыт на 1.17× (трейлинг 1.20×) |
| Чистый трейлинг | стоп идёт за максимумом с входа; 50% на 2.02×; остаток закрыт на 1.17× (трейлинг 1.20×) |

Разница Трейлинг / Чистый трейлинг видна лесенкой стопа до 2×: у первого он ровный на 0.5×,
у второго поднимается с первой секунды.

## Анимация

- Появление карточки при попадании в область видимости (opacity/transform, с каскадом).
- Выбранная карточка после первого появления на экране проигрывает демонстрацию 3,6 с один раз: уровни → цена и стоп
  открываются слева направо (маска `scaleX`, не размеры) → отметки продаж в свой момент →
  точка закрытия → подпись завершения. Повтор — кнопкой «↻ Повторить показ».
- Остальные карточки статичны в итоговом состоянии. Ни одного бесконечного цикла.
- `prefers-reduced-motion`: та же картинка без движения, кнопки повтора нет.
  Изменение системной настройки учитывается без перезагрузки. Контракт-тест проверяет, что каждый анимированный `.agent-*` класс отключён.
- Размеры карточек не анимируются; сцена имеет фиксированные пропорции — вёрстка не прыгает.

## Доступность и управление

- `role="radiogroup"` / `role="radio"`, `aria-checked`, `data-exit-mode` сохранены.
- Стрелки ↑↓←→ переключают режим и переносят фокус; видимый фокус — кольцо на карточке.
- Сцена — `role="img"` с текстовым итогом («Лестница: На общей траектории: 40% на 1.62×…»).
- Кнопка повтора и «Подробнее» вынесены из radio-кнопки (вложенные интерактивные элементы недопустимы).
- Правки администратора (стоп, трейлинг, время) пересчитывают сцену выбранной карточки.

## Файлы

Код:
- `apps/web/lib/exit-scene.ts` — сцена: траектория, прогон ядра, геометрия (чистый модуль)
- `apps/web/components/agent/ExitModeCard.tsx` — карточка и SVG-сцена
- `apps/web/app/agent/agent-screen.tsx` — подключение карточек, клавиатура
- `apps/web/app/globals.css` — фон, пелена, анимации сцены, reduced-motion
- `apps/web/scripts/exit-mode-cards.tsx`, `apps/web/scripts/tsconfig.json` — экспорт изображений
- `apps/web/tsconfig.json` — `scripts` исключён из сборки приложения
- `apps/web/app/agent/agent-page.test.tsx` — проверки карточек, появления в кадре, изменения reduced motion и подтверждения чистого трейлинга
- `apps/web/app/retired-calls.contract.test.ts` — разбор CSS без обратного перебора

Изображения:
- `apps/web/public/exit-modes/<режим>-{desktop,mobile}.{webp,avif}` — фоны для сайта
- `artifacts/exit-modes/<режим>-desktop.png` (2400×1350) и `-mobile.png` (1350×2400) — полные карточки
- `artifacts/exit-modes/layers/<режим>-{art,scene,text}.png` — слои (фон, сцена, текст)
- `artifacts/exit-modes/screens/` — до/после 390 и 1280 px, середина демонстрации, reduced-motion, фокус
- `artifacts/exit-modes/demo.webm`, `demo.gif` — запись демонстрации (выбор → повтор → другой режим)

Пересобрать изображения: `cd apps/web && npx tsx --tsconfig scripts/tsconfig.json scripts/exit-mode-cards.tsx`
(геометрия детерминирована; растровый результат также зависит от установленных шрифтов и версии растеризатора).

В среде с ограничением локальных IPC-сокетов: `cd apps/web && TSX_TSCONFIG_PATH=scripts/tsconfig.json node --import tsx scripts/exit-mode-cards.tsx`.

## Проверки

- `npm run build -w @memex/core` — ок; core **2037** тестов — ок; API **1677** — ок.
- web: проверка типов в статической сборке чистая, **437** тестов — ок.
- `DEPLOY_TARGET=pages next build` — ок, `/agent/settings/` и `exit-modes/` в экспорте.
- 390 и 1280 px: без горизонтального переполнения; демонстрация, reduced-motion, клавиатура — снимки в `screens/`.

## Ограничения

- Фоны созданы программно (SVG → растр), без нейросетевой генерации. В этой проверке художественный стиль не заменялся.
- Шрифты в экспортных PNG — системные (Inter/JetBrains Mono, если установлены; иначе DejaVu).


## Финальная перепроверка

Повторно выполнены сборка ядра, полный прогон тестов, экспорт изображений и
статическая сборка. После обнаруженных правок повторены все веб-тесты и сборка.
Торговая логика ядра и API в этой проверке не менялись.

Исправлены три проблемы:

1. Демонстрация выбранной карточки могла завершиться до прокрутки к ней. Теперь она ждёт первого появления карточки на экране.
2. Изменение reduced motion теперь сразу отключает демонстрацию и кнопку повтора.
3. В итог мастера вернулись ошибочные «без стопа» и «после ступени 0». Для чистого трейлинга восстановлено «трейлинг −50% с момента входа», добавлена проверка отправляемого режима.

Экспорты пересобраны: 10 полных PNG, каждый 2400 px по длинной стороне,
15 PNG-слоёв, 20 файлов WebP/AVIF. Размеры и SHA-256 записаны в manifest.json.
Снимки «после» обновлены по готовой сборке, исходные «до» сохранены.
Снимки и видео используют демонстрационные PAPER-данные, а не реальный баланс.

Новое видео: WebM (VP8), 1280×900, 15,68 с. GIF построен из той же записи,
800×562, 12 кадров/с. Проверено декодирование всей записи и просмотр контрольного кадра.

| Проверка браузера | 390 px | 1280 px |
|---|---|---|
| Все пять карточек, фоны загружены | Да | Да |
| Горизонтальное переполнение | Нет | Нет |
| Выбор, демонстрация и подтверждение | Да | Да |
| Reduced motion без перезагрузки | Да | Да |
| Выбор стрелками и фокус | Покрыто общим тестом | Проверено в браузере |
| Ошибки JavaScript | 0 | 0 |

## Готовые изображения

| Режим | Десктоп · 2400×1350 | Телефон · 1350×2400 |
|---|---|---|
| Цель 2× | [PNG](/Users/myrotec/Desktop/memex-dex/artifacts/exit-modes/target-desktop.png) | [PNG](/Users/myrotec/Desktop/memex-dex/artifacts/exit-modes/target-mobile.png) |
| Защищённый | [PNG](/Users/myrotec/Desktop/memex-dex/artifacts/exit-modes/protected-desktop.png) | [PNG](/Users/myrotec/Desktop/memex-dex/artifacts/exit-modes/protected-mobile.png) |
| Лестница | [PNG](/Users/myrotec/Desktop/memex-dex/artifacts/exit-modes/ladder-desktop.png) | [PNG](/Users/myrotec/Desktop/memex-dex/artifacts/exit-modes/ladder-mobile.png) |
| Трейлинг | [PNG](/Users/myrotec/Desktop/memex-dex/artifacts/exit-modes/trailing-desktop.png) | [PNG](/Users/myrotec/Desktop/memex-dex/artifacts/exit-modes/trailing-mobile.png) |
| Чистый трейлинг | [PNG](/Users/myrotec/Desktop/memex-dex/artifacts/exit-modes/trailing-pure-desktop.png) | [PNG](/Users/myrotec/Desktop/memex-dex/artifacts/exit-modes/trailing-pure-mobile.png) |

[Видео](/Users/myrotec/Desktop/memex-dex/artifacts/exit-modes/demo.webm) · [GIF](/Users/myrotec/Desktop/memex-dex/artifacts/exit-modes/demo.gif) · [Экран 390 px](/Users/myrotec/Desktop/memex-dex/artifacts/exit-modes/screens/after-390.png) · [Экран 1280 px](/Users/myrotec/Desktop/memex-dex/artifacts/exit-modes/screens/after-1280.png)

## Протоколы проверки

- [Размеры, хеши и итог проверок](/Users/myrotec/Desktop/memex-dex/artifacts/exit-modes/verification/manifest.json)
- [Полный прогон до исправлений интерфейса](/Users/myrotec/Desktop/memex-dex/artifacts/exit-modes/verification/full-tests.log)
- [Итоговый прогон веб-тестов](/Users/myrotec/Desktop/memex-dex/artifacts/exit-modes/verification/final-web-tests.log)
- [Итоговая статическая сборка](/Users/myrotec/Desktop/memex-dex/artifacts/exit-modes/verification/static-build.log)
- [Экспорт изображений](/Users/myrotec/Desktop/memex-dex/artifacts/exit-modes/verification/image-export.log)
- [Браузерные проверки](/Users/myrotec/Desktop/memex-dex/artifacts/exit-modes/verification/browser-checks.jsonl)
