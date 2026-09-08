import { describe, expect, it } from 'vitest';
import {
  DEVNET_PROOF_FORMAT_VERSION,
  DEVNET_PROOF_TTL_MS,
  DEVNET_REQUIRED_RPC_METHODS,
  FORBIDDEN_SOLANA_RPC_METHODS,
  devnetRpcState,
  evaluateDevnetProof,
  isForbiddenSolanaRpcMethod,
  leaseHeld,
  type DevnetProofCode,
  type DevnetProofRecord,
  type DevnetProofExpectation,
} from './devnet-proof.js';

/**
 * Что считается доказательством проверки узла.
 *
 * Файл появился из-за одной строки в `signing-state.ts`:
 *
 *     networkVerified: Boolean(env.SOLANA_PREFLIGHT_RPC_URL)
 *
 * Она отвечала «переменная задана», а читалась «сеть проверена».
 * Каждый тест ниже — отдельный способ, которым эти два утверждения
 * расходятся: узел не отвечает, узел оказался mainnet, проверку не
 * делали, сделали вчера, endpoint заменили после неё.
 */

const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const NOW = Date.UTC(2026, 8, 5, 12);
const FINGERPRINT = 'a'.repeat(64);

const expectation = (over: Partial<DevnetProofExpectation> = {}): DevnetProofExpectation => ({
  network: 'devnet',
  genesisHash: DEVNET,
  mainnetGenesisHash: MAINNET,
  endpointFingerprint: FINGERPRINT,
  requiredMethods: DEVNET_REQUIRED_RPC_METHODS,
  nowMs: NOW,
  ...over,
});

/** Доказательство, к которому нечего придраться. */
const fresh = (over: Partial<DevnetProofRecord> = {}): DevnetProofRecord => ({
  formatVersion: DEVNET_PROOF_FORMAT_VERSION,
  network: 'devnet',
  genesisHash: DEVNET,
  endpointFingerprint: FINGERPRINT,
  outcome: 'VERIFIED',
  failureCode: null,
  methods: [...DEVNET_REQUIRED_RPC_METHODS],
  verifiedAtMs: NOW - 60_000,
  expiresAtMs: NOW - 60_000 + DEVNET_PROOF_TTL_MS,
  ...over,
});

describe('наличие настройки не заменяет проверку', () => {
  it('endpoint задан, проверки не было — не подтверждено', () => {
    /*
     * Тот самый случай. Отпечаток настройки есть, значит адрес узла
     * задан; записи о проверке нет. Прежняя реализация ответила бы
     * «проверено» именно здесь.
     */
    const verdict = evaluateDevnetProof(null, expectation());

    expect(verdict.verified).toBe(false);
    expect(verdict.code).toBe('NOT_RUN');
  });

  it('строка заведена, но проверка не выполнялась — не подтверждено', () => {
    // Строку заводит сама служба, чтобы взять аренду. Пустая строка
    // не должна выглядеть неудачей — но и успехом тем более.
    const verdict = evaluateDevnetProof(fresh({ outcome: 'NOT_RUN' }), expectation());

    expect(verdict.code).toBe('NOT_RUN');
    expect(verdict.verified).toBe(false);
  });

  it('endpoint не задан — проверять нечего', () => {
    const verdict = evaluateDevnetProof(null, expectation({ endpointFingerprint: null }));

    expect(verdict.code).toBe('NOT_CONFIGURED');
    expect(verdict.verified).toBe(false);
  });

  it('свежее доказательство подтверждает', () => {
    // Негативный контроль ко всему файлу: отвергается не всё подряд.
    const verdict = evaluateDevnetProof(fresh(), expectation());

    expect(verdict.verified).toBe(true);
    expect(verdict.code).toBe('VERIFIED');
    expect(verdict.expiresInMs).toBeGreaterThan(0);
    expect(verdict.stale).toBe(false);
  });
});

describe('доказательство теряет силу', () => {
  it('истёк срок годности', () => {
    const verdict = evaluateDevnetProof(
      fresh({ verifiedAtMs: NOW - DEVNET_PROOF_TTL_MS - 1, expiresAtMs: NOW - 1 }),
      expectation(),
    );

    expect(verdict.code).toBe('EXPIRED');
    expect(verdict.stale, 'устарело, а не сломалось').toBe(true);
    expect(verdict.verified).toBe(false);
  });

  it('ровно в момент истечения уже не годится', () => {
    /*
     * Граница включительно. Секунда в пользу «ещё годится» ничего не
     * даёт, а неопределённость на границе однажды придётся выяснять
     * по журналам.
     */
    expect(evaluateDevnetProof(fresh({ expiresAtMs: NOW }), expectation()).code).toBe('EXPIRED');
  });

  it('сменился endpoint', () => {
    // Ключ провайдера поменяли — значит, поменялся доступ. Прежняя
    // проверка доказывает работу того, чего больше нет.
    const verdict = evaluateDevnetProof(fresh({ endpointFingerprint: 'b'.repeat(64) }), expectation());

    expect(verdict.code).toBe('ENDPOINT_CHANGED');
    expect(verdict.verified).toBe(false);
  });

  it('сменилась сеть', () => {
    const verdict = evaluateDevnetProof(fresh({ network: 'testnet' }), expectation());

    expect(verdict.code).toBe('NETWORK_CHANGED');
  });

  it('genesis не тот', () => {
    const verdict = evaluateDevnetProof(fresh({ genesisHash: 'x'.repeat(44) }), expectation());

    expect(verdict.code).toBe('GENESIS_MISMATCH');
  });

  it('узел оказался mainnet — отдельная причина', () => {
    /*
     * Самая вероятная и самая дорогая ошибка оператора: боевой адрес
     * остался в переменной, поменяли только имя сети. Общий код
     * «не тот genesis» отправил бы искать опечатку.
     */
    const verdict = evaluateDevnetProof(fresh({ genesisHash: MAINNET }), expectation());

    expect(verdict.code).toBe('MAINNET_ENDPOINT_REFUSED');
    expect(verdict.verified).toBe(false);
  });

  it('узел не поддерживает нужный метод', () => {
    const verdict = evaluateDevnetProof(
      fresh({ methods: ['getHealth', 'getGenesisHash'] }),
      expectation(),
    );

    expect(verdict.code).toBe('METHODS_UNSUPPORTED');
  });

  it('проверка выполнялась и не прошла', () => {
    const verdict = evaluateDevnetProof(
      fresh({ outcome: 'FAILED', failureCode: 'SOLANA_RPC_TIMEOUT', verifiedAtMs: null, expiresAtMs: null }),
      expectation(),
    );

    expect(verdict.code).toBe('CHECK_FAILED');
  });

  it('чужая версия формата не читается', () => {
    // Молча принять запись другой версии значило бы прочитать поля,
    // смысл которых мог измениться.
    const verdict = evaluateDevnetProof(
      fresh({ formatVersion: DEVNET_PROOF_FORMAT_VERSION + 1 }),
      expectation(),
    );

    expect(verdict.code).toBe('FORMAT_UNSUPPORTED');
  });
});

describe('неполная запись не доказательство', () => {
  /**
   * Каждый случай ниже выглядит как успех, если не смотреть внимательно.
   *
   * Успех без срока годности не истекает никогда; без genesis hash не
   * отличает devnet от mainnet; со сроком раньше проверки означает
   * испорченные часы.
   */
  const broken: Array<[string, Partial<DevnetProofRecord>]> = [
    ['без genesis hash', { genesisHash: null }],
    ['без срока годности', { expiresAtMs: null }],
    ['без времени проверки', { verifiedAtMs: null }],
    ['срок раньше проверки', { expiresAtMs: NOW - 120_000 }],
    ['пустой список методов', { methods: [] }],
    ['пустое имя сети', { network: '' }],
    ['пустой отпечаток', { endpointFingerprint: '' }],
    ['неизвестный исход', { outcome: 'MAYBE' }],
  ];

  it.each(broken)('%s', (_name, over) => {
    const verdict = evaluateDevnetProof(fresh(over), expectation());

    expect(verdict.verified).toBe(false);
    expect(verdict.code).toBe('INCOMPLETE_RECORD');
  });
});

describe('подтверждает только один код', () => {
  it('ни одна причина отказа не даёт verified', () => {
    /*
     * Проверка правила, а не перечисления случаев. Она поймает
     * ветку, добавленную завтра и забывшую выставить `verified`.
     */
    const cases: DevnetProofRecord[] = [
      fresh({ outcome: 'FAILED' }),
      fresh({ outcome: 'NOT_RUN' }),
      fresh({ formatVersion: 99 }),
      fresh({ genesisHash: MAINNET }),
      fresh({ genesisHash: 'иное' }),
      fresh({ network: 'mainnet-beta' }),
      fresh({ endpointFingerprint: 'иное' }),
      fresh({ methods: [] }),
      fresh({ expiresAtMs: NOW - 1 }),
    ];

    for (const record of cases) {
      const verdict = evaluateDevnetProof(record, expectation());
      expect(verdict.verified, verdict.code).toBe(verdict.code === 'VERIFIED');
      expect(verdict.code, 'подтверждения быть не должно').not.toBe('VERIFIED');
    }
  });
});

describe('состояние для человека', () => {
  const states: Array<[DevnetProofCode, string]> = [
    ['NOT_CONFIGURED', 'NOT_CONFIGURED'],
    ['NOT_RUN', 'NOT_RUN'],
    ['EXPIRED', 'STALE'],
    ['CHECK_FAILED', 'FAILED'],
    ['GENESIS_MISMATCH', 'FAILED'],
    ['MAINNET_ENDPOINT_REFUSED', 'FAILED'],
    ['ENDPOINT_CHANGED', 'FAILED'],
    ['NETWORK_CHANGED', 'FAILED'],
    ['METHODS_UNSUPPORTED', 'FAILED'],
    ['FORMAT_UNSUPPORTED', 'FAILED'],
    ['INCOMPLETE_RECORD', 'FAILED'],
    ['VERIFIED', 'VERIFIED'],
  ];

  it.each(states)('%s без идущей проверки → %s', (code, expected) => {
    expect(devnetRpcState(code, false)).toBe(expected);
  });

  it('идущая проверка не отменяет годного доказательства', () => {
    /*
     * Показать «проверяется» вместо «готов» значило бы на две минуты
     * опустить ступень лестницы, ничего при этом не узнав.
     */
    expect(devnetRpcState('VERIFIED', true)).toBe('VERIFIED');
  });

  it('во время проверки негодное доказательство помечается проверяемым', () => {
    expect(devnetRpcState('NOT_RUN', true)).toBe('VERIFYING');
    expect(devnetRpcState('EXPIRED', true)).toBe('VERIFYING');
  });
});

describe('запрещённые методы RPC узнаются по полному имени', () => {
  /**
   * Список появился после настоящего ложного срабатывания.
   *
   * Проверка была написана как поиск подстрок `/send|sign|simulate/i`
   * и объявила запрещённым `getSignaturesForAddress` — обычное чтение
   * чужой публичной истории, на котором держится сверка зачислений.
   * Защита, ловящая безопасное вместе с опасным, кончается тем, что
   * её ослабляют целиком.
   */
  it.each(FORBIDDEN_SOLANA_RPC_METHODS)('%s запрещён', (method) => {
    expect(isForbiddenSolanaRpcMethod(method)).toBe(true);
  });

  const allowed = [
    // Тот самый метод, из-за которого всё и началось.
    'getSignaturesForAddress',
    'getSignatureStatuses',
    'getHealth',
    'getGenesisHash',
    'getSlot',
    'getTransaction',
    'getLatestBlockhash',
  ];

  it.each(allowed)('%s разрешён', (method) => {
    expect(isForbiddenSolanaRpcMethod(method)).toBe(false);
  });

  it('совпадение только полное, а не по вхождению', () => {
    /*
     * Негативный контроль к самому правилу. Имя, содержащее
     * запрещённое как часть, — это другой метод, и запрещать его
     * заодно значило бы вернуться к поиску подстрок.
     */
    expect(isForbiddenSolanaRpcMethod('getSendTransactionCount')).toBe(false);
    expect(isForbiddenSolanaRpcMethod('sendTransactionBatch')).toBe(false);
    expect(isForbiddenSolanaRpcMethod('')).toBe(false);
  });

  it('в списке нет ни одного метода, который умеет только читать', () => {
    for (const method of FORBIDDEN_SOLANA_RPC_METHODS) {
      expect(allowed, `${method} попал бы в оба списка`).not.toContain(method);
    }
  });
});

describe('аренда', () => {
  it('свободна, если её не брали', () => {
    expect(leaseHeld(null, NOW)).toBe(false);
  });

  it('занята, пока не истекла', () => {
    expect(leaseHeld(NOW + 1, NOW)).toBe(true);
  });

  it('просроченная аренда освобождается сама', () => {
    // Иначе упавший процесс запретил бы проверку навсегда.
    expect(leaseHeld(NOW, NOW)).toBe(false);
    expect(leaseHeld(NOW - 1, NOW)).toBe(false);
  });
});
