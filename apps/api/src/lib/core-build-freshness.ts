import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Свежесть сборки `@memex/core` относительно её исходников.
 *
 * Зачем это существует. API импортирует ядро как собранный пакет —
 * через `packages/core/dist`, а не через `src`. Пока сборка не
 * обновлена, тесты API видят **прошлую** версию правил. Это уже
 * случилось: правка бухгалтерии в `src` дала 74/75, а после
 * `npm run build -w @memex/core` тот же прогон дал 75/75.
 *
 * Опасность не в потерянном времени, а в том, какой вывод из этого
 * делают. Устаревшая сборка одинаково легко даёт и ложное падение
 * («сломал»), и ложный успех («починил») — а второе куда хуже:
 * зелёный прогон на старом коде выглядит как доказательство.
 *
 * Проверка сравнивает время изменения: самый свежий файл `src`
 * против самого свежего файла `dist`. Она не доказывает, что сборка
 * правильная, — только что она не старше исходников. Этого хватает
 * для того случая, ради которого она написана, и она честно
 * не притворяется большим.
 */

const ROOT = new URL('../../../../', import.meta.url).pathname;
const SRC = join(ROOT, 'packages/core/src');
const DIST = join(ROOT, 'packages/core/dist');

/** Самое позднее время изменения среди файлов с нужным расширением. */
function newestMtime(dir: string, extension: string): number | null {
  let newest: number | null = null;

  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(extension)) continue;
      const time = statSync(path).mtimeMs;
      if (newest == null || time > newest) newest = time;
    }
  };

  try {
    walk(dir);
  } catch {
    return null;
  }
  return newest;
}

export interface CoreBuildFreshness {
  fresh: boolean;
  /** Понятная человеку причина. Пусто, когда всё в порядке. */
  reason: string;
}

export function coreBuildFreshness(): CoreBuildFreshness {
  const src = newestMtime(SRC, '.ts');
  const dist = newestMtime(DIST, '.js');

  if (src == null) {
    return { fresh: false, reason: 'не найдены исходники packages/core/src' };
  }
  if (dist == null) {
    return {
      fresh: false,
      reason: 'сборка packages/core/dist отсутствует — выполните npm run build -w @memex/core',
    };
  }
  if (dist < src) {
    const behind = Math.round((src - dist) / 1000);
    return {
      fresh: false,
      reason:
        `сборка packages/core/dist отстала от исходников на ${behind} с. ` +
        'Тесты API видят прошлую версию правил ядра: и падение, и успех на ней ничего не значат. ' +
        'Выполните npm run build -w @memex/core',
    };
  }

  return { fresh: true, reason: '' };
}

/** То же самое, но с исключением: для мест, где продолжать нельзя. */
export function assertCoreBuildFresh(): void {
  const verdict = coreBuildFreshness();
  if (!verdict.fresh) throw new Error(verdict.reason);
}
