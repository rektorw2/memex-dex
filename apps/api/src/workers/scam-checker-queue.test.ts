import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EMPTY_RWA_REGISTRY } from '@memex/core';

/**
 * Кого проверка берёт в работу.
 *
 * Проверяется настоящий `checkBatch` с поддельной базой и мёртвыми
 * источниками. Пересказ отбора в тесте доказывал бы правильность
 * пересказа, а сломано было именно условие: `isHidden: false`
 * отсекало находки DexScreener, и они не проверялись никогда —
 * висели с символом «???», снять флаг мог только админ руками.
 *
 * Ни один источник здесь не отвечает: сеть в тестах запрещена,
 * а нам и не нужен вердикт — нужен состав очереди.
 */

let findManyArgs: Record<string, unknown>[] = [];
let updateArgs: Record<string, unknown>[] = [];
let rows: Record<string, unknown>[] = [];

/**
 * Токены, которых нет в обычном срезе.
 *
 * Открытая карточка добирается вторым запросом по списку id,
 * и без отдельного набора этот путь не проверить: если токен уже
 * в срезе, второго запроса не будет вовсе.
 */
let outOfPool: Record<string, unknown>[] = [];
let lastWarn: unknown[] = [];

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    token: {
      findMany: async (args: Record<string, unknown>) => {
        findManyArgs.push(args);
        // Второй запрос — добор открытых карточек по списку id.
        const where = (args.where ?? {}) as { id?: { in?: string[] } };
        if (where.id?.in) {
          return [...rows, ...outOfPool].filter((r) => where.id!.in!.includes(r.id as string));
        }
        return rows;
      },
      update: async (args: Record<string, unknown>) => {
        updateArgs.push(args);
        return {};
      },
    },
  },
  serializable: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: (...a: unknown[]) => { lastWarn = a; }, error: vi.fn(), debug: vi.fn() },
}));

/** Источники молчат: сеть в тестах запрещена. */
const dead = () => Promise.resolve(null);

vi.mock('../services/token-intel.js', () => ({ fetchSecurityFacts: dead }));
vi.mock('../services/dexscreener.js', () => ({
  fetchTokenPair: dead,
  isDexScreenerSupported: () => true,
}));
vi.mock('../services/jupiter.js', () => ({ fetchJupiterToken: dead }));
vi.mock('../services/okx.js', () => ({
  fetchOkxTokenDetail: dead,
  checkRoundTrip: dead,
  isOkxConfigured: () => false,
  isOkxSupported: () => false,
}));
vi.mock('../services/okx-market.js', () => ({
  /*
   * Настоящий пустой реестр, а не объект похожей формы.
   *
   * Подделка не того типа роняет проверку, и все тесты файла уходят
   * в ветку обработки ошибки — где поля тоже пишутся, а утверждения
   * выглядят проходящими. Ровно это здесь и случилось, пока
   * не появилась проверка `lastWarn`.
   */
  fetchRwaRegistry: async () => EMPTY_RWA_REGISTRY,
  fetchPriceInfo: async () => new Map(),
  safeCall: dead,
  MARKET_DATA_SOURCE: 'okx',
}));
vi.mock('../services/okx-security.js', () => ({
  fetchAdvancedInfo: dead,
  readTags: () => null,
  readOkxRisk: () => ({ hardBlock: false, band: 'none', explanation: '', level: 0 }),
}));
vi.mock('../services/honeypot.js', () => ({
  checkHoneypot: dead,
  isHoneypotSupported: () => false,
}));
vi.mock('../services/rugcheck.js', () => ({
  checkRugcheck: dead,
  isAbsoluteFinding: () => false,
}));

const { checkBatch, RULES_VERSION } = await import('./scam-checker.js');
const { markHot, resetHotTokensForTests } = await import('./hot-tokens.js');

const HOUR = 3_600_000;
const NOW = Date.now();

const token = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  chain: 'SOLANA',
  address: `Addr${id}`,
  symbol: id.toUpperCase(),
  name: id,
  isHidden: false,
  isQuote: false,
  priceUsd: null,
  liquidityUsd: null,
  volume24hUsd: null,
  fdvUsd: null,
  priceChange24h: null,
  logoUrl: null,
  scamCheckedAt: new Date(NOW - HOUR),
  scamRulesVersion: RULES_VERSION,
  scamCheckAttempts: 0,
  scamCheckNextAt: null,
  scamProviderError: false,
  ...over,
});

beforeEach(() => {
  findManyArgs = [];
  updateArgs = [];
  rows = [];
  outOfPool = [];
  lastWarn = [];
  resetHotTokensForTests();
});

/** Условие первого запроса кандидатов. */
const candidateWhere = () => (findManyArgs[0]?.where ?? {}) as Record<string, unknown>;

/** Кого проверка в итоге обновила. */
const touched = () => updateArgs.map((a) => (a.where as { id: string }).id);

/**
 * Убедиться, что проверка не упала.
 *
 * Ветка обработки ошибки тоже пишет в базу и тоже двигает счётчики,
 * поэтому упавшая проверка выглядит как работающая. Без этой сверки
 * половина файла зеленела, не проверяя ничего.
 */
const expectNoFailure = () => expect(lastWarn, JSON.stringify(lastWarn)).toEqual([]);

describe('скрытые находки проверяются', () => {
  it('отбор не отсекает скрытые', async () => {
    /*
     * Тот самый дефект: токены с вкладки DexScreener заводятся
     * скрытыми, а отбор брал только `isHidden: false`. Они не
     * проверялись никогда и висели в «ожидает проверки» вечно.
     */
    rows = [];
    await checkBatch(4);

    expect(candidateWhere()).not.toHaveProperty('isHidden');
  });

  it('скрытый токен попадает в пачку', async () => {
    rows = [token('hidden', { isHidden: true, scamCheckedAt: null })];

    await checkBatch(4);

    expect(touched()).toContain('hidden');
  });

  it('котировочные токены по-прежнему не проверяются', async () => {
    // Их проверять незачем: это USDC и подобные.
    await checkBatch(4);
    expect(candidateWhere().isQuote).toBe(false);
  });
});

describe('открытая карточка идёт вне очереди', () => {
  it('токен вне среза добирается отдельным запросом', async () => {
    /*
     * Срез отсортирован по версии правил и возрасту, и свежепроверенный
     * токен стоит в самом его конце. Без отдельного запроса открытая
     * карточка ждала бы полного круга.
     */
    markHot('opened');
    rows = [token('other')];
    outOfPool = [token('opened')];

    await checkBatch(4);

    const second = (findManyArgs[1]?.where ?? {}) as { id?: { in?: string[] } };
    expect(second.id?.in).toContain('opened');
    expect(touched()).toContain('opened');
  });

  it('открытый токен проверяется вперёд остальных', async () => {
    markHot('opened');

    rows = [
      token('routine-1'),
      token('routine-2'),
      token('opened', { scamCheckedAt: new Date(NOW - 60_000) }),
    ];

    await checkBatch(1);

    expect(touched()).toEqual(['opened']);
  });
});

describe('повторные попытки', () => {
  it('токен с назначенным повтором в пачку не берётся', async () => {
    rows = [
      token('waiting', { scamCheckAttempts: 2, scamCheckNextAt: new Date(NOW + 10 * 60_000) }),
      token('ready'),
    ];

    await checkBatch(4);

    expect(touched()).toEqual(['ready']);
  });

  it('исчерпавший попытки выпадает из очереди', async () => {
    // Иначе пять таких записей выедают всю пропускную способность,
    // а снаружи очередь выглядит работающей.
    rows = [token('broken', { scamCheckAttempts: 6 }), token('ok')];

    await checkBatch(4);

    expect(touched()).toEqual(['ok']);
  });

  it('неполный опрос назначает повтор, а не блокирует', async () => {
    /*
     * Ключевое поведение. Все источники молчат, но молчат они
     * возвратом null — это «нечего сказать», а не сбой, поэтому
     * блокировки быть не должно ни при каком исходе.
     */
    rows = [token('quiet')];

    await checkBatch(1);

    expectNoFailure();

    const data = updateArgs[0]!.data as Record<string, unknown>;
    expect(data.riskLevel).not.toBe('blocked');
  });

  it('состояние попыток пишется в базу', async () => {
    // В память нельзя: перезапуск обнулял бы счётчик, и токен,
    // роняющий проверку, начинал бы круг после каждого деплоя.
    rows = [token('any')];

    await checkBatch(1);

    expectNoFailure();

    const data = updateArgs[0]!.data as Record<string, unknown>;
    expect(data).toHaveProperty('scamCheckAttempts');
    expect(data).toHaveProperty('scamProviderError');
  });
});

describe('открытие после проверки', () => {
  it('скрытый токен без замечаний становится видимым', async () => {
    rows = [token('clean', { isHidden: true, scamCheckedAt: null })];

    await checkBatch(1);
    expectNoFailure();

    const data = updateArgs[0]!.data as Record<string, unknown>;
    const level = data.riskLevel;

    // Открывается только чистый результат; при молчащих источниках
    // вердикт не «низкий риск», поэтому токен остаётся скрытым.
    if (level === 'low' || level === 'verified') expect(data.isHidden).toBe(false);
    else expect(data).not.toHaveProperty('isHidden');
  });

  it('видимый токен этот код никогда не прячет', async () => {
    /*
     * Обратного хода нет намеренно: спрятать открытый админом токен
     * фоновая проверка права не имеет. Скрытие остаётся ручным
     * действием.
     */
    rows = [token('visible', { isHidden: false })];

    await checkBatch(1);
    expectNoFailure();

    expect(updateArgs[0]!.data as Record<string, unknown>).not.toHaveProperty('isHidden');
  });
});

describe('бюджет прохода', () => {
  it('нулевой бюджет не начинает работу', async () => {
    rows = [token('a'), token('b')];

    const r = await checkBatch(4, { budgetMs: -1 });

    expect(r.checked).toBe(0);
    expect(r.timedOut).toBe(true);
  });

  it('пустая витрина обрабатывается без ошибок', async () => {
    rows = [];
    await expect(checkBatch(4)).resolves.toMatchObject({ checked: 0 });
  });
});
