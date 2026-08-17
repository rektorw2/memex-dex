/**
 * Проверка соответствия базы коду. Только чтение.
 *
 * Нужна потому, что схема здесь наливается вручную, а код катится
 * автоматически: между ними бывает окно, в котором новый воркер
 * обращается к колонке, которой ещё нет. Узнавать об этом из падения
 * боевого запроса — дорого и поздно.
 *
 * Команда ничего не создаёт и не меняет: ни таблиц, ни колонок,
 * ни тестовых записей. Она отвечает на один вопрос — можно ли
 * запускать воркеры кошельков, — и на этом останавливается.
 *
 * Запуск: npm run db:check -w @memex/api
 */

import { checkSchema } from '../src/lib/schema-guard.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * Коды выхода.
 *
 * Совпадают с кодами smoke-скриптов: устаревшая схема везде 7,
 * недоступность — 3. Одинаковый смысл у одинакового числа избавляет
 * от необходимости помнить таблицу соответствий для каждой команды.
 */
export const DB_CHECK_EXIT = {
  ok: 0,
  unavailable: 3,
  outdated: 7,
} as const;

async function main(): Promise<number> {
  const result = await checkSchema();

  if (result.status === 'unavailable') {
    // Только код: текст ошибки драйвера содержит хост и пользователя
    // базы, а вывод команды попадает в журналы сборки.
    console.error('DATABASE_UNAVAILABLE');
    console.error(`Код: ${result.errorCode ?? 'unknown'}`);
    return DB_CHECK_EXIT.unavailable;
  }

  if (result.status === 'outdated') {
    console.error('DATABASE_SCHEMA_OUTDATED');
    console.error('\nНе хватает:');
    for (const item of result.missingObjects) console.error(`  · ${item}`);
    console.error(
      '\nDATABASE_SCHEMA_UPDATE_REQUIRED' +
        '\nПрименить прямым подключением (строка без -pooler):' +
        '\n  DATABASE_URL="<прямая строка>" npm run db:push',
    );
    return DB_CHECK_EXIT.outdated;
  }

  console.log('DATABASE_SCHEMA_OK');
  return DB_CHECK_EXIT.ok;
}

// Отключение в finally: висящее соединение с пулом Neon держит слот,
// а слотов на бесплатном тарифе немного.
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: any) => {
    console.error('DATABASE_UNAVAILABLE');
    console.error(`Код: ${e?.code ?? e?.name ?? 'unknown'}`);
    process.exitCode = DB_CHECK_EXIT.unavailable;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
