import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Проверки настроек оплаты при старте.
 *
 * Смысл у них один: приложение не должно подниматься в состоянии,
 * где страница оплаты работает, а деньги некуда доставить или нечем
 * подтвердить. Молчаливый старт с неполной настройкой хуже отказа —
 * человек платит, а мы не узнаём.
 *
 * Каждый случай задаёт все относящиеся к делу переменные явно, чтобы
 * локальный .env не подмешивал своих значений.
 */

const KEYS = [
  'NODE_ENV',
  'SUBSCRIPTION_PAYMENT_PROVIDER',
  'SUBSCRIPTION_TREASURY_SOLANA_ADDRESS',
  'BRIDGE_PAYMENTS_ENABLED',
  'BRIDGE_API_KEY',
  'BRIDGE_WEBHOOK_PUBLIC_KEY',
  'COINBASE_ONRAMP_ENABLED',
  'COINBASE_ONRAMP_MODE',
  'COINBASE_CDP_API_KEY_ID',
  'COINBASE_CDP_API_KEY_SECRET',
  'COINBASE_WEBHOOK_SECRET',
  'COINBASE_REDIRECT_URL',
] as const;

const TREASURY = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

let saved: Record<string, string | undefined> = {};

const COMPLETE_COINBASE = {
  COINBASE_ONRAMP_ENABLED: 'true',
  COINBASE_ONRAMP_MODE: 'production',
  COINBASE_CDP_API_KEY_ID: 'organizations/o/apiKeys/k',
  COINBASE_CDP_API_KEY_SECRET: 'выдуманный секрет, ключом не является',
  COINBASE_WEBHOOK_SECRET: 'выдуманный секрет вебхука',
  COINBASE_REDIRECT_URL: 'https://memex.example/checkout',
  SUBSCRIPTION_TREASURY_SOLANA_ADDRESS: TREASURY,
};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  vi.resetModules();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Загрузка настроек с заданным окружением. Возвращает ошибку, если была. */
async function load(overrides: Record<string, string>): Promise<Error | null> {
  for (const k of KEYS) delete process.env[k];

  process.env.NODE_ENV = 'test';
  Object.assign(process.env, overrides);

  vi.resetModules();

  try {
    await import('./env.js');
    return null;
  } catch (e) {
    return e as Error;
  }
}

describe('настройки Coinbase при старте', () => {
  it('поднимаются при полной настройке', async () => {
    expect(await load({ ...COMPLETE_COINBASE })).toBeNull();
  });

  it.each([
    'COINBASE_CDP_API_KEY_ID',
    'COINBASE_CDP_API_KEY_SECRET',
    'COINBASE_WEBHOOK_SECRET',
    'COINBASE_REDIRECT_URL',
    'SUBSCRIPTION_TREASURY_SOLANA_ADDRESS',
  ])('не поднимаются без %s', async (key) => {
    const partial = { ...COMPLETE_COINBASE } as Record<string, string>;
    delete partial[key];

    const err = await load(partial);

    expect(err).not.toBeNull();
    expect(err!.message).toContain(key);
  });

  it('не принимают адрес выручки с опечаткой', async () => {
    const err = await load({
      ...COMPLETE_COINBASE,
      SUBSCRIPTION_TREASURY_SOLANA_ADDRESS: 'не адрес',
    });

    expect(err!.message).toContain('SUBSCRIPTION_TREASURY_SOLANA_ADDRESS');
  });

  it('запрещают песочницу в боевой среде', async () => {
    // Тестовые карты выдавали бы настоящие подписки.
    const err = await load({
      ...COMPLETE_COINBASE,
      NODE_ENV: 'production',
      COINBASE_ONRAMP_MODE: 'sandbox',
    });

    expect(err!.message).toContain('COINBASE_ONRAMP_MODE');
  });

  it('разрешают песочницу вне боевой среды', async () => {
    const err = await load({ ...COMPLETE_COINBASE, COINBASE_ONRAMP_MODE: 'sandbox' });
    expect(err).toBeNull();
  });

  it('требуют https для адреса возврата в боевой среде', async () => {
    const err = await load({
      ...COMPLETE_COINBASE,
      NODE_ENV: 'production',
      COINBASE_REDIRECT_URL: 'http://memex.example/checkout',
    });

    expect(err!.message).toContain('https');
  });

  it.each([
    'https://localhost:3000/checkout',
    'https://pay-sandbox.coinbase.com/checkout',
  ])('не пускают адрес возврата %s в боевую среду', async (redirect) => {
    const err = await load({
      ...COMPLETE_COINBASE,
      NODE_ENV: 'production',
      COINBASE_REDIRECT_URL: redirect,
    });

    expect(err).not.toBeNull();
  });

  it('замечают тестовый ключ в боевой среде', async () => {
    const err = await load({
      ...COMPLETE_COINBASE,
      NODE_ENV: 'production',
      COINBASE_CDP_API_KEY_ID: 'organizations/o/apiKeys/sandbox-key',
    });

    expect(err!.message).toContain('COINBASE_CDP_API_KEY_ID');
  });
});

describe('выбор провайдера при старте', () => {
  it('по умолчанию оплата выключена и это не ошибка', async () => {
    // Каталог тарифов работает и без оплаты: посмотреть цены можно,
    // а кнопки, за которой ничего нет, не будет.
    expect(await load({})).toBeNull();
  });

  it('не выбирают Coinbase, пока он не включён', async () => {
    const err = await load({ SUBSCRIPTION_PAYMENT_PROVIDER: 'coinbase' });

    expect(err).not.toBeNull();
    expect(err!.message).toContain('COINBASE_ONRAMP_ENABLED');
  });

  it('не выбирают Bridge, пока он не включён', async () => {
    const err = await load({ SUBSCRIPTION_PAYMENT_PROVIDER: 'bridge' });

    expect(err).not.toBeNull();
    expect(err!.message).toContain('BRIDGE_PAYMENTS_ENABLED');
  });

  it('принимают согласованный выбор Coinbase', async () => {
    const err = await load({
      ...COMPLETE_COINBASE,
      SUBSCRIPTION_PAYMENT_PROVIDER: 'coinbase',
    });

    expect(err).toBeNull();
  });

  it('не мешают Bridge остаться включённым при выбранном Coinbase', async () => {
    // Исторические платежи Bridge должны продолжать читаться
    // и обрабатываться после смены провайдера.
    const err = await load({
      ...COMPLETE_COINBASE,
      SUBSCRIPTION_PAYMENT_PROVIDER: 'coinbase',
      BRIDGE_PAYMENTS_ENABLED: 'true',
      BRIDGE_API_KEY: 'выдуманный ключ',
      BRIDGE_WEBHOOK_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----выдумка-----END PUBLIC KEY-----',
    });

    expect(err).toBeNull();
  });
});
