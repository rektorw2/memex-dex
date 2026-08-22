import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Доставка почты — часть регистрации, а не необязательная интеграция.
 * Эти проверки не дают серверу подняться в состоянии, где интерфейс
 * обещает письмо, а транспорт заведомо не может его отправить.
 */

const KEYS = [
  'NODE_ENV',
  'EMAIL_PROVIDER',
  'EMAIL_FROM',
  'RESEND_API_KEY',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASS',
] as const;

const COMPLETE_SMTP = {
  EMAIL_PROVIDER: 'smtp',
  EMAIL_FROM: 'Memex DEX <sender@gmail.com>',
  SMTP_HOST: 'smtp.gmail.com',
  SMTP_PORT: '465',
  SMTP_SECURE: 'true',
  SMTP_USER: 'sender@gmail.com',
  SMTP_PASS: 'выдуманный-пароль-приложения',
};

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  vi.resetModules();
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function load(overrides: Record<string, string>): Promise<Error | null> {
  // Явные пустые значения не дают локальному .env подмешать Gmail
  // разработчика в проверку другого случая.
  for (const key of KEYS) process.env[key] = '';
  process.env.NODE_ENV = 'test';
  process.env.EMAIL_PROVIDER = 'disabled';
  process.env.SMTP_PORT = '465';
  process.env.SMTP_SECURE = 'true';
  Object.assign(process.env, overrides);

  vi.resetModules();

  try {
    await import('./env.js');
    return null;
  } catch (error) {
    return error as Error;
  }
}

describe('SMTP при старте', () => {
  it('принимает полную конфигурацию Gmail', async () => {
    expect(await load(COMPLETE_SMTP)).toBeNull();
  });

  it.each(['EMAIL_FROM', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'])('не стартует без %s', async (key) => {
    const partial = { ...COMPLETE_SMTP } as Record<string, string>;
    partial[key] = '';

    const error = await load(partial);

    expect(error).not.toBeNull();
    expect(error!.message).toContain(key);
  });

  it('не раскрывает пароль приложения в ошибке конфигурации', async () => {
    const error = await load({
      ...COMPLETE_SMTP,
      SMTP_HOST: '',
      SMTP_PASS: 'секрет-который-нельзя-печатать',
    });

    expect(error).not.toBeNull();
    expect(error!.message).not.toContain('секрет-который-нельзя-печатать');
  });

  it('понимает SMTP_SECURE=false для STARTTLS на порту 587', async () => {
    for (const key of KEYS) process.env[key] = '';
    process.env.NODE_ENV = 'test';
    Object.assign(process.env, {
      ...COMPLETE_SMTP,
      SMTP_PORT: '587',
      SMTP_SECURE: 'false',
    });
    vi.resetModules();

    const { env } = await import('./env.js');

    expect(env.SMTP_PORT).toBe(587);
    expect(env.SMTP_SECURE).toBe(false);
  });
});

describe('остальные почтовые транспорты', () => {
  it('по умолчанию доставка честно выключена', async () => {
    expect(await load({})).toBeNull();
  });

  it('Resend по-прежнему требует ключ и отправителя', async () => {
    const withoutKey = await load({
      EMAIL_PROVIDER: 'resend',
      EMAIL_FROM: 'Memex DEX <no-reply@example.test>',
    });
    expect(withoutKey?.message).toContain('RESEND_API_KEY');

    const complete = await load({
      EMAIL_PROVIDER: 'resend',
      EMAIL_FROM: 'Memex DEX <no-reply@example.test>',
      RESEND_API_KEY: 're_выдуманный',
    });
    expect(complete).toBeNull();
  });

  it('console запрещён только в production', async () => {
    expect(await load({ EMAIL_PROVIDER: 'console' })).toBeNull();

    const error = await load({ EMAIL_PROVIDER: 'console', NODE_ENV: 'production' });
    expect(error?.message).toContain('EMAIL_PROVIDER=console');
  });
});
