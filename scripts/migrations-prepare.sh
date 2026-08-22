#!/usr/bin/env bash
#
# Создание файлов миграций. Ни одной команды к базе.
#
# Проект прожил до сих пор на `prisma db push`: схема правилась,
# команда приводила базу к новому виду, и никакой записи о том, что
# именно менялось, не оставалось. Пока таблиц мало и данные не жалко,
# это работает. Дальше — нет: `db push` умеет удалять колонку, чтобы
# схема сошлась, и делает это молча.
#
# Переход устроен так: baseline описывает базу, которая уже есть,
# и на боевой базе не выполняется никогда — только помечается
# выполненным. Всё, что появилось после, едет обычной миграцией.
#
# ВНИМАНИЕ: скрипт уже отработал. Обе миграции лежат в репозитории
# и закоммичены. Здесь он остаётся записью о том, как именно они
# получены, и средством пересоздать их, если папку миграций удалят.
# При существующих миграциях он отказывается работать.
#
# Скрипт запускается локально и ничего не применяет.
# `migrate diff --from-empty` и `--from-schema-datamodel` работают
# на файлах: подключения к базе здесь нет, DATABASE_URL не читается.
#
#   bash scripts/migrations-prepare.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

BASELINE_DIR="prisma/migrations/0_baseline"
FEATURE_NAME="add_subscriptions_and_trial"
FEATURE_DIR="prisma/migrations/$(date -u +%Y%m%d%H%M%S)_${FEATURE_NAME}"

# ── Отказы до первой записи ──────────────────────────────────────────
#
# Повторный запуск не должен переписывать уже созданные файлы.
# Миграция, которую отредактировали после применения, — это база,
# состояние которой больше никто не знает.

if [ ! -f prisma/.drift-checked ]; then
  echo "Сначала scripts/migrations-drift.sh." >&2
  echo >&2
  echo "Порядок не формальность. Baseline объявляет, что боевая база" >&2
  echo "выглядит так, как описано в снимке. Создать это объявление," >&2
  echo "не посмотрев на саму базу, значит поручиться за то, чего" >&2
  echo "никто не проверял." >&2
  exit 2
fi

if [ ! -f prisma/baseline.prisma ]; then
  echo "Нет prisma/baseline.prisma." >&2
  echo "Либо скрипт уже отработал, либо снимок схемы потерян." >&2
  exit 2
fi

if [ -f "$BASELINE_DIR/migration.sql" ]; then
  echo "$BASELINE_DIR/migration.sql уже существует. Перезапись запрещена." >&2
  exit 2
fi

if compgen -G "prisma/migrations/*_${FEATURE_NAME}" > /dev/null; then
  echo "Миграция ${FEATURE_NAME} уже создана. Перезапись запрещена." >&2
  exit 2
fi

# ── Baseline: пустая база → схема на момент перехода ─────────────────

mkdir -p "$BASELINE_DIR"
npx prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/baseline.prisma \
  --script > "$BASELINE_DIR/migration.sql"

if [ ! -s "$BASELINE_DIR/migration.sql" ]; then
  echo "Baseline вышел пустым. Это не может быть правдой — остановка." >&2
  rm -f "$BASELINE_DIR/migration.sql"
  exit 3
fi

# ── Новые модели: схема на момент перехода → текущая схема ───────────

mkdir -p "$FEATURE_DIR"
npx prisma migrate diff \
  --from-schema-datamodel prisma/baseline.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script > "$FEATURE_DIR/migration.sql"

if [ ! -s "$FEATURE_DIR/migration.sql" ]; then
  echo "Миграция новых моделей вышла пустой." >&2
  echo "Значит, baseline и schema.prisma совпадают, а этого быть не должно." >&2
  rm -rf "$FEATURE_DIR"
  exit 3
fi

# ── Проверка на разрушающие операции ─────────────────────────────────
#
# Новые таблицы не требуют ни DROP, ни ALTER существующих колонок.
# Если такое появилось, значит baseline разошёлся с schema.prisma
# сильнее, чем предполагалось, и это надо прочитать глазами прежде,
# чем оно доедет до боевой базы.

if grep -Eiq '^\s*(DROP|ALTER TABLE .* DROP)' "$FEATURE_DIR/migration.sql"; then
  echo "ВНИМАНИЕ: в миграции есть DROP. Прочитайте её целиком:" >&2
  echo "  $FEATURE_DIR/migration.sql" >&2
fi

# Снимок остаётся: на нём держится сверка боевой базы
# (scripts/migrations-drift.sh). Редактировать его нельзя —
# любая правка тихо разойдётся с тем, что уже развёрнуто.

echo
echo "Готово. Созданы файлы, к базе не обращались."
echo "  $BASELINE_DIR/migration.sql"
echo "  $FEATURE_DIR/migration.sql"
echo
echo "Дальше — прочитать обе миграции и следовать docs/migrations-runbook.md."
echo "Ничего из runbook этот скрипт не выполняет."
