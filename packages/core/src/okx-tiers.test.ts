import { describe, it, expect } from 'vitest';
import {
  OKX_ENDPOINT_TIER,
  OKX_PLANS,
  OKX_MAX_BATCH,
  okxBatchCount,
  okxCountsAgainstQuota,
  okxPlanQuota,
  okxTierOf,
  parseOkxPlan,
} from './okx-tiers.js';

/**
 * Тарификация OKX.
 *
 * Все утверждения здесь сверены с официальной страницей
 * https://web3.okx.com/onchainos/dev-docs/market/market-api-fee
 * (25 августа 2026). Тест существует ровно затем, чтобы правка
 * «по смыслу» не прошла молча: пути `market/price` и `market/price-info`
 * отличаются одним дефисом и стоят по-разному, и именно на этой паре
 * держался весь перерасход.
 */

describe('категории endpoint', () => {
  it('живая цена — Basic', () => {
    expect(okxTierOf('/api/v6/dex/market/price')).toBe('basic');
  });

  it('расширенная информация о цене — Premium', () => {
    /*
     * Один дефис разницы и вдвое дороже. Живая цена шла через этот
     * путь, и горячий цикл звал его раз в секунду: восемьдесят шесть
     * тысяч Premium-вызовов в сутки при месячной квоте в сто тысяч.
     */
    expect(okxTierOf('/api/v6/dex/market/price-info')).toBe('premium');
  });

  it.each([
    ['/api/v6/dex/market/candles', 'basic'],
    ['/api/v6/dex/market/token/hot-token', 'basic'],
    ['/api/v6/dex/market/token/basic-info', 'basic'],
    ['/api/v6/dex/market/token/search', 'basic'],
    ['/api/v6/dex/market/token/top-liquidity', 'basic'],
  ])('%s — %s', (path, tier) => {
    expect(okxTierOf(path)).toBe(tier);
  });

  it.each([
    '/api/v6/dex/market/token/advanced-info',
    '/api/v6/dex/market/historical-candles',
    '/api/v6/dex/market/signal/list',
    '/api/v6/dex/market/token/holder',
    '/api/v6/dex/market/leaderboard/list',
    '/api/v6/dex/market/portfolio/overview',
    '/api/v6/dex/market/token/top-trader',
  ])('%s — Premium', (path) => {
    expect(okxTierOf(path)).toBe('premium');
  });

  it.each([
    '/api/v6/dex/market/supported/chain',
    '/api/v6/dex/index/current-price',
    '/api/v6/dex/balance/token-balances-by-address',
  ])('%s — бесплатный', (path) => {
    expect(okxTierOf(path)).toBe('free');
  });

  it('свечи и историческая история — разные квоты', () => {
    // Обычные свечи Basic, полная история Premium. Загрузка полной
    // истории стоит вчетверо дороже и не должна идти по расписанию.
    expect(okxTierOf('/api/v6/dex/market/candles')).toBe('basic');
    expect(okxTierOf('/api/v6/dex/market/historical-candles')).toBe('premium');
  });
});

describe('разбор пути', () => {
  it('строка запроса не мешает', () => {
    expect(okxTierOf('/api/v6/dex/market/candles?chainIndex=501&bar=1m')).toBe('basic');
  });

  it('двойной слэш не мешает', () => {
    // Встречается и в коде, и в самой документации.
    expect(okxTierOf('/api/v6/dex/market//portfolio/dex-history')).toBe('basic');
  });

  it('неизвестный путь считается Premium', () => {
    /*
     * Осторожная сторона. Посчитать Premium за Basic значит
     * недооценить расход и проснуться с исчерпанной квотой;
     * посчитать Basic за Premium — всего лишь притормозить фон
     * чуть раньше нужного.
     */
    expect(okxTierOf('/api/v6/dex/market/что-то-новое')).toBe('premium');
  });
});

describe('квоты планов', () => {
  it('бесплатный план: сто тысяч на каждую квоту', () => {
    expect(okxPlanQuota('free')).toMatchObject({ basic: 100_000, premium: 100_000 });
  });

  it('на бесплатном плане WebSocket не поддерживается', () => {
    /*
     * Самый практичный факт из всей таблицы. Пока он не был учтён,
     * приложение бесконечно переподключалось к каналу, которого
     * для него не существует, и параллельно расходовало Premium
     * запасным REST-опросом.
     */
    expect(okxPlanQuota('free').websocket).toBe(false);
  });

  it('на платных планах WebSocket есть', () => {
    for (const plan of ['starter', 'growth', 'scale', 'pro'] as const) {
      expect(okxPlanQuota(plan).websocket, plan).toBe(true);
    }
  });

  it('Starter даёт вдвадцатеро больше Basic и вшестеро больше Premium', () => {
    expect(OKX_PLANS.starter.basic / OKX_PLANS.free.basic).toBe(20);
    expect(OKX_PLANS.starter.premium / OKX_PLANS.free.premium).toBe(6);
  });

  it('Premium везде меньше Basic: он дороже', () => {
    for (const [name, quota] of Object.entries(OKX_PLANS)) {
      if (name === 'free') continue;
      expect(quota.premium, name).toBeLessThan(quota.basic);
    }
  });
});

describe('разбор названия плана', () => {
  it('известное значение', () => {
    expect(parseOkxPlan('starter')).toBe('starter');
    expect(parseOkxPlan('  GROWTH ')).toBe('growth');
  });

  it('неизвестное и пустое читаются как бесплатный', () => {
    // Опечатка приведёт к преждевременному замедлению фона,
    // а не к молчаливому перерасходу чужих денег.
    expect(parseOkxPlan('стартер')).toBe('free');
    expect(parseOkxPlan(undefined)).toBe('free');
    expect(parseOkxPlan('')).toBe('free');
  });
});

describe('пакеты', () => {
  it('сто адресов за запрос', () => {
    expect(OKX_MAX_BATCH).toBe(100);
  });

  it('сто адресов — один запрос, сто один — два', () => {
    expect(okxBatchCount(100)).toBe(1);
    expect(okxBatchCount(101)).toBe(2);
  });

  it('пустой список запросов не стоит', () => {
    expect(okxBatchCount(0)).toBe(0);
  });

  it('полторы тысячи токенов — пятнадцать запросов', () => {
    // Число из расчёта расхода: полный круг каталога стоит столько.
    expect(okxBatchCount(1500)).toBe(15);
  });
});

describe('что расходует квоту', () => {
  it('бесплатные endpoint — нет', () => {
    expect(okxCountsAgainstQuota('free')).toBe(false);
  });

  it('Basic и Premium — да', () => {
    expect(okxCountsAgainstQuota('basic')).toBe(true);
    expect(okxCountsAgainstQuota('premium')).toBe(true);
  });

  it('таблица не пуста и не содержит пустых путей', () => {
    const paths = Object.keys(OKX_ENDPOINT_TIER);

    expect(paths.length).toBeGreaterThan(20);
    for (const p of paths) expect(p.startsWith('/api/'), p).toBe(true);
  });
});
