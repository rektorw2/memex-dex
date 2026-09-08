import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Управляемый источник: адаптер и его единственный собственный запрет.
 *
 * Правила допуска проверены в ядре отдельно. Здесь проверяется то,
 * что чистой функцией не выражается: служба не умеет писать в чужие
 * строки. Тест поведенческий — запись действительно не доходит до
 * базы, а не «в коде есть проверка».
 */

const tokens = new Map<string, { id: string; address: string; symbol: string; name: string }>([
  ['test-1', { id: 'test-1', address: 'TEST0abc', symbol: 'TST', name: 'Test' }],
  // Настоящий USDC. Именно его подмена была бы подменой production
  // market data для всего приложения сразу.
  ['real-1', {
    id: 'real-1',
    address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    name: 'USD Coin',
  }],
]);

const updates: unknown[] = [];
const creates: unknown[] = [];

const prismaMock = {
  token: {
    findUnique: vi.fn(async ({ where }: any) => tokens.get(where.id) ?? null),
    update: vi.fn(async (args: any) => {
      updates.push(args);
      return { id: args.where.id };
    }),
    create: vi.fn(async (args: any) => {
      creates.push(args);
      return { id: 'created-1', address: args.data.address };
    }),
  },
  okxSignal: {
    create: vi.fn(async (args: any) => {
      creates.push(args);
      return { id: 'signal-1' };
    }),
  },
};

/** Конфигурация, которую подменяем от теста к тесту. */
const envMock = {
  PAPER_TEST_SOURCE_ENABLED: true,
  EXECUTION_MODE: 'paper',
  LIVE_EXECUTION_ENABLED: false,
  WITHDRAWALS_ENABLED: false,
  SOLANA_NETWORK: 'devnet',
};

vi.mock('../lib/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../lib/env.js', () => ({ env: envMock }));

const {
  createPaperTestSignal,
  createPaperTestToken,
  newPaperTestAddress,
  paperTestAccess,
  setPaperTestPrice,
} = await import('./paper-test-source.js');

beforeEach(() => {
  envMock.PAPER_TEST_SOURCE_ENABLED = true;
  envMock.EXECUTION_MODE = 'paper';
  envMock.LIVE_EXECUTION_ENABLED = false;
  envMock.WITHDRAWALS_ENABLED = false;
  envMock.SOLANA_NETWORK = 'devnet';
  updates.length = 0;
  creates.length = 0;
  vi.clearAllMocks();
});

describe('допуск читается из конфигурации', () => {
  it('при полном наборе условий администратор допущен', () => {
    expect(paperTestAccess('ADMIN')).toEqual({ ok: true, value: true });
  });

  it('выключенная настройка закрывает контур', () => {
    envMock.PAPER_TEST_SOURCE_ENABLED = false;

    expect(paperTestAccess('ADMIN')).toEqual({ ok: false, reason: 'TEST_SOURCE_DISABLED' });
  });

  it('обычный пользователь не допущен', () => {
    expect(paperTestAccess('USER')).toEqual({ ok: false, reason: 'ADMIN_REQUIRED' });
  });
});

describe('чужие данные недостижимы', () => {
  it('цена настоящего токена не переписывается', async () => {
    /*
     * Главный тест файла, и он поведенческий: важно не наличие
     * проверки в коде, а то, что до `update` дело не доходит.
     * `Token.priceUsd` читают терминал, радар и все подборки.
     */
    const result = await setPaperTestPrice('ADMIN', 'real-1', 42);

    expect(result).toEqual({ ok: false, reason: 'ADDRESS_NOT_TEST_NAMESPACE' });
    expect(prismaMock.token.update).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('цена тестового токена меняется', async () => {
    // Негативный контроль к тесту выше: отказ вызван адресом,
    // а не тем, что запись вообще не работает.
    const result = await setPaperTestPrice('ADMIN', 'test-1', 42);

    expect(result).toEqual({ ok: true, value: { id: 'test-1' } });
    expect(updates).toHaveLength(1);
  });

  it('сигнал нельзя повесить на настоящий токен', async () => {
    const result = await createPaperTestSignal('ADMIN', {
      tokenId: 'real-1',
      walletTypes: ['smart_money'],
      amountUsd: 5_000,
      signaledAt: new Date(),
      receivedAt: new Date(),
      priceUsd: 1,
    });

    expect(result).toEqual({ ok: false, reason: 'ADDRESS_NOT_TEST_NAMESPACE' });
    expect(prismaMock.okxSignal.create).not.toHaveBeenCalled();
  });

  it('несуществующий токен тоже отказ, а не создание нового', async () => {
    const result = await setPaperTestPrice('ADMIN', 'нет-такого', 42);

    expect(result).toEqual({ ok: false, reason: 'ADDRESS_NOT_TEST_NAMESPACE' });
    expect(prismaMock.token.update).not.toHaveBeenCalled();
  });

  it('закрытый контур не пишет вообще ничего', async () => {
    envMock.PAPER_TEST_SOURCE_ENABLED = false;

    await setPaperTestPrice('ADMIN', 'test-1', 42);
    await createPaperTestToken('ADMIN', {
      symbol: 'X', name: 'X', priceUsd: 1, poolCreatedAt: null,
    });
    await createPaperTestSignal('ADMIN', {
      tokenId: 'test-1', walletTypes: ['smart_money'], amountUsd: 5_000,
      signaledAt: new Date(), receivedAt: new Date(), priceUsd: 1,
    });

    expect(updates).toHaveLength(0);
    expect(creates).toHaveLength(0);
  });
});

describe('тестовые записи узнаваемы', () => {
  it('адрес выдаёт служба, а не вызывающий', async () => {
    /*
     * Параметр `address` означал бы, что вызывающий может назвать
     * чужой mint. Служба выдаёт адрес сама, и он всегда в тестовом
     * пространстве.
     */
    await createPaperTestToken('ADMIN', {
      symbol: 'TST', name: 'Test', priceUsd: 1, poolCreatedAt: null,
    });

    const created = creates[0] as any;
    expect(created.data.address).toMatch(/^TEST0/);
    expect(created.data.isHidden).toBe(true);
  });

  it('два вызова дают разные адреса', () => {
    expect(newPaperTestAddress()).not.toBe(newPaperTestAddress());
  });

  it('сигнал помечен тестовым происхождением', async () => {
    // Иначе тестовый прогон улучшал бы метрики живой ленты.
    await createPaperTestSignal('ADMIN', {
      tokenId: 'test-1',
      walletTypes: ['smart_money'],
      amountUsd: 5_000,
      signaledAt: new Date(),
      receivedAt: new Date(),
      priceUsd: 1,
    });

    expect((creates[0] as any).data.ingestOrigin).toBe('TEST_HARNESS');
  });

  it('цена может быть пустой: это отдельный проверяемый сценарий', async () => {
    // «Цена не пришла» — тоже состояние PAPER-режима, и без
    // возможности его создать его нельзя проверить.
    await createPaperTestToken('ADMIN', {
      symbol: 'TST', name: 'Test', priceUsd: null, poolCreatedAt: null,
    });

    expect((creates[0] as any).data.priceUsd).toBeNull();
    expect((creates[0] as any).data.priceUpdatedAt).toBeNull();
  });
});
