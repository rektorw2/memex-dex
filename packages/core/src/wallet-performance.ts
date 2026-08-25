/**
 * Единственный контракт результативности кошелька.
 *
 * ─── Зачем он ───────────────────────────────────────────────────────
 *
 * Знаменателей было три, и все разные:
 *
 *     settled   = wins2x + rugs        (считался и не использовался)
 *     hitRate   = wins2x / tokensBought
 *     sampleSize = tokensBought
 *
 * `wins2x` приходил из расчёта по отдельным покупкам, `tokensBought` —
 * по уникальным токенам. Десять покупок одного токена давали до десяти
 * побед при одном купленном токене, то есть долю попаданий больше
 * единицы. На экране это «данные противоречивы» рядом со Smart Score
 * 100/100.
 *
 * Отсюда правило: доля и её знаменатель считаются здесь, один раз,
 * и уезжают наружу вместе. Ни интерфейс, ни маршрут не имеют права
 * делить одно поле на другое — именно так и разошлись прежние три.
 *
 * ─── Что проверяется ────────────────────────────────────────────────
 *
 * Сводка с невозможными числами не должна выглядеть нормальной.
 * `assertSummaryInvariants` возвращает список нарушений, и вызывающий
 * обязан либо не отдавать такую сводку, либо отдать её с пометкой —
 * но не молча.
 */

import {
  wilsonLowerBound,
  MIN_TRADES_FOR_SCORE,
  WIN_MULTIPLE,
  BIG_WIN_MULTIPLE,
  RUG_MULTIPLE,
} from './wallet-score.js';
import type { WalletTokenOutcome } from './wallet-token-outcome.js';

/**
 * Версия правил расчёта.
 *
 * Растёт, когда меняется способ подсчёта. По ней видно, посчитана
 * сводка нынешними правилами или досталась от прежних — сохранённая
 * оценка не должна выглядеть свежей только потому, что лежит в базе.
 *
 * История:
 *   1 — исход считался по каждой покупке, знаменатели расходились
 *   2 — один токен даёт один оцениваемый исход
 */
export const SCORE_VERSION = 2;

/** Насколько полны данные, на которых посчитана сводка. */
export type SummaryCoverage =
  /** Все наблюдения подведены. */
  | 'complete'
  /** Часть исходов ещё ждёт наблюдений. */
  | 'partial'
  /** Оценивать нечего. */
  | 'empty'
  /**
   * Строка посчитана прежними правилами и ещё не пересчитана.
   *
   * Отдельное состояние, а не разновидность `partial`. Разница
   * в том, чего мы не знаем: при `partial` неизвестен исход части
   * токенов, при `stale` неизвестно вообще ничего — сохранённые
   * числа считались другим способом, и подгонять их к новому
   * контракту значит выдавать старую ошибку за исправленный
   * результат.
   */
  | 'stale';

export interface WalletPerformanceSummary {
  /** Сколько разных токенов кошелёк покупал. */
  observedTokens: number;
  /** Из них с подведённым и достоверным исходом. Знаменатель доли. */
  scorableOutcomes: number;
  /** Ждут наблюдений. Не проигрыши. */
  pendingOutcomes: number;
  /** Исходы с недостоверной базой. В оценку не идут. */
  ambiguousOutcomes: number;

  wins2x: number;
  wins5x: number;
  rugs: number;

  /** Доля попаданий, 0–1. null — считать не из чего. */
  hitRate: number | null;
  /** Нижняя граница доли: на малой выборке она честнее самой доли. */
  hitRateLower: number | null;

  /** Средняя кратность, взвешенная по объёму входа. */
  avgPeakMultiple: number | null;
  medianEntryHours: number | null;
  buyVolumeUsd: number;

  /** null до минимальной выборки. Отсутствие оценки — тоже сведения. */
  score: number | null;
  confidence: 'none' | 'low' | 'medium' | 'high';
  coverage: SummaryCoverage;
  reason: string | null;

  /**
   * Когда сводка была посчитана. `null` — неизвестно.
   *
   * Прежде здесь стояло `Date.now()` в момент чтения, то есть время
   * открытия страницы. Поле называлось «когда посчитано», а отвечало
   * на вопрос «когда прочитано», и по нему нельзя было отличить
   * свежий пересчёт от строки, лежащей без изменений полгода.
   */
  computedAt: number | null;
  /**
   * Версия правил, по которым посчитана эта сводка. `null` —
   * строка досталась от прежних правил и ещё не пересчитана.
   *
   * Подставлять сюда текущую версию при чтении нельзя: это ровно
   * то заявление, которое поле призвано опровергать.
   */
  scoreVersion: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Уверенность в оценке.
 *
 * Отдельно от самой оценки намеренно. Две сделки и двести сделок
 * могут дать одну и ту же долю попаданий, и показывать их одинаково
 * значит вводить в заблуждение ровно там, где на кону деньги.
 */
function confidenceOf(scorable: number): WalletPerformanceSummary['confidence'] {
  if (scorable < MIN_TRADES_FOR_SCORE) return 'none';
  if (scorable < 10) return 'low';
  if (scorable < 30) return 'medium';
  return 'high';
}

export interface SummaryInput {
  outcomes: WalletTokenOutcome[];
  now?: number;
  /** Готовая оценка 0–100, посчитанная общим движком. */
  score?: number | null;
}

/**
 * Сводка по исходам токенов.
 *
 * На входе — исходы по токенам, а не покупки. Это и есть исправление:
 * `scorableOutcomes` не может оказаться меньше числа побед, потому что
 * победы считаются из того же списка.
 */
export function walletPerformanceSummary(input: SummaryInput): WalletPerformanceSummary {
  const { outcomes } = input;
  const now = input.now ?? Date.now();

  const scorable = outcomes.filter((o) => o.status === 'scorable');
  const pending = outcomes.filter((o) => o.status === 'pending');
  const ambiguous = outcomes.filter((o) => o.status === 'ambiguous');

  const wins2x = scorable.filter((o) => (o.peakMultiple ?? 0) >= WIN_MULTIPLE).length;
  const wins5x = scorable.filter((o) => (o.peakMultiple ?? 0) >= BIG_WIN_MULTIPLE).length;
  const rugs = scorable.filter((o) => (o.peakMultiple ?? 0) <= RUG_MULTIPLE).length;

  const buyVolumeUsd = outcomes.reduce(
    (s, o) => s + (Number.isFinite(o.buyVolumeUsd) ? o.buyVolumeUsd : 0),
    0,
  );

  const entryHours = outcomes
    .map((o) => o.entryHours)
    .filter((h): h is number => h != null && Number.isFinite(h) && h >= 0);

  /*
   * Средняя кратность взвешивается объёмом входа.
   *
   * Кошелёк, заходящий крупно именно в удачные токены, отличается
   * от того, кто ставит одинаково везде и попадает случайно.
   * Неоднозначные исходы сюда не входят: именно они и давали 4130×.
   */
  const weightTotal = scorable.reduce((s, o) => s + Math.max(o.buyVolumeUsd, 1), 0);

  const avgPeakMultiple =
    scorable.length > 0 && weightTotal > 0
      ? scorable.reduce((s, o) => s + (o.peakMultiple ?? 0) * Math.max(o.buyVolumeUsd, 1), 0) /
        weightTotal
      : null;

  const enough = scorable.length >= MIN_TRADES_FOR_SCORE;

  return {
    observedTokens: outcomes.length,
    scorableOutcomes: scorable.length,
    pendingOutcomes: pending.length,
    ambiguousOutcomes: ambiguous.length,

    wins2x,
    wins5x,
    rugs,

    hitRate: scorable.length > 0 ? wins2x / scorable.length : null,
    hitRateLower: scorable.length > 0 ? wilsonLowerBound(wins2x, scorable.length) : null,

    avgPeakMultiple,
    medianEntryHours: median(entryHours),
    buyVolumeUsd,

    /*
     * До минимальной выборки оценки нет, и это не осторожность,
     * а точность: на двух исходах любое число было бы выдумкой.
     * Интерфейс показывает «Собираем историю», а не 100/100.
     */
    score: enough ? (input.score ?? null) : null,
    confidence: confidenceOf(scorable.length),
    coverage:
      outcomes.length === 0 ? 'empty' : pending.length > 0 || ambiguous.length > 0 ? 'partial' : 'complete',
    reason: enough
      ? null
      : `Оцениваемых исходов: ${scorable.length} из ${MIN_TRADES_FOR_SCORE} необходимых`,

    computedAt: now,
    scoreVersion: SCORE_VERSION,
  };
}

// ─────────────────────────────── Инварианты ─────────────────────────────────

/**
 * Что не может быть правдой ни при каких данных.
 *
 * Возвращает список нарушений; пустой список означает, что сводку
 * можно показывать. Проверка существует потому, что невозможные
 * числа уже доходили до экрана и выглядели там обычными: доля
 * попаданий больше единицы читается как «очень хороший кошелёк»,
 * а не как «расчёт сломан».
 */
export function assertSummaryInvariants(s: WalletPerformanceSummary): string[] {
  const broken: string[] = [];

  if (s.wins5x > s.wins2x) broken.push('WINS5X_ABOVE_WINS2X');
  if (s.wins2x > s.scorableOutcomes) broken.push('WINS_ABOVE_SCORABLE');
  if (s.rugs > s.scorableOutcomes) broken.push('RUGS_ABOVE_SCORABLE');
  if (s.scorableOutcomes > s.observedTokens) broken.push('SCORABLE_ABOVE_OBSERVED');

  if (s.pendingOutcomes + s.ambiguousOutcomes + s.scorableOutcomes !== s.observedTokens) {
    broken.push('OUTCOME_PARTS_DO_NOT_SUM');
  }

  if (s.hitRate != null && (s.hitRate < 0 || s.hitRate > 1)) broken.push('HIT_RATE_OUT_OF_RANGE');
  if (s.hitRateLower != null && (s.hitRateLower < 0 || s.hitRateLower > 1)) {
    broken.push('HIT_RATE_LOWER_OUT_OF_RANGE');
  }

  if (s.score != null && (s.score < 0 || s.score > 100)) broken.push('SCORE_OUT_OF_RANGE');

  // Оценка на недостаточной выборке — ровно тот случай,
  // из-за которого два исхода превращались в 100/100.
  if (s.score != null && s.scorableOutcomes < MIN_TRADES_FOR_SCORE) {
    broken.push('SCORE_WITHOUT_SAMPLE');
  }

  /*
   * Оценка обязана быть подписана правилами и временем.
   *
   * Без версии нельзя сказать, каким способом получено число;
   * без времени — когда. И то и другое прежде подставлялось при
   * чтении, поэтому любая строка выглядела свежей и современной,
   * включая ту, что не пересчитывалась ни разу.
   */
  if (s.score != null && s.scoreVersion == null) broken.push('SCORE_WITHOUT_VERSION');
  if (s.score != null && s.computedAt == null) broken.push('SCORE_WITHOUT_COMPUTED_AT');

  /*
   * Строка, ожидающая пересчёта, не отчитывается о результатах.
   *
   * Показать её старые wins рядом с новым знаменателем — это и есть
   * «зажать неправильные числа и выдать за исправленные». Пока
   * пересчёт не прошёл, честный ответ один: неизвестно.
   */
  if (s.coverage === 'stale') {
    if (s.score != null) broken.push('SCORE_ON_STALE_SUMMARY');

    if (
      s.scorableOutcomes !== 0 ||
      s.wins2x !== 0 ||
      s.wins5x !== 0 ||
      s.rugs !== 0 ||
      s.hitRate != null ||
      s.avgPeakMultiple != null
    ) {
      broken.push('STALE_SUMMARY_REPORTS_OUTCOMES');
    }
  }

  return broken;
}

/** Годится ли сводка для показа без оговорок. */
export function summaryIsSound(s: WalletPerformanceSummary): boolean {
  return assertSummaryInvariants(s).length === 0;
}

/**
 * Пустая сводка.
 *
 * Нужна там, где кошелёк известен, а наблюдений ещё нет: показывать
 * нули как результат нельзя, но и отсутствие полей ломает интерфейс.
 */
export function emptyWalletSummary(now = Date.now()): WalletPerformanceSummary {
  return walletPerformanceSummary({ outcomes: [], now });
}

export const NEEDS_RECOMPUTE_REASON =
  'Статистика ожидает пересчёта: сохранённые числа посчитаны прежними правилами';

/**
 * Сводка строки, которая ещё не пересчитана новыми правилами.
 *
 * ─── Почему нельзя показать то, что лежит в базе ────────────────────
 *
 * Старая строка хранит `wins2x`, посчитанный по отдельным покупкам,
 * и `tokensBought`, посчитанный по уникальным токенам. Знаменателя
 * у неё нет вовсе — его тогда не хранили. Любая попытка собрать
 * из этих полей современную сводку требует выдумать недостающее,
 * а выдуманное потом неотличимо от посчитанного.
 *
 * ─── Почему нули, а не старые числа ─────────────────────────────────
 *
 * Ноль здесь не выдаётся за результат: `coverage` равен `stale`,
 * `reason` говорит прямо, `score` пуст, а инвариант
 * `STALE_SUMMARY_REPORTS_OUTCOMES` запрещает такой сводке нести
 * какие-либо результаты вообще. Интерфейс обязан показать
 * «ожидает пересчёта», а не «0 побед из 0».
 *
 * После `rescoreAllWallets --apply` строка получает настоящую сводку
 * и это состояние исчезает.
 */
export function needsRecomputeSummary(
  stored: { scoreVersion?: number | null; computedAt?: number | null } = {},
): WalletPerformanceSummary {
  return {
    observedTokens: 0,
    scorableOutcomes: 0,
    pendingOutcomes: 0,
    ambiguousOutcomes: 0,

    wins2x: 0,
    wins5x: 0,
    rugs: 0,

    hitRate: null,
    hitRateLower: null,

    avgPeakMultiple: null,
    medianEntryHours: null,
    buyVolumeUsd: 0,

    score: null,
    confidence: 'none',
    coverage: 'stale',
    reason: NEEDS_RECOMPUTE_REASON,

    // Что известно — сообщается как есть. Версия прежних правил
    // и время последней записи, если они были сохранены.
    computedAt: stored.computedAt ?? null,
    scoreVersion: stored.scoreVersion ?? null,
  };
}

/** Ждёт ли строка пересчёта. Один вопрос — одно место ответа. */
export function summaryNeedsRecompute(s: WalletPerformanceSummary): boolean {
  return s.coverage === 'stale';
}
