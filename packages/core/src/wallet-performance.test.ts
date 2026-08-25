import { describe, it, expect } from 'vitest';
import {
  foldTokenOutcomes,
  MIN_TRUSTWORTHY_MCAP_USD,
  SUPPLY_DISAGREEMENT_FACTOR,
  supplyDisagreement,
  type WalletBuyObservation,
} from './wallet-token-outcome.js';
import {
  assertSummaryInvariants,
  emptyWalletSummary,
  summaryIsSound,
  walletPerformanceSummary,
  needsRecomputeSummary,
  summaryNeedsRecompute,
  NEEDS_RECOMPUTE_REASON,
  SCORE_VERSION,
} from './wallet-performance.js';
import { scoreWallet, MIN_TRADES_FOR_SCORE } from './wallet-score.js';

/**
 * Живой случай `GXUC1A…b928f`.
 *
 * На странице: Smart Score 100/100, «Собираем историю», «данные
 * противоречивы», средний максимум 4130× и повторяющаяся покупка
 * `s8Ws…pump`. Всё это следствия одной ошибки — исход считался
 * по каждой покупке, а знаменатель по уникальным токенам.
 */

const CHAIN = 'SOLANA' as const;
const PUMP = 's8WsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump';
const OTHER = 'BbbbBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBmoon';

const AT = 1_756_000_000_000;
const HOUR = 3_600_000;

const buy = (over: Partial<WalletBuyObservation> = {}): WalletBuyObservation => ({
  chain: CHAIN,
  tokenAddress: PUMP,
  amountUsd: 50,
  poolAgeHours: 0.5,
  tradedAt: AT,
  outcomeMultiple: 4175,
  mcapAtTradeUsd: 50_000,
  ...over,
});

/**
 * Живая выборка: восемь покупок одного `s8Ws…pump` и одна другого.
 * Уникальных токенов два — ровно как показано на экране.
 */
const LIVE_CASE: WalletBuyObservation[] = [
  ...Array.from({ length: 8 }, (_, i) =>
    buy({ tradedAt: AT + i, amountUsd: 12.5, outcomeMultiple: 4175 }),
  ),
  buy({ tokenAddress: OTHER, tradedAt: AT + 5 * HOUR, outcomeMultiple: 1.4 }),
];

describe('прежняя модель и была дефектом', () => {
  it('исход по каждой покупке давал восемь побед на одном токене', () => {
    /*
     * Так считал `rescoreWallets`: список покупок, а не токенов.
     * Восемь строк одного токена превращались в восемь независимых
     * успехов.
     */
    const perBuy = scoreWallet(
      LIVE_CASE.map((b) => ({
        amountUsd: b.amountUsd,
        outcomeMultiple: b.outcomeMultiple,
        poolAgeHours: b.poolAgeHours,
      })),
    );

    // Восемь покупок PUMP выше двух иксов; девятая, другого токена,
    // выросла только в 1.4 раза и победой не считается.
    expect(perBuy.wins2x).toBe(8);

    // А `tokensBought` в базе считался по уникальным токенам.
    const tokensBought = new Set(LIVE_CASE.map((b) => b.tokenAddress)).size;
    expect(tokensBought).toBe(2);

    // Отсюда и «данные противоречивы»: доля попаданий 400%.
    expect(perBuy.wins2x / tokensBought).toBeGreaterThan(1);
  });

  it('и оценка выставлялась на этой выборке', () => {
    // Девять «исходов» превышали минимальную выборку, поэтому
    // кошелёк с двумя настоящими токенами получал 100/100.
    const perBuy = scoreWallet(
      LIVE_CASE.map((b) => ({
        amountUsd: b.amountUsd,
        outcomeMultiple: b.outcomeMultiple,
        poolAgeHours: b.poolAgeHours,
      })),
    );

    expect(perBuy.score).not.toBeNull();
  });
});

describe('живой случай после исправления', () => {
  const outcomes = foldTokenOutcomes(LIVE_CASE);
  const summary = walletPerformanceSummary({ outcomes, now: AT, score: 100 });

  it('девять покупок дают два исхода', () => {
    expect(outcomes).toHaveLength(2);
    expect(summary.observedTokens).toBe(2);
  });

  it('побед не больше, чем оцениваемых исходов', () => {
    expect(summary.wins2x).toBeLessThanOrEqual(summary.scorableOutcomes);
    expect(summary.wins2x).toBe(1);
  });

  it('оценки нет: выборка мала', () => {
    /*
     * Ключевой результат. Два исхода — это не «сто из ста»,
     * а «пока не знаем». Интерфейс показывает прогресс до
     * минимальной выборки.
     */
    expect(summary.score).toBeNull();
    expect(summary.confidence).toBe('none');
    expect(summary.reason).toContain(String(MIN_TRADES_FOR_SCORE));
  });

  it('повторные покупки остаются объёмом, а не победами', () => {
    const pump = outcomes.find((o) => o.tokenAddress === PUMP)!;

    expect(pump.buyCount).toBe(8);
    expect(pump.buyVolumeUsd).toBe(100);
  });

  it('доля попаданий в допустимых пределах', () => {
    // Прежде она была 450%.
    expect(summary.hitRate).toBeGreaterThanOrEqual(0);
    expect(summary.hitRate).toBeLessThanOrEqual(1);
  });

  it('сводка не нарушает ни одного инварианта', () => {
    expect(assertSummaryInvariants(summary)).toEqual([]);
    expect(summaryIsSound(summary)).toBe(true);
  });
});

describe('один токен — один исход', () => {
  it('десять покупок одного токена дают один оцениваемый исход', () => {
    const outcomes = foldTokenOutcomes(
      Array.from({ length: 10 }, (_, i) => buy({ tradedAt: AT + i })),
    );

    expect(outcomes).toHaveLength(1);
    expect(walletPerformanceSummary({ outcomes }).scorableOutcomes).toBe(1);
  });

  it('два разных токена дают максимум две победы', () => {
    const outcomes = foldTokenOutcomes([
      buy({ tradedAt: AT }),
      buy({ tradedAt: AT + 1 }),
      buy({ tokenAddress: OTHER, tradedAt: AT + 2 }),
      buy({ tokenAddress: OTHER, tradedAt: AT + 3 }),
    ]);

    expect(walletPerformanceSummary({ outcomes }).wins2x).toBeLessThanOrEqual(2);
  });

  it('точкой входа служит первая покупка', () => {
    /*
     * Умение найти токен проявляется один раз. Брать максимум
     * по всем покупкам нельзя: докупка на дне превратила бы
     * неудачный вход в удачный.
     */
    const outcomes = foldTokenOutcomes([
      buy({ tradedAt: AT, outcomeMultiple: 0.5, poolAgeHours: 2 }),
      buy({ tradedAt: AT + HOUR, outcomeMultiple: 900, poolAgeHours: 3 }),
    ]);

    expect(outcomes[0]!.peakMultiple).toBe(0.5);
    expect(outcomes[0]!.entryHours).toBe(2);
  });

  it('порядок поступления на результат не влияет', () => {
    const forward = foldTokenOutcomes([
      buy({ tradedAt: AT, outcomeMultiple: 3 }),
      buy({ tradedAt: AT + HOUR, outcomeMultiple: 900 }),
    ]);

    const reverse = foldTokenOutcomes([
      buy({ tradedAt: AT + HOUR, outcomeMultiple: 900 }),
      buy({ tradedAt: AT, outcomeMultiple: 3 }),
    ]);

    expect(reverse[0]!.peakMultiple).toBe(forward[0]!.peakMultiple);
  });

  it('регистр адреса не создаёт второй токен', () => {
    const outcomes = foldTokenOutcomes([
      buy({ chain: 'BNB', tokenAddress: '0xABC' }),
      buy({ chain: 'BNB', tokenAddress: '0xabc', tradedAt: AT + 1 }),
    ]);

    expect(outcomes).toHaveLength(1);
  });

  it('разные сети не смешиваются', () => {
    const outcomes = foldTokenOutcomes([
      buy({ chain: 'BNB', tokenAddress: '0xabc' }),
      buy({ chain: 'BASE', tokenAddress: '0xabc', tradedAt: AT + 1 }),
    ]);

    expect(outcomes).toHaveLength(2);
  });
});

describe('незавершённое не считается проигрышем', () => {
  it('покупка без подведённого исхода ждёт', () => {
    const outcomes = foldTokenOutcomes([buy({ outcomeMultiple: null })]);

    expect(outcomes[0]!.status).toBe('pending');
    expect(outcomes[0]!.reason).toBe('AWAITING_OBSERVATIONS');
  });

  it('ожидание не попадает ни в знаменатель, ни в rugs', () => {
    const outcomes = foldTokenOutcomes([
      buy({ outcomeMultiple: null }),
      buy({ tokenAddress: OTHER, tradedAt: AT + 1, outcomeMultiple: 3 }),
    ]);

    const s = walletPerformanceSummary({ outcomes });

    expect(s.observedTokens).toBe(2);
    expect(s.scorableOutcomes).toBe(1);
    expect(s.pendingOutcomes).toBe(1);
    expect(s.rugs).toBe(0);
  });
});

describe('база кратности', () => {
  it('капитализация в несколько долларов делает исход неоднозначным', () => {
    /*
     * Ровно источник 4130× и 4175×. Кратность считается как
     * пик / база; при базе в десятки долларов любой обычный рост
     * даёт тысячи иксов, и отличить ранний вход от ошибки единиц
     * измерения невозможно.
     */
    const outcomes = foldTokenOutcomes([buy({ mcapAtTradeUsd: 10, outcomeMultiple: 4175 })]);

    expect(outcomes[0]!.status).toBe('ambiguous');
    expect(outcomes[0]!.reason).toBe('IMPLAUSIBLE_MCAP_BASE');
  });

  it('число сохраняется, а не прячется', () => {
    // Прятать нельзя: это сведения. Нельзя только считать их оценкой.
    const outcomes = foldTokenOutcomes([buy({ mcapAtTradeUsd: 10, outcomeMultiple: 4175 })]);

    expect(outcomes[0]!.peakMultiple).toBe(4175);
  });

  it('неоднозначный исход не идёт ни в знаменатель, ни в среднюю кратность', () => {
    const outcomes = foldTokenOutcomes([
      buy({ mcapAtTradeUsd: 10, outcomeMultiple: 4175 }),
      buy({ tokenAddress: OTHER, tradedAt: AT + 1, outcomeMultiple: 3, mcapAtTradeUsd: 80_000 }),
    ]);

    const s = walletPerformanceSummary({ outcomes });

    expect(s.ambiguousOutcomes).toBe(1);
    expect(s.scorableOutcomes).toBe(1);
    expect(s.avgPeakMultiple).toBe(3);
  });

  it('неизвестная база тоже неоднозначна', () => {
    const outcomes = foldTokenOutcomes([buy({ mcapAtTradeUsd: null })]);

    expect(outcomes[0]!.status).toBe('ambiguous');
    expect(outcomes[0]!.reason).toBe('UNKNOWN_MCAP_BASE');
  });

  it('настоящая большая кратность на достоверной базе не обрезается', () => {
    /*
     * Порог доверия к знаменателю — не потолок кратности.
     * Ранний вход в токен с капитализацией в сто тысяч и рост
     * в тысячу раз сохраняется как есть.
     */
    const outcomes = foldTokenOutcomes([
      buy({ mcapAtTradeUsd: 100_000, outcomeMultiple: 1_000 }),
    ]);

    expect(outcomes[0]!.status).toBe('scorable');
    expect(outcomes[0]!.peakMultiple).toBe(1_000);
  });

  it('порог доверия ровно на границе', () => {
    const below = foldTokenOutcomes([buy({ mcapAtTradeUsd: MIN_TRUSTWORTHY_MCAP_USD - 1 })]);
    const at = foldTokenOutcomes([buy({ mcapAtTradeUsd: MIN_TRUSTWORTHY_MCAP_USD })]);

    expect(below[0]!.status).toBe('ambiguous');
    expect(at[0]!.status).toBe('scorable');
  });
});

describe('инварианты сводки', () => {
  const outcomes = foldTokenOutcomes(LIVE_CASE);
  const good = walletPerformanceSummary({ outcomes, now: AT });

  it('нормальная сводка нарушений не даёт', () => {
    expect(assertSummaryInvariants(good)).toEqual([]);
  });

  it.each([
    ['больше побед, чем исходов', { wins2x: 99 }, 'WINS_ABOVE_SCORABLE'],
    ['пятикратных больше двукратных', { wins5x: 99, wins2x: 1 }, 'WINS5X_ABOVE_WINS2X'],
    ['rugs больше исходов', { rugs: 99 }, 'RUGS_ABOVE_SCORABLE'],
    ['доля вне диапазона', { hitRate: 4.5 }, 'HIT_RATE_OUT_OF_RANGE'],
    ['оценка вне диапазона', { score: 500, scorableOutcomes: 10 }, 'SCORE_OUT_OF_RANGE'],
  ])('%s ловится', (_name, over, code) => {
    expect(assertSummaryInvariants({ ...good, ...over })).toContain(code);
  });

  it('оценка при недостаточной выборке — нарушение', () => {
    /*
     * Тот самый 100/100 при двух исходах. Такая сводка не должна
     * сериализоваться как нормальный результат.
     */
    const broken = { ...good, score: 100, scorableOutcomes: 2 };

    expect(assertSummaryInvariants(broken)).toContain('SCORE_WITHOUT_SAMPLE');
    expect(summaryIsSound(broken)).toBe(false);
  });

  it('части исходов складываются в наблюдаемые токены', () => {
    expect(
      assertSummaryInvariants({ ...good, observedTokens: 99 }),
    ).toContain('OUTCOME_PARTS_DO_NOT_SUM');
  });
});

describe('пустая сводка', () => {
  const s = emptyWalletSummary(AT);

  it('нули не выдаются за результат', () => {
    expect(s.hitRate).toBeNull();
    expect(s.avgPeakMultiple).toBeNull();
    expect(s.score).toBeNull();
  });

  it('состояние названо явно', () => {
    expect(s.coverage).toBe('empty');
    expect(s.confidence).toBe('none');
  });

  it('инварианты соблюдены и на пустоте', () => {
    expect(assertSummaryInvariants(s)).toEqual([]);
  });

  it('версия правил проставлена', () => {
    expect(s.scoreVersion).toBe(SCORE_VERSION);
  });
});

describe('достаточная выборка', () => {
  it('пять исходов открывают оценку', () => {
    const outcomes = foldTokenOutcomes(
      Array.from({ length: MIN_TRADES_FOR_SCORE }, (_, i) =>
        buy({ tokenAddress: `Token${i}111111111111111111111`, tradedAt: AT + i, outcomeMultiple: 3 }),
      ),
    );

    const s = walletPerformanceSummary({ outcomes, score: 72 });

    expect(s.scorableOutcomes).toBe(MIN_TRADES_FOR_SCORE);
    expect(s.score).toBe(72);
    expect(s.confidence).not.toBe('none');
    expect(assertSummaryInvariants(s)).toEqual([]);
  });

  it('на четырёх оценки ещё нет', () => {
    const outcomes = foldTokenOutcomes(
      Array.from({ length: MIN_TRADES_FOR_SCORE - 1 }, (_, i) =>
        buy({ tokenAddress: `Token${i}111111111111111111111`, tradedAt: AT + i, outcomeMultiple: 3 }),
      ),
    );

    expect(walletPerformanceSummary({ outcomes, score: 72 }).score).toBeNull();
  });
});

// ────────────────────── Нейтральные исходы в знаменателе ─────────────────────

/**
 * Потеря, ради которой всё это и переделывалось.
 *
 * Знаменатель не хранился, и чтение восстанавливало его так:
 *
 *     scorableOutcomes = max(wins2x, rugs)
 *
 * Исход между 0.2x и 2x оцениваемый, но ни победа, ни rug — в `max`
 * он не попадает. Десять оценённых токенов превращались в выборку
 * из одного, а доля попаданий 10% — в 100%.
 */
describe('одна победа, восемь обычных исходов, один rug', () => {
  const outcomes = foldTokenOutcomes([
    buy({ tokenAddress: 'Win111111111111111111111111111111111111', tradedAt: AT, outcomeMultiple: 3 }),
    ...Array.from({ length: 8 }, (_, i) =>
      buy({
        tokenAddress: `Mid${i}11111111111111111111111111111111`,
        tradedAt: AT + (i + 1) * HOUR,
        // Между rug (0.2x) и победой (2x): обычный исход.
        outcomeMultiple: 0.9 + i * 0.1,
      }),
    ),
    buy({ tokenAddress: 'Rug111111111111111111111111111111111111', tradedAt: AT + 9 * HOUR, outcomeMultiple: 0.05 }),
  ]);

  const s = walletPerformanceSummary({ outcomes, score: 40 });

  it('знаменатель — десять, а не один', () => {
    expect(s.observedTokens).toBe(10);
    expect(s.scorableOutcomes).toBe(10);
  });

  it('доля попаданий 10%', () => {
    expect(s.wins2x).toBe(1);
    expect(s.rugs).toBe(1);
    expect(s.hitRate).toBeCloseTo(0.1, 10);
  });

  it('прежнее выражение дало бы 100%', () => {
    // Негативный контроль: если знаменатель когда-нибудь снова начнут
    // восстанавливать, этот тест покажет, во что это обходится.
    const reconstructed = Math.max(s.wins2x, s.rugs);

    expect(reconstructed).toBe(1);
    expect(s.wins2x / reconstructed).toBe(1);
    expect(s.scorableOutcomes).not.toBe(reconstructed);
  });

  it('восемь обычных исходов не потерялись и не стали ожиданием', () => {
    expect(s.pendingOutcomes).toBe(0);
    expect(s.ambiguousOutcomes).toBe(0);
    expect(assertSummaryInvariants(s)).toEqual([]);
  });
});

// ─────────────────────────── Подпись расчёта ────────────────────────────────

describe('время и версия расчёта', () => {
  it('время расчёта — переданный момент, а не текущий', () => {
    const at = Date.parse('2026-08-25T10:00:00Z');
    const s = walletPerformanceSummary({ outcomes: [], now: at });

    expect(s.computedAt).toBe(at);
    // Прежде здесь стоял `Date.now()` в момент чтения, то есть время
    // открытия страницы.
    expect(s.computedAt).not.toBeCloseTo(Date.now(), -4);
  });

  it('оценка без версии правил недопустима', () => {
    const s = { ...emptyWalletSummary(), score: 80, scorableOutcomes: 10, observedTokens: 10, scoreVersion: null };

    expect(assertSummaryInvariants(s)).toContain('SCORE_WITHOUT_VERSION');
  });

  it('оценка без времени расчёта недопустима', () => {
    const s = { ...emptyWalletSummary(), score: 80, scorableOutcomes: 10, observedTokens: 10, computedAt: null };

    expect(assertSummaryInvariants(s)).toContain('SCORE_WITHOUT_COMPUTED_AT');
  });
});

// ──────────────────────── Ожидание пересчёта ────────────────────────────────

describe('строка, ожидающая пересчёта', () => {
  it('не несёт ни оценки, ни результатов', () => {
    const s = needsRecomputeSummary({ scoreVersion: 1, computedAt: 1_700_000_000_000 });

    expect(s.score).toBeNull();
    expect(s.coverage).toBe('stale');
    expect(s.hitRate).toBeNull();
    expect(s.avgPeakMultiple).toBeNull();
    expect(s.reason).toBe(NEEDS_RECOMPUTE_REASON);
    expect(summaryNeedsRecompute(s)).toBe(true);
    expect(assertSummaryInvariants(s)).toEqual([]);
  });

  it('сохраняет то, что известно о прежнем расчёте', () => {
    const s = needsRecomputeSummary({ scoreVersion: 1, computedAt: 1_700_000_000_000 });

    // Версия прежних правил сообщается как есть и не подменяется
    // нынешней: подмена — это ровно то утверждение, которое поле
    // призвано опровергать.
    expect(s.scoreVersion).toBe(1);
    expect(s.scoreVersion).not.toBe(SCORE_VERSION);
    expect(s.computedAt).toBe(1_700_000_000_000);
  });

  it('оценка рядом с ожиданием пересчёта — нарушение', () => {
    const s = { ...needsRecomputeSummary(), score: 100 };

    expect(assertSummaryInvariants(s)).toContain('SCORE_ON_STALE_SUMMARY');
  });

  it('старые числа рядом с ожиданием пересчёта — нарушение', () => {
    // Попытка «зажать» прежние победы и выдать их за исправленные.
    const s = { ...needsRecomputeSummary(), wins2x: 8, observedTokens: 8, scorableOutcomes: 8 };

    expect(assertSummaryInvariants(s)).toContain('STALE_SUMMARY_REPORTS_OUTCOMES');
  });
});

// ──────────────────── Достоверность базы кратности ──────────────────────────

describe('база кратности', () => {
  it('расхождение единиц ловится сверкой предложения', () => {
    const [o] = foldTokenOutcomes([
      buy({
        // База и цена дают предложение в миллион раз меньше,
        // чем независимое наблюдение: это ошибка единиц.
        mcapAtTradeUsd: 40,
        priceUsd: 0.00004,
        referenceMcapUsd: 41_000,
        referencePriceUsd: 0.0000410,
        outcomeMultiple: 4130,
      }),
    ]);

    expect(o!.status).toBe('ambiguous');
    expect(o!.reason).toBe('MCAP_BASE_UNITS_DISAGREE');
    // Число не выброшено и не обрезано — просто не идёт в оценку.
    expect(o!.peakMultiple).toBe(4130);
  });

  it('честный ранний вход сверку проходит, несмотря на малую базу', () => {
    const [o] = foldTokenOutcomes([
      buy({
        // Ниже абсолютного порога, но цена и капитализация
        // согласованы с независимым наблюдением: предложение то же.
        mcapAtTradeUsd: 300,
        priceUsd: 0.0000003,
        referenceMcapUsd: 60_000,
        referencePriceUsd: 0.00006,
        outcomeMultiple: 12,
      }),
    ]);

    expect(o!.mcapAtTradeUsd ?? 300).toBeLessThan(MIN_TRUSTWORTHY_MCAP_USD);
    expect(o!.status).toBe('scorable');
  });

  it('сверять не с чем — работает абсолютный порог', () => {
    const [below] = foldTokenOutcomes([buy({ mcapAtTradeUsd: MIN_TRUSTWORTHY_MCAP_USD - 1 })]);
    const [at] = foldTokenOutcomes([buy({ mcapAtTradeUsd: MIN_TRUSTWORTHY_MCAP_USD })]);

    expect(below!.status).toBe('ambiguous');
    expect(below!.reason).toBe('IMPLAUSIBLE_MCAP_BASE');
    // Граница включающая: ровно тысяча уже считается измеренной.
    expect(at!.status).toBe('scorable');
  });

  it('настоящая тысячекратная кратность не обрезается', () => {
    const [o] = foldTokenOutcomes([
      buy({ mcapAtTradeUsd: 80_000, outcomeMultiple: 1_400 }),
    ]);

    expect(o!.status).toBe('scorable');
    expect(o!.peakMultiple).toBe(1_400);
  });

  it('расхождение ровно на порог считается расхождением', () => {
    const d = supplyDisagreement({
      mcapUsd: 100,
      priceUsd: 1,
      referenceMcapUsd: 100 * SUPPLY_DISAGREEMENT_FACTOR,
      referencePriceUsd: 1,
    });

    expect(d).not.toBeNull();
    expect(d!.ratio).toBe(SUPPLY_DISAGREEMENT_FACTOR);
    expect(d!.disagrees).toBe(true);
  });

  it('чуть ниже порога расхождением не считается', () => {
    const d = supplyDisagreement({
      mcapUsd: 100,
      priceUsd: 1,
      referenceMcapUsd: 100 * (SUPPLY_DISAGREEMENT_FACTOR - 1),
      referencePriceUsd: 1,
    });

    expect(d!.disagrees).toBe(false);
  });

  it('неполная пара наблюдений — не признак исправности', () => {
    // null означает «сверить не с чем», и вызывающий обязан перейти
    // к запасному правилу, а не считать базу проверенной.
    expect(
      supplyDisagreement({ mcapUsd: 100, priceUsd: null, referenceMcapUsd: 1, referencePriceUsd: 1 }),
    ).toBeNull();
  });
});
