import { describe, it, expect } from 'vitest';
import {
  OKX_CHAIN_INDEX,
  chainFromIndex,
  isOkxChain,
  okxNum,
  okxInt,
  okxTime,
  okxStr,
  okxBool,
  looksLikeAddress,
  parseHotToken,
  normalizePct,
  normalizeChange,
  okxRiskBand,
  isOkxHardBlock,
} from './okx-model.js';
import { dedupeByAddress, tokenKey } from './token-registry.js';

describe('соответствие сетей', () => {
  it('четыре поддерживаемых сети имеют индекс', () => {
    expect(OKX_CHAIN_INDEX.ETHEREUM).toBe('1');
    expect(OKX_CHAIN_INDEX.BNB).toBe('56');
    expect(OKX_CHAIN_INDEX.BASE).toBe('8453');
    expect(OKX_CHAIN_INDEX.SOLANA).toBe('501');
  });

  it('Robinhood Chain помечена как неподдерживаемая', () => {
    // Не ошибка конфигурации, а факт: у OKX этой сети нет.
    expect(OKX_CHAIN_INDEX.ROBINHOOD).toBeNull();
    expect(isOkxChain('ROBINHOOD')).toBe(false);
  });

  it('обратное соответствие работает для всех четырёх', () => {
    expect(chainFromIndex('1')).toBe('ETHEREUM');
    expect(chainFromIndex('56')).toBe('BNB');
    expect(chainFromIndex(8453)).toBe('BASE');
    expect(chainFromIndex('501')).toBe('SOLANA');
  });

  it('незнакомый индекс даёт null, а не догадку', () => {
    expect(chainFromIndex('137')).toBeNull();
    expect(chainFromIndex(null)).toBeNull();
    expect(chainFromIndex(undefined)).toBeNull();
  });
});

describe('разбор чисел', () => {
  it('обычные значения', () => {
    expect(okxNum('123.45')).toBe(123.45);
    expect(okxNum(42)).toBe(42);
    expect(okxNum('0')).toBe(0);
  });

  it('ноль отличается от неизвестности', () => {
    // Ликвидность 0 означает пустой пул и блокирует токен.
    // Неизвестная ликвидность не означает ничего.
    expect(okxNum('0')).toBe(0);
    expect(okxNum('')).toBeNull();
    expect(okxNum(null)).toBeNull();
    expect(okxNum(undefined)).toBeNull();
  });

  it('мусор даёт null', () => {
    expect(okxNum('null')).toBeNull();
    expect(okxNum('NaN')).toBeNull();
    expect(okxNum('-')).toBeNull();
    expect(okxNum('abc')).toBeNull();
    expect(okxNum({})).toBeNull();
    expect(okxNum(Infinity)).toBeNull();
  });

  it('целые округляются вниз', () => {
    expect(okxInt('42.9')).toBe(42);
    expect(okxInt('')).toBeNull();
  });

  it('строки', () => {
    expect(okxStr('  hi  ')).toBe('hi');
    expect(okxStr('')).toBeNull();
    expect(okxStr('x'.repeat(200), 10)).toHaveLength(10);
    expect(okxStr(42)).toBeNull();
  });

  it('логические значения различают ложь и отсутствие', () => {
    expect(okxBool(false)).toBe(false);
    expect(okxBool('false')).toBe(false);
    expect(okxBool('true')).toBe(true);
    expect(okxBool(undefined)).toBeNull();
    expect(okxBool('maybe')).toBeNull();
  });
});

describe('разбор времени', () => {
  it('миллисекунды', () => {
    const d = okxTime(1_700_000_000_000);
    expect(d?.getUTCFullYear()).toBe(2023);
  });

  it('секунды распознаются по порядку величины', () => {
    const d = okxTime(1_700_000_000);
    expect(d?.getUTCFullYear()).toBe(2023);
  });

  it('ноль и мусор дают null', () => {
    expect(okxTime(0)).toBeNull();
    expect(okxTime('')).toBeNull();
    expect(okxTime(-5)).toBeNull();
  });
});

describe('доли и проценты', () => {
  it('доля приводится к процентам', () => {
    expect(normalizePct(0.65)).toBeCloseTo(65);
  });

  it('проценты остаются процентами', () => {
    expect(normalizePct(65)).toBe(65);
  });

  it('свыше ста обрезается', () => {
    expect(normalizePct(150)).toBe(100);
  });

  it('отрицательная доля бессмысленна', () => {
    expect(normalizePct(-5)).toBeNull();
  });

  it('изменение цены умножается на сто без эвристик', () => {
    // Тут эвристика диапазона не годится: рост на 250% обычное дело.
    expect(normalizeChange(0.15)).toBeCloseTo(15);
    expect(normalizeChange(2.5)).toBeCloseTo(250);
    expect(normalizeChange(null)).toBeNull();
  });
});

describe('распознавание адреса', () => {
  it('EVM', () => {
    expect(looksLikeAddress('0x' + 'a'.repeat(40))).toBe(true);
    expect(looksLikeAddress('0xAbCdEf0123456789012345678901234567890123')).toBe(true);
  });

  it('Solana', () => {
    expect(looksLikeAddress('So11111111111111111111111111111111111111112')).toBe(true);
  });

  it('тикер адресом не считается', () => {
    expect(looksLikeAddress('NVDA')).toBe(false);
    expect(looksLikeAddress('PEPE')).toBe(false);
    expect(looksLikeAddress('')).toBe(false);
  });

  it('обрезанный EVM-адрес не проходит', () => {
    expect(looksLikeAddress('0x' + 'a'.repeat(39))).toBe(false);
  });
});

describe('разбор hot-token', () => {
  const raw = {
    chainIndex: '501',
    tokenContractAddress: 'So11111111111111111111111111111111111111112',
    tokenSymbol: 'WSOL',
    tokenName: 'Wrapped SOL',
    tokenLogoUrl: 'https://example.test/logo.png',
    price: '148.23',
    change: '0.0512',
    volume: '9500000',
    liquidity: '4200000',
    marketCap: '88000000',
    firstTradeTime: '1700000000',
    holders: '15234',
    txsBuy: '900',
    txsSell: '870',
    riskLevelControl: '1',
    top10HoldPercent: '0.42',
  };

  it('основные поля переводятся в нашу модель', () => {
    const t = parseHotToken(raw)!;
    expect(t.chain).toBe('SOLANA');
    expect(t.symbol).toBe('WSOL');
    expect(t.priceUsd).toBe(148.23);
    expect(t.priceChange24h).toBeCloseTo(5.12);
    expect(t.holders).toBe(15234);
    expect(t.top10HoldPct).toBeCloseTo(42);
    expect(t.okxRiskLevel).toBe(1);
  });

  it('запись без адреса отбрасывается', () => {
    expect(parseHotToken({ ...raw, tokenContractAddress: '' })).toBeNull();
  });

  it('запись с неизвестной сетью отбрасывается', () => {
    expect(parseHotToken({ ...raw, chainIndex: '137' })).toBeNull();
  });

  it('незнакомая форма ответа не роняет разбор', () => {
    expect(parseHotToken(null)).toBeNull();
    expect(parseHotToken('строка')).toBeNull();
    expect(parseHotToken(42)).toBeNull();
  });

  it('отсутствующие числа остаются неизвестными', () => {
    const t = parseHotToken({
      chainIndex: '1',
      tokenContractAddress: '0x' + 'a'.repeat(40),
      tokenSymbol: 'X',
    })!;
    expect(t.liquidityUsd).toBeNull();
    expect(t.holders).toBeNull();
    // Ноль тут был бы враньём: он значит «пул пуст», а мы не знаем.
    expect(t.volume24hUsd).not.toBe(0);
  });

  it('EVM-адрес нормализуется, Solana — нет', () => {
    const evm = parseHotToken({
      chainIndex: '1',
      tokenContractAddress: '0xABCDEF0123456789012345678901234567890123',
      tokenSymbol: 'X',
    })!;
    expect(evm.address).toBe('0xabcdef0123456789012345678901234567890123');

    const sol = parseHotToken(raw)!;
    expect(sol.address).toBe('So11111111111111111111111111111111111111112');
  });
});

describe('дедупликация по сети и адресу', () => {
  it('один адрес в разном регистре — один токен', () => {
    const items = [
      { chain: 'ETHEREUM' as const, address: '0xAAAA000000000000000000000000000000000001' },
      { chain: 'ETHEREUM' as const, address: '0xaaaa000000000000000000000000000000000001' },
    ];
    expect(dedupeByAddress(items)).toHaveLength(1);
  });

  it('один адрес в разных сетях — два токена', () => {
    const items = [
      { chain: 'ETHEREUM' as const, address: '0x' + 'a'.repeat(40) },
      { chain: 'BASE' as const, address: '0x' + 'a'.repeat(40) },
    ];
    expect(dedupeByAddress(items)).toHaveLength(2);
  });

  it('одинаковый тикер с разными адресами не схлопывается', () => {
    // Именно на этом строится подделка: три NVDA — три разных токена.
    const items = [
      { chain: 'SOLANA' as const, address: 'Mint1111111111111111111111111111111111111111' },
      { chain: 'SOLANA' as const, address: 'Mint2222222222222222222222222222222222222222' },
    ];
    expect(dedupeByAddress(items)).toHaveLength(2);
  });

  it('ключ токена строится по сети и адресу, а не по тикеру', () => {
    expect(tokenKey('ETHEREUM', '0xABC')).toBe('ETHEREUM:0xabc');
    expect(tokenKey('SOLANA', 'AbC')).toBe('SOLANA:AbC');
  });
});

describe('уровни риска OKX', () => {
  it('уровни 3 и выше скрываются полностью', () => {
    expect(isOkxHardBlock(3)).toBe(true);
    expect(isOkxHardBlock(4)).toBe(true);
    expect(isOkxHardBlock(5)).toBe(true);
  });

  it('уровни 0–2 полностью не блокируют', () => {
    expect(isOkxHardBlock(0)).toBe(false);
    expect(isOkxHardBlock(1)).toBe(false);
    expect(isOkxHardBlock(2)).toBe(false);
    expect(isOkxHardBlock(null)).toBe(false);
  });

  it('ноль означает «не проверяли», а не «чисто»', () => {
    // Самая важная проверка в этом блоке. Ноль стоит по умолчанию,
    // в том числе у токена, до которого проверка не дошла.
    expect(okxRiskBand(0)).toBe('unknown');
    expect(okxRiskBand(null)).toBe('unknown');
    expect(okxRiskBand(1)).toBe('clean');
    expect(okxRiskBand(2)).toBe('caution');
    expect(okxRiskBand(3)).toBe('danger');
    expect(okxRiskBand(5)).toBe('danger');
  });
});
