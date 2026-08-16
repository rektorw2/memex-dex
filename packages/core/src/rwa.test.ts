import { describe, it, expect } from 'vitest';
import {
  RwaRegistry,
  EMPTY_RWA_REGISTRY,
  checkRwa,
  concentrationRulesApply,
  parseRwaEntry,
  STOCK_TICKERS,
  type RwaEntry,
} from './rwa.js';
import { chainFromIndex } from './okx-model.js';

/**
 * Главный вопрос этих проверок — различает ли система подделку
 * и настоящий токенизированный актив. Заблокировать оба одинаково
 * легко и одинаково неверно.
 */

const REAL_NVDA: RwaEntry = {
  chain: 'SOLANA',
  address: 'Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg',
  symbol: 'NVDAx',
  name: 'NVIDIA xStock',
  issuer: 'xStocks',
  underlying: 'NVDA',
};

const REAL_TSLA: RwaEntry = {
  chain: 'SOLANA',
  address: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB',
  symbol: 'TSLAx',
  name: 'Tesla xStock',
  issuer: 'xStocks',
  underlying: 'TSLA',
};

const registry = new RwaRegistry([REAL_NVDA, REAL_TSLA]);

describe('настоящие токенизированные акции', () => {
  it('подтверждённый адрес признаётся настоящим', () => {
    const v = checkRwa(
      { chain: 'SOLANA', address: REAL_NVDA.address, symbol: 'NVDAx' },
      registry,
    );
    expect(v.isGenuineRwa).toBe(true);
    expect(v.isFakeRwa).toBe(false);
    expect(v.entry?.issuer).toBe('xStocks');
  });

  it('находится и по тикеру базовой бумаги', () => {
    // Токен называется NVDAx, бумага — NVDA. Искать надо по обоим.
    expect(registry.bySymbolAll('NVDA')).toHaveLength(1);
    expect(registry.bySymbolAll('NVDAx')).toHaveLength(1);
  });

  it('к настоящему RWA правила концентрации не применяются', () => {
    // У эмитента почти весь выпуск — это обеспечение, а не захват.
    const v = checkRwa(
      { chain: 'SOLANA', address: REAL_NVDA.address, symbol: 'NVDAx' },
      registry,
    );
    expect(concentrationRulesApply(v)).toBe(false);
  });
});

describe('подделки под биржевые тикеры', () => {
  for (const ticker of ['NVDA', 'TSLA', 'HOOD', 'QQQ']) {
    it(`${ticker} с чужим адресом объявляется подделкой`, () => {
      const v = checkRwa(
        { chain: 'SOLANA', address: 'FakeMint111111111111111111111111111111111111', symbol: ticker },
        registry,
      );
      expect(v.isFakeRwa).toBe(true);
      expect(v.isGenuineRwa).toBe(false);
      expect(v.reason).toContain(ticker);
    });
  }

  it('подделка ловится и в другой сети', () => {
    // Настоящий NVDAx выпущен на Solana. Токен NVDA на Base —
    // подделка независимо от того, как выглядит его контракт.
    const v = checkRwa(
      { chain: 'BASE', address: '0x' + 'a'.repeat(40), symbol: 'NVDA' },
      registry,
    );
    expect(v.isFakeRwa).toBe(true);
  });

  it('маскировка знаками не помогает', () => {
    // $NVDA, N-V-D-A и H00D с нулями сводятся к одному виду.
    expect(checkRwa({ chain: 'BASE', address: '0x1', symbol: '$NVDA' }, registry).isFakeRwa).toBe(true);
    expect(checkRwa({ chain: 'BASE', address: '0x2', symbol: 'H00D' }, registry).isFakeRwa).toBe(true);
  });

  it('к подделке правила концентрации применяются', () => {
    const v = checkRwa({ chain: 'BASE', address: '0x3', symbol: 'NVDA' }, registry);
    expect(concentrationRulesApply(v)).toBe(true);
  });

  it('сообщение подсказывает, где настоящий', () => {
    const v = checkRwa(
      { chain: 'BASE', address: '0x' + 'b'.repeat(40), symbol: 'NVDA' },
      registry,
    );
    expect(v.reason).toContain('xStocks');
  });
});

describe('обычные токены', () => {
  it('мем-коин не трогают', () => {
    const v = checkRwa(
      { chain: 'SOLANA', address: 'SomeMemeMint1111111111111111111111111111111', symbol: 'WIF' },
      registry,
    );
    expect(v.isFakeRwa).toBe(false);
    expect(v.isGenuineRwa).toBe(false);
    expect(v.isUndetermined).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('тикер, похожий на акцию по длине, но не входящий в список, проходит', () => {
    const v = checkRwa({ chain: 'BASE', address: '0x4', symbol: 'PEPE' }, registry);
    expect(v.isFakeRwa).toBe(false);
  });
});

describe('поведение при недоступном реестре', () => {
  it('пустой реестр не объявляет подделкой, но и не пропускает', () => {
    // Это самое важное поведение во всём модуле. Заблокировать
    // настоящий Ondo из-за несработавшей загрузки списка было бы
    // хуже, чем на время показать подделку с предупреждением.
    const v = checkRwa({ chain: 'BASE', address: '0x5', symbol: 'NVDA' }, EMPTY_RWA_REGISTRY);
    expect(v.isFakeRwa).toBe(false);
    expect(v.isUndetermined).toBe(true);
    expect(v.reason).toContain('не загружен');
  });

  it('обычный токен при пустом реестре проходит без замечаний', () => {
    const v = checkRwa({ chain: 'BASE', address: '0x6', symbol: 'DOGE2' }, EMPTY_RWA_REGISTRY);
    expect(v.isUndetermined).toBe(false);
    expect(v.isFakeRwa).toBe(false);
  });

  it('пустой реестр знает, что он пуст', () => {
    expect(EMPTY_RWA_REGISTRY.isEmpty).toBe(true);
    expect(registry.isEmpty).toBe(false);
  });
});

describe('разбор ответа OKX', () => {
  const parse = (raw: unknown) => parseRwaEntry(raw, (i) => chainFromIndex(i as string));

  it('обычная запись разбирается', () => {
    const e = parse({
      chainIndex: '501',
      tokenContractAddress: REAL_NVDA.address,
      tokenSymbol: 'NVDAx',
      tokenName: 'NVIDIA xStock',
      issuer: 'xStocks',
      underlyingSymbol: 'NVDA',
    });
    expect(e?.chain).toBe('SOLANA');
    expect(e?.underlying).toBe('NVDA');
  });

  it('EVM-адрес приводится к нижнему регистру', () => {
    const e = parse({
      chainIndex: '1',
      tokenContractAddress: '0xAbCdEf0123456789012345678901234567890123',
      tokenSymbol: 'ONDO',
    });
    expect(e?.address).toBe('0xabcdef0123456789012345678901234567890123');
  });

  it('mint Solana регистр сохраняет', () => {
    const e = parse({
      chainIndex: '501',
      tokenContractAddress: REAL_NVDA.address,
      tokenSymbol: 'NVDAx',
    });
    // Приведение к нижнему регистру превратило бы адрес в чужой.
    expect(e?.address).toBe(REAL_NVDA.address);
  });

  it('мусор даёт null, а не исключение', () => {
    expect(parse(null)).toBeNull();
    expect(parse({})).toBeNull();
    expect(parse({ chainIndex: '999', tokenContractAddress: '0x1', tokenSymbol: 'X' })).toBeNull();
    expect(parse({ chainIndex: '1', tokenContractAddress: '', tokenSymbol: 'X' })).toBeNull();
  });
});

describe('список защищённых тикеров', () => {
  it('содержит то, что чаще всего подделывают', () => {
    for (const t of ['NVDA', 'TSLA', 'HOOD', 'QQQ', 'AAPL', 'SPY']) {
      expect(STOCK_TICKERS.has(t)).toBe(true);
    }
  });

  it('не содержит обычных крипто-тикеров', () => {
    // Иначе честный мем-коин с трёхбуквенным именем попал бы под запрет.
    for (const t of ['PEPE', 'WIF', 'BONK', 'DOGE']) {
      expect(STOCK_TICKERS.has(t)).toBe(false);
    }
  });
});
