/**
 * Сверка источников между собой.
 *
 * До сих пор источники использовались как поставщики чисел: берём
 * ликвидность у того, у кого она больше, цену — у первого ответившего.
 * Это ошибка, и HLZ с ликвидностью в три с половиной миллиарда — прямое
 * её следствие: одно значение было бредовым, но проверять его было
 * не с чем, и оно прошло.
 *
 * Здесь источники проверяют друг друга. Логика простая: у настоящего
 * токена GeckoTerminal, DexScreener и OKX видят один и тот же пул
 * и сообщают близкие числа. Расхождение в разы означает одно из двух —
 * либо кто-то читает поддельный пул, накачанный собственным токеном
 * проекта, либо токена по сути нет и данные случайны.
 *
 * Отдельно ценно присутствие. Токен, о котором знает один агрегатор
 * из трёх, — это либо пул возрастом в час, либо подделка, до которой
 * остальные ещё не добрались. Оба случая требуют осторожности,
 * и различить их помогает возраст пула.
 */

export interface SourceReading {
  /** Название источника для объяснения расхождения. */
  source: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  /**
   * Значение получено в этом проходе, а не взято из нашей базы.
   *
   * Различение появилось после того, как правило расхождения цен
   * заблокировало 106 токенов из 132. Причина была в круге: в базу
   * цену пишет эта же проверка, а следующий проход сравнивал с ней
   * свежие котировки и объявлял разницу подделкой. Сравнивалось
   * не мнение двух источников, а течение времени.
   *
   * Наше сохранённое значение источником не является ни в каком
   * смысле. Оно участвует в расчёте медианы, но в сверке — нет.
   */
  live?: boolean;
}

export interface CrossSourceVerdict {
  /** Сколько источников вообще знают токен. */
  known: number;
  /** Сколько источников опрашивалось. */
  queried: number;
  /** Наибольшее расхождение цены между источниками, доля. */
  priceSpread: number | null;
  /** То же по ликвидности. */
  liquiditySpread: number | null;
  /** Согласованные значения: медиана, а не максимум. */
  agreed: { priceUsd: number | null; liquidityUsd: number | null; volume24hUsd: number | null };
  blockers: string[];
  warnings: string[];
}

/**
 * Расхождение цены, выше которого стоит насторожиться.
 *
 * Двадцать процентов — с запасом на разницу пулов и задержку обновления.
 * У честного токена источники расходятся на единицы процентов.
 *
 * Само по себе больше не блокирует. Причина в том, что источники
 * опрашиваются не мгновенно и не синхронно: пока идёт цепочка запросов,
 * цена мем-коина успевает уйти, и разница в четверть между двумя
 * честными котировками — обычное дело на волатильном токене.
 */
export const MAX_PRICE_SPREAD = 0.2;

/**
 * Расхождение, которое временем не объясняется.
 *
 * Трёхкратная разница в цене между двумя источниками не бывает
 * следствием задержки: за секунды между запросами цена так не ходит.
 * Значит источники смотрят на разные пулы, и один из них —
 * накачанный собственным токеном проекта.
 */
export const ABSURD_PRICE_SPREAD = 2;

/**
 * Расхождение ликвидности. Порог выше, чем у цены: источники считают
 * её по разным пулам, и двукратная разница ещё правдоподобна.
 */
export const MAX_LIQUIDITY_SPREAD = 3;

/**
 * Медиана вместо максимума.
 *
 * Максимум был прежним способом собрать значение из нескольких
 * источников, и именно он пропускал завышенные числа: достаточно
 * одному источнику ошибиться в большую сторону. Медиана требует,
 * чтобы ошиблось большинство.
 */
function median(values: number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid]! : (clean[mid - 1]! + clean[mid]!) / 2;
}

/** Относительный разброс: (max − min) / min. */
function spread(values: Array<number | null>): number | null {
  const clean = values.filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
  if (clean.length < 2) return null;

  const min = Math.min(...clean);
  const max = Math.max(...clean);
  return min > 0 ? (max - min) / min : null;
}

export function crossCheck(
  readings: SourceReading[],
  opts: { poolAgeHours?: number | null } = {},
): CrossSourceVerdict {
  const blockers: string[] = [];
  const warnings: string[] = [];

  const queried = readings.length;
  const present = readings.filter(
    (r) => r.priceUsd != null || r.liquidityUsd != null,
  );
  const known = present.length;

  // Сверка идёт только между теми, кого спросили сейчас. Наше
  // сохранённое значение в расчёт разброса не входит: сравнивать
  // свежую котировку с собственным прошлым выводом значит измерять
  // время, а не согласие источников.
  const live = present.filter((r) => r.live !== false);

  const priceSpread = spread(live.map((r) => r.priceUsd));
  const liquiditySpread = spread(live.map((r) => r.liquidityUsd));

  const agreed = {
    priceUsd: median(present.map((r) => r.priceUsd).filter((v): v is number => v != null)),
    liquidityUsd: median(
      present.map((r) => r.liquidityUsd).filter((v): v is number => v != null),
    ),
    volume24hUsd: median(
      present.map((r) => r.volume24hUsd).filter((v): v is number => v != null),
    ),
  };

  // ─── Расхождения ────────────────────────────────────────────────────

  if (priceSpread != null && priceSpread > MAX_PRICE_SPREAD) {
    const names = live
      .filter((r) => r.priceUsd != null)
      .map((r) => `${r.source} ${r.priceUsd}`)
      .join(', ');

    if (priceSpread > ABSURD_PRICE_SPREAD) {
      // Разница в разы. Задержкой опроса это не объясняется.
      blockers.push(
        `Источники расходятся в цене в ${(priceSpread + 1).toFixed(1)} раза: ${names}. ` +
          'Значит как минимум один читает подделанный пул',
      );
    } else {
      // Заметная, но объяснимая разница. Повод для осторожности,
      // не приговор: пока идёт опрос, цена мем-коина успевает уйти.
      warnings.push(
        `Источники расходятся в цене на ${Math.round(priceSpread * 100)}%: ${names}`,
      );
    }
  }

  if (liquiditySpread != null && liquiditySpread > MAX_LIQUIDITY_SPREAD) {
    blockers.push(
      `Ликвидность у источников отличается в ${Math.round(liquiditySpread)} раз — ` +
        'скорее всего пул оценён по собственному токену проекта',
    );
  }

  // ─── Присутствие ────────────────────────────────────────────────────

  if (known === 0) {
    blockers.push('Ни один источник не знает этот токен');
  } else if (known === 1 && queried > 1) {
    const ageHours = opts.poolAgeHours;

    // Молодой пул логично известен одному источнику: остальные
    // подхватывают с задержкой. Старый — нет: за неделю его увидели
    // бы все, и то, что не увидели, само по себе признак.
    if (ageHours != null && ageHours < 24) {
      warnings.push(
        `Токен знает только ${present[0]!.source} — пулу ${ageHours.toFixed(0)} ч, ` +
          'остальные подхватывают с задержкой',
      );
    } else {
      warnings.push(
        `Из ${queried} источников токен знает только ${present[0]!.source} — ` +
          'для пула такого возраста это необычно',
      );
    }
  }

  return { known, queried, priceSpread, liquiditySpread, agreed, blockers, warnings };
}
