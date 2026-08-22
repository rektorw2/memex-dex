#!/usr/bin/env bash
#
# Расхождение боевой базы со снимком схемы. Только чтение.
#
# Вопрос ровно один: та ли база сейчас развёрнута, которую описывает
# prisma/baseline.prisma. Если нет — помечать baseline выполненным
# нельзя: Prisma поверит на слово и перестанет замечать разницу,
# а разница никуда не денется.
#
# Расхождение здесь ожидаемо, а не исключительно. Схему меняли
# командой `db push` не один раз, и след от таких изменений
# существует только в самой базе.
#
# Строка подключения читается из ~/.memex-prod-url и никуда не
# выводится: ни в вывод, ни в ошибки, ни в историю команд. Вывод
# программы дополнительно пропускается через замену — Prisma любит
# называть хост в тексте ошибки.
#
#   bash scripts/migrations-drift.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

URL_FILE="$HOME/.memex-prod-url"
MARKER="prisma/.drift-checked"

if [ ! -f "$URL_FILE" ]; then
  echo "Нет $URL_FILE." >&2
  echo "Положите туда прямую строку подключения (без -pooler) одной строкой." >&2
  exit 2
fi

if [ ! -f prisma/baseline.prisma ]; then
  echo "Нет prisma/baseline.prisma — сравнивать не с чем." >&2
  exit 2
fi

# Замена всего, что похоже на адрес и на учётные данные. Ошибки
# Prisma нужны целиком, но без этой их части.
redact() {
  sed -E \
    -e 's#postgres(ql)?://[^[:space:]"]*#postgresql://[скрыто]#g' \
    -e 's#[A-Za-z0-9._-]+\.(neon\.tech|aws\.neon\.tech|render\.com|amazonaws\.com)#[скрыто]#g' \
    -e 's#(password|user|host)=[^[:space:]&"]*#\1=[скрыто]#g'
}

echo "Читаю боевую схему. Записи не будет."

set +e
DIFF_OUT=$(
  DATABASE_URL="$(cat "$URL_FILE")" npx prisma migrate diff \
    --from-schema-datasource prisma/baseline.prisma \
    --to-schema-datamodel prisma/baseline.prisma \
    --script 2>&1
)
CODE=$?
set -e

if [ $CODE -ne 0 ]; then
  echo "Не удалось прочитать боевую схему:" >&2
  printf '%s\n' "$DIFF_OUT" | redact >&2
  exit 3
fi

# Объекты, которых язык схемы Prisma не описывает.
#
# Их создаёт SQL, дописанный в миграцию вручную. Prisma о них не знает
# и при каждом сравнении предлагает их удалить. Список поимённый,
# а не по шаблону: «игнорировать всё, что похоже на индекс» однажды
# скроет настоящее расхождение.
KNOWN_UNSUPPORTED='Subscription_one_active_per_user'

# Пустой diff Prisma оформляет комментарием, а не пустым файлом.
BODY=$(
  printf '%s\n' "$DIFF_OUT" \
    | grep -vE "$KNOWN_UNSUPPORTED" \
    | grep -vE '^\s*(--|$)' || true
)

if [ -n "$BODY" ]; then
  echo
  echo "Боевая база расходится со снимком схемы."
  echo "Ниже SQL, который привёл бы её к виду baseline.prisma."
  echo "Выполнять его не нужно — это описание разницы, а не план."
  echo
  printf '%s\n' "$DIFF_OUT" | redact
  echo
  echo "Дальше по runbook: разницу либо переносят в baseline.prisma,"
  echo "либо объясняют, почему она допустима. Пометка выполненного"
  echo "baseline не создана."
  exit 4
fi

date -u +%Y-%m-%dT%H:%M:%SZ > "$MARKER"
echo
echo "Расхождений нет: боевая база совпадает со снимком схемы."
echo "Создана пометка $MARKER — без неё migrations-prepare.sh не запустится."
