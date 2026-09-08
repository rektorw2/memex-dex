import { migrationsOnDisk } from '../lib/migrations-on-disk.js';
import { prisma } from '../lib/prisma.js';
import { planProductionSchemaRepair } from '../lib/production-schema-repair.js';
import { readProductionSchemaSnapshot } from '../lib/production-schema-snapshot.js';

/**
 * Применена ли схема целиком — по живой базе, а не по флагу.
 *
 * Раньше ступень «сверка зачислений работает» опиралась на
 * `LIVE_MIGRATIONS_READY`, помеченный в лестнице как наблюдаемый
 * факт. Это была та же ошибка, что и с адресом узла, только тише:
 * переменная означала «оператор считает схему готовой», а читалась
 * как «схема готова». Поставить её можно одной строкой в панели
 * развёртывания — в том числе на базе, где нужных таблиц нет.
 *
 * Теперь ответ даёт тот же планировщик, что применяет миграции при
 * выкладке: он читает `information_schema`, `pg_indexes` и историю
 * `_prisma_migrations` и отвечает `ready` только когда на месте всё,
 * что он умеет проверять.
 */

export type SchemaReadinessCode =
  /** Схема применена целиком. */
  | 'READY'
  /** Есть непринятые миграции. */
  | 'PENDING'
  /** Состояние противоречиво: планировщик отказывается действовать. */
  | 'REFUSED'
  /** Прочитать состояние не удалось. Это не «готово». */
  | 'UNKNOWN';

export interface SchemaReadiness {
  ready: boolean;
  code: SchemaReadinessCode;
  /**
   * Безопасная причина: имена миграций либо машинный код отказа.
   *
   * Имена миграций секретом не являются и полезны оператору. Текста
   * ошибки драйвера здесь нет — он содержит строку подключения.
   */
  detail: string | null;
}

/**
 * Как долго ответ считается свежим.
 *
 * Снимок схемы — это девятнадцать запросов к `information_schema`, и
 * делать их на каждое открытие экрана незачем: схема меняется при
 * выкладке, а не ежесекундно. Минута выбрана так, чтобы после
 * применения миграций экран поправился сам, без перезапуска.
 */
const CACHE_TTL_MS = 60_000;

let cached: { at: number; value: SchemaReadiness } | null = null;

/** Сбрасывает кеш. Нужен тестам и после применения миграций. */
export function resetSchemaReadinessCache(): void {
  cached = null;
}

export async function readSchemaReadiness(nowMs = Date.now()): Promise<SchemaReadiness> {
  if (cached && nowMs - cached.at < CACHE_TTL_MS) return cached.value;

  const value = await computeSchemaReadiness();
  cached = { at: nowMs, value };
  return value;
}

async function computeSchemaReadiness(): Promise<SchemaReadiness> {
  try {
    const snapshot = await readProductionSchemaSnapshot(
      (sql, params) => prisma.$queryRawUnsafe<{ name: string }[]>(sql, ...params),
      migrationsOnDisk(),
    );
    const plan = planProductionSchemaRepair(snapshot);

    if (plan.action === 'ready') return { ready: true, code: 'READY', detail: null };
    if (plan.action === 'refuse') {
      return { ready: false, code: 'REFUSED', detail: plan.reason };
    }
    return { ready: false, code: 'PENDING', detail: plan.pending.join(', ') };
  } catch {
    /*
     * Прочитать не удалось — значит, не известно.
     *
     * Ровно то место, где легче всего написать «ну наверное готово»:
     * запрос упал, а экран нужно чем-то заполнить. Молчащая проверка
     * не считается пройденной — иначе однажды молчание совпадёт с
     * попыткой включить LIVE.
     */
    return { ready: false, code: 'UNKNOWN', detail: null };
  }
}
