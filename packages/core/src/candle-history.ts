import type { LiveChartCandle } from './chart-live.js';

/**
 * Подгрузка истории графика.
 *
 * ─── Что было ───────────────────────────────────────────────────────
 *
 * Запрос отдавал последние `limit` свечей выбранного таймфрейма
 * и не принимал курсора. Человек перетаскивал график влево, упирался
 * в край данных, и дальше ничего не происходило: старые свечи
 * не запрашивались, потому что попросить их было нечем.
 *
 * ─── Что здесь ──────────────────────────────────────────────────────
 *
 * Правила слияния страниц и решения о том, когда пора грузить
 * следующую. Без React и без сети: это арифметика на массивах,
 * и проверять её надо на массивах, а не в браузере.
 */

/**
 * Состояние истории одного графика.
 *
 * Ключ намеренно составной: пара «токен и таймфрейм». Смешать свечи
 * пятиминутки и часовика — значит нарисовать бессмысленную кривую,
 * и обнаружить это по виду графика почти невозможно.
 */
export interface CandleHistoryState {
  tokenId: string;
  interval: string;
  candles: LiveChartCandle[];
  /** Время самой старой известной свечи, секунды. Курсор следующей страницы. */
  oldest: number | null;
  /** Провайдер сказал, что дальше ничего нет. */
  exhausted: boolean;
  /** Курсоры, по которым запрос уже уходил. */
  requested: Set<number>;
  loading: boolean;
  /**
   * Курсор, на котором запрос не удался.
   *
   * Отдельно от `requested` намеренно. Неудачный курсор нельзя
   * считать пройденным — иначе повторить его будет нечем; но и
   * пытаться снова при каждом движении мыши тоже нельзя — сеть
   * лежит, а запросы уходят десятками в секунду. Поэтому край
   * замирает до явного нажатия «Повторить».
   */
  failedAt: number | null;
}

export function emptyCandleHistory(tokenId: string, interval: string): CandleHistoryState {
  return {
    tokenId,
    interval,
    candles: [],
    oldest: null,
    exhausted: false,
    requested: new Set(),
    loading: false,
    failedAt: null,
  };
}

/**
 * Запрос не удался.
 *
 * График не трогается: уже показанные свечи остаются на экране.
 * Пропала только возможность уйти левее, и об этом надо сказать
 * кнопкой, а не пустым экраном.
 */
export function markHistoryFailed(
  state: CandleHistoryState,
  cursor: number | null,
): CandleHistoryState {
  return { ...state, loading: false, failedAt: cursor };
}

/** Человек нажал «Повторить»: край снова открыт. */
export function clearHistoryFailure(state: CandleHistoryState): CandleHistoryState {
  return { ...state, failedAt: null };
}

/**
 * Слияние страницы свечей с уже загруженными.
 *
 * ─── Три правила ────────────────────────────────────────────────────
 *
 * Без дублей: страницы перекрываются по краю, и одна и та же свеча
 * приходит дважды. Дубль на графике рисуется вертикальной палкой
 * в случайном месте.
 *
 * Строго по времени: библиотека графика требует возрастающего
 * порядка и молча ломается на нарушении.
 *
 * Новее — важнее. При совпадении времени побеждает свежая запись:
 * последняя свеча живого таймфрейма меняется каждую секунду, и
 * старая страница не должна её затирать.
 */
export function mergeCandlePages(
  existing: readonly LiveChartCandle[],
  incoming: readonly LiveChartCandle[],
): LiveChartCandle[] {
  const byTime = new Map<number, LiveChartCandle>();

  for (const candle of existing) byTime.set(candle.time, candle);

  for (const candle of incoming) {
    // Пришедшее записывается поверх: страница истории приходит после
    // того, как живая свеча уже нарисована, и затирать её нельзя —
    // но и наоборот тоже. Разводится это тем, что живая свеча всегда
    // добавляется последней, отдельным шагом.
    if (!byTime.has(candle.time)) byTime.set(candle.time, candle);
  }

  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * Применить страницу истории к состоянию.
 *
 * Возвращает новое состояние. Пустая страница означает, что история
 * закончилась: запоминаем это, чтобы не спрашивать одно и то же
 * при каждом следующем перетаскивании.
 */
export function applyHistoryPage(
  state: CandleHistoryState,
  page: readonly LiveChartCandle[],
  cursor: number | null,
): CandleHistoryState {
  const requested = new Set(state.requested);
  if (cursor != null) requested.add(cursor);

  if (page.length === 0) {
    return { ...state, requested, exhausted: true, loading: false, failedAt: null };
  }

  const candles = mergeCandlePages(state.candles, page);
  const oldest = candles.length > 0 ? candles[0]!.time : state.oldest;

  return {
    ...state,
    candles,
    oldest,
    requested,
    /*
     * История считается исчерпанной, если страница не сдвинула левый
     * край. Провайдер вернул что-то, но всё это уже было — значит
     * дальше пусто, и следующий запрос принесёт ровно то же самое.
     */
    exhausted: state.oldest != null && oldest === state.oldest,
    loading: false,
    // Успех снимает прежнюю неудачу: край снова живой.
    failedAt: null,
  };
}

/**
 * Сколько свечей от левого края считается «человек подошёл к концу».
 *
 * Не ноль: подгружать в момент, когда пустота уже видна, поздно —
 * человек успевает увидеть обрыв. Двадцать свечей это примерно
 * четверть экрана на обычной ширине.
 */
export const HISTORY_PREFETCH_MARGIN = 20;

/**
 * Пора ли запрашивать следующую страницу.
 *
 * Отдельной функцией, потому что условий пять и все они про «нет»:
 * уже грузим, история кончилась, курсора ещё нет, по этому курсору
 * уже спрашивали, до края далеко. Разложенные по разным местам
 * разметки, они превращаются в запрос на каждое движение мыши.
 */
export function shouldLoadOlder(input: {
  state: CandleHistoryState;
  /** Индекс самой левой видимой свечи. Отрицательный — за краем данных. */
  visibleFrom: number;
  margin?: number;
}): boolean {
  const { state } = input;

  if (state.loading) return false;
  if (state.exhausted) return false;
  if (state.oldest == null) return false;
  if (state.requested.has(state.oldest)) return false;

  /*
   * После неудачи край замирает.
   *
   * Без этого лежащая сеть превращается в поток запросов: обработчик
   * зовётся на каждое движение видимого диапазона, а неудачный курсор
   * в `requested` не попадает — иначе повторить его было бы нечем.
   */
  if (state.failedAt === state.oldest) return false;

  return input.visibleFrom <= (input.margin ?? HISTORY_PREFETCH_MARGIN);
}

/**
 * Ушёл ли человек от живого края.
 *
 * Нужно для двух вещей сразу: не возвращать график к правому краю
 * при обновлении цены и показать кнопку «К текущей цене». Обе
 * опираются на один и тот же факт, и считать его в двух местах
 * значит однажды разойтись.
 */
export const LIVE_EDGE_TOLERANCE = 3;

export function isAwayFromLive(input: {
  visibleTo: number;
  total: number;
  tolerance?: number;
}): boolean {
  if (input.total === 0) return false;

  const tolerance = input.tolerance ?? LIVE_EDGE_TOLERANCE;
  return input.visibleTo < input.total - 1 - tolerance;
}

/**
 * Сброс при смене токена или таймфрейма.
 *
 * Возвращает прежнее состояние, если ключ не менялся: пересоздание
 * на каждый рендер стирало бы загруженную историю и курсоры,
 * и подгрузка начиналась бы заново после каждого обновления цены.
 */
export function historyFor(
  state: CandleHistoryState | null,
  tokenId: string | null,
  interval: string,
): CandleHistoryState | null {
  if (tokenId == null) return null;

  if (state != null && state.tokenId === tokenId && state.interval === interval) {
    return state;
  }

  return emptyCandleHistory(tokenId, interval);
}
