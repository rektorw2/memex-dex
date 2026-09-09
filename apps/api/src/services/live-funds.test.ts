/**
 * Сводка средств по сетям: нативный актив отдельно от токенов,
 * резерв под комиссии не считается свободным.
 */
import { describe, expect, it, vi } from 'vitest';
import { Prisma as P } from '@prisma/client';

vi.mock('../lib/env.js', () => ({ env: { EXECUTION_MODE: 'paper' } }));
vi.mock('../lib/prisma.js', () => ({ prisma: {} }));
vi.mock('./balances.js', () => ({ lock: vi.fn() }));

const { networkFundsFrom, liveFundsVerdictFromRows } = await import('./live-funds.js');

const NATIVE: Record<string, string> = { SOLANA: 'So11111111111111111111111111111111111111112', BNB: '0x0000000000000000000000000000000000000000', ROBINHOOD: '0x0000000000000000000000000000000000000000', ETHEREUM: '0x0000000000000000000000000000000000000000' };
const row = (chain: string, symbol: string, available: number | string, locked: number | string = 0, address = NATIVE[chain]!) => ({
  tokenId: `${chain}:${symbol}:${address.slice(0, 6)}`, available: new P.Decimal(available), locked: new P.Decimal(locked), token: { chain, symbol, address },
});

describe('средства по сетям', () => {
  it('три сети агента, нативный актив отдельно от токенов, адрес по кошельку сети', () => {
    const networks = networkFundsFrom(
      [row('SOLANA', 'SOL', 1.5, 0.5), row('SOLANA', 'USDC', 100), row('BNB', 'BNB', 0.2), row('BNB', 'CAKE', 10), row('ETHEREUM', 'ETH', 3)],
      [{ id: 'w1', chain: 'SOLANA', address: 'SoL' }, { id: 'w2', chain: 'ROBINHOOD', address: '0xrh' }],
    );
    expect(networks.map((n) => n.chain)).toEqual(['SOLANA', 'BNB', 'ROBINHOOD']);
    expect(networks[0]).toMatchObject({ depositAddress: 'SoL', nativeSymbol: 'SOL', tokenAssets: 1, native: { available: '1.5', locked: '0.5', spendable: '1.49' } });
    expect(networks[1]).toMatchObject({ depositAddress: null, native: { available: '0.2' }, tokenAssets: 1 });
    expect(networks[2]).toMatchObject({ depositAddress: '0xrh', nativeSymbol: 'ETH', native: null, tokenAssets: 0 });
  });

  it('одноимённый токен и обёрнутый актив не выдаются за газ, порядок строк не важен', () => {
    const fakeBnb = row('BNB', 'BNB', 100, 0, '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    const wbnb = row('BNB', 'WBNB', 3, 0, '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c');
    const realBnb = row('BNB', 'BNB', '0.25', '0.05');
    for (const rows of [[fakeBnb, wbnb, realBnb], [realBnb, fakeBnb, wbnb], [wbnb, realBnb, fakeBnb]]) {
      const bnb = networkFundsFrom(rows, []).find((n) => n.chain === 'BNB')!;
      expect(bnb.native).toMatchObject({ tokenId: realBnb.tokenId, available: '0.25', locked: '0.05', spendable: '0.247' });
      expect(bnb.tokenAssets).toBe(2);
    }
    const onlyFakes = networkFundsFrom([fakeBnb, wbnb], []).find((n) => n.chain === 'BNB')!;
    expect(onlyFakes.native).toBeNull();
    expect(onlyFakes.tokenAssets).toBe(2);
  });

  it('допуск: токен «ETH» с чужим контрактом не заменяет настоящий газ Robinhood Chain', () => {
    const fakeEth = row('ROBINHOOD', 'ETH', 10, 0, '0x1111111111111111111111111111111111111111');
    const denied = liveFundsVerdictFromRows({ network: 'ROBINHOOD', walletConnected: true, rows: [fakeEth], tokenId: fakeEth.tokenId, amount: '1' });
    expect(denied.code).toBe('NO_NATIVE_FOR_FEES');
    const realEth = row('ROBINHOOD', 'ETH', '0.01');
    for (const rows of [[fakeEth, realEth], [realEth, fakeEth]]) {
      const ok = liveFundsVerdictFromRows({ network: 'ROBINHOOD', walletConnected: true, rows, tokenId: fakeEth.tokenId, amount: '1' });
      expect(ok).toMatchObject({ ok: true, code: 'OK', spendable: '10' });
      const native = liveFundsVerdictFromRows({ network: 'ROBINHOOD', walletConnected: true, rows, tokenId: realEth.tokenId, amount: '0.0096' });
      expect(native).toMatchObject({ ok: false, code: 'INSUFFICIENT_FUNDS', spendable: '0.0095', shortfall: '0.0001' });
    }
  });

  it('точность: восемнадцать знаков не теряются', () => {
    const eth = row('ROBINHOOD', 'ETH', '0.000500000000000001');
    const v = liveFundsVerdictFromRows({ network: 'ROBINHOOD', walletConnected: true, rows: [eth], tokenId: eth.tokenId, amount: '0.000000000000000001' });
    expect(v.ok).toBe(true);
    expect(new P.Decimal(v.spendable).toFixed()).toBe('0.000000000000000001');
  });
});
