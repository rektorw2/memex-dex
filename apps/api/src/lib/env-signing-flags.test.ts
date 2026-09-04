import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Матрица старых и нового флагов подписи.
 *
 * До этой задачи в проекте было два переключателя. Воркер читал
 * `SOLANA_SIGNING_ENABLED`, часть guards и интерфейс —
 * `KMS_SIGNING_ENABLED`, а в Render и production-примерах стоял
 * только старый. Значит, существовало состояние, в котором экран
 * говорил «подпись выключена», а воркер считал себя вправе вызвать
 * KMS, — и обратное тоже.
 *
 * Проверяется не «флаг читается», а поведение на всех сочетаниях:
 * именно сочетания и порождали расхождение.
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
    if (/^(SOLANA_|KMS_|LIVE_|AWS_|EXECUTION_|FUNDING_|WITHDRAWALS_)/.test(key)) {
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

/** Полностью заполненная конфигурация AWS. Без неё «включено» не проверить. */
const AWS_READY = {
  SOLANA_SIGNER_PROVIDER: 'aws-kms',
  SOLANA_SIGNER_KEY_ID: 'key-1',
  SOLANA_SIGNER_KEY_VERSION: '1',
  SOLANA_SIGNER_WALLET_PUBLIC_KEY: 'A'.repeat(44),
  AWS_REGION: 'eu-central-1',
  SOLANA_PREFLIGHT_RPC_URL: 'https://example.invalid/devnet',
  SOLANA_NETWORK: 'devnet',
};

afterEach(() => {
  vi.resetModules();
});

// ═════════════════════ Таблица двух флагов ═══════════════════════════════════

describe('старый и новый флаг: все сочетания', () => {
  it('оба false — запуск проходит, подпись выключена', async () => {
    const { env } = await load({
      KMS_SIGNING_ENABLED: 'false',
      SOLANA_SIGNING_ENABLED: 'false',
    });

    expect(env.SOLANA_SIGNING_ENABLED).toBe(false);
    expect(env.KMS_SIGNING_ENABLED).toBe(false);
  });

  it('legacy отсутствует, canonical false — запуск проходит', async () => {
    const { env } = await load({ KMS_SIGNING_ENABLED: undefined });

    // Отсутствие отличается от `false` и не превращается в него.
    expect(env.KMS_SIGNING_ENABLED).toBeUndefined();
    expect(env.SOLANA_SIGNING_ENABLED).toBe(false);
  });

  it('legacy true — старт останавливается с объяснением', async () => {
    /*
     * Главный случай. Тихий alias включил бы подпись в окружении,
     * которое просило совсем о другом: этот флаг означал готовность
     * LIVE-контура, а не разрешение подписывать.
     */
    await expect(load({ KMS_SIGNING_ENABLED: 'true' }))
      .rejects.toThrow('KMS_SIGNING_ENABLED=true больше не включает подпись');
  });

  it('в сообщении названа замена, а не только запрет', async () => {
    await expect(load({ KMS_SIGNING_ENABLED: 'true' }))
      .rejects.toThrow(/SOLANA_SIGNING_ENABLED/);
  });

  it('оба true — тоже остановка: несовпадение не решается оптимистично', async () => {
    await expect(load({
      ...AWS_READY,
      KMS_SIGNING_ENABLED: 'true',
      SOLANA_SIGNING_ENABLED: 'true',
    })).rejects.toThrow('KMS_SIGNING_ENABLED=true больше не включает подпись');
  });

  it('legacy false + canonical true — решает canonical', async () => {
    const { env } = await load({
      ...AWS_READY,
      KMS_SIGNING_ENABLED: 'false',
      SOLANA_SIGNING_ENABLED: 'true',
    });

    /*
     * Старое «выключено» не отменяет нового «включено».
     *
     * Обратное правило звучало бы безопаснее, но означало бы, что
     * забытая в Render переменная тихо выключает контур, который
     * оператор только что включил, — и он будет искать причину в
     * коде.
     */
    expect(env.SOLANA_SIGNING_ENABLED).toBe(true);
  });
});

// ═════════════════════ Условия включения ═════════════════════════════════════

describe('подпись включается только при полном наборе условий', () => {
  it('provider unavailable — отказ', async () => {
    await expect(load({
      ...AWS_READY,
      SOLANA_SIGNER_PROVIDER: 'unavailable',
      SOLANA_SIGNING_ENABLED: 'true',
    })).rejects.toThrow(/SOLANA_SIGNER_PROVIDER/);
  });

  it('mainnet — отказ раньше любых других причин', async () => {
    await expect(load({
      ...AWS_READY,
      SOLANA_NETWORK: 'mainnet-beta',
      SOLANA_SIGNING_ENABLED: 'true',
    })).rejects.toThrow('mainnet');
  });

  it('включённые выводы — отказ ещё до контура подписи', async () => {
    /*
     * Ожидание пришлось исправить после первого прогона: отказ
     * приходит раньше, от более общего запрета на LIVE. Это верный
     * порядок — выводы не бывают включены сами по себе, — но
     * означает, что сочетание «подпись плюс выводы» через
     * переменные окружения недостижимо.
     *
     * Поэтому здесь проверяется, что отказ вообще происходит, а
     * само правило — на уровне чистой функции, где оно достижимо
     * и где живёт. Тест, требовавший конкретной формулировки,
     * проверял бы порядок guards, а не защиту.
     */
    await expect(load({
      ...AWS_READY,
      SOLANA_SIGNING_ENABLED: 'true',
      WITHDRAWALS_ENABLED: 'true',
    })).rejects.toThrow();
  });

  it('правило «подпись плюс выводы» работает в самом расчёте', async () => {
    const { transactionSigningState, allowsKmsCall } = await import('@memex/core');
    const ready = {
      signingEnabled: true,
      signerProvider: 'aws-kms',
      providerSupported: true,
      keyConfigured: true,
      identity: 'OK' as const,
      expectedKeyMatches: true,
      network: 'devnet',
      networkVerified: true,
      signatureValidated: false,
      safetyLatchHealthy: true,
      hasAmbiguousAttempt: false,
      withdrawalsEnabled: false,
      broadcastAvailable: false,
    };

    expect(transactionSigningState(ready)).toBe('READY_TO_SIGN_DEVNET');
    // Включённые выводы вместе с подписью — полный путь денег наружу.
    expect(transactionSigningState({ ...ready, withdrawalsEnabled: true }))
      .toBe('REVIEW_REQUIRED');
    expect(allowsKmsCall(transactionSigningState({ ...ready, withdrawalsEnabled: true })))
      .toBe(false);
  });

  it('preflight sign без канонического флага — отказ', async () => {
    /*
     * «Разрешаю подписать при проверке» не включает подпись и не
     * обходит ни одного условия. Иначе это был бы второй способ
     * включить контур, о котором никто не помнит.
     */
    await expect(load({ KMS_PREFLIGHT_ALLOW_SIGN: 'true' }))
      .rejects.toThrow(/KMS_PREFLIGHT_ALLOW_SIGN/);
  });

  it('полностью заполненный AWS при выключенной подписи запускается', async () => {
    const { env } = await load({ ...AWS_READY, SOLANA_SIGNING_ENABLED: 'false' });

    // Заполненная конфигурация сама по себе ничего не включает.
    expect(env.SOLANA_SIGNING_ENABLED).toBe(false);
    expect(env.SOLANA_SIGNER_PROVIDER).toBe('aws-kms');
  });
});

// ═════════════════ Custody отдельно от подписи ═══════════════════════════════

describe('custody encryption и подпись — разные контуры', () => {
  it('KMS_PROVIDER=local не запрещает devnet-подпись', async () => {
    /*
     * Раньше запрещал. Это была склейка понятий по общему слову
     * «KMS»: custody отвечает за шифрование сохранённого ключа, а
     * при подписи через облачный HSM сохранённого ключа нет вовсе.
     *
     * Требование production-custody ради devnet-подписи учило
     * оператора обходить непонятный запрет и скрывало настоящее
     * условие — выбранный провайдер подписи.
     */
    const { env } = await load({
      ...AWS_READY,
      KMS_PROVIDER: 'local',
      SOLANA_SIGNING_ENABLED: 'true',
    });

    expect(env.SOLANA_SIGNING_ENABLED).toBe(true);
    expect(env.KMS_PROVIDER).toBe('local');
  });

  it('custody остаётся условием для LIVE', async () => {
    // Там, где двигаются настоящие средства, локальный мастер-ключ
    // по-прежнему не годится.
    await expect(load({
      EXECUTION_MODE: 'live',
      LIVE_AGENT_ENABLED: 'true',
      KMS_PROVIDER: 'local',
    })).rejects.toThrow('KMS_PROVIDER=local');
  });
});

// ═════════════════════ Контракт использования ════════════════════════════════

describe('старый флаг не используется вне слоя совместимости', () => {
  const ROOT = new URL('../', import.meta.url).pathname;

  function sources(dir: string, found: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) sources(path, found);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) found.push(path);
    }
    return found;
  }

  it('ни один модуль, кроме env.ts, не читает KMS_SIGNING_ENABLED', () => {
    /*
     * Проверяется именно источник, а не наличие условия.
     *
     * Второе чтение старого флага где угодно вернёт ту самую
     * ситуацию, ради устранения которой всё это делалось: два
     * ответа на один вопрос, расходящиеся со временем.
     */
    const offenders: string[] = [];

    for (const path of sources(ROOT)) {
      if (path.endsWith('/lib/env.ts')) continue;
      const source = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      if (source.includes('KMS_SIGNING_ENABLED')) offenders.push(path.slice(ROOT.length));
    }

    expect(offenders).toEqual([]);
  });

  it('воркер подписи не читает флаги сам', () => {
    const source = readFileSync(
      new URL('../workers/intent-signing.ts', import.meta.url), 'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // Решение принимает общий расчёт. Собственный список условий
    // здесь и был половиной расхождения.
    expect(source).not.toMatch(/env\.SOLANA_SIGNING_ENABLED/);
    expect(source).not.toMatch(/env\.SOLANA_SIGNER_PROVIDER/);
    expect(source).toContain('signingStateFromConfig');
    expect(source).toContain('readSigningState');
  });

  it('публичный API не отдаёт сырой флаг как готовность', () => {
    const source = readFileSync(
      new URL('../modules/paper-agent.ts', import.meta.url), 'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const block = source.slice(source.indexOf('signing: {'), source.indexOf('withdrawals: {'));

    expect(block).not.toMatch(/env\.SOLANA_SIGNING_ENABLED/);
    expect(block).toContain('signing.state');
  });
});

// ═════════════════════ Конфигурационные файлы ════════════════════════════════

describe('Render и примеры содержат безопасные значения', () => {
  const repo = new URL('../../../../', import.meta.url).pathname;

  it('render.yaml задаёт канонический флаг выключенным', () => {
    const render = readFileSync(join(repo, 'render.yaml'), 'utf8');

    expect(render).toMatch(/key: SOLANA_SIGNING_ENABLED\s*\n\s*value: "false"/);
    expect(render).toMatch(/key: SOLANA_SIGNER_PROVIDER\s*\n\s*value: unavailable/);
    expect(render).toMatch(/key: KMS_PREFLIGHT_ALLOW_SIGN\s*\n\s*value: "false"/);
  });

  it('render.yaml больше не задаёт устаревший флаг', () => {
    const render = readFileSync(join(repo, 'render.yaml'), 'utf8');
    expect(render).not.toMatch(/key: KMS_SIGNING_ENABLED/);
  });

  it('production-пример содержит канонический флаг', () => {
    const example = readFileSync(join(repo, '.env.production.example'), 'utf8');

    expect(example).toContain('SOLANA_SIGNING_ENABLED=false');
    expect(example).toContain('SOLANA_SIGNER_PROVIDER=unavailable');
    expect(example).toContain('KMS_PREFLIGHT_ALLOW_SIGN=false');
    // Устаревшее присваивание убрано; упоминание в пояснении — нет.
    expect(example).not.toMatch(/^KMS_SIGNING_ENABLED=/m);
  });

  it('в примерах нет учётных данных и адресов узлов', () => {
    for (const name of ['.env.example', '.env.production.example', 'render.yaml']) {
      const text = readFileSync(join(repo, name), 'utf8');
      expect(text, name).not.toMatch(/AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|AWS_SESSION_TOKEN/);
      expect(text, name).not.toMatch(/arn:aws:kms/);
      expect(text, name).not.toMatch(/AWS_KMS_EXPECTED_PUBLIC_KEY=\S/);
    }
  });
});
