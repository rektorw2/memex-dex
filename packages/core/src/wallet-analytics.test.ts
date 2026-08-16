import { describe, it, expect } from 'vitest';
import { normalizeTrades, classifyOperation, type RawEvent } from './economic-trade.js';
import { buildPositions, summarizePnl } from './position-ledger.js';
import {
  computeSmartScore,
  computeCopyability,
  assessConfidence,
  assessWalletRisk,
  isListableWallet,
  winsorize,
  CONFIDENCE_THRESHOLDS,
} from './smart-score-v2.js';

const ev = (o: Partial<RawEvent>): RawEvent => ({
  chain: 'SOLANA', wallet: 'W1', txHash: 'tx1', tokenAddress: 'T1',
  side: 'BUY', tokenAmount: 100, amountUsd: 1000, timestamp: 1_000, kind: 'swap', ...o,
});

// ─────────────────── Что считается сделкой ───────────────────

describe('нормализация сделок', () => {
  it('шаги маршрута склеиваются в одну сделку', () => {
    // Один обмен через агрегатор даёт три события. Считая их
    // отдельными, мы втрое завышаем число сделок кошелька.
    const { trades } = normalizeTrades([
      ev({ tokenAmount: 40, amountUsd: 400 }),
      ev({ tokenAmount: 35, amountUsd: 350 }),
      ev({ tokenAmount: 25, amountUsd: 250 }),
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0]!.tokenAmount).toBe(100);
    expect(trades[0]!.amountUsd).toBe(1000);
    expect(trades[0]!.legs).toBe(3);
  });

  it('покупка и продажа в одной транзакции не схлопываются', () => {
    const { trades } = normalizeTrades([ev({}), ev({ side: 'SELL' })]);
    expect(trades).toHaveLength(2);
  });

  it('аирдроп не считается покупкой', () => {
    // Иначе цена входа равна нулю, и любой рост — бесконечная прибыль.
    const { trades, rejected } = normalizeTrades([ev({ kind: 'airdrop' })]);
    expect(trades).toHaveLength(0);
    expect(rejected.airdrop).toBe(1);
  });

  it('переводы, мосты, биржи и неудачные транзакции отбрасываются', () => {
    const { trades } = normalizeTrades([
      ev({ kind: 'transfer', txHash: 'a' }),
      ev({ kind: 'bridge', txHash: 'b' }),
      ev({ kind: 'cex', txHash: 'c' }),
      ev({ kind: 'failed', txHash: 'd' }),
      ev({ kind: 'staking', txHash: 'e' }),
    ]);
    expect(trades).toHaveLength(0);
  });

  it('промежуточный токен маршрута не считается сделкой', () => {
    const { trades } = normalizeTrades([ev({ isIntermediate: true })]);
    expect(trades).toHaveLength(0);
  });

  it('сделка без суммы в долларах не участвует', () => {
    const { trades, rejected } = normalizeTrades([ev({ amountUsd: null })]);
    expect(trades).toHaveLength(0);
    expect(rejected.no_usd_value).toBe(1);
  });

  it('пыль отсеивается', () => {
    expect(normalizeTrades([ev({ amountUsd: 0.2 })]).trades).toHaveLength(0);
  });

  it('уверенность склеенной сделки — минимальная среди частей', () => {
    const { trades } = normalizeTrades([
      ev({ parsingConfidence: 1 }),
      ev({ parsingConfidence: 0.4 }),
    ]);
    expect(trades[0]!.parsingConfidence).toBe(0.4);
  });
});

describe('определение вида операции', () => {
  it('неудачная транзакция важнее всех прочих признаков', () => {
    expect(classifyOperation({ failed: true, counterpartyType: 'pool' })).toBe('failed');
  });

  it('перевод между своими адресами', () => {
    expect(classifyOperation({ isSelfTransfer: true })).toBe('transfer');
  });

  it('приход без встречной оплаты — аирдроп', () => {
    expect(classifyOperation({ hasNoCounterValue: true })).toBe('airdrop');
  });

  it('обмен через пул', () => {
    expect(classifyOperation({ counterpartyType: 'pool' })).toBe('swap');
  });
});

// ─────────────────── Учёт позиций ───────────────────

describe('позиции и результат', () => {
  const trade = (o: any) => ({
    chain: 'SOLANA', wallet: 'W1', tokenAddress: 'T1', txHash: 't',
    legs: 1, parsingConfidence: 1, source: null, priceUsd: null, ...o,
  });

  it('рост токена не считается прибылью кошелька', () => {
    // Главная правка. Купил на 1000, продал на 700 — токен потом
    // вырос вдвое, но кошелёк в минусе.
    const pos = buildPositions([
      trade({ side: 'BUY', tokenAmount: 100, amountUsd: 1000, timestamp: 1 }),
      trade({ side: 'SELL', tokenAmount: 100, amountUsd: 700, timestamp: 2 }),
    ]);
    expect(pos[0]!.realizedPnlUsd).toBe(-300);
    expect(pos[0]!.isClosed).toBe(true);
    expect(summarizePnl(pos).wins).toBe(0);
  });

  it('средневзвешенная себестоимость', () => {
    const pos = buildPositions([
      trade({ side: 'BUY', tokenAmount: 100, amountUsd: 1000, timestamp: 1 }),
      trade({ side: 'BUY', tokenAmount: 100, amountUsd: 3000, timestamp: 2 }),
      trade({ side: 'SELL', tokenAmount: 100, amountUsd: 3000, timestamp: 3 }),
    ]);
    // Средний вход 20, продали по 30 — прибыль 1000.
    expect(pos[0]!.avgEntryPrice).toBe(20);
    expect(pos[0]!.realizedPnlUsd).toBe(1000);
  });

  it('частичная продажа оставляет позицию открытой', () => {
    const pos = buildPositions([
      trade({ side: 'BUY', tokenAmount: 100, amountUsd: 1000, timestamp: 1 }),
      trade({ side: 'SELL', tokenAmount: 30, amountUsd: 600, timestamp: 2 }),
    ]);
    expect(pos[0]!.isClosed).toBe(false);
    expect(pos[0]!.realizedPnlUsd).toBe(300);
    expect(summarizePnl(pos).closedCount).toBe(0);
  });

  it('пылевой остаток закрывает позицию', () => {
    const pos = buildPositions([
      trade({ side: 'BUY', tokenAmount: 100, amountUsd: 1000, timestamp: 1 }),
      trade({ side: 'SELL', tokenAmount: 99.5, amountUsd: 2000, timestamp: 2 }),
    ]);
    expect(pos[0]!.isClosed).toBe(true);
  });

  it('продажа без покупки не создаёт бесконечной прибыли', () => {
    const pos = buildPositions([
      trade({ side: 'SELL', tokenAmount: 100, amountUsd: 5000, timestamp: 1 }),
    ]);
    expect(pos[0]!.realizedPnlUsd).toBe(0);
  });

  it('открытые позиции не входят в долю удачных', () => {
    const pos = buildPositions([
      trade({ side: 'BUY', tokenAmount: 100, amountUsd: 1000, timestamp: 1 }),
    ]);
    const s = summarizePnl(pos);
    expect(s.closedCount).toBe(0);
    expect(s.openCount).toBe(1);
    expect(s.rawWinRate).toBe(0);
  });

  it('концентрация прибыли считается', () => {
    const mk = (token: string, buy: number, sell: number) => [
      trade({ tokenAddress: token, side: 'BUY', tokenAmount: 10, amountUsd: buy, timestamp: 1 }),
      trade({ tokenAddress: token, side: 'SELL', tokenAmount: 10, amountUsd: sell, timestamp: 2 }),
    ];
    const s = summarizePnl(buildPositions([
      ...mk('A', 100, 10_100),
      ...mk('B', 100, 200),
      ...mk('C', 100, 150),
    ]));
    expect(s.topTradeShare).toBeGreaterThan(0.9);
  });
});

// ─────────────────── Оценки ───────────────────

describe('уверенность', () => {
  it('одна сделка не даёт числовой оценки', () => {
    const c = assessConfidence({ closedPositions: 1 });
    expect(c.showScore).toBe(false);
    expect(c.label).toBe('Собираем историю');
  });

  it('порог высокой уверенности поднят до 50', () => {
    expect(assessConfidence({ closedPositions: 20 }).level).toBe('medium');
    expect(assessConfidence({ closedPositions: 50 }).level).toBe('high');
    expect(CONFIDENCE_THRESHOLDS.high).toBe(50);
  });

  it('расхождение источников важнее размера выборки', () => {
    const c = assessConfidence({ closedPositions: 200, sourceDisagreement: 0.5 });
    expect(c.level).toBe('conflict');
    expect(c.showScore).toBe(false);
    expect(c.label).toBe('Данные проверяются');
  });
});

describe('Smart Score', () => {
  const pnl = (o: any) => ({
    closedCount: 0, openCount: 0, realizedPnlUsd: 0, openCostUsd: 0,
    wins: 0, losses: 0, rawWinRate: 0, medianRoi: 0, profitFactor: 1,
    topTradeShare: null, top3Share: null, uniqueTokens: 0, medianHoldingHours: null, ...o,
  });

  it('одна сделка — оценки нет', () => {
    const r = computeSmartScore({ pnl: pnl({ closedCount: 1, wins: 1 }), positions: [] });
    expect(r.score).toBeNull();
  });

  it('одна сделка на сто концов не даёт высокой оценки', () => {
    // Пять закрытых позиций, из них одна дала всю прибыль.
    const r = computeSmartScore({
      pnl: pnl({
        closedCount: 5, wins: 1, losses: 4, medianRoi: -0.3,
        profitFactor: 3, topTradeShare: 0.97, uniqueTokens: 5,
      }),
      positions: [],
    });
    expect(r.score).not.toBeNull();
    expect(r.score!).toBeLessThan(40);
  });

  it('ровный прибыльный кошелёк оценивается выше', () => {
    const r = computeSmartScore({
      pnl: pnl({
        closedCount: 60, wins: 40, losses: 20, medianRoi: 0.5,
        profitFactor: 2.5, topTradeShare: 0.2, uniqueTokens: 45,
      }),
      medianEntryHours: 1,
      discovery2xRate: 0.4,
      zeroedShare: 0.05,
      positions: [],
    });
    expect(r.score!).toBeGreaterThan(50);
  });

  it('усечение ограничивает влияние выброса', () => {
    expect(winsorize(120, -1, 5)).toBe(5);
    expect(winsorize(-8, -1, 5)).toBe(-1);
  });
});

describe('повторимость', () => {
  it('снайпер получает низкую оценку повторимости', () => {
    const c = computeCopyability({
      medianEntryLiquidityUsd: 200_000,
      medianPositionUsd: 5_000,
      medianEntryHours: 0.01,
    });
    expect(c.badges).toContain('sniper');
    expect(c.score).toBeLessThan(60);
  });

  it('мелкие пулы помечаются', () => {
    const c = computeCopyability({
      medianEntryLiquidityUsd: 3_000,
      medianPositionUsd: 100,
      medianEntryHours: 5,
    });
    expect(c.badges).toContain('low_liquidity');
    expect(c.canEnterSmall).toBe(false);
  });

  it('обычный кошелёк повторим', () => {
    const c = computeCopyability({
      medianEntryLiquidityUsd: 300_000,
      medianPositionUsd: 500,
      medianEntryHours: 4,
      tradesPerDay: 3,
    });
    expect(c.badges).not.toContain('not_copyable');
    expect(c.canEnterSmall).toBe(true);
  });
});

describe('риск и исключения', () => {
  it('связь с инсайдерами — критический риск', () => {
    expect(assessWalletRisk({ zeroedShare: 0, scamTokens: 0, insiderLinked: true }).level)
      .toBe('critical');
  });

  it('чистый кошелёк — низкий риск', () => {
    expect(assessWalletRisk({ zeroedShare: 0.05, scamTokens: 0 }).level).toBe('low');
  });

  it('служебные адреса в рейтинг не попадают', () => {
    for (const k of ['cex', 'bridge', 'router', 'pool', 'developer', 'insider', 'bundle', 'wash'] as const) {
      expect(isListableWallet(k), k).toBe(false);
    }
    expect(isListableWallet('trader')).toBe(true);
  });
});
