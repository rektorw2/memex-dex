import { describe, it, expect, beforeEach } from 'vitest';
import { FakeWalletLedgerRepository } from './wallet-ledger-fake.js';
import { rebuildWallet, type HistorySource } from './wallet-ledger-core.js';
import { canonicalKey, assessCoverage, type CanonicalTrade } from '@memex/core';

const CHAIN = 'SOLANA' as const;
const W = 'Wal1';

function trade(o: Partial<CanonicalTrade> & { amount: string; side: 'BUY' | 'SELL'; tradedAt: number }): CanonicalTrade {
  const base = {
    chain: CHAIN, wallet: W, tokenAddress: 'Tok1',
    valueUsd: '1000', price: '10', ...o,
  };
  return {
    ...base,
    tokenSymbol: null, marketCapUsd: null, providerPnlUsd: null,
    key: canonicalKey(base as never),
  } as CanonicalTrade;
}

const coverage = (trades: CanonicalTrade[], over: any = {}) =>
  assessCoverage({ trades, pagesFetched: 1, cursorExhausted: true, pageLimitReached: false, ...over });

/** Подставной источник истории. */
function source(trades: CanonicalTrade[], over: any = {}): HistorySource {
  return { fetch: async () => ({ trades, coverage: coverage(trades, over) }) };
}

let repo: FakeWalletLedgerRepository;
beforeEach(() => { repo = new FakeWalletLedgerRepository(); });

// ───────────────────── Атомарность приёма ─────────────────────

describe('приём события и постановка в очередь', () => {
  const activity = (id: string) => ({
    id, chain: CHAIN, walletAddress: W, tokenAddress: 'Tok1', tokenSymbol: null,
    side: 'BUY', quoteSymbol: null, quoteAmount: null, priceUsd: null,
    marketCapUsd: null, realizedPnlUsd: null, txHash: null, trackerType: null,
    source: 'okx_websocket', parsingConfidence: 1, tradedAt: new Date(1_000),
  });

  it('событие и задача создаются вместе', async () => {
    // Раздельно нельзя: падение между ними оставило бы сделку
    // навсегда неучтённой.
    await repo.ingestAtomically(activity('e1'), new Date(2_000));
    expect(repo.activities.size).toBe(1);
    expect(repo.queue.size).toBe(1);
  });

  it('повтор не создаёт вторую запись', async () => {
    await repo.ingestAtomically(activity('e1'), new Date(2_000));
    const r = await repo.ingestAtomically(activity('e1'), new Date(3_000));
    expect(r.created).toBe(false);
    expect(repo.activities.size).toBe(1);
  });

  it('повтор неучтённого события гарантирует наличие задачи', async () => {
    await repo.ingestAtomically(activity('e1'), new Date(2_000));
    repo.queue.clear();
    await repo.ingestAtomically(activity('e1'), new Date(3_000));
    expect(repo.queue.size).toBe(1);
  });

  it('десять событий одного кошелька дают одну задачу', async () => {
    for (let i = 0; i < 10; i++) {
      await repo.ingestAtomically(activity(`e${i}`), new Date(2_000));
    }
    expect(repo.queue.size).toBe(1);
    expect(repo.activities.size).toBe(10);
  });

  it('разные сети дают разные задачи', async () => {
    await repo.ingestAtomically(activity('e1'), new Date(2_000));
    await repo.ingestAtomically({ ...activity('e2'), chain: 'BASE' }, new Date(2_000));
    expect(repo.queue.size).toBe(2);
  });
});

// ───────────────────── Захват и аренда ─────────────────────

describe('очередь', () => {
  beforeEach(async () => {
    await repo.markDirty(CHAIN, W, new Date(0));
  });

  it('два процесса не получают одну задачу', async () => {
    const a = await repo.claimNext(new Date(1_000), 30_000, 'api-1');
    const b = await repo.claimNext(new Date(1_000), 30_000, 'api-2');
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  it('живая аренда не перехватывается', async () => {
    await repo.claimNext(new Date(1_000), 30_000, 'api-1');
    expect(await repo.claimNext(new Date(20_000), 30_000, 'api-2')).toBeNull();
  });

  it('просроченная аренда перехватывается', async () => {
    // Процесс, упавший с захваченной задачей, не должен
    // блокировать её навсегда.
    await repo.claimNext(new Date(1_000), 30_000, 'api-1');
    expect(await repo.claimNext(new Date(50_000), 30_000, 'api-2')).not.toBeNull();
  });

  it('чужую аренду продлить нельзя', async () => {
    const job = (await repo.claimNext(new Date(1_000), 30_000, 'api-1'))!;
    const stolen = { ...job, leaseToken: 'чужой' };
    expect(await repo.extendLease(stolen, new Date(90_000))).toBe(false);
    expect(await repo.extendLease(job, new Date(90_000))).toBe(true);
  });
});

// ───────────────────── Гонка поколений ─────────────────────

describe('гонка поколений', () => {
  it('старый воркер не стирает новую работу', async () => {
    // Сценарий: воркер забрал задачу, пошёл за историей,
    // пришло новое событие, воркер завершился. Без проверки
    // поколения событие потерялось бы навсегда.
    await repo.markDirty(CHAIN, W, new Date(0));
    const job = (await repo.claimNext(new Date(1_000), 30_000, 'api-1'))!;

    await repo.markDirty(CHAIN, W, new Date(0));

    const outcome = await repo.finish(job, { ok: true });
    expect(outcome).toBe('requeued');

    const again = await repo.claimNext(new Date(2_000), 30_000, 'api-1');
    expect(again).not.toBeNull();
  });

  it('без новых событий задача снимается', async () => {
    await repo.markDirty(CHAIN, W, new Date(0));
    const job = (await repo.claimNext(new Date(1_000), 30_000, 'api-1'))!;
    expect(await repo.finish(job, { ok: true })).toBe('cleared');
    expect(await repo.claimNext(new Date(2_000), 30_000, 'api-1')).toBeNull();
  });

  it('неудача возвращает задачу с растущей попыткой', async () => {
    await repo.markDirty(CHAIN, W, new Date(0));
    const job = (await repo.claimNext(new Date(1_000), 30_000, 'api-1'))!;
    await repo.finish(job, { ok: false, errorCode: 'network', retryAt: new Date(5_000) });

    const row = repo.queue.get(job.id)!;
    expect(row.attempts).toBe(1);
    expect(row.lastErrorCode).toBe('network');
  });
});

// ───────────────────── Пересчёт позиций ─────────────────────

describe('пересчёт', () => {
  it('покупка открывает позицию, продажа закрывает', async () => {
    const trades = [
      trade({ side: 'BUY', amount: '100', valueUsd: '1000', price: '10', tradedAt: 1 }),
      trade({ side: 'SELL', amount: '100', valueUsd: '3000', price: '30', tradedAt: 2 }),
    ];
    const r = await rebuildWallet(CHAIN, W, { repo, history: source(trades) });
    expect(r.scorableClosed).toBe(1);
    expect(r.incompleteTokens).toBe(0);
  });

  it('открытая позиция в оценку не идёт', async () => {
    const r = await rebuildWallet(CHAIN, W, {
      repo, history: source([trade({ side: 'BUY', amount: '100', tradedAt: 1 })]),
    });
    expect(r.scorableClosed).toBe(0);
  });

  it('повторная выгрузка не удваивает сделки', async () => {
    const trades = [trade({ side: 'BUY', amount: '100', tradedAt: 1 })];
    await rebuildWallet(CHAIN, W, { repo, history: source(trades) });
    const second = await rebuildWallet(CHAIN, W, { repo, history: source(trades) });
    expect(second.newTrades).toBe(0);
    expect(second.totalTrades).toBe(1);
  });

  it('порядок получения не влияет на результат', async () => {
    // Главное свойство детерминированного пересчёта.
    const trades = [
      trade({ side: 'BUY', amount: '100', valueUsd: '1000', price: '10', tradedAt: 1 }),
      trade({ side: 'BUY', amount: '100', valueUsd: '3000', price: '30', tradedAt: 2 }),
      trade({ side: 'SELL', amount: '200', valueUsd: '6000', price: '30', tradedAt: 3 }),
    ];

    const forward = new FakeWalletLedgerRepository();
    const backward = new FakeWalletLedgerRepository();

    const a = await rebuildWallet(CHAIN, W, { repo: forward, history: source(trades) });
    const b = await rebuildWallet(CHAIN, W, { repo: backward, history: source([...trades].reverse()) });

    expect(a.scorableClosed).toBe(b.scorableClosed);
    expect(a.totalTrades).toBe(b.totalTrades);
  });

  it('поздняя историческая покупка меняет расчёт', async () => {
    await rebuildWallet(CHAIN, W, {
      repo, history: source([trade({ side: 'BUY', amount: '100', tradedAt: 10 })]),
    });

    // Догрузилась более ранняя покупка — пересчёт идёт по всем.
    const r = await rebuildWallet(CHAIN, W, {
      repo, history: source([trade({ side: 'BUY', amount: '50', valueUsd: '100', price: '2', tradedAt: 5 })]),
    });
    expect(r.totalTrades).toBe(2);
  });

  it('одна сделка с разным форматированием чисел не удваивается', async () => {
    await rebuildWallet(CHAIN, W, {
      repo, history: source([trade({ side: 'BUY', amount: '100', valueUsd: '1000', price: '10', tradedAt: 1 })]),
    });
    const r = await rebuildWallet(CHAIN, W, {
      repo, history: source([trade({ side: 'BUY', amount: '100.000', valueUsd: '1000.00', price: '10.0', tradedAt: 1 })]),
    });
    expect(r.totalTrades).toBe(1);
  });
});

// ───────────────────── Неполная история ─────────────────────

describe('осиротевшие продажи', () => {
  it('продажа без покупки не создаёт закрытую прибыльную позицию', async () => {
    // Иначе она считается чистой прибылью, и кошелёк с обрезанной
    // историей выглядит тем успешнее, чем больше потеряно.
    const r = await rebuildWallet(CHAIN, W, {
      repo, history: source([trade({ side: 'SELL', amount: '100', valueUsd: '5000', price: '50', tradedAt: 1 })]),
    });
    expect(r.incompleteTokens).toBe(1);
    expect(r.scorableClosed).toBe(0);
    expect(r.coveragePercent).toBe(0);
  });

  it('токен с полной историей считается, с неполной — нет', async () => {
    const r = await rebuildWallet(CHAIN, W, {
      repo,
      history: source([
        trade({ tokenAddress: 'A', side: 'BUY', amount: '10', valueUsd: '100', price: '10', tradedAt: 1 }),
        trade({ tokenAddress: 'A', side: 'SELL', amount: '10', valueUsd: '300', price: '30', tradedAt: 2 }),
        trade({ tokenAddress: 'B', side: 'SELL', amount: '5', valueUsd: '500', price: '100', tradedAt: 3 }),
      ]),
    });
    expect(r.scorableClosed).toBe(1);
    expect(r.incompleteTokens).toBe(1);
    expect(r.coveragePercent).toBe(50);
  });

  it('обрезанная история помечается', async () => {
    const r = await rebuildWallet(CHAIN, W, {
      repo,
      history: source([trade({ side: 'BUY', amount: '1', tradedAt: 1 })], {
        cursorExhausted: false, pageLimitReached: true,
      }),
    });
    expect(r.historyStatus).toBe('truncated');
  });
});

// ───────────────────── Отставание провайдера ─────────────────────

describe('сопоставление ленты и истории', () => {
  const act = (id: string, tradedAt: number, side = 'BUY') => ({
    id, chain: CHAIN, walletAddress: W, tokenAddress: 'Tok1', tokenSymbol: null,
    side, quoteSymbol: null, quoteAmount: null, priceUsd: null, marketCapUsd: null,
    realizedPnlUsd: null, txHash: null, trackerType: null,
    source: 'okx_websocket', parsingConfidence: 1, tradedAt: new Date(tradedAt),
  });

  it('точное совпадение помечает событие учтённым', async () => {
    await repo.ingestAtomically(act('e1', 1_000), new Date(0));
    const r = await rebuildWallet(CHAIN, W, {
      repo, history: source([trade({ side: 'BUY', amount: '10', tradedAt: 1_000 })]),
    });
    expect(r.appliedActivities).toBe(1);
    expect(repo.activities.get('e1')!.appliedToLedger).toBe(true);
  });

  it('расхождение времени в пределах окна допускается', async () => {
    await repo.ingestAtomically(act('e1', 1_000), new Date(0));
    const r = await rebuildWallet(CHAIN, W, {
      repo, history: source([trade({ side: 'BUY', amount: '10', tradedAt: 61_000 })]),
    });
    expect(r.appliedActivities).toBe(1);
  });

  it('история отстаёт — событие откладывается, а не выдумывается', async () => {
    await repo.ingestAtomically(act('e1', 1_000), new Date(0));
    const r = await rebuildWallet(CHAIN, W, { repo, history: source([]) });

    expect(r.appliedActivities).toBe(0);
    expect(r.deferredActivities).toBe(1);
    const row = repo.activities.get('e1')!;
    expect(row.appliedToLedger).toBe(false);
    expect(row.ledgerState).toBe('deferred');
  });

  it('после появления истории событие учитывается', async () => {
    await repo.ingestAtomically(act('e1', 1_000), new Date(0));
    await rebuildWallet(CHAIN, W, { repo, history: source([]) });

    const r = await rebuildWallet(CHAIN, W, {
      repo, history: source([trade({ side: 'BUY', amount: '10', tradedAt: 1_000 })]),
    });
    expect(r.appliedActivities).toBe(1);
  });

  it('несовпадение по направлению не считается совпадением', async () => {
    await repo.ingestAtomically(act('e1', 1_000, 'SELL'), new Date(0));
    const r = await rebuildWallet(CHAIN, W, {
      repo, history: source([trade({ side: 'BUY', amount: '10', tradedAt: 1_000 })]),
    });
    expect(r.appliedActivities).toBe(0);
  });
});

// ───────────────────── Восстановление после падений ─────────────────────

describe('падения между шагами', () => {
  const trades = [trade({ side: 'BUY', amount: '100', tradedAt: 1 })];

  it('падение при записи сделок оставляет задачу', async () => {
    await repo.markDirty(CHAIN, W, new Date(0));
    const job = (await repo.claimNext(new Date(1_000), 30_000, 'api-1'))!;

    repo.failAt = 'persist';
    await expect(rebuildWallet(CHAIN, W, { repo, history: source(trades) })).rejects.toThrow();
    await repo.finish(job, { ok: false, retryAt: new Date(1_000) });

    // После перезапуска задача подхватывается заново.
    expect(await repo.claimNext(new Date(2_000), 30_000, 'api-2')).not.toBeNull();
  });

  it('повторный проход после падения не удваивает сделки', async () => {
    repo.failAt = 'apply';
    await expect(rebuildWallet(CHAIN, W, { repo, history: source(trades) })).rejects.toThrow();

    const r = await rebuildWallet(CHAIN, W, { repo, history: source(trades) });
    expect(r.totalTrades).toBe(1);
  });

  it('событие не помечается учтённым до успешного пересчёта', async () => {
    const a = {
      id: 'e1', chain: CHAIN, walletAddress: W, tokenAddress: 'Tok1', tokenSymbol: null,
      side: 'BUY', quoteSymbol: null, quoteAmount: null, priceUsd: null, marketCapUsd: null,
      realizedPnlUsd: null, txHash: null, trackerType: null,
      source: 'okx_websocket', parsingConfidence: 1, tradedAt: new Date(1),
    };
    await repo.ingestAtomically(a, new Date(0));

    repo.failAt = 'apply';
    await expect(rebuildWallet(CHAIN, W, { repo, history: source(trades) })).rejects.toThrow();

    expect(repo.activities.get('e1')!.appliedToLedger).toBe(false);
  });
});
