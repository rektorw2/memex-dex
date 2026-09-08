import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Файлы миграций не выполняются вручную.
 *
 * Этот запрет пришлось вводить дважды, и оба раза он стоил целого
 * прогона. Схема выглядит безобидно:
 *
 *     await db.$executeRawUnsafe(migrationSql(name))
 *
 * а PostgreSQL отвечает `42601: cannot insert multiple commands into
 * a prepared statement`, потому что расширенный протокол не принимает
 * несколько команд в одном запросе. Первый раз это уронило подготовку
 * стенда, второй — набор перехода схемы.
 *
 * Очевидная починка — поделить файл по `;` — хуже болезни: точка с
 * запятой встречается внутри строковых литералов, тел функций и
 * `$$`-блоков, и разбор ломает миграцию тем незаметнее, чем сложнее
 * она написана.
 *
 * Правильный способ один: `prisma migrate deploy`. Контракт ниже
 * не даёт вернуться к неправильному — теперь не читая эту историю.
 *
 * Проверка текстовая, и это осознанный выбор: она защищает от
 * появления нового такого места, а не от того, что уже работает.
 * Поведенческую часть закрывают сами наборы стенда.
 *
 * Живёт вне каталога стенда намеренно: там файлы исключены из
 * обычного набора, и контракт, который запускается только вместе
 * с базой, не защищал бы ничего в повседневном прогоне.
 */

const DIR = new URL('../e2e/', import.meta.url).pathname;

/** Исходники стенда без комментариев: они рассказывают о запрете. */
function sources(): Array<{ name: string; code: string }> {
  return readdirSync(DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({
      name,
      code: readFileSync(`${DIR}${name}`, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, ''),
    }));
}

describe('SQL миграций не исполняется из тестов', () => {
  it('ни один файл не отдаёт migrationSql в сырой запрос', () => {
    /*
     * Ловится сама связка «прочитали файл миграции — выполнили».
     * Отдельно ни чтение, ни сырой запрос не запрещены: первое нужно,
     * чтобы посчитать команды, второе — чтобы прочитать историю.
     */
    for (const { name, code } of sources()) {
      expect(code, `${name}: migrationSql внутри сырого запроса`).not.toMatch(
        /\$executeRaw[A-Za-z]*\s*\(\s*[^)]*migrationSql/,
      );
      expect(code, `${name}: migrationSql в шаблоне сырого запроса`).not.toMatch(
        /\$executeRaw[A-Za-z]*`[^`]*migrationSql/,
      );
    }
  });

  it('никто не делит SQL по точке с запятой ради выполнения', () => {
    // Разбор по `;` допустим только для подсчёта команд — там нет
    // ни одного вызова выполнения рядом.
    for (const { name, code } of sources()) {
      const splits = code.match(/\.split\(\s*\/;[^)]*\)/g) ?? [];
      for (const found of splits) {
        const at = code.indexOf(found);
        const after = code.slice(at, at + 400);
        expect(after, `${name}: разбор по «;» рядом с выполнением`).not.toMatch(
          /\$executeRaw|\$queryRaw/,
        );
      }
    }
  });

  it('в стенде есть настоящий вызов migrate deploy', () => {
    /*
     * Негативный контроль к двум проверкам выше: они прошли бы и на
     * стенде, который вообще не накатывает схему.
     */
    const all = sources().map((file) => file.code).join('\n');

    expect(all).toMatch(/'migrate',\s*\n?\s*'deploy'/);
  });
});
