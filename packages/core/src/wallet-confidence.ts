/**
 * Уверенность в оценке кошелька — отдельно от самой оценки.
 *
 * Это главное различие всей страницы, и оно нужно потому, что два
 * разных утверждения постоянно путают.
 *
 * «Восемьдесят два из ста» говорит, насколько хороши результаты.
 * «Насколько этому можно верить» говорит, сколько за этими
 * результатами наблюдений. Кошелёк с одной удачной сделкой на десять
 * концов и кошелёк с восемнадцатью сделками и той же долей попаданий
 * получают близкие баллы, но доверия заслуживают несопоставимо
 * разного.
 *
 * Смешать их в одно число нельзя: тогда либо удачливый новичок
 * выглядит мастером, либо мастер занижен из-за короткой истории.
 * Поэтому здесь два значения, и интерфейс обязан показывать оба.
 *
 * Нижняя граница доверительного интервала (wilsonLowerBound
 * в wallet-score.ts) уже учитывает размер выборки в самой оценке.
 * Этот модуль отвечает за то, чтобы человек видел размер выборки
 * своими глазами, а не доверял поправке, о которой не знает.
 */

import { MIN_TRADES_FOR_SCORE } from './wallet-score.js';

export type Confidence = 'high' | 'medium' | 'low' | 'none';

export interface ConfidenceInfo {
  level: Confidence;
  /** Подпись для человека. */
  label: string;
  /** Ключ цвета. Никогда не единственный носитель смысла. */
  tone: 'up' | 'warn' | 'muted';
  /** Пояснение: почему уверенность такая. */
  explanation: string;
}

/**
 * Пороги выборки.
 *
 * Пять сделок — минимум, при котором вообще выставляется оценка:
 * на четырёх одна удача даёт двадцать пять процентов разницы
 * в доле попаданий, и такая оценка колеблется сильнее, чем
 * различает кошельки.
 *
 * Пятнадцать — граница, за которой доля попаданий перестаёт
 * заметно прыгать от одной новой сделки. Число не универсальное,
 * но именно на этом порядке величин выборка начинает описывать
 * поведение, а не совпадение.
 */
export const HIGH_CONFIDENCE_TRADES = 15;
export const MEDIUM_CONFIDENCE_TRADES = MIN_TRADES_FOR_SCORE;

export function confidenceOf(settled: number | null | undefined): ConfidenceInfo {
  const n = settled ?? 0;

  if (n <= 0) {
    return {
      level: 'none',
      label: 'Нет завершённых сделок',
      tone: 'muted',
      explanation:
        'Кошелёк отслеживается, но ни одна его покупка ещё не получила исход. ' +
        'Оценивать нечего.',
    };
  }

  if (n < MEDIUM_CONFIDENCE_TRADES) {
    return {
      level: 'low',
      label: 'Собираем историю',
      tone: 'muted',
      explanation:
        `Завершённых сделок ${n} из ${MEDIUM_CONFIDENCE_TRADES}, нужных для первой оценки. ` +
        'На такой выборке одна удача меняет картину целиком.',
    };
  }

  if (n < HIGH_CONFIDENCE_TRADES) {
    return {
      level: 'medium',
      label: 'Средняя уверенность',
      tone: 'warn',
      explanation:
        `Выборка из ${n} сделок уже что-то говорит, но остаётся короткой: ` +
        'несколько новых исходов могут заметно сдвинуть оценку.',
    };
  }

  return {
    level: 'high',
    label: 'Высокая уверенность',
    tone: 'up',
    explanation:
      `Выборка из ${n} завершённых сделок достаточна, чтобы оценка описывала ` +
      'поведение кошелька, а не стечение обстоятельств.',
  };
}

/**
 * Насколько далеко до первой оценки.
 *
 * Нужно вместо повторяющейся плашки «оценки нет». Та встречается
 * у большинства кошельков, ничего не объясняет и читается как брак
 * в данных. Прогресс отвечает на настоящий вопрос: сколько ещё ждать.
 */
export function progressToScore(settled: number | null | undefined): {
  done: number;
  needed: number;
  ratio: number;
  text: string;
} {
  const done = Math.max(0, Math.min(settled ?? 0, MEDIUM_CONFIDENCE_TRADES));
  return {
    done,
    needed: MEDIUM_CONFIDENCE_TRADES,
    ratio: done / MEDIUM_CONFIDENCE_TRADES,
    text: `${done} из ${MEDIUM_CONFIDENCE_TRADES} сделок для первой оценки`,
  };
}

// ─────────────────────────── Форматирование ─────────────────────────────────

/**
 * Доля удачных сделок в виде, который нельзя прочитать неверно.
 *
 * Прежняя подпись «выросли x2: 3 из 2» содержала невозможное:
 * успешных больше, чем всего. Такое число подрывает доверие
 * ко всей странице сильнее, чем отсутствие числа, поэтому здесь
 * есть явная проверка — и она возвращает признак ошибки, а не
 * молча подгоняет значения.
 */
export interface WinRateView {
  text: string;
  /** Данные противоречивы: успешных больше, чем всего. */
  isImpossible: boolean;
  pct: number | null;
}

export function winRateView(wins: number | null, settled: number | null): WinRateView {
  const w = wins ?? 0;
  const s = settled ?? 0;

  if (s <= 0) {
    return { text: 'нет завершённых', isImpossible: false, pct: null };
  }

  if (w > s) {
    // Не прячем и не исправляем: это ошибка в данных, и о ней
    // должно быть видно, что она есть.
    return { text: 'данные противоречивы', isImpossible: true, pct: null };
  }

  const pct = Math.round((w / s) * 100);
  return { text: `${w}/${s} · ${pct}%`, isImpossible: false, pct };
}

/**
 * Кратность: «3.6×», «4×», «12×».
 *
 * Отсутствие показывается прочерком, а не нулём: ноль означал бы,
 * что все сделки обнулились, а это другое утверждение.
 *
 * Ровная кратность пишется без дробной части. «4.0×» читается хуже
 * «4×» и подсказывает точность, которой в этом числе нет: десятая
 * доля икса не значит ничего ни при оценке кошелька, ни при оценке
 * роста цены.
 */
export function formatMultiple(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v <= 0) return '—';

  const text = v.toFixed(v >= 10 ? 0 : 1);

  return `${text.endsWith('.0') ? text.slice(0, -2) : text}×`;
}

/**
 * Медианное время входа после запуска токена.
 *
 * Прежнее «обычный вход: 0.0 ч» было худшим из возможных вариантов:
 * ноль с десятичной долей выглядит как сбой измерения, хотя означает
 * ровно обратное — вход в первые минуты, то есть самое ценное
 * свойство кошелька.
 */
export function formatEntryTime(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours) || hours < 0) return '—';

  const min = hours * 60;
  if (min < 1) return '<1 мин';
  if (min < 60) return `${Math.round(min)} мин`;
  if (hours < 24) return hours < 10 ? `${hours.toFixed(1)} ч` : `${Math.round(hours)} ч`;

  const d = hours / 24;
  return d < 10 ? `${d.toFixed(1)} дн` : `${Math.round(d)} дн`;
}

// ─────────────────────────── Категории кошельков ────────────────────────────

export type WalletCategory = 'whale' | 'early' | 'steady' | 'new' | 'none';

export const CATEGORY_LABELS: Record<WalletCategory, string> = {
  whale: 'Кит',
  early: 'Ранний',
  steady: 'Стабильный',
  new: 'Новый',
  none: 'Без категории',
};

export const CATEGORY_EXPLAIN: Record<WalletCategory, string> = {
  whale: 'Крупные покупки: объём заметно выше остальных отслеживаемых',
  early: 'Входит в первые часы после запуска пула',
  steady: 'Долгая история с устойчивой долей удачных сделок',
  new: 'Отслеживается недавно, история ещё копится',
  none: 'Ни один признак пока не выражен',
};

/**
 * Категория по накопленным данным.
 *
 * Отдельно от метки label из wallet-score: та отвечает на вопрос
 * «стоит ли учитывать сигнал», эта — «чем этот кошелёк отличается
 * от соседнего в списке». Второе нужно для фильтров и для того,
 * чтобы человек мог выбрать себе тип поведения, а не только балл.
 */
export function categorize(input: {
  settled: number | null;
  volumeUsd: number | null;
  medianEntryHours: number | null;
  score: number | null;
  whaleVolumeUsd?: number;
  earlyHours?: number;
}): WalletCategory {
  const whaleAt = input.whaleVolumeUsd ?? 50_000;
  const earlyAt = input.earlyHours ?? 6;
  const settled = input.settled ?? 0;

  if ((input.volumeUsd ?? 0) >= whaleAt) return 'whale';

  if (input.medianEntryHours != null && input.medianEntryHours <= earlyAt) return 'early';

  // «Стабильный» требует и длинной истории, и приличного балла:
  // одно без другого описывает либо старательного неудачника,
  // либо везучего новичка.
  if (settled >= HIGH_CONFIDENCE_TRADES && (input.score ?? 0) >= 50) return 'steady';

  if (settled < MEDIUM_CONFIDENCE_TRADES) return 'new';

  return 'none';
}
