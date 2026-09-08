import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { assertCoreBuildFresh } from '../lib/core-build-freshness.js';
import { prismaEnv, requireE2eDatabaseUrl } from './e2e-database.js';

/**
 * Подготовка схемы перед сквозным стендом.
 *
 * Схема накатывается настоящей командой `prisma migrate deploy` — той
 * же, что выполняется при выкладке. Это не удобство, а условие
 * осмысленности стенда: если схему собирать иначе, стенд проверял бы
 * базу, которой в production не бывает.
 *
 * Почему не применяем файлы миграций сами. Первая версия так и делала:
 * читала `migration.sql` и отдавала его одним `$executeRawUnsafe`.
 * PostgreSQL отверг это с `42601: cannot insert multiple commands into
 * a prepared statement` — расширенный протокол не принимает несколько
 * команд в одном запросе. Разделять файл по `;` вручную нельзя:
 * точка с запятой встречается внутри строковых литералов, тел функций
 * и `$$`-блоков, и такой разбор ломает миграцию тем незаметнее, чем
 * сложнее она написана. Prisma умеет это правильно — пусть и делает.
 *
 * Место тоже выбрано намеренно. Подготовка стоит в `globalSetup`, а не
 * в `beforeAll`: ошибка в хуке помечает тесты пропущенными, и прогон
 * выглядит скорее пустым, чем сломанным. Отказ здесь останавливает
 * весь запуск и делает его красным — а именно этого и хочется, когда
 * схема не накатилась.
 */

const require_ = createRequire(import.meta.url);

/** Путь к локальному Prisma CLI. Никакой загрузки на лету. */
function prismaCli(): string {
  return require_.resolve('prisma/build/index.js');
}

/** Корневая схема — та же, что у production. */
function schemaPath(): string {
  return new URL('../../../../prisma/schema.prisma', import.meta.url).pathname;
}

export default function setup(): void {
  /*
   * Сборка ядра проверяется раньше базы.
   *
   * API импортирует `@memex/core` как собранный пакет. На отставшей
   * сборке прогон проверяет прошлую версию правил — и одинаково
   * легко даёт как ложное падение, так и ложный успех. Второе хуже:
   * зелёные 75 из 75 на старом коде выглядят доказательством.
   *
   * Команда `npm run test:e2e` пересобирает ядро сама; проверка
   * остаётся на случай запуска `vitest` напрямую.
   */
  assertCoreBuildFresh();

  const url = requireE2eDatabaseUrl();

  /*
   * Запуск без интерпретации оболочкой.
   *
   * Аргументы передаются массивом, `shell` не включается. Строка
   * подключения в аргументы не попадает вовсе — только в окружение,
   * поэтому она не окажется ни в списке процессов, ни в сообщении
   * об ошибке.
   */
  const result = spawnSync(
    process.execPath,
    [prismaCli(), 'migrate', 'deploy', '--schema', schemaPath()],
    {
      env: prismaEnv(url),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  if (result.error) {
    throw new Error(`Не удалось запустить Prisma CLI: ${result.error.message}`);
  }

  if (result.status !== 0) {
    /*
     * Наружу идёт вывод CLI без строки подключения.
     *
     * Prisma печатает адрес базы в заголовке — вместе с паролем,
     * если он в строке. Заголовок вырезается, остальное нужно
     * человеку, чтобы понять, что именно не так со схемой.
     */
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
      .split('\n')
      .filter((line) => !/postgres(ql)?:\/\//i.test(line))
      .filter((line) => !/Datasource .* at /i.test(line))
      .join('\n')
      .trim();

    throw new Error(
      `prisma migrate deploy завершилась с кодом ${result.status}.\n${output}`,
    );
  }
}
