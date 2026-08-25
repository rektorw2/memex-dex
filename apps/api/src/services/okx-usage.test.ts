import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Учёт вызовов OKX.
 *
 * Проверяется настоящий счётчик, а не пересказ политики: смысл
 * в том, чтобы Basic и Premium никогда не сложились в одно число
 * и чтобы резерв последних процентов достался человеку, а не фону.
 */

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** План берётся из настроек; по умолчанию бесплатный. */
let plan: string | undefined;

vi.mock('../lib/env.js', () => ({
  env: {
    get OKX_PLAN() {
      return plan;
    },
    NODE_ENV: 'test',
  },
}));

const {
  canSpendOkxCall,
  currentOkxPlan,
  okxSlowdown,
  okxUsageSnapshot,
  recordOkxCall,
  resetOkxUsageForTests,
  seedOkxUsageForTests,
} = await import('./okx-usage.js');

const BASIC = '/api/v6/dex/market/price';
const PREMIUM = '/api/v6/dex/market/price-info';
const FREE = '/api/v6/dex/index/current-price';

beforeEach(() => {
  plan = undefined;
  resetOkxUsageForTests();
});

describe('квоты не смешиваются', () => {
  it('Basic и Premium считаются раздельно', () => {
    /*
     * Это две независимые месячные квоты, а не общая. Сложить их
     * значит объявить, что двести тысяч вызовов взаимозаменяемы,
     * тогда как цена перерасхода у них разная.
     */
    recordOkxCall(BASIC, 'cold-price', 'ok');
    recordOkxCall(BASIC, 'cold-price', 'ok');
    recordOkxCall(PREMIUM, 'enrichment', 'ok');

    const snap = okxUsageSnapshot();

    expect(snap.basic.used).toBe(2);
    expect(snap.premium.used).toBe(1);
  });

  it('бесплатные endpoint не расходуют ни одну квоту', () => {
    recordOkxCall(FREE, 'signal', 'ok');

    const snap = okxUsageSnapshot();

    expect(snap.basic.used).toBe(0);
    expect(snap.premium.used).toBe(0);
  });

  it('исчерпание Basic не закрывает Premium', () => {
    seedOkxUsageForTests('basic', 100_000);

    expect(canSpendOkxCall(BASIC, 'cold-price').allow).toBe(false);
    expect(canSpendOkxCall(PREMIUM, 'enrichment').allow).toBe(true);
  });

  it('отказ провайдера тоже расходует квоту', () => {
    // Утверждать обратное мы не можем, а ошибиться безопаснее
    // в сторону осторожности.
    recordOkxCall(BASIC, 'cold-price', 'rate-limit');
    recordOkxCall(BASIC, 'cold-price', 'error');

    expect(okxUsageSnapshot().basic.used).toBe(2);
  });
});

describe('резерв достаётся пользователю', () => {
  it('у предела фон останавливается, а открытый график работает', () => {
    /*
     * Главное свойство всей схемы. Разница между «каталог обновится
     * в следующем месяце» и «график перестал работать» — это разница
     * между экономией и сломанным продуктом.
     */
    seedOkxUsageForTests('basic', 92_000);

    expect(canSpendOkxCall(BASIC, 'cold-price')).toMatchObject({
      allow: false,
      reason: 'reserve',
    });
    expect(canSpendOkxCall(BASIC, 'hot-price').allow).toBe(true);
  });

  it('фоновая догрузка свечей резерв не занимает', () => {
    /*
     * Свечи открытого графика и фоновая догрузка истории зовут один
     * endpoint. Не различать их значило бы отдать резерв обходу
     * каталога — то есть потратить его ровно на то, ради чего он
     * и берёгся не был.
     */
    seedOkxUsageForTests('basic', 92_000);

    expect(canSpendOkxCall('/api/v6/dex/market/candles', 'candles-backfill').allow).toBe(false);
    expect(canSpendOkxCall('/api/v6/dex/market/candles', 'candles').allow).toBe(true);
  });

  it('после полного исчерпания отказ получает и пользователь', () => {
    // Дальше каждый вызов стоит денег, и тратить их без спроса
    // нельзя даже ради живого графика.
    seedOkxUsageForTests('basic', 100_000);

    expect(canSpendOkxCall(BASIC, 'hot-price')).toMatchObject({
      allow: false,
      reason: 'quota',
    });
  });

  it('лента сигналов считается пользовательской', () => {
    seedOkxUsageForTests('premium', 86_000);

    expect(canSpendOkxCall(PREMIUM, 'signal').allow).toBe(true);
    expect(canSpendOkxCall(PREMIUM, 'enrichment').allow).toBe(false);
  });
});

describe('замедление фона', () => {
  it('до предупреждения обычный темп', () => {
    expect(okxSlowdown('basic')).toBe(1);
  });

  it('после предупреждения реже', () => {
    seedOkxUsageForTests('basic', 81_000);
    expect(okxSlowdown('basic')).toBe(4);
  });

  it('после резерва не запускать вовсе', () => {
    seedOkxUsageForTests('basic', 91_000);
    expect(okxSlowdown('basic')).toBe(0);
  });
});

describe('план из настроек', () => {
  it('по умолчанию бесплатный', () => {
    expect(currentOkxPlan()).toBe('free');
    expect(okxUsageSnapshot().websocketSupported).toBe(false);
  });

  it('платный план поднимает квоту и открывает WebSocket', () => {
    plan = 'starter';

    const snap = okxUsageSnapshot();

    expect(snap.plan).toBe('starter');
    expect(snap.basic.quota).toBe(2_000_000);
    expect(snap.websocketSupported).toBe(true);
  });

  it('опечатка читается как бесплатный, а не как безлимит', () => {
    plan = 'стартер';
    expect(currentOkxPlan()).toBe('free');
  });
});

describe('диагностика честно себя называет', () => {
  it('подписана как локальная оценка, а не баланс OKX', () => {
    /*
     * Остаток квоты провайдер через API не сообщает. Приняв наш
     * счётчик за факт, легко решить «квота ещё есть» ровно тогда,
     * когда её уже нет: он не видит второй экземпляр приложения
     * и обнуляется при перезапуске Render.
     */
    const snap = okxUsageSnapshot();

    expect(snap.source).toContain('Локальный счётчик MEMEX');
    expect(snap.source).toContain('Не является балансом OKX');
  });

  it('разбивка по endpoint и по источнику расхода', () => {
    recordOkxCall(BASIC, 'hot-price', 'ok');
    recordOkxCall(BASIC, 'cold-price', 'ok');
    recordOkxCall(PREMIUM, 'signal', 'rate-limit');

    const snap = okxUsageSnapshot();

    expect(snap.byEndpoint.find((e) => e.endpoint === BASIC)).toMatchObject({
      tier: 'basic',
      calls: 2,
    });
    expect(snap.byEndpoint.find((e) => e.endpoint === PREMIUM)).toMatchObject({
      tier: 'premium',
      rateLimited: 1,
    });
    expect(snap.byPurpose.map((p) => p.purpose)).toContain('hot-price');
  });

  it('строка запроса не плодит отдельные endpoint', () => {
    recordOkxCall('/api/v6/dex/market/candles?bar=1m', 'candles', 'ok');
    recordOkxCall('/api/v6/dex/market/candles?bar=5m', 'candles', 'ok');

    const candles = okxUsageSnapshot().byEndpoint.filter((e) =>
      e.endpoint.includes('/candles'),
    );

    expect(candles).toHaveLength(1);
    expect(candles[0]!.calls).toBe(2);
  });
});
