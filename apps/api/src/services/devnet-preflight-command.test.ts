import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SolanaRpcClient } from './solana-rpc-deposit-source.js';

/**
 * Что делает команда проверки узла — и сколько раз она ходит к узлу.
 *
 * Два свойства, ради которых файл существует.
 *
 * Первое: **один поход к узлу в режиме `--record`**. Прежняя версия
 * скрипта сначала выполняла `runSolanaPreflight` ради вывода на
 * экран, а потом вызывала службу, которая выполняла ту же проверку
 * заново. Два одинаковых обхода узла, вдвое больший расход чужого
 * лимита частоты — и ни одного нового факта. Здесь считается число
 * вызовов `getGenesisHash`: он делается ровно один раз за preflight,
 * поэтому его счётчик и есть число проверок.
 *
 * Второе: **безопасный путь не подключает модуль записи**. Проверяется
 * поведением, а не чтением исходника: подставляется загрузчик, и
 * видно, звали его или нет. Обычный запуск и `--dry-run` звать его не
 * должны — тогда кода записи в процессе нет вовсе, и «не пишем без
 * флага» перестаёт держаться на одном ветвлении.
 */

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

const envMock = {
  SOLANA_PREFLIGHT_RPC_URL: 'https://example.invalid/devnet?api-key=секрет',
  SOLANA_NETWORK: 'devnet' as 'devnet' | 'testnet' | 'mainnet-beta',
  SOLANA_EXPECTED_GENESIS_HASH: undefined as string | undefined,
};

vi.mock('../lib/env.js', () => ({ env: envMock }));

/** Единственная строка таблицы доказательств. */
let row: Record<string, any> | null = null;
const audit: Array<Record<string, any>> = [];

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    solanaNetworkProof: {
      findUnique: async (args: any) => (row && row.id === args.where.id ? { ...row } : null),
      createMany: async ({ data }: any) => {
        if (row) return { count: 0 };
        row = { methods: [], leaseHolder: null, leaseExpiresAt: null, ...data[0] };
        return { count: 1 };
      },
      updateMany: async ({ where, data }: any) => {
        if (!row || row.id !== where.id) return { count: 0 };
        if (where.leaseHolder !== undefined && row.leaseHolder !== where.leaseHolder) {
          return { count: 0 };
        }
        row = { ...row, ...data };
        return { count: 1 };
      },
    },
    auditLog: {
      create: async ({ data }: any) => {
        audit.push(data);
        return data;
      },
    },
  },
  prismaWasInstantiated: () => false,
}));

const { preflightMode, runPreflightCommand } = await import('./devnet-preflight-command.js');

/** Узел, отвечающий как настоящий devnet, со счётчиком вызовов. */
function devnetNode(): SolanaRpcClient & { calls: string[] } {
  const answers: Record<string, unknown> = {
    getHealth: 'ok',
    getGenesisHash: DEVNET_GENESIS,
    getSlot: 100,
    getSignaturesForAddress: [{ signature: 'sig-1' }],
    getSignatureStatuses: { value: [null] },
    getTransaction: null,
  };
  const calls: string[] = [];
  return {
    calls,
    async call<T>(method: string): Promise<T> {
      calls.push(method);
      return answers[method] as T;
    },
  };
}

/** Сколько раз выполнялся preflight: по одному `getGenesisHash` на проход. */
const preflights = (node: { calls: string[] }) =>
  node.calls.filter((method) => method === 'getGenesisHash').length;

/** Загрузчик модуля записи, который считает обращения к себе. */
function countingLoader() {
  const loader = vi.fn(async () => import('./devnet-network-proof.js'));
  return loader;
}

const REPORT_OPTIONS = { requireHistory: false } as const;

beforeEach(() => {
  row = null;
  audit.length = 0;
  envMock.SOLANA_PREFLIGHT_RPC_URL = 'https://example.invalid/devnet?api-key=секрет';
  envMock.SOLANA_NETWORK = 'devnet';
});

describe('режим по флагам', () => {
  it('без флагов — отчёт', () => {
    expect(preflightMode({ dryRun: false, record: false })).toBe('REPORT');
  });

  it('--dry-run — холостой проход', () => {
    expect(preflightMode({ dryRun: true, record: false })).toBe('DRY_RUN');
  });

  it('--record — проверка с записью', () => {
    expect(preflightMode({ dryRun: false, record: true })).toBe('RECORD');
  });

  it('--dry-run вместе с --record — отказ, а не выбор одного', () => {
    /*
     * Молча проигнорировать `--record` значило бы, что человек
     * попросил записать, об отказе не узнал и ушёл в уверенности,
     * что доказательство есть.
     */
    expect(preflightMode({ dryRun: true, record: true })).toBe('CONFLICT');
  });
});

describe('обычный запуск', () => {
  it('делает ровно один preflight', async () => {
    const node = devnetNode();
    const loader = countingLoader();

    const result = await runPreflightCommand({
      mode: 'REPORT',
      network: 'devnet',
      rpc: node,
      reportOptions: REPORT_OPTIONS,
      loadRecorder: loader,
    });

    expect(preflights(node)).toBe(1);
    expect(result.report?.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('не подключает модуль записи и ничего не пишет', async () => {
    const loader = countingLoader();

    const result = await runPreflightCommand({
      mode: 'REPORT',
      network: 'devnet',
      rpc: devnetNode(),
      reportOptions: REPORT_OPTIONS,
      loadRecorder: loader,
    });

    expect(loader, 'модуль записи не загружался').not.toHaveBeenCalled();
    expect(result.proof).toBeNull();
    expect(row, 'в базу ничего не записано').toBeNull();
    expect(audit).toHaveLength(0);
  });

  it('непригодный узел даёт ненулевой код возврата', async () => {
    // Негативный контроль: код возврата не всегда ноль.
    const node = devnetNode();
    const broken: SolanaRpcClient = {
      call: async <T>(method: string, params: readonly unknown[]): Promise<T> =>
        method === 'getGenesisHash'
          ? ('x'.repeat(44) as unknown as T)
          : node.call<T>(method, params),
    };

    const result = await runPreflightCommand({
      mode: 'REPORT',
      network: 'devnet',
      rpc: broken,
      reportOptions: REPORT_OPTIONS,
    });

    expect(result.report?.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});

describe('холостой проход', () => {
  it('не подключает модуль записи', async () => {
    const loader = countingLoader();

    const result = await runPreflightCommand({
      mode: 'DRY_RUN',
      network: 'devnet',
      rpc: devnetNode(),
      dryRun: {
        address: 'A'.repeat(44),
        fromSlot: 0n,
        pageSize: 10,
        maxPages: 1,
        maxTransactions: 10,
      },
      loadRecorder: loader,
    });

    expect(loader).not.toHaveBeenCalled();
    expect(result.dryRun, 'холостой проход выполнен').not.toBeNull();
    expect(result.proof).toBeNull();
    expect(row).toBeNull();
  });

  it('не выполняет preflight: это другой вопрос к узлу', async () => {
    const node = devnetNode();

    await runPreflightCommand({
      mode: 'DRY_RUN',
      network: 'devnet',
      rpc: node,
      dryRun: {
        address: 'A'.repeat(44),
        fromSlot: 0n,
        pageSize: 10,
        maxPages: 1,
        maxTransactions: 10,
      },
    });

    expect(preflights(node)).toBe(0);
  });
});

describe('запись доказательства', () => {
  it('делает ровно один preflight, а не два', async () => {
    /*
     * Регрессия на настоящий лишний расход. Раньше команда сначала
     * проверяла узел ради вывода на экран, а затем служба проверяла
     * его заново ради записи.
     */
    const node = devnetNode();

    const result = await runPreflightCommand({
      mode: 'RECORD',
      network: 'devnet',
      rpc: node,
      loadRecorder: countingLoader(),
    });

    expect(preflights(node), 'узел обойдён один раз').toBe(1);
    expect(result.proof?.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('подключает модуль записи ровно один раз', async () => {
    const loader = countingLoader();

    await runPreflightCommand({
      mode: 'RECORD',
      network: 'devnet',
      rpc: devnetNode(),
      loadRecorder: loader,
    });

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('отчёт приходит от службы, без повторного запроса', async () => {
    /*
     * Подробный список проверок нужен человеку на экране. Раньше
     * ради него делался второй обход узла; теперь отчёт возвращает
     * та же проверка, что записала доказательство.
     */
    const node = devnetNode();

    const result = await runPreflightCommand({
      mode: 'RECORD',
      network: 'devnet',
      rpc: node,
      loadRecorder: countingLoader(),
    });

    expect(result.report, 'отчёт есть').not.toBeNull();
    expect(result.report?.observedGenesisHash).toBe(DEVNET_GENESIS);
    expect(preflights(node)).toBe(1);
  });

  it('доказательство действительно записано', async () => {
    await runPreflightCommand({
      mode: 'RECORD',
      network: 'devnet',
      rpc: devnetNode(),
      loadRecorder: countingLoader(),
    });

    expect(row?.outcome).toBe('VERIFIED');
    expect(audit, 'запуск попал в журнал').toHaveLength(1);
  });

  it('запуск из командной строки не выдаёт себя за человека', async () => {
    // `actorId: null` — не «неизвестно кто», а «не человек из
    // интерфейса»: в журнале это отличимо.
    await runPreflightCommand({
      mode: 'RECORD',
      network: 'devnet',
      rpc: devnetNode(),
      loadRecorder: countingLoader(),
    });

    expect(audit[0]?.actorId).toBeNull();
  });
});

describe('несовместимые флаги', () => {
  it('не идут ни в сеть, ни в базу', async () => {
    const node = devnetNode();
    const loader = countingLoader();

    const result = await runPreflightCommand({
      mode: 'CONFLICT',
      network: 'devnet',
      rpc: node,
      loadRecorder: loader,
    });

    expect(node.calls, 'к узлу не обращались').toEqual([]);
    expect(loader).not.toHaveBeenCalled();
    expect(row).toBeNull();
    expect(result.exitCode).toBe(2);
  });
});
