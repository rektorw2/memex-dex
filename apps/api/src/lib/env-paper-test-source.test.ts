import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Управляемый источник сигналов не запускается рядом с боевым режимом.
 *
 * Проверка стоит на старте, а не в маршруте, и тест проверяет именно
 * старт. Маршрут можно обойти скриптом, задачей планировщика или
 * следующим обработчиком, который забудут спросить; запуск проходят
 * все.
 *
 * Что здесь на кону. Управляемый источник — это возможность
 * нарисовать агенту любую картину рынка. В PAPER-режиме это ровно
 * то, ради чего он сделан. В боевом это чужие деньги.
 */

const BASE = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(48),
  KMS_LOCAL_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
};

async function load(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  const previous = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (/^(SOLANA_|KMS_|LIVE_|AWS_|EXECUTION_|FUNDING_|WITHDRAWALS_|PAPER_)/.test(key)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, BASE, overrides);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
  }
  try {
    return await import('./env.js');
  } finally {
    process.env = previous;
  }
}

afterEach(() => {
  vi.resetModules();
});

describe('управляемый источник в конфигурации', () => {
  it('по умолчанию выключен', async () => {
    // Значение по умолчанию — единственное, которое получит
    // production, если о настройке никто не вспомнит.
    const { env } = await load();

    expect(env.PAPER_TEST_SOURCE_ENABLED).toBe(false);
  });

  it('включается в PAPER-режиме на devnet', async () => {
    const { env } = await load({ PAPER_TEST_SOURCE_ENABLED: 'true' });

    expect(env.PAPER_TEST_SOURCE_ENABLED).toBe(true);
    expect(env.EXECUTION_MODE).toBe('paper');
  });

  it('боевой режим исполнения останавливает запуск', async () => {
    /*
     * Ни в одном тесте здесь ничего не включается: проверяется,
     * что такая конфигурация вообще не поднимается. Сочетание
     * «управляемый источник плюс боевой режим» — это возможность
     * заставить агента торговать по выдуманным сигналам.
     */
    await expect(
      load({ PAPER_TEST_SOURCE_ENABLED: 'true', EXECUTION_MODE: 'live' }),
    ).rejects.toThrow(/EXECUTION_MODE=live/);
  });

  it('mainnet-beta останавливает запуск', async () => {
    await expect(
      load({ PAPER_TEST_SOURCE_ENABLED: 'true', SOLANA_NETWORK: 'mainnet-beta' }),
    ).rejects.toThrow(/PAPER_TEST_SOURCE_ENABLED/);
  });

  it('в сообщении названо конфликтующее значение', async () => {
    /*
     * Дежурному нужно знать, что именно снять. Сообщение вида
     * «нельзя» отправляет читать исходники.
     */
    await expect(
      load({ PAPER_TEST_SOURCE_ENABLED: 'true', SOLANA_NETWORK: 'mainnet-beta' }),
    ).rejects.toThrow(/SOLANA_NETWORK=mainnet-beta/);
  });

  it('выключенный источник не мешает никакой конфигурации', async () => {
    // Негативный контроль: запрет срабатывает из-за источника,
    // а не из-за самой сети.
    const { env } = await load({ SOLANA_NETWORK: 'mainnet-beta' });

    expect(env.PAPER_TEST_SOURCE_ENABLED).toBe(false);
    expect(env.SOLANA_NETWORK).toBe('mainnet-beta');
  });
});

describe('примеры и Render задают источник выключенным', () => {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../${name}`, import.meta.url), 'utf8');

  it('оба примера содержат флаг и он выключен', () => {
    /*
     * Отсутствие строки хуже, чем `false`: настройку, которой нет
     * в примере, включают наугад и без оговорок. Значение по
     * умолчанию в схеме от этого не спасает — спасает то, что
     * человек прочитал, зачем оно нужно.
     */
    for (const file of ['.env.example', '.env.production.example']) {
      expect(read(file), file).toMatch(/^PAPER_TEST_SOURCE_ENABLED=false$/m);
    }
  });

  it('Render не включает источник', () => {
    const render = read('render.yaml');

    expect(render).not.toMatch(/PAPER_TEST_SOURCE_ENABLED[\s\S]{0,40}true/);
  });

  it('рядом с флагом объяснено, чем он опасен', () => {
    // Настройка без объяснения — это настройка, которую включат
    // «чтобы посмотреть».
    for (const file of ['.env.example', '.env.production.example']) {
      const block = read(file).split('PAPER_TEST_SOURCE_ENABLED')[0]!.slice(-900);
      expect(block, file).toMatch(/mainnet|исполнени|выводов/i);
    }
  });
});
