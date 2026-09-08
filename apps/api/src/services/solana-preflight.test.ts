import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { FORBIDDEN_SOLANA_RPC_METHODS } from '@memex/core';
import {
  runSolanaPreflight,
  KNOWN_GENESIS_HASHES,
  type PreflightCheckName,
  type PreflightReport,
} from './solana-preflight.js';
import { SolanaRpcRequestError, type SolanaRpcClient } from './solana-rpc-deposit-source.js';

/**
 * Preflight проверяется на подделке транспорта.
 *
 * Живой запрос к devnet сюда не входит намеренно: тест, который
 * ходит в сеть, однажды сходит не в ту сеть, и обнаружится это по
 * счёту от провайдера.
 */

const SECRET_ENDPOINT = 'https://mainnet.example.com/?api-key=super-secret-value';

class FakeRpc implements SolanaRpcClient {
  readonly calls: string[] = [];
  constructor(private readonly answer: (method: string, params: readonly unknown[]) => unknown) {}
  async call<T>(method: string, params: readonly unknown[]): Promise<T> {
    this.calls.push(method);
    const value = this.answer(method, params);
    if (value instanceof Error) throw value;
    return value as T;
  }
}

const devnetNode = (over: Partial<Record<string, unknown>> = {}) =>
  new FakeRpc((method) => {
    if (method in over) return over[method];
    switch (method) {
      case 'getHealth': return 'ok';
      case 'getGenesisHash': return KNOWN_GENESIS_HASHES.devnet;
      case 'getSlot': return 400_000_000;
      case 'getSignaturesForAddress': return [{ signature: 'probe-signature', slot: 1, err: null }];
      case 'getSignatureStatuses': return { value: [{ confirmations: null, confirmationStatus: 'finalized', err: null }] };
      case 'getTransaction': return { slot: 1 };
      default: return null;
    }
  });

const outcome = (report: PreflightReport, name: PreflightCheckName) =>
  report.checks.find((check) => check.name === name);

// ────────────────────────────── Опознание сети ───────────────────────────────

describe('опознание сети', () => {
  it('devnet принимается по genesis hash', async () => {
    const report = await runSolanaPreflight(devnetNode(), { network: 'devnet' });

    expect(outcome(report, 'GENESIS')?.outcome).toBe('PASS');
    expect(report.ok).toBe(true);
  });

  it('mainnet-endpoint при ожидаемом devnet отклоняется', async () => {
    // Самая вероятная ошибка оператора: поменять имя сети, забыв URL.
    const node = devnetNode({ getGenesisHash: KNOWN_GENESIS_HASHES['mainnet-beta'] });
    const report = await runSolanaPreflight(node, { network: 'devnet' });

    expect(report.ok).toBe(false);
    expect(outcome(report, 'GENESIS')?.code).toBe('SOLANA_PREFLIGHT_MAINNET_ENDPOINT_REFUSED');
  });

  it('чужая сеть отклоняется как несовпадение', async () => {
    const node = devnetNode({ getGenesisHash: KNOWN_GENESIS_HASHES.testnet });
    const report = await runSolanaPreflight(node, { network: 'devnet' });

    expect(outcome(report, 'GENESIS')?.code).toBe('SOLANA_PREFLIGHT_GENESIS_MISMATCH');
  });

  it('после несовпадения остальные вызовы не делаются', async () => {
    // Проверять работоспособность неизвестной сети незачем.
    const node = devnetNode({ getGenesisHash: 'что-то-другое' });
    await runSolanaPreflight(node, { network: 'devnet' });

    expect(node.calls).not.toContain('getSignaturesForAddress');
  });

  it('оператор может задать ожидаемый hash сам', async () => {
    const node = devnetNode({ getGenesisHash: 'собственное-значение-оператора' });
    const report = await runSolanaPreflight(node, {
      network: 'devnet',
      expectedGenesisHash: 'собственное-значение-оператора',
    });

    expect(report.ok).toBe(true);
  });

  it('три известные сети различимы', () => {
    const values = Object.values(KNOWN_GENESIS_HASHES);
    expect(new Set(values).size).toBe(3);
  });
});

// ──────────────────────────── Набор возможностей ─────────────────────────────

describe('возможности узла', () => {
  it('проверяются оба уровня подтверждения', async () => {
    const node = devnetNode();
    await runSolanaPreflight(node, { network: 'devnet' });

    expect(node.calls.filter((method) => method === 'getSlot')).toHaveLength(2);
  });

  it('доступность истории проверяется отдельно', async () => {
    const report = await runSolanaPreflight(devnetNode(), { network: 'devnet', requireHistory: true });

    expect(outcome(report, 'HISTORY_CAPABILITY')?.outcome).toBe('PASS');
  });

  it('узел без архива не выдаётся за пригодный', async () => {
    let historyCall = 0;
    const node = new FakeRpc((method, params) => {
      if (method === 'getGenesisHash') return KNOWN_GENESIS_HASHES.devnet;
      if (method === 'getHealth') return 'ok';
      if (method === 'getSlot') return 1;
      if (method === 'getSignaturesForAddress') return [{ signature: 'probe', slot: 1, err: null }];
      if (method === 'getTransaction') return { slot: 1 };
      if (method === 'getSignatureStatuses') {
        const config = params[1] as { searchTransactionHistory?: boolean };
        if (config?.searchTransactionHistory) {
          historyCall += 1;
          return new SolanaRpcRequestError('SOLANA_RPC_ERROR_-32602', true);
        }
        return { value: [null] };
      }
      return null;
    });
    const report = await runSolanaPreflight(node, { network: 'devnet', requireHistory: true });

    expect(historyCall).toBe(1);
    expect(report.ok).toBe(false);
    expect(outcome(report, 'HISTORY_CAPABILITY')?.outcome).toBe('FAIL');
  });

  it('отсутствие пробной подписи помечается пропуском, а не успехом', async () => {
    const report = await runSolanaPreflight(devnetNode({ getSignaturesForAddress: [] }), {
      network: 'devnet',
      requireHistory: true,
    });

    expect(outcome(report, 'GET_TRANSACTION')?.outcome).toBe('SKIPPED');
    // Пропуск не валит отчёт, но и не обещает проверенной возможности.
    expect(outcome(report, 'GET_TRANSACTION')?.code).toBe('NO_PROBE_SIGNATURE');
  });

  it('нечисловой слот не считается успехом', async () => {
    const report = await runSolanaPreflight(devnetNode({ getSlot: 'скоро' }), { network: 'devnet' });

    expect(outcome(report, 'SLOT_CONFIRMED')?.code).toBe('SOLANA_PREFLIGHT_SLOT_INVALID');
  });
});

// ────────────────────────── Секреты и побочные эффекты ───────────────────────

describe('preflight ничего не выдаёт и ничего не меняет', () => {
  it('адрес узла не попадает в отчёт', async () => {
    const node = new FakeRpc(() => {
      throw new Error(`connect ECONNREFUSED ${SECRET_ENDPOINT}`);
    });
    const report = await runSolanaPreflight(node, { network: 'devnet' });
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).not.toContain('mainnet.example.com');
  });

  it('в отчёте остаётся только имя сети', async () => {
    const report = await runSolanaPreflight(devnetNode(), { network: 'devnet' });

    expect(report.network).toBe('devnet');
    expect(JSON.stringify(report)).not.toMatch(/https?:\/\//);
  });

  it('вызываются только читающие методы', async () => {
    const node = devnetNode();
    await runSolanaPreflight(node, { network: 'devnet', requireHistory: true });

    // Ни отправки, ни симуляции, ни запроса airdrop.
    for (const method of node.calls) {
      expect(method, method).toMatch(/^get/);
    }
    expect(node.calls).not.toContain('requestAirdrop');
    expect(node.calls).not.toContain('sendTransaction');
  });

  it('модуль preflight не знает ни про базу, ни про ключи', () => {
    const source = readFileSync(new URL('./solana-preflight.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/prisma|PrismaClient|privateKey|Keypair|signTransaction/);
  });
});

/**
 * Контракты скрипта запуска.
 *
 * Прежде здесь стояло одно правило: слово `prisma` запрещено во всём
 * исходнике. Оно перестало быть верным, когда появился явный
 * `--record`: запись доказательства — это работа с базой, и запрещать
 * её целиком значило бы запрещать заявленную возможность.
 *
 * Но ослаблять правило до «можно всё» тоже нельзя. Оно разделено на
 * несколько более узких, и каждое проверяет своё:
 *
 *   • статических импортов базы в безопасном пути нет;
 *   • обычный запуск и `--dry-run` модуль записи не подключают;
 *   • подключает его только явный `--record`, и только динамически;
 *   • опасные методы Solana проверяются точным списком имён.
 *
 * Поведение проверяется отдельно, в `devnet-preflight-command.test.ts`:
 * там видно, что модуль записи действительно не загружается. Здесь —
 * структура исходника, то есть та часть, которую поведенческий тест
 * не покажет.
 */
describe('скрипт запуска: что он может, а чего не может', () => {
  const script = readFileSync(
    new URL('../../scripts/solana-deposit-preflight.ts', import.meta.url),
    'utf8',
  );
  const command = readFileSync(
    new URL('./devnet-preflight-command.ts', import.meta.url),
    'utf8',
  );

  /**
   * Исходник без комментариев.
   *
   * Комментарии не выполняются, и объяснение «здесь нет
   * sendTransaction» не должно проваливать проверку, которая ищет
   * `sendTransaction`. Проверка, обвиняющая собственную
   * документацию, кончается тем, что её удаляют.
   */
  const codeOf = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  /** Только строки статических импортов. */
  const staticImports = (text: string) =>
    codeOf(text)
      .split('\n')
      .filter((line) => /^\s*import\s/.test(line) || /^\s*}\s*from\s/.test(line))
      .join('\n');

  it('endpoint задаётся отдельной переменной', () => {
    // Значение по умолчанию однажды отправило бы «просто проверку»
    // в mainnet.
    expect(script).toContain('SOLANA_PREFLIGHT_RPC_URL');
    expect(script).toContain('SOLANA_PREFLIGHT_ALLOW_MAINNET');
  });

  it('ни скрипт, ни команда не импортируют базу статически', () => {
    /*
     * Ключевое слово здесь — «статически». Модуль, подключённый
     * обычным импортом, попадает в процесс всегда, независимо от
     * флагов, и тогда «не записываем без --record» держится на
     * одном лишь ветвлении.
     */
    for (const [name, source] of [['скрипт', script], ['команда', command]] as const) {
      const imports = staticImports(source);
      expect(imports, `${name}: статический импорт Prisma`).not.toMatch(/@prisma\/client/);
      expect(imports, `${name}: статический импорт клиента базы`).not.toMatch(
        /^\s*import\s+\{[^}]*\bprisma\b/m,
      );
    }
  });

  it('модуль записи подключается только динамически', () => {
    const imports = staticImports(command);

    // `import type` стирается компилятором и в процесс не попадает;
    // значимый импорт того же модуля — попадает.
    expect(imports).not.toMatch(/^\s*import\s+(?!type\b)[^;]*devnet-network-proof/m);
    expect(codeOf(command), 'динамический импорт на месте').toMatch(
      /import\(['"]\.\/devnet-network-proof\.js['"]\)/,
    );
  });

  it('динамический импорт записи ровно один и стоит в ветке RECORD', () => {
    /*
     * Второе место подключения означало бы второй путь к записи —
     * и когда-нибудь один из них окажется вне ветки `--record`.
     */
    const code = codeOf(command);
    const dynamic = code.match(/import\(/g) ?? [];
    expect(dynamic).toHaveLength(1);

    const recordBranch = code.slice(code.indexOf("input.mode === 'RECORD'"));
    expect(recordBranch).toMatch(/import\(['"]\.\/devnet-network-proof\.js['"]\)/);
  });

  it('опасные методы Solana не встречаются в коде', () => {
    /*
     * Точный список имён, а не поиск слов. Поиск подстрок уже один
     * раз объявил запрещённым `getSignaturesForAddress` — обычное
     * чтение чужой публичной истории.
     */
    for (const source of [codeOf(script), codeOf(command)]) {
      for (const method of FORBIDDEN_SOLANA_RPC_METHODS) {
        expect(source, method).not.toContain(method);
      }
      expect(source).not.toMatch(/Keypair|privateKey|secretKey/);
    }
  });

  it('чтение истории адреса при этом разрешено', () => {
    /*
     * Негативный контроль к проверке выше. Без него она прошла бы и
     * на правиле, которое запрещает вообще всё, — а именно таким
     * правилом и была прежняя версия.
     */
    expect([...FORBIDDEN_SOLANA_RPC_METHODS]).not.toContain('getSignaturesForAddress');
  });
});
