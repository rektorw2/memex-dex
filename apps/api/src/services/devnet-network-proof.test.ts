import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVNET_PROOF_TTL_MS, isForbiddenSolanaRpcMethod } from '@memex/core';
import { SolanaRpcRequestError, type SolanaRpcClient } from './solana-rpc-deposit-source.js';

/**
 * Проверка узла devnet: что записывается, что нет и кто ходит в сеть.
 *
 * Заменяемое поведение было таким: `networkVerified` считалось равным
 * `Boolean(env.SOLANA_PREFLIGHT_RPC_URL)`. Тесты ниже проверяют не
 * «работает ли функция», а что каждый способ разойтись у настройки с
 * реальностью теперь заканчивается отказом.
 *
 * Сеть подменена на уровне клиента RPC — там, где проходит настоящая
 * граница внешней зависимости. Всё остальное настоящее: те же правила
 * ядра, тот же `runSolanaPreflight`, та же служба.
 */

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

const envMock = {
  SOLANA_PREFLIGHT_RPC_URL: 'https://example.invalid/devnet?api-key=секрет',
  SOLANA_NETWORK: 'devnet' as 'devnet' | 'testnet' | 'mainnet-beta',
  SOLANA_EXPECTED_GENESIS_HASH: undefined as string | undefined,
};

vi.mock('../lib/env.js', () => ({ env: envMock }));

/** Единственная строка таблицы: она и есть всё состояние. */
let row: Record<string, any> | null = null;
const audit: Array<Record<string, any>> = [];

/**
 * Разрешает ли `where` изменить текущую строку.
 *
 * Условие на аренду разбирается здесь же, потому что именно оно
 * делает захват атомарным: в настоящей базе оно входит в тот же
 * `UPDATE`, и проверять его отдельным чтением было бы не тем.
 */
function matches(where: any, now: Date): boolean {
  if (!row || row.id !== where.id) return false;
  if (where.leaseHolder !== undefined && row.leaseHolder !== where.leaseHolder) return false;
  if (where.OR) {
    return where.OR.some((clause: any) => {
      if ('leaseExpiresAt' in clause && clause.leaseExpiresAt === null) {
        return row!.leaseExpiresAt == null;
      }
      if (clause.leaseExpiresAt?.lte) {
        return row!.leaseExpiresAt != null && row!.leaseExpiresAt <= clause.leaseExpiresAt.lte;
      }
      return false;
    });
  }
  return true;
}

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    solanaNetworkProof: {
      findUnique: async (args: any) => (row && row.id === args.where.id ? { ...row } : null),
      createMany: async ({ data, skipDuplicates }: any) => {
        // Тот же контракт, что у `ON CONFLICT DO NOTHING`: повтор не
        // бросает, а возвращает `count: 0`.
        expect(skipDuplicates, 'вставка обязана пропускать дубликаты').toBe(true);
        const rows = Array.isArray(data) ? data : [data];
        if (row) return { count: 0 };
        row = { methods: [], leaseHolder: null, leaseExpiresAt: null, ...rows[0] };
        return { count: 1 };
      },
      updateMany: async ({ where, data }: any) => {
        if (!matches(where, new Date())) return { count: 0 };
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
}));

const { readDevnetProof, verifyDevnetNetwork, endpointFingerprint } = await import(
  './devnet-network-proof.js'
);

/** Узел, отвечающий как настоящий devnet. */
function devnetNode(over: Record<string, unknown> = {}): SolanaRpcClient & { calls: string[] } {
  const answers: Record<string, unknown> = {
    getHealth: 'ok',
    getGenesisHash: DEVNET_GENESIS,
    getSlot: 100,
    getSignaturesForAddress: [{ signature: 'sig-1' }],
    getSignatureStatuses: { value: [null] },
    getTransaction: null,
    ...over,
  };
  const calls: string[] = [];
  return {
    calls,
    async call<T>(method: string): Promise<T> {
      calls.push(method);
      const answer = answers[method];
      if (answer instanceof Error) throw answer;
      return answer as T;
    },
  };
}

/** Узел, который на всё отвечает одной и той же ошибкой транспорта. */
function failingNode(code: string): SolanaRpcClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async call<T>(method: string): Promise<T> {
      calls.push(method);
      throw new SolanaRpcRequestError(code, true);
    },
  };
}

const NOW = Date.UTC(2026, 8, 5, 12);
const at = (ms: number) => () => ms;

beforeEach(() => {
  row = null;
  audit.length = 0;
  envMock.SOLANA_PREFLIGHT_RPC_URL = 'https://example.invalid/devnet?api-key=секрет';
  envMock.SOLANA_NETWORK = 'devnet';
  envMock.SOLANA_EXPECTED_GENESIS_HASH = undefined;
});

// ────────────────── Настройка не заменяет проверку ───────────────────

describe('адрес узла задан, но проверки не было', () => {
  it('сеть не считается проверенной', async () => {
    /*
     * Регрессия на исходный дефект. Переменная задана — прежняя
     * реализация ответила бы «проверено» ровно здесь.
     */
    const proof = await readDevnetProof(NOW);

    expect(proof.verified).toBe(false);
    expect(proof.code).toBe('NOT_RUN');
    expect(proof.state).toBe('NOT_RUN');
  });

  it('чтение состояния не ходит в сеть', async () => {
    // Проверка сети — отдельное действие оператора, а не побочный
    // эффект открытия экрана.
    const proof = await readDevnetProof(NOW);

    expect(proof.checkedAt).toBeNull();
  });
});

describe('успешная проверка', () => {
  it('делает сеть проверенной и назначает срок годности', async () => {
    const node = devnetNode();
    const outcome = await verifyDevnetNetwork({ actorId: 'admin-1', rpc: node, now: at(NOW) });

    expect(outcome.ok).toBe(true);
    expect(outcome.snapshot.verified).toBe(true);
    expect(outcome.snapshot.state).toBe('VERIFIED');
    expect(Date.parse(outcome.snapshot.expiresAt as string)).toBe(NOW + DEVNET_PROOF_TTL_MS);
  });

  it('записывает наблюдённый genesis, а не ожидаемый', async () => {
    /*
     * Разница видна только когда они расходятся, но именно в этот
     * момент она и важна: сохранённое ожидание сверялось бы само с
     * собой.
     */
    await verifyDevnetNetwork({ actorId: 'admin-1', rpc: devnetNode(), now: at(NOW) });

    expect(row?.genesisHash).toBe(DEVNET_GENESIS);
  });

  it('записывает только подтверждённые методы', async () => {
    await verifyDevnetNetwork({ actorId: 'admin-1', rpc: devnetNode(), now: at(NOW) });

    expect(row?.methods).toEqual(
      expect.arrayContaining(['getHealth', 'getGenesisHash', 'getSlot', 'getSignaturesForAddress']),
    );
  });

  it('ничего не подписывает и не отправляет', async () => {
    /*
     * Проверяется список вызовов, а не намерение. Отправки нет не
     * потому, что её запретили флагом, а потому, что у проверки нет
     * такого вызова.
     *
     * Сравнение по полному имени из закрытого списка. Прежняя версия
     * искала подстроки `/send|sign|simulate/i` и объявляла
     * запрещённым `getSignaturesForAddress` — обычное чтение чужой
     * публичной истории, без которого не работает сверка зачислений.
     */
    const node = devnetNode();
    await verifyDevnetNetwork({ actorId: 'admin-1', rpc: node, now: at(NOW) });

    expect(node.calls.length, 'вызовы вообще были').toBeGreaterThan(0);
    for (const method of node.calls) {
      expect(isForbiddenSolanaRpcMethod(method), method).toBe(false);
    }
  });

  it('чтение истории адреса не считается подписью', () => {
    /*
     * Негативный контроль к тесту выше: он проверяет отсутствие
     * запрещённых вызовов, и без этой строки прошёл бы даже на
     * правиле, которое не запрещает ничего.
     */
    expect(isForbiddenSolanaRpcMethod('getSignaturesForAddress')).toBe(false);
    expect(isForbiddenSolanaRpcMethod('sendTransaction')).toBe(true);
  });

  it('доказательство стареет ровно по сроку', async () => {
    await verifyDevnetNetwork({ actorId: 'admin-1', rpc: devnetNode(), now: at(NOW) });

    expect((await readDevnetProof(NOW + DEVNET_PROOF_TTL_MS - 1)).verified).toBe(true);

    const stale = await readDevnetProof(NOW + DEVNET_PROOF_TTL_MS);
    expect(stale.verified).toBe(false);
    expect(stale.state).toBe('STALE');
  });

  it('смена endpoint обесценивает прежнее доказательство', async () => {
    await verifyDevnetNetwork({ actorId: 'admin-1', rpc: devnetNode(), now: at(NOW) });
    expect((await readDevnetProof(NOW)).verified).toBe(true);

    envMock.SOLANA_PREFLIGHT_RPC_URL = 'https://other.invalid/devnet';

    const after = await readDevnetProof(NOW);
    expect(after.verified).toBe(false);
    expect(after.code).toBe('ENDPOINT_CHANGED');
  });
});

// ──────────────────────── Отказы узла ────────────────────────────────

describe('узел не прошёл проверку', () => {
  it('mainnet при devnet-конфигурации отвергается', async () => {
    const outcome = await verifyDevnetNetwork({
      actorId: 'admin-1',
      rpc: devnetNode({ getGenesisHash: MAINNET_GENESIS }),
      now: at(NOW),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.snapshot.verified).toBe(false);
    expect(outcome.snapshot.failureCode).toBe('SOLANA_PREFLIGHT_MAINNET_ENDPOINT_REFUSED');
  });

  it('чужой genesis отвергается отдельным кодом', async () => {
    const outcome = await verifyDevnetNetwork({
      actorId: 'admin-1',
      rpc: devnetNode({ getGenesisHash: 'x'.repeat(44) }),
      now: at(NOW),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.snapshot.failureCode).toBe('SOLANA_PREFLIGHT_GENESIS_MISMATCH');
  });

  const transport: Array<[string, string]> = [
    ['таймаут', 'SOLANA_RPC_TIMEOUT'],
    ['нет прав', 'SOLANA_RPC_HTTP_401'],
    ['доступ запрещён', 'SOLANA_RPC_HTTP_403'],
    ['предел частоты', 'SOLANA_RPC_HTTP_429'],
    ['испорченный ответ', 'SOLANA_RPC_MALFORMED_RESPONSE'],
  ];

  it.each(transport)('%s сохраняется отдельным кодом', async (_name, code) => {
    /*
     * Разные причины требуют разных действий: таймаут лечится другим
     * узлом, предел частоты — тарифом, отсутствие прав — ключом.
     * Общий код «не сработало» не позволяет выбрать ни одно.
     */
    const outcome = await verifyDevnetNetwork({
      actorId: 'admin-1',
      rpc: failingNode(code),
      now: at(NOW),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.snapshot.failureCode).toBe(code);
    expect(outcome.snapshot.state).toBe('FAILED');
  });

  it('неудача стирает прежний успех', async () => {
    /*
     * Главное правило раздела. Оставить прежнее доказательство
     * активным значило бы показывать «готово» рядом с ошибкой —
     * и разрешить подпись на узле, который только что не ответил.
     */
    await verifyDevnetNetwork({ actorId: 'admin-1', rpc: devnetNode(), now: at(NOW) });
    expect((await readDevnetProof(NOW)).verified).toBe(true);

    await verifyDevnetNetwork({
      actorId: 'admin-1',
      rpc: failingNode('SOLANA_RPC_TIMEOUT'),
      now: at(NOW + 1_000),
    });

    const after = await readDevnetProof(NOW + 1_000);
    expect(after.verified).toBe(false);
    expect(after.verifiedAt).toBeNull();
    expect(after.expiresAt).toBeNull();
    expect(row?.genesisHash).toBeNull();
    expect(row?.methods).toEqual([]);
  });
});

// ─────────────────── Границы, которые нельзя перейти ─────────────────

describe('границы', () => {
  it('без адреса узла сетевого вызова нет вовсе', async () => {
    envMock.SOLANA_PREFLIGHT_RPC_URL = '';
    const node = devnetNode();

    const outcome = await verifyDevnetNetwork({ actorId: 'admin-1', rpc: node, now: at(NOW) });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('NOT_CONFIGURED');
    expect(node.calls, 'к узлу не обращались').toEqual([]);
    expect(row, 'в базу ничего не записано').toBeNull();
  });

  it('основная сеть — отказ до вызова', async () => {
    /*
     * Проверка только читает, но «только чтение mainnet» — это всё
     * равно запрос к боевой сети из контура, которому туда нельзя.
     * Отказ раньше вызова делает границу проверяемой.
     */
    envMock.SOLANA_NETWORK = 'mainnet-beta';
    const node = devnetNode();

    const outcome = await verifyDevnetNetwork({ actorId: 'admin-1', rpc: node, now: at(NOW) });

    expect(outcome.ok === false && outcome.reason).toBe('MAINNET_REFUSED');
    expect(node.calls).toEqual([]);
    expect(audit, 'несостоявшееся действие не пишется в журнал').toHaveLength(0);
  });

  it('отпечаток не содержит ни адреса, ни ключа', async () => {
    const url = 'https://node.example/devnet?api-key=очень-секретный-ключ';
    const fingerprint = endpointFingerprint(url);

    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).not.toContain('node.example');
    expect(fingerprint).not.toContain('очень-секретный-ключ');
    expect(fingerprint).not.toContain('api-key');
  });

  it('снимок не выносит наружу ни адреса, ни отпечатка', async () => {
    await verifyDevnetNetwork({ actorId: 'admin-1', rpc: devnetNode(), now: at(NOW) });
    const serialized = JSON.stringify(await readDevnetProof(NOW));

    expect(serialized).not.toContain('example.invalid');
    expect(serialized).not.toContain('секрет');
    expect(serialized).not.toContain(endpointFingerprint(envMock.SOLANA_PREFLIGHT_RPC_URL));
  });

  it('в журнал не попадает ни адрес, ни отпечаток', async () => {
    await verifyDevnetNetwork({ actorId: 'admin-1', rpc: devnetNode(), now: at(NOW) });
    const serialized = JSON.stringify(audit);

    expect(serialized).not.toContain('example.invalid');
    expect(serialized).not.toContain('секрет');
    expect(serialized).not.toContain(endpointFingerprint(envMock.SOLANA_PREFLIGHT_RPC_URL));
  });
});

// ──────────────────── Повторы и параллельные запуски ─────────────────

describe('повторы и гонки', () => {
  it('повторный запуск идемпотентен: строка одна', async () => {
    await verifyDevnetNetwork({ actorId: 'admin-1', rpc: devnetNode(), now: at(NOW) });
    const first = row?.verifiedAt;

    await verifyDevnetNetwork({ actorId: 'admin-1', rpc: devnetNode(), now: at(NOW + 5_000) });

    expect(row?.id).toBe('solana-signing');
    expect(row?.outcome).toBe('VERIFIED');
    expect(row?.verifiedAt, 'время проверки обновилось').not.toEqual(first);
  });

  it('каждый запуск попадает в журнал', async () => {
    await verifyDevnetNetwork({ actorId: 'admin-1', rpc: devnetNode(), now: at(NOW) });
    await verifyDevnetNetwork({ actorId: 'admin-1', rpc: devnetNode(), now: at(NOW + 5_000) });

    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({
      actorId: 'admin-1',
      action: 'live.devnet_network_check',
      entity: 'SolanaNetworkProof',
    });
  });

  it('параллельные запуски не создают двух доказательств', async () => {
    /*
     * Аренда берётся одним `UPDATE ... WHERE`, поэтому второй
     * запуск проигрывает гонку и до узла не доходит: предел частоты
     * у провайдера общий, а второй ответ ничего не добавил бы.
     */
    const first = devnetNode();
    const second = devnetNode();

    const [a, b] = await Promise.all([
      verifyDevnetNetwork({ actorId: 'admin-1', rpc: first, now: at(NOW) }),
      verifyDevnetNetwork({ actorId: 'admin-2', rpc: second, now: at(NOW) }),
    ]);

    const succeeded = [a, b].filter((outcome) => outcome.ok);
    const refused = [a, b].filter((outcome) => !outcome.ok);

    expect(succeeded, 'проверка удалась один раз').toHaveLength(1);
    expect(refused[0]?.ok === false && refused[0].reason).toBe('IN_PROGRESS');
    expect(audit, 'к узлу ходили один раз').toHaveLength(1);
    expect(row?.outcome).toBe('VERIFIED');
  });

  it('просроченная аренда не запрещает проверку навсегда', async () => {
    // Иначе упавший процесс заблокировал бы контур насовсем.
    await verifyDevnetNetwork({ actorId: 'admin-1', rpc: devnetNode(), now: at(NOW) });
    row = { ...row, leaseHolder: 'admin-9', leaseExpiresAt: new Date(NOW - 1) };

    const outcome = await verifyDevnetNetwork({
      actorId: 'admin-1',
      rpc: devnetNode(),
      now: at(NOW + 10_000),
    });

    expect(outcome.ok).toBe(true);
  });

  it('пока проверка идёт, годное доказательство остаётся годным', async () => {
    await verifyDevnetNetwork({ actorId: 'admin-1', rpc: devnetNode(), now: at(NOW) });
    row = { ...row, leaseHolder: 'admin-2', leaseExpiresAt: new Date(NOW + 60_000) };

    const proof = await readDevnetProof(NOW + 1_000);

    expect(proof.checkInProgress).toBe(true);
    expect(proof.state, 'ступень не опускается на время проверки').toBe('VERIFIED');
  });
});
