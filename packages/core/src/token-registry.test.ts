import { describe, it, expect } from 'vitest';
import {
  checkAuthenticity,
  isRegistered,
  normalizeAddress,
  normalizeSymbol,
  tokenKey,
  dedupeByAddress,
  REGISTRY,
  CHAIN_IDS,
} from './token-registry.js';

const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const FAKE = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

describe('нормализация и ключи', () => {
  it('регистр EVM-адреса не значим', () => {
    expect(normalizeAddress('ETHEREUM', USDC_ETH.toUpperCase())).toBe(USDC_ETH);
    expect(tokenKey('ETHEREUM', USDC_ETH.toUpperCase())).toBe(
      tokenKey('ETHEREUM', USDC_ETH),
    );
  });

  it('регистр адреса Solana значим', () => {
    // base58 различает O и o — приведение сломало бы адрес.
    expect(normalizeAddress('SOLANA', USDC_SOL)).toBe(USDC_SOL);
    expect(normalizeAddress('SOLANA', USDC_SOL.toLowerCase())).not.toBe(USDC_SOL);
  });

  it('один адрес в разных сетях — разные токены', () => {
    // EVM-адрес существует одновременно в нескольких сетях,
    // и это разные контракты.
    expect(tokenKey('ETHEREUM', USDC_ETH)).not.toBe(tokenKey('BASE', USDC_ETH));
  });

  it('пробелы по краям не создают новый токен', () => {
    expect(tokenKey('SOLANA', ` ${USDC_SOL} `)).toBe(tokenKey('SOLANA', USDC_SOL));
  });
});

describe('normalizeSymbol', () => {
  it('снимает оформление', () => {
    for (const s of ['$NVDA', 'nvda', 'N.V.D.A', ' NVDA ', 'N-V-D-A']) {
      expect(normalizeSymbol(s), s).toBe('NVDA');
    }
  });

  it('ловит замену букв на похожие цифры', () => {
    expect(normalizeSymbol('H00D')).toBe('HOOD');
    expect(normalizeSymbol('C01N')).toBe('COIN');
  });
});

describe('checkAuthenticity — подтверждённые', () => {
  it('токен из реестра проходит', () => {
    const r = checkAuthenticity('SOLANA', USDC_SOL, 'USDC');
    expect(r.isVerified).toBe(true);
    expect(r.isImpersonation).toBe(false);
    expect(r.entry?.tags).toContain('stablecoin');
  });

  it('подтверждённый актив не считается подделкой самого себя', () => {
    // USDC — защищённый тикер, но настоящий USDC должен проходить.
    // Прежняя проверка по тикеру блокировала бы его.
    const r = checkAuthenticity('ETHEREUM', USDC_ETH, 'USDC');
    expect(r.isVerified).toBe(true);
    expect(r.isImpersonation).toBe(false);
  });

  it('регистр адреса не мешает опознать подтверждённый токен', () => {
    const r = checkAuthenticity('ETHEREUM', USDC_ETH.toUpperCase(), 'USDC');
    expect(r.isVerified).toBe(true);
  });
});

describe('checkAuthenticity — подделки', () => {
  it('чужой адрес с защищённым тикером — подделка', () => {
    const r = checkAuthenticity('SOLANA', FAKE, 'USDC');
    expect(r.isImpersonation).toBe(true);
    expect(r.reason).toContain('не совпадает');
  });

  it('ловит подделки под акции со скриншота', () => {
    for (const s of ['NVDA', 'TSLA', 'HOOD', 'SNDK', 'IPO']) {
      const r = checkAuthenticity('SOLANA', FAKE, s);
      expect(r.isImpersonation, s).toBe(true);
    }
  });

  it('ловит подделки сквозь оформление тикера', () => {
    for (const s of ['$NVDA', 'H00D', 'T.S.L.A']) {
      expect(checkAuthenticity('SOLANA', FAKE, s).isImpersonation, s).toBe(true);
    }
  });

  it('честный мем-коин проходит', () => {
    for (const s of ['PEPE', 'BONK', 'WIF', 'MOG', 'quq']) {
      const r = checkAuthenticity('SOLANA', FAKE, s);
      expect(r.isImpersonation, s).toBe(false);
      expect(r.isVerified, s).toBe(false);
    }
  });
});

describe('REGISTRY', () => {
  it('адреса хранятся нормализованными', () => {
    // Иначе поиск по ключу промахнётся на первом же EVM-адресе
    // с контрольной суммой.
    for (const e of REGISTRY) {
      expect(normalizeAddress(e.chain, e.address), `${e.symbol} ${e.chain}`).toBe(e.address);
    }
  });

  it('нет дублей по паре сеть-адрес', () => {
    const keys = REGISTRY.map((e) => tokenKey(e.chain, e.address));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('у каждой записи есть тег', () => {
    for (const e of REGISTRY) {
      expect(e.tags.length, e.symbol).toBeGreaterThan(0);
    }
  });

  it('isRegistered согласован с реестром', () => {
    expect(isRegistered('SOLANA', USDC_SOL)).toBe(true);
    expect(isRegistered('SOLANA', FAKE)).toBe(false);
    // Тот же адрес в другой сети — не тот же токен.
    expect(isRegistered('BASE', USDC_SOL)).toBe(false);
  });
});

describe('CHAIN_IDS', () => {
  it('идентификаторы сетей соответствуют общепринятым', () => {
    expect(CHAIN_IDS.ETHEREUM).toBe(1);
    expect(CHAIN_IDS.BNB).toBe(56);
    expect(CHAIN_IDS.BASE).toBe(8453);
    // У Solana числового идентификатора нет.
    expect(CHAIN_IDS.SOLANA).toBeNull();
  });
});

describe('dedupeByAddress', () => {
  it('убирает дубли по паре сеть-адрес', () => {
    const items = [
      { chain: 'SOLANA' as const, address: USDC_SOL, liq: 900 },
      { chain: 'SOLANA' as const, address: USDC_SOL, liq: 100 },
      { chain: 'SOLANA' as const, address: FAKE, liq: 50 },
    ];
    const out = dedupeByAddress(items);
    expect(out).toHaveLength(2);
    // Остаётся первый — вызывающий задаёт порядок сам.
    expect(out[0]!.liq).toBe(900);
  });

  it('одинаковые адреса в разных сетях остаются оба', () => {
    const out = dedupeByAddress([
      { chain: 'ETHEREUM' as const, address: USDC_ETH },
      { chain: 'BASE' as const, address: USDC_ETH },
    ]);
    expect(out).toHaveLength(2);
  });

  it('регистр EVM-адреса не создаёт дубль', () => {
    const out = dedupeByAddress([
      { chain: 'ETHEREUM' as const, address: USDC_ETH },
      { chain: 'ETHEREUM' as const, address: USDC_ETH.toUpperCase() },
    ]);
    expect(out).toHaveLength(1);
  });

  it('одинаковые тикеры с разными адресами не схлопываются', () => {
    // Главное свойство: объединять по символу нельзя никогда.
    const out = dedupeByAddress([
      { chain: 'SOLANA' as const, address: USDC_SOL, symbol: 'NVDA' },
      { chain: 'SOLANA' as const, address: FAKE, symbol: 'NVDA' },
    ]);
    expect(out).toHaveLength(2);
  });
});
