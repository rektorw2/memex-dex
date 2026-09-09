import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { NATIVE_ASSETS, NATIVE_FEE_RESERVE, addressMatchesChain, isNativeAsset, liveFundsVerdict, nativeGasReady, spendableNative } from './live-funds.js';

describe('нативный актив по идентичности, а не по тикеру', () => {
  it('узнаётся по каноническому адресу и синонимам, независимо от регистра EVM', () => {
    expect(isNativeAsset('SOLANA', { address: NATIVE_ASSETS.SOLANA.address, symbol: 'SOL' })).toBe(true);
    expect(isNativeAsset('BNB', '0x0000000000000000000000000000000000000000')).toBe(true);
    expect(isNativeAsset('BNB', '0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE')).toBe(true);
    expect(isNativeAsset('ROBINHOOD', { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH' })).toBe(true);
  });

  it('токен с тем же тикером и обёрнутый актив — не нативные', () => {
    expect(isNativeAsset('ROBINHOOD', { address: '0x1111111111111111111111111111111111111111', symbol: 'ETH' })).toBe(false);
    expect(isNativeAsset('BNB', { address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', symbol: 'WBNB' })).toBe(false);
    expect(isNativeAsset('BNB', { address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', symbol: 'BNB' })).toBe(false);
    expect(isNativeAsset('SOLANA', { address: 'Fake111111111111111111111111111111111111111', symbol: 'SOL' })).toBe(false);
    expect(isNativeAsset('SOLANA', { address: 'so11111111111111111111111111111111111111112', symbol: 'SOL' })).toBe(false); // регистр Solana значим
    expect(isNativeAsset('BNB', { address: '', symbol: 'BNB' })).toBe(false);
  });
});

describe('средства под LIVE-операцию', () => {
  it('без кошелька в сети операция не допускается', () => {
    const v = liveFundsVerdict({ network: 'ROBINHOOD', walletConnected: false, native: null, spend: null, requiredAmount: '1' });
    expect(v).toMatchObject({ ok: false, code: 'NO_WALLET' });
    expect(v.message).toContain('Robinhood Chain');
  });

  it('резерв на комиссии не тратится; точность без плавающей точки', () => {
    expect(spendableNative({ available: '0.02', locked: '0' }, 'SOLANA')).toBe('0.01');
    expect(spendableNative({ available: '0.1', locked: '0' }, 'BNB')).toBe('0.097');
    expect(spendableNative({ available: '0.000000000000000001', locked: '0' }, 'ROBINHOOD')).toBe('0');
    const v = liveFundsVerdict({ network: 'SOLANA', walletConnected: true, native: { available: '0.005', locked: '1' }, spend: { symbol: 'SOL', isNative: true, available: '0.005', locked: '1' }, requiredAmount: '0.001' });
    expect(v.code).toBe('NO_NATIVE_FOR_FEES');
  });

  it('нет настоящего газа — операция не допускается, даже если есть одноимённый токен', () => {
    const v = liveFundsVerdict({ network: 'ROBINHOOD', walletConnected: true, native: null, spend: { symbol: 'ETH', isNative: false, available: '5', locked: '0' }, requiredAmount: '1' });
    expect(v.code).toBe('NO_NATIVE_FOR_FEES');
  });

  it('замороженное под другую операцию не считается свободным', () => {
    const v = liveFundsVerdict({ network: 'BNB', walletConnected: true, native: { available: '1', locked: '0' }, spend: { symbol: 'USDC', isNative: false, available: '40', locked: '60' }, requiredAmount: '50' });
    expect(v).toMatchObject({ ok: false, code: 'INSUFFICIENT_FUNDS', spendable: '40', shortfall: '10' });
  });

  it('хватает — допуск с точным числом', () => {
    const v = liveFundsVerdict({ network: 'BNB', walletConnected: true, native: { available: '0.5', locked: '0' }, spend: { symbol: 'BNB', isNative: true, available: '0.5', locked: '0' }, requiredAmount: '0.1' });
    expect(v.ok).toBe(true);
    expect(v.spendable).toBe('0.497');
    expect(NATIVE_FEE_RESERVE.BNB).toBe('0.003');
  });
});

describe('адрес и сеть', () => {
  it('EVM-адрес не проходит для Solana, и наоборот', () => {
    expect(addressMatchesChain('SOLANA', 'So11111111111111111111111111111111111111112')).toBe(true);
    expect(addressMatchesChain('SOLANA', '0x000000000000000000000000000000000000dEaD')).toBe(false);
    expect(addressMatchesChain('ROBINHOOD', '0x000000000000000000000000000000000000dEaD')).toBe(true);
    expect(addressMatchesChain('BNB', 'So11111111111111111111111111111111111111112')).toBe(false);
  });
});

describe('готовность по газу — ровно один резерв', () => {
  it.each([['SOLANA', '0.01'], ['BNB', '0.003'], ['ROBINHOOD', '0.0005']] as const)('%s: ниже резерва — нет, ровно на уровне и выше — да', (network, reserve) => {
    const below = new Decimal(reserve).minus('0.000000001').toString();
    const above = new Decimal(reserve).plus('0.000000001').toString();
    expect(nativeGasReady({ available: below, locked: '0' }, network)).toMatchObject({ ok: false, code: 'NO_NATIVE_FOR_FEES', feeReserve: reserve });
    expect(nativeGasReady({ available: reserve, locked: '5' }, network)).toMatchObject({ ok: true, code: 'OK' });
    expect(nativeGasReady({ available: above, locked: '0' }, network)).toMatchObject({ ok: true });
    expect(nativeGasReady(null, network).ok).toBe(false);
    // Двойного резерва нет: при 1.5 резерва газ есть, хотя допуск сделки на сумму резерва отказал бы.
    const oneAndHalf = new Decimal(reserve).times('1.5').toString();
    expect(nativeGasReady({ available: oneAndHalf, locked: '0' }, network).ok).toBe(true);
    expect(liveFundsVerdict({ network, walletConnected: true, native: { available: oneAndHalf, locked: '0' }, spend: { symbol: 'X', isNative: true, available: oneAndHalf, locked: '0' }, requiredAmount: reserve }).code).toBe('INSUFFICIENT_FUNDS');
  });
});
