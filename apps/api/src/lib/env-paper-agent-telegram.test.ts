import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEYS = [
  'NODE_ENV',
  'DATABASE_URL',
  'JWT_SECRET',
  'TELEGRAM_AGENT_NOTIFICATIONS_ENABLED',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_AGENT_CHAT_ID',
] as const;

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
  for (const key of KEYS) process.env[key] = '';
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/memex_test',
    JWT_SECRET: 'test-only-jwt-secret-at-least-32-characters',
    TELEGRAM_AGENT_NOTIFICATIONS_ENABLED: 'false',
    ...overrides,
  });
  vi.resetModules();
  try {
    await import('./env.js');
    return null;
  } catch (error) {
    return error as Error;
  }
}

describe('Telegram paper-агента при старте', () => {
  it('по умолчанию выключен и не требует секретов', async () => {
    expect(await load({})).toBeNull();
  });

  it.each(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_AGENT_CHAT_ID'])('не стартует без %s', async (key) => {
    const complete: Record<string, string> = {
      TELEGRAM_AGENT_NOTIFICATIONS_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: 'test-bot-token',
      TELEGRAM_AGENT_CHAT_ID: '123456789',
    };
    complete[key] = '';
    expect((await load(complete))?.message).toContain(key);
  });

  it('не раскрывает токен или chat id в ошибке', async () => {
    const error = await load({
      TELEGRAM_AGENT_NOTIFICATIONS_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: 'секретный-токен',
      TELEGRAM_AGENT_CHAT_ID: '',
    });
    expect(error?.message).not.toContain('секретный-токен');
  });
});
