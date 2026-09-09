/**
 * Выбор кошелька для LIVE и подготовка операции.
 *
 * База подделана простыми таблицами; правила настоящие: чужой и
 * отключённый кошелёк не выбираются и не подставляются, сеть должна
 * совпадать, подготовка операции идёт через тот же `reserveSpend`,
 * что ручные ордера, и не отправляет ничего.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma as P } from '@prisma/client';

const envMock = vi.hoisted(() => ({ EXECUTION_MODE: 'paper' as 'paper' | 'live' }));
const db = vi.hoisted(() => ({
  wallets: [] as any[],
  selections: [] as any[],
  balances: [] as any[],
  locks: [] as any[],
  unlocks: [] as any[],
}));

vi.mock('../lib/env.js', () => ({ env: envMock }));
vi.mock('./balances.js', () => ({
  lock: vi.fn(async (_tx: unknown, params: any) => { db.locks.push(params); }),
  unlock: vi.fn(async (_tx: unknown, params: any) => { db.locks = db.locks.filter((l) => l.refId !== params.refId); db.unlocks.push(params); }),
}));
vi.mock('../lib/prisma.js', () => {
  const prisma: any = {
    wallet: {
      findUnique: async ({ where }: any) => db.wallets.find((w) => w.id === where.id) ?? null,
      findMany: async ({ where }: any) => db.wallets.filter((w) => where.id.in.includes(w.id)),
      // Точная семантика запроса Prisma: `kind` — строка или `{ in: [...] }`, `isActive` — точное значение.
      findFirst: async ({ where }: any) => db.wallets.find((w) =>
        w.userId === where.userId && w.chain === where.chain && w.isActive === where.isActive
        && (where.kind == null || (typeof where.kind === 'string' ? w.kind === where.kind : where.kind.in.includes(w.kind)))) ?? null,
    },
    agentLiveWallet: {
      findUnique: async ({ where }: any) => db.selections.find((s) => s.userId === where.userId_network.userId && s.network === where.userId_network.network) ?? null,
      findMany: async ({ where }: any) => db.selections.filter((s) => s.userId === where.userId),
      upsert: async ({ where, create, update }: any) => {
        const i = db.selections.findIndex((s) => s.userId === where.userId_network.userId && s.network === where.userId_network.network);
        const row = i >= 0 ? { ...db.selections[i], ...update, updatedAt: new Date() } : { id: `sel-${db.selections.length + 1}`, ...create, updatedAt: new Date() };
        if (i >= 0) db.selections[i] = row; else db.selections.push(row);
        return row;
      },
    },
    balance: { findMany: async ({ where }: any) => db.balances.filter((b) => b.userId === where.userId && b.token.chain === where.token.chain) },
  };
  return { prisma };
});

const svc = await import('./live-funds.js');
const { prisma } = await import('../lib/prisma.js');

const NATIVE_SOL = 'So11111111111111111111111111111111111111112';
const wallet = (over: any) => ({ id: 'w1', userId: 'u1', chain: 'SOLANA', kind: 'HOT_DEPOSIT', isActive: true, address: 'SoLAddr', ...over });
const balance = (over: any) => ({ userId: 'u1', tokenId: 't-sol', available: new P.Decimal('0.5'), locked: new P.Decimal(0), token: { chain: 'SOLANA', symbol: 'SOL', address: NATIVE_SOL }, ...over });

beforeEach(() => { db.wallets = []; db.selections = []; db.balances = []; db.locks = []; db.unlocks = []; envMock.EXECUTION_MODE = 'paper'; });

describe('выбор кошелька для LIVE', () => {
  it('свой активный кошелёк своей сети выбирается и сохраняется на сервере', async () => {
    db.wallets = [wallet({})];
    const r = await svc.selectLiveWallet('u1', 'SOLANA', 'w1');
    expect(r).toMatchObject({ network: 'SOLANA', walletId: 'w1', address: 'SoLAddr' });
    expect(db.selections).toHaveLength(1);
    const list = await svc.liveWalletSelections('u1');
    expect(list.find((s) => s.network === 'SOLANA')).toMatchObject({ walletId: 'w1', address: 'SoLAddr', problem: null });
    expect(list.find((s) => s.network === 'BNB')).toMatchObject({ walletId: null, address: null });
  });

  it('чужой кошелёк отвечает как отсутствующий, отключённый и чужая сеть — своими кодами', async () => {
    db.wallets = [wallet({ id: 'w-other', userId: 'u2' }), wallet({ id: 'w-off', isActive: false }), wallet({ id: 'w-bnb', chain: 'BNB' })];
    await expect(svc.selectLiveWallet('u1', 'SOLANA', 'w-other')).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
    await expect(svc.selectLiveWallet('u1', 'SOLANA', 'nope')).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
    await expect(svc.selectLiveWallet('u1', 'SOLANA', 'w-off')).rejects.toMatchObject({ code: 'WALLET_INACTIVE' });
    await expect(svc.selectLiveWallet('u1', 'SOLANA', 'w-bnb')).rejects.toMatchObject({ code: 'WALLET_WRONG_NETWORK' });
    await expect(svc.selectLiveWallet('u1', 'ETHEREUM', 'w1')).rejects.toMatchObject({ code: 'NETWORK_NOT_SUPPORTED' });
    expect(db.selections).toHaveLength(0);
  });

  it('кошелёк, отключённый после выбора, помечается проблемой, а адрес не подставляется', async () => {
    db.wallets = [wallet({})];
    await svc.selectLiveWallet('u1', 'SOLANA', 'w1');
    db.wallets[0].isActive = false;
    const list = await svc.liveWalletSelections('u1');
    expect(list.find((s) => s.network === 'SOLANA')).toMatchObject({ walletId: 'w1', address: null, problem: 'WALLET_INACTIVE' });
  });
});

describe('подготовка LIVE-операции', () => {
  it('без выбранного кошелька операция не готовится', async () => {
    await expect(svc.prepareLiveOperation(prisma as never, { userId: 'u1', network: 'SOLANA', tokenId: 't-sol', amount: '0.1', refId: 'op-1' }))
      .rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
    expect(db.locks).toHaveLength(0);
  });

  it('PAPER: кошелёк проверяется, средства считаются, заморозки нет', async () => {
    db.wallets = [wallet({})]; db.balances = [balance({})];
    await svc.selectLiveWallet('u1', 'SOLANA', 'w1');
    const r = await svc.prepareLiveOperation(prisma as never, { userId: 'u1', network: 'SOLANA', tokenId: 't-sol', amount: '0.1', refId: 'op-1' });
    expect(r).toMatchObject({ network: 'SOLANA', wallet: { id: 'w1', address: 'SoLAddr' }, reserved: false, funds: { ok: true, spendable: '0.49' } });
    expect(db.locks).toHaveLength(0);
  });

  it('LIVE: допуск по резерву и заморозка тем же lock; недостаток средств — отказ без заморозки', async () => {
    envMock.EXECUTION_MODE = 'live';
    db.wallets = [wallet({})]; db.balances = [balance({})];
    await svc.selectLiveWallet('u1', 'SOLANA', 'w1');
    const ok = await svc.prepareLiveOperation(prisma as never, { userId: 'u1', network: 'SOLANA', tokenId: 't-sol', amount: '0.1', refId: 'op-1' });
    expect(ok.reserved).toBe(true);
    expect(db.locks).toEqual([{ userId: 'u1', tokenId: 't-sol', amount: '0.1', refId: 'op-1' }]);
    await expect(svc.prepareLiveOperation(prisma as never, { userId: 'u1', network: 'SOLANA', tokenId: 't-sol', amount: '0.495', refId: 'op-2' }))
      .rejects.toMatchObject({ verdict: { code: 'INSUFFICIENT_FUNDS' } });
    expect(db.locks).toHaveLength(1);
  });

  it('готовность кошелька к подтверждению: без газа — NO_NATIVE_FOR_FEES', async () => {
    db.wallets = [wallet({})];
    await svc.selectLiveWallet('u1', 'SOLANA', 'w1');
    const noGas = await svc.assertLiveWalletReady('u1', 'SOLANA');
    expect(noGas.gas.code).toBe('NO_NATIVE_FOR_FEES');
    db.balances = [balance({})];
    const ready = await svc.assertLiveWalletReady('u1', 'SOLANA');
    expect(ready.gas.ok).toBe(true);
    expect(ready.wallet.address).toBe('SoLAddr');
  });

  const NATIVE: Record<string, { address: string; symbol: string; reserve: string; walletChain: string }> = {
    SOLANA: { address: NATIVE_SOL, symbol: 'SOL', reserve: '0.01', walletChain: 'SOLANA' },
    BNB: { address: '0x0000000000000000000000000000000000000000', symbol: 'BNB', reserve: '0.003', walletChain: 'BNB' },
    ROBINHOOD: { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', reserve: '0.0005', walletChain: 'ROBINHOOD' },
  };
  it.each(['SOLANA', 'BNB', 'ROBINHOOD'])('%s: готовность по газу — ровно один резерв (ниже / ровно / выше), без двойного', async (network) => {
    const n = NATIVE[network]!;
    db.wallets = [wallet({ id: `w-${network}`, chain: network, address: `addr-${network}` })];
    await svc.selectLiveWallet('u1', network, `w-${network}`);
    const withBalance = async (available: string) => {
      db.balances = [balance({ tokenId: `t-${network}`, available: new P.Decimal(available), token: { chain: network, symbol: n.symbol, address: n.address } })];
      return (await svc.assertLiveWalletReady('u1', network)).gas;
    };
    expect((await withBalance(new P.Decimal(n.reserve).minus('0.000000001').toString())).code).toBe('NO_NATIVE_FOR_FEES');
    expect((await withBalance(n.reserve)).ok).toBe(true);
    expect((await withBalance(new P.Decimal(n.reserve).times(1.5).toString())).ok).toBe(true); // раньше требовалось 2× резерва
    expect((await withBalance(new P.Decimal(n.reserve).times(2).toString())).ok).toBe(true);
  });

  it('созданный/импортированный HOT_TRADING без HOT_DEPOSIT: выбор, допуск и резерв идут через него', async () => {
    envMock.EXECUTION_MODE = 'live';
    db.wallets = [wallet({ id: 'w-trading', kind: 'HOT_TRADING' })];
    db.balances = [balance({})];
    await svc.selectLiveWallet('u1', 'SOLANA', 'w-trading');
    const r = await svc.prepareLiveOperation(prisma as never, { userId: 'u1', network: 'SOLANA', tokenId: 't-sol', amount: '0.1', refId: 'op-1' });
    expect(r).toMatchObject({ wallet: { id: 'w-trading' }, funds: { ok: true }, reserved: true });
    expect(db.locks).toEqual([{ userId: 'u1', tokenId: 't-sol', amount: '0.1', refId: 'op-1' }]);
  });

  it('выбранный кошелёк идёт через допуск как есть: отключённый после выбора — отказ, а не подмена другим', async () => {
    envMock.EXECUTION_MODE = 'live';
    db.wallets = [wallet({ id: 'w-trading', kind: 'HOT_TRADING' }), wallet({ id: 'w-dep', kind: 'HOT_DEPOSIT' })];
    db.balances = [balance({})];
    await svc.selectLiveWallet('u1', 'SOLANA', 'w-trading');
    db.wallets[0].isActive = false;
    await expect(svc.prepareLiveOperation(prisma as never, { userId: 'u1', network: 'SOLANA', tokenId: 't-sol', amount: '0.1', refId: 'op-2' }))
      .rejects.toMatchObject({ code: 'WALLET_INACTIVE' });
    expect(db.locks).toHaveLength(0);
  });

  it('резерв снимается тем же unlock при отказе следующего шага', async () => {
    envMock.EXECUTION_MODE = 'live';
    db.wallets = [wallet({})]; db.balances = [balance({})];
    await svc.selectLiveWallet('u1', 'SOLANA', 'w1');
    const prepared = await svc.prepareLiveOperation(prisma as never, { userId: 'u1', network: 'SOLANA', tokenId: 't-sol', amount: '0.1', refId: 'op-9' });
    expect(prepared.reserved).toBe(true);
    // Следующий шаг (котировка/подпись) отказал — резерв возвращается под тем же refId.
    await svc.releaseSpend(prisma as never, { userId: 'u1', tokenId: 't-sol', amount: '0.1', refId: 'op-9' });
    expect(db.locks).toEqual([]);
    expect(db.unlocks).toEqual([{ userId: 'u1', tokenId: 't-sol', amount: '0.1', refId: 'op-9' }]);
  });

  it('холодный кошелёк не выбирается как источник средств', async () => {
    db.wallets = [wallet({ id: 'w-cold', kind: 'COLD' })];
    await expect(svc.selectLiveWallet('u1', 'SOLANA', 'w-cold')).rejects.toMatchObject({ code: 'WALLET_KIND_NOT_ALLOWED' });
  });

  it('ручной допуск без выбранного кошелька находит активный кошелёк любого допустимого вида', async () => {
    db.wallets = [wallet({ id: 'w-trading', kind: 'HOT_TRADING' })];
    db.balances = [balance({})];
    const v = await svc.liveFundsCheck(prisma as never, { userId: 'u1', chain: 'SOLANA', tokenId: 't-sol', amount: '0.1' });
    expect(v.ok).toBe(true);
    db.wallets = [wallet({ id: 'w-cold', kind: 'COLD' })];
    const none = await svc.liveFundsCheck(prisma as never, { userId: 'u1', chain: 'SOLANA', tokenId: 't-sol', amount: '0.1' });
    expect(none.code).toBe('NO_WALLET');
  });
});
