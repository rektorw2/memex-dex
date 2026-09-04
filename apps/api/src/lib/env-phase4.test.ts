import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const ORIGINAL = { ...process.env };

async function load(over: Record<string, string>) {
  vi.resetModules();
  process.env = {
    ...ORIGINAL,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/memex',
    JWT_SECRET: 'x'.repeat(40),
    KMS_LOCAL_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    EXECUTION_MODE: 'paper',
    FUNDING_ENABLED: 'false',
    LIVE_AGENT_ENABLED: 'false',
    LIVE_EXECUTION_ENABLED: 'false',
    WITHDRAWALS_ENABLED: 'false',
    LIVE_RPC_READY: 'false',
    LIVE_RECONCILIATION_ENABLED: 'false',
    LIVE_MIGRATIONS_READY: 'false',
    KMS_SIGNING_ENABLED: 'false',
    LIVE_AGENT_CONTROL_MODE: 'semi-auto',
    ...over,
  };
  return import('./env.js');
}

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

describe('Phase 4 startup guards', () => {
  it('keeps every money-moving flag disabled by default', async () => {
    const { env } = await load({});
    expect(env.EXECUTION_MODE).toBe('paper');
    expect(env.FUNDING_ENABLED).toBe(false);
    expect(env.LIVE_AGENT_ENABLED).toBe(false);
    expect(env.LIVE_EXECUTION_ENABLED).toBe(false);
    expect(env.WITHDRAWALS_ENABLED).toBe(false);
  });

  it('cannot enable LIVE from paper mode', async () => {
    await expect(load({ LIVE_AGENT_ENABLED: 'true' })).rejects.toThrow('EXECUTION_MODE=paper');
  });

  it('cannot enable LIVE with local KMS', async () => {
    await expect(load({ EXECUTION_MODE: 'live', LIVE_AGENT_ENABLED: 'true' })).rejects.toThrow('KMS_PROVIDER=local');
  });

  it('requires RPC, reconciliation and migrations before funding', async () => {
    await expect(load({ FUNDING_ENABLED: 'true' })).rejects.toThrow('LIVE_RPC_READY');
  });

  it('requires the RPC deposit source after readiness gates pass', async () => {
    await expect(load({
      FUNDING_ENABLED: 'true',
      LIVE_RPC_READY: 'true',
      LIVE_RECONCILIATION_ENABLED: 'true',
      LIVE_MIGRATIONS_READY: 'true',
    })).rejects.toThrow('SOLANA_DEPOSIT_SOURCE=rpc');
  });

  it('requires an explicit first-run slot instead of scanning from genesis', async () => {
    await expect(load({
      FUNDING_ENABLED: 'true',
      LIVE_RPC_READY: 'true',
      LIVE_RECONCILIATION_ENABLED: 'true',
      LIVE_MIGRATIONS_READY: 'true',
      SOLANA_DEPOSIT_SOURCE: 'rpc',
    })).rejects.toThrow('SOLANA_DEPOSIT_BOOTSTRAP_SLOT');
  });

  it('requires signing before execution', async () => {
    await expect(load({
      EXECUTION_MODE: 'live', KMS_PROVIDER: 'aws-kms', AWS_KMS_KEY_ID: 'key-1',
      LIVE_AGENT_ENABLED: 'true', LIVE_EXECUTION_ENABLED: 'true',
      LIVE_RPC_READY: 'true', LIVE_RECONCILIATION_ENABLED: 'true', LIVE_MIGRATIONS_READY: 'true',
      // Проверяется канонический флаг: старый больше не управляет
      // подписью и на старте отвергается.
    })).rejects.toThrow('SOLANA_SIGNING_ENABLED');
  });

  it('does not allow withdrawals without the LIVE executor', async () => {
    await expect(load({
      EXECUTION_MODE: 'live', KMS_PROVIDER: 'aws-kms', AWS_KMS_KEY_ID: 'key-1',
      // Подпись здесь ни при чём: проверяется структура флагов.
      LIVE_AGENT_ENABLED: 'true', WITHDRAWALS_ENABLED: 'true',
      LIVE_RPC_READY: 'true', LIVE_RECONCILIATION_ENABLED: 'true', LIVE_MIGRATIONS_READY: 'true',
    })).rejects.toThrow('LIVE_EXECUTION_ENABLED');
  });

  it('rejects Auto even when all readiness flags are true', async () => {
    await expect(load({ LIVE_AGENT_CONTROL_MODE: 'auto' })).rejects.toThrow('Auto');
  });

  it('does not let readiness flags turn mock contracts into a mainnet implementation', async () => {
    await expect(load({
      EXECUTION_MODE: 'live', KMS_PROVIDER: 'aws-kms', AWS_KMS_KEY_ID: 'key-1',
      LIVE_AGENT_ENABLED: 'true', LIVE_EXECUTION_ENABLED: 'true',
      SOLANA_SIGNING_ENABLED: 'true', SOLANA_SIGNER_PROVIDER: 'aws-kms',
      SOLANA_SIGNER_KEY_ID: 'k', SOLANA_SIGNER_KEY_VERSION: '1',
      SOLANA_SIGNER_WALLET_PUBLIC_KEY: 'A'.repeat(44), AWS_REGION: 'eu-central-1',
      SOLANA_PREFLIGHT_RPC_URL: 'https://example.invalid/devnet',
      LIVE_RPC_READY: 'true', LIVE_RECONCILIATION_ENABLED: 'true', LIVE_MIGRATIONS_READY: 'true',
    })).rejects.toThrow('network adapters are not implemented');
  });

  it('refuses the devnet test mint outside devnet', async () => {
    /*
     * Тестовый токен не существует нигде, кроме devnet. Параметр,
     * задаваемый переменной окружения, рано или поздно окажется
     * скопирован в боевую конфигурацию вместе с остальным блоком —
     * и платформа начнёт принимать нарисованную монету как деньги.
     */
    for (const network of ['mainnet-beta', 'testnet']) {
      await expect(load({
        SOLANA_NETWORK: network,
        SOLANA_DEVNET_TEST_MINT: 'DevnetTestMint1111111111111111111111111111',
      }), network).rejects.toThrow('SOLANA_NETWORK=devnet');
    }
  });

  it('refuses the devnet test mint in production regardless of network', async () => {
    await expect(load({
      NODE_ENV: 'production',
      SOLANA_NETWORK: 'devnet',
      SOLANA_DEVNET_TEST_MINT: 'DevnetTestMint1111111111111111111111111111',
      ADMIN_EMAIL: 'admin@example.com',
    })).rejects.toThrow(/production/);
  });

  it('accepts the devnet test mint in devnet', async () => {
    const { env } = await load({
      SOLANA_NETWORK: 'devnet',
      SOLANA_DEVNET_TEST_MINT: 'DevnetTestMint1111111111111111111111111111',
    });

    expect(env.SOLANA_DEVNET_TEST_MINT).toBe('DevnetTestMint1111111111111111111111111111');
  });

  it('defaults to devnet so a stray mainnet URL fails the genesis check', async () => {
    // URL по умолчанию указывает на mainnet. Ожидаемая сеть devnet
    // означает, что preflight такой узел отвергнет, а не примет.
    const { env } = await load({});

    expect(env.SOLANA_NETWORK).toBe('devnet');
  });

  it('keeps the safe defaults intact', async () => {
    const { env } = await load({});

    expect(env.EXECUTION_MODE).toBe('paper');
    expect(env.FUNDING_ENABLED).toBe(false);
    expect(env.LIVE_AGENT_ENABLED).toBe(false);
    expect(env.LIVE_EXECUTION_ENABLED).toBe(false);
    expect(env.WITHDRAWALS_ENABLED).toBe(false);
    expect(env.SOLANA_DEPOSIT_SOURCE).toBe('disabled');
  });

  it('подпись без провайдера не включается', async () => {
    await expect(load({ SOLANA_SIGNING_ENABLED: 'true' }))
      .rejects.toThrow('SOLANA_SIGNER_PROVIDER');
  });

  it('подпись без идентификатора и версии ключа не включается', async () => {
    await expect(load({
      SOLANA_SIGNING_ENABLED: 'true',
      SOLANA_SIGNER_PROVIDER: 'aws-kms',
      KMS_PROVIDER: 'aws-kms',
      AWS_KMS_KEY_ID: 'key-1',
    })).rejects.toThrow('SOLANA_SIGNER_KEY_ID');
  });

  it('подпись без провайдера подписи запрещена', async () => {
    /*
     * Раньше здесь проверялся `KMS_PROVIDER=local`. Это была склейка
     * понятий по общему слову «KMS»: custody отвечает за шифрование
     * сохранённого ключа, а при подписи через облачный HSM
     * сохранённого ключа нет вовсе.
     *
     * Настоящее условие — выбранный провайдер подписи. Требование
     * production-custody ради devnet-подписи учило обходить
     * непонятный запрет и прятало эту причину.
     */
    await expect(load({
      SOLANA_SIGNING_ENABLED: 'true',
      SOLANA_SIGNER_PROVIDER: 'unavailable',
      SOLANA_SIGNER_KEY_ID: 'k',
      SOLANA_SIGNER_KEY_VERSION: '1',
      SOLANA_SIGNER_WALLET_PUBLIC_KEY: 'A'.repeat(44),
      KMS_PROVIDER: 'local',
    })).rejects.toThrow('SOLANA_SIGNER_PROVIDER');
  });

  it('подпись mainnet запрещена на этом этапе', async () => {
    await expect(load({
      SOLANA_SIGNING_ENABLED: 'true',
      SOLANA_SIGNER_PROVIDER: 'aws-kms',
      SOLANA_SIGNER_KEY_ID: 'k',
      SOLANA_SIGNER_KEY_VERSION: '1',
      SOLANA_SIGNER_WALLET_PUBLIC_KEY: 'A'.repeat(44),
      KMS_PROVIDER: 'aws-kms',
      AWS_KMS_KEY_ID: 'key-1',
      SOLANA_NETWORK: 'mainnet-beta',
    })).rejects.toThrow('mainnet');
  });

  it('mainnet отвергается раньше неполной конфигурации', async () => {
    /*
     * Регион не задан — то есть конфигурация неполна и по другой
     * причине. Отказ всё равно должен назвать сеть.
     *
     * Сообщение «требуется AWS_REGION» читается как «допиши и
     * заработает». Оператор допишет, перезапустит и получит уже
     * другой ответ — а вопрос был не в регионе.
     *
     * Эта проверка появилась после того, как запрет mainnet
     * обнаружился недостижимым: он стоял после `throw` в чужом
     * блоке и не выполнялся ни разу.
     */
    await expect(load({
      SOLANA_SIGNING_ENABLED: 'true',
      SOLANA_SIGNER_PROVIDER: 'aws-kms',
      SOLANA_SIGNER_KEY_ID: 'k',
      SOLANA_SIGNER_KEY_VERSION: '1',
      SOLANA_SIGNER_WALLET_PUBLIC_KEY: 'A'.repeat(44),
      KMS_PROVIDER: 'aws-kms',
      AWS_KMS_KEY_ID: 'key-1',
      AWS_REGION: '',
      SOLANA_NETWORK: 'mainnet-beta',
    })).rejects.toThrow('mainnet');
  });

  it('в проверках подписи нет кода после throw', () => {
    /*
     * Недостижимая проверка выглядит как защита и не является ею.
     * Здесь ищется буквальный признак: оператор после `throw` внутри
     * того же блока.
     */
    const source = readFileSync(new URL('./env.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(source).not.toMatch(/throw new Error\([^;]*\);\s*\n\s*(if|const|let|return)\s/);
  });

  it('правило «отправка требует подписи» записано ровно один раз', () => {
    /*
     * Раньше это правило было записано дважды: один раз по старому
     * флагу и один раз ниже общего блокера — «на будущее». После
     * перевода обеих записей на канонический флаг они совпали.
     *
     * Дубликат правила и есть та болезнь, ради которой затевалась
     * работа: два ответа на один вопрос со временем расходятся.
     */
    const source = readFileSync(new URL('./env.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    /*
     * Считается сообщение, а не форма условия.
     *
     * Первые две попытки ловили шаблоном по именам переменных и
     * оба раза считали лишнее: те же имена встречаются в вычислении
     * `phase4LiveRequested` и в правиле про preflight. Сообщение
     * принадлежит ровно одному правилу и потому считается точно.
     */
    const matches = source.match(/требуют SOLANA_SIGNING_ENABLED=true/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(source).not.toContain('требует рабочего контура подписи');
  });

  it('правило достижимо: LIVE без подписи отвергается', async () => {
    // Проверка стоит до общего блокера и потому работает сегодня,
    // а не «вступит в силу, когда блокер снимут».
    await expect(load({
      EXECUTION_MODE: 'live',
      LIVE_AGENT_ENABLED: 'true',
      LIVE_EXECUTION_ENABLED: 'true',
      LIVE_RPC_READY: 'true',
      LIVE_RECONCILIATION_ENABLED: 'true',
      LIVE_MIGRATIONS_READY: 'true',
      KMS_PROVIDER: 'aws-kms',
      AWS_KMS_KEY_ID: 'key-1',
    })).rejects.toThrow('SOLANA_SIGNING_ENABLED');
  });

  it('подпись по умолчанию выключена', async () => {
    const { env } = await load({});
    expect(env.SOLANA_SIGNING_ENABLED).toBe(false);
    expect(env.SOLANA_SIGNER_PROVIDER).toBe('unavailable');
  });

  it('keeps funding blocked even with the RPC reader configured', async () => {
    await expect(load({
      FUNDING_ENABLED: 'true',
      LIVE_RPC_READY: 'true',
      LIVE_RECONCILIATION_ENABLED: 'true',
      LIVE_MIGRATIONS_READY: 'true',
      SOLANA_DEPOSIT_SOURCE: 'rpc',
      SOLANA_DEPOSIT_BOOTSTRAP_SLOT: '123456789',
    })).rejects.toThrow('network adapters are not implemented');
  });
});
