import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BLOCKHASH_MAX_AGE_MS,
  CLIENT_FORBIDDEN_FIELDS,
  canTransitionIntent,
  checkBlockhash,
  checkSigningIdentity,
  forbiddenClientFields,
  isAllowedOrigin,
  isLiveIntentState,
  isMainnet,
  isTerminalIntentState,
  liveReadinessStage,
  signingBlockers,
  transactionSigningState,
  allowsKmsCall,
  verdictPausesSigning,
  type TransactionIntentState,
  type TransactionSigningInput,
} from '@memex/core';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import { BROADCAST_AVAILABLE, readSigningState } from '../services/signing-state.js';
import {
  DEVNET_PROOF_FORMAT_VERSION,
  DEVNET_REQUIRED_RPC_METHODS,
  evaluateDevnetProof,
  type DevnetProofRecord,
} from '@memex/core';
import {
  DEVNET_PROOF_ID,
  endpointFingerprint,
  readDevnetProof,
  verifyDevnetNetwork,
} from '../services/devnet-network-proof.js';
import { KNOWN_GENESIS_HASHES } from '../services/solana-preflight.js';
import { assertSchemaReady, forbidNetwork, paperAgentSnapshot, resetData } from './harness.js';

/**
 * Готовность LIVE devnet — всё, что проверяется без внешних секретов.
 *
 * Граница проведена честно и названа вслух. Ключа KMS, учётных данных
 * и адреса узла у стенда нет и не должно быть; всё, что без них
 * недостижимо, помечается `BLOCKED_EXTERNAL` и не выдаётся за
 * проверенное. Подменять живую проверку моком и писать в отчёт
 * «пройдено» — худшее, что здесь можно сделать: цена ошибки в этом
 * контуре измеряется чужими деньгами.
 *
 * Что проверяется здесь по-настоящему:
 *   • сеть контура — devnet, и mainnet распознаётся как запрет;
 *   • жизненный цикл намерения: переходы, истечение, отсутствие
 *     состояний отправки;
 *   • что вправе прислать клиент, а что собирает только сервер;
 *   • свежесть blockhash;
 *   • реестр подписанта и его пауза;
 *   • ступень лестницы готовности на настоящем ответе `/agent`;
 *   • отсутствие автоматического перехода PAPER → LIVE;
 *   • запрет выводов.
 *
 * Что помечено `BLOCKED_EXTERNAL` и почему — в последнем наборе.
 */

beforeEach(async () => {
  await assertSchemaReady();
  await resetData();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('сеть контура', () => {
  it('стенд работает на devnet', () => {
    expect(env.SOLANA_NETWORK).toBe('devnet');
    expect(isMainnet(env.SOLANA_NETWORK)).toBe(false);
  });

  it('оба написания mainnet распознаются как запрет', () => {
    // Проверка самого правила: без неё пункт выше говорит только
    // о текущей настройке, а не о том, что mainnet вообще узнаётся.
    expect(isMainnet('mainnet')).toBe(true);
    expect(isMainnet('mainnet-beta')).toBe(true);
  });

  it('боевое исполнение и выводы выключены', () => {
    expect(env.EXECUTION_MODE).toBe('paper');
    expect(env.LIVE_EXECUTION_ENABLED).toBe(false);
    expect(env.WITHDRAWALS_ENABLED).toBe(false);
    expect(env.LIVE_AGENT_ENABLED).toBe(false);
  });
});

describe('жизненный цикл намерения', () => {
  const STATES: TransactionIntentState[] = [
    'DRAFT',
    'VALIDATED',
    'APPROVED',
    'SIGNING',
    'SIGNED',
    'EXPIRED',
    'REJECTED',
    'FAILED',
  ];

  it('в машине состояний нет отправки и подтверждения', () => {
    /*
     * `SIGNED` не равно `SUBMITTED`. Состояния отправки нет не потому,
     * что её выключили, а потому, что транспорта не существует —
     * и появиться он должен отдельным решением, а не флагом.
     */
    for (const name of STATES) {
      expect(name, `состояние ${name}`).not.toMatch(/SUBMIT|BROADCAST|CONFIRM/i);
    }
  });

  it('подпись — конечное состояние: дальше идти некуда', () => {
    expect(isTerminalIntentState('SIGNED')).toBe(true);
    for (const to of STATES) {
      expect(canTransitionIntent('SIGNED', to), `SIGNED → ${to}`).toBe(false);
    }
  });

  it('истёкшее и отклонённое никуда не ведут', () => {
    for (const terminal of ['EXPIRED', 'REJECTED', 'FAILED'] as const) {
      expect(isTerminalIntentState(terminal), terminal).toBe(true);
      expect(isLiveIntentState(terminal), terminal).toBe(false);
    }
  });

  it('подпись достижима только из подтверждённого намерения', () => {
    expect(canTransitionIntent('APPROVED', 'SIGNING')).toBe(true);
    expect(canTransitionIntent('DRAFT', 'SIGNING')).toBe(false);
    expect(canTransitionIntent('VALIDATED', 'SIGNING')).toBe(false);
  });

  it('истечение доступно из каждого живого состояния', () => {
    // Иначе намерение могло бы зависнуть навсегда.
    for (const from of STATES.filter(isLiveIntentState)) {
      expect(canTransitionIntent(from, 'EXPIRED'), from).toBe(true);
    }
  });

  it('отправка недоступна как факт, а не как настройка', () => {
    // Константа, а не переменная окружения: включить нечем.
    expect(BROADCAST_AVAILABLE).toBe(false);
  });
});

describe('что вправе прислать клиент', () => {
  it('запрещённые поля перечислены и отвергаются', () => {
    const payload = Object.fromEntries(CLIENT_FORBIDDEN_FIELDS.map((field) => [field, 'x']));

    expect(forbiddenClientFields(payload).sort()).toEqual([...CLIENT_FORBIDDEN_FIELDS].sort());
  });

  it('обычное подтверждение проходит', () => {
    // Негативный контроль: отвергается не всё подряд.
    expect(forbiddenClientFields({ intentId: 'x', decision: 'APPROVE' })).toEqual([]);
  });

  it('происхождение намерения — из закрытого списка', () => {
    expect(isAllowedOrigin('AGENT_PROPOSAL')).toBe(true);
    for (const origin of ['CLIENT', 'MANUAL_API', '']) {
      expect(isAllowedOrigin(origin), origin).toBe(false);
    }
  });
});

describe('свежесть blockhash', () => {
  const nowMs = Date.UTC(2026, 8, 5, 12);
  const facts = (over: Record<string, unknown> = {}) => ({
    blockhash: 'a'.repeat(44),
    lastValidBlockHeight: '100',
    network: 'devnet',
    fetchedAtMs: nowMs,
    ...over,
  });

  it('свежий принимается, просроченный — нет', () => {
    expect(
      checkBlockhash({
        facts: facts(),
        nowMs,
        expectedNetwork: 'devnet',
        currentBlockHeight: '90',
      }),
    ).toBe('OK');

    expect(
      checkBlockhash({
        facts: facts({ fetchedAtMs: nowMs - BLOCKHASH_MAX_AGE_MS - 1 }),
        nowMs,
        expectedNetwork: 'devnet',
        currentBlockHeight: '90',
      }),
    ).toBe('STALE');
  });

  it('высота выше предельной делает blockhash непригодным', () => {
    expect(
      checkBlockhash({
        facts: facts(),
        nowMs,
        expectedNetwork: 'devnet',
        currentBlockHeight: '101',
      }),
    ).toBe('HEIGHT_PASSED');
  });

  it('blockhash из чужой сети отвергается', () => {
    /*
     * Значение из mainnet синтаксически неотличимо от devnet
     * и привело бы к подписи под транзакцией, которой в devnet
     * никогда не существовало.
     */
    expect(
      checkBlockhash({
        facts: facts({ network: 'mainnet-beta' }),
        nowMs,
        expectedNetwork: 'devnet',
        currentBlockHeight: '90',
      }),
    ).toBe('WRONG_NETWORK');
  });

  it('отсутствующий blockhash не считается пригодным', () => {
    expect(
      checkBlockhash({ facts: null, nowMs, expectedNetwork: 'devnet', currentBlockHeight: '90' }),
    ).toBe('MISSING');
  });
});

describe('реестр подписанта', () => {
  const observed = {
    fingerprint: 'f'.repeat(16),
    solanaAddress: 'A'.repeat(44),
    keyVersion: '1',
    algorithm: 'ED25519',
    network: 'devnet',
  };

  /**
   * Полностью готовый контур, кроме одного признака.
   *
   * От него тесты «отламывают» по одному условию: так видно, что
   * запрещает именно проверяемое обстоятельство, а не общий отказ.
   */
  const readyInput: TransactionSigningInput = {
    signingEnabled: true,
    signerProvider: 'aws-kms',
    providerSupported: true,
    keyConfigured: true,
    network: 'devnet',
    withdrawalsEnabled: false,
    broadcastAvailable: false,
    identity: 'OK',
    expectedKeyMatches: true,
    networkVerified: true,
    signatureValidated: false,
    safetyLatchHealthy: true,
    hasAmbiguousAttempt: false,
  };

  it('незарегистрированный ключ делает вызов KMS невозможным', () => {
    /*
     * Первая версия теста требовала `verdictPausesSigning('NOT_REGISTERED')
     * === true` и падала. Ошибался тест: `verdictPausesSigning`
     * отвечает на вопрос «переводить ли ранее зарегистрированный ключ
     * в паузу», а незарегистрированный переводить неоткуда.
     *
     * Настоящий запрет живёт ветвью раньше: `transactionSigningState`
     * возвращает `IDENTITY_UNVERIFIED`, а `allowsKmsCall` пропускает
     * только `READY_TO_SIGN_DEVNET` и `SIGNATURE_VALIDATED`. Проверять
     * надо это, а не имя функции.
     */
    const state = transactionSigningState({ ...readyInput, identity: 'NOT_REGISTERED' });

    expect(state).toBe('IDENTITY_UNVERIFIED');
    expect(allowsKmsCall(state), 'вызов KMS обязан быть запрещён').toBe(false);
    expect(signingBlockers({ ...readyInput, identity: 'NOT_REGISTERED' })).toContain(
      'IDENTITY_NOT_REGISTERED',
    );
  });

  it('полный набор условий — единственный, при котором подпись разрешена', () => {
    /*
     * Негативный контроль ко всем запретам ниже: `allowsKmsCall`
     * не отвечает «нет» всегда.
     */
    expect(allowsKmsCall(transactionSigningState(readyInput))).toBe(true);
  });

  it('снятие любого условия запрещает вызов KMS', () => {
    const breaks: Array<Partial<TransactionSigningInput>> = [
      { signingEnabled: false },
      { providerSupported: false },
      { keyConfigured: false },
      { identity: 'NOT_REGISTERED' },
      { identity: 'PAUSED' },
      { expectedKeyMatches: false },
      { networkVerified: false },
      { network: 'mainnet-beta' },
      { safetyLatchHealthy: false },
      { hasAmbiguousAttempt: true },
      { withdrawalsEnabled: true },
      { broadcastAvailable: true },
    ];

    for (const patch of breaks) {
      const state = transactionSigningState({ ...readyInput, ...patch });
      expect(allowsKmsCall(state), JSON.stringify(patch)).toBe(false);
    }
  });

  it('расхождение отпечатка переводит зарегистрированный ключ в паузу', () => {
    // Вот где `verdictPausesSigning` действительно применим.
    expect(verdictPausesSigning('FINGERPRINT_CHANGED')).toBe(true);
    expect(verdictPausesSigning('EXPECTED_MISMATCH')).toBe(true);
    expect(verdictPausesSigning('OK')).toBe(false);
    expect(
      verdictPausesSigning('NOT_REGISTERED'),
      'незарегистрированный ключ не «ставится на паузу» — его просто нет',
    ).toBe(false);
  });

  it('поставленный на паузу ключ не подписывает', () => {
    const verdict = checkSigningIdentity({
      state: 'PAUSED',
      registered: observed,
      observed,
      expectedFingerprint: null,
    } as never);

    expect(verdict).toBe('PAUSED');
    expect(verdictPausesSigning(verdict)).toBe(true);
  });

  it('подменённый отпечаток останавливает подпись', () => {
    // Самый опасный случай: ключ формально тот же, а на деле другой.
    const verdict = checkSigningIdentity({
      state: 'REGISTERED',
      registered: observed,
      observed: { ...observed, fingerprint: 'e'.repeat(16) },
      expectedFingerprint: null,
    } as never);

    expect(verdictPausesSigning(verdict)).toBe(true);
  });

  it('состояние подписи читается из базы и контур выключен', async () => {
    /*
     * Настоящее чтение через ту же функцию, что и в бою. Контур
     * выключен, поэтому вызов KMS запрещён — и это наблюдаемый
     * результат, а не предположение.
     */
    const signing = await readSigningState();

    expect(signing.facts.signingEnabled).toBe(false);
    expect(signing.allowsKmsCall).toBe(false);
    expect(signing.facts.broadcastAvailable).toBe(false);
    expect(signing.blockers.length).toBeGreaterThan(0);
  });

  it('диагностика не раскрывает имя ресурса ключа', async () => {
    const signing = await readSigningState();
    const serialized = JSON.stringify(signing);

    expect(serialized).not.toMatch(/arn:aws|projects\/|https?:\/\//i);
  });
});

describe('лестница готовности на настоящем ответе', () => {
  it('стенд стоит на первой ступени и mainnet не запрошен', async () => {
    const snapshot = await paperAgentSnapshot();

    expect(snapshot.phase4.live.stage).toBe('PAPER_READY');
    expect(snapshot.phase4.live.ready).toBe(false);
    expect(snapshot.phase4.live.mainnetRequested).toBe(false);
    expect(snapshot.phase4.live.enabled).toBe(false);
    expect(snapshot.phase4.withdrawals.enabled).toBe(false);
  });

  it('ни одна ступень не поднимается сама', () => {
    /*
     * Автоматического перехода PAPER → LIVE нет: лестница
     * определяется первой невыполненной ступенью, а условия
     * приходят снаружи и не выставляются кодом.
     */
    const base = {
      paperAgentConfigured: true,
      allocationConfigured: true,
      signingEnabled: false,
      signerProviderSupported: false,
      signerKeyConfigured: false,
      signerKeyFingerprintObserved: false,
      identityRegistered: false,
      expectedKeyMatches: false,
      networkVerified: false,
      reconciliationEnabled: false,
      safetyLatchHealthy: false,
      migrationsReady: false,
      signatureValidated: false,
      hasAmbiguousAttempt: false,
      network: 'devnet',
    };

    expect(liveReadinessStage(base).stage).toBe('PAPER_READY');
    expect(liveReadinessStage(base).blockers.length).toBeGreaterThan(0);
  });
});

/**
 * Доказательство проверки узла — на настоящем PostgreSQL.
 *
 * Живого узла у стенда нет и быть не должно: сетевой вызов остаётся
 * `BLOCKED_EXTERNAL`. Зато здесь проверяется всё остальное — то, что
 * ломается тише всего: как значения переживают запись и чтение,
 * `TEXT[]` для списка методов, `TIMESTAMP(3)` для сроков, и что
 * правило ядра выносит тот же вердикт на строке из базы, а не только
 * на объекте из памяти.
 */
describe('доказательство проверки сети хранится и стареет', () => {
  const FINGERPRINT = endpointFingerprint('https://node.example.invalid/devnet?api-key=нет');

  /** Ожидание текущего стенда: devnet, свой отпечаток, свои методы. */
  const expectation = (nowMs: number) => ({
    network: 'devnet',
    genesisHash: KNOWN_GENESIS_HASHES.devnet,
    mainnetGenesisHash: KNOWN_GENESIS_HASHES['mainnet-beta'],
    endpointFingerprint: FINGERPRINT,
    requiredMethods: DEVNET_REQUIRED_RPC_METHODS,
    nowMs,
  });

  /** Записать строку и прочитать её обратно как запись доказательства. */
  async function roundTrip(data: Record<string, unknown>): Promise<DevnetProofRecord> {
    await prisma.solanaNetworkProof.create({
      data: {
        id: DEVNET_PROOF_ID,
        formatVersion: DEVNET_PROOF_FORMAT_VERSION,
        network: 'devnet',
        endpointFingerprint: FINGERPRINT,
        checkedAt: new Date(),
        ...data,
      } as never,
    });
    const row = await prisma.solanaNetworkProof.findUniqueOrThrow({
      where: { id: DEVNET_PROOF_ID },
    });
    return {
      formatVersion: row.formatVersion,
      network: row.network,
      genesisHash: row.genesisHash,
      endpointFingerprint: row.endpointFingerprint,
      outcome: row.outcome,
      failureCode: row.failureCode,
      methods: row.methods,
      verifiedAtMs: row.verifiedAt?.getTime() ?? null,
      expiresAtMs: row.expiresAt?.getTime() ?? null,
    };
  }

  const verified = (nowMs: number, over: Record<string, unknown> = {}) => ({
    outcome: 'VERIFIED',
    genesisHash: KNOWN_GENESIS_HASHES.devnet,
    methods: [...DEVNET_REQUIRED_RPC_METHODS],
    verifiedAt: new Date(nowMs - 60_000),
    expiresAt: new Date(nowMs + 600_000),
    ...over,
  });

  it('таблица существует и пуста между сценариями', async () => {
    // Негативный контроль ко всему разделу: строки берутся отсюда,
    // а не остаются от соседнего теста.
    expect(await prisma.solanaNetworkProof.count()).toBe(0);
  });

  it('список методов переживает запись как массив, а не строка', async () => {
    /*
     * `TEXT[]` в PostgreSQL и `string[]` в коде совпадают не сами
     * собой. Строка вместо массива прошла бы проверку методов по
     * подстроке и разрешила бы узел, который метода не умеет.
     */
    const now = Date.now();
    const record = await roundTrip(verified(now));

    expect(Array.isArray(record.methods)).toBe(true);
    expect(record.methods).toEqual([...DEVNET_REQUIRED_RPC_METHODS]);
  });

  it('свежая запись из базы подтверждает сеть', async () => {
    const now = Date.now();
    const record = await roundTrip(verified(now));

    expect(evaluateDevnetProof(record, expectation(now))).toMatchObject({
      verified: true,
      code: 'VERIFIED',
    });
  });

  it('истёкшая запись не подтверждает', async () => {
    const now = Date.now();
    const record = await roundTrip(
      verified(now, { verifiedAt: new Date(now - 7_200_000), expiresAt: new Date(now - 3_600_000) }),
    );

    const verdict = evaluateDevnetProof(record, expectation(now));
    expect(verdict.verified).toBe(false);
    expect(verdict.code).toBe('EXPIRED');
    expect(verdict.stale).toBe(true);
  });

  it('заведённая, но не выполненная проверка не подтверждает', async () => {
    // Строку заводит сама служба, чтобы взять аренду. Пустая строка
    // не должна выглядеть ни успехом, ни поломкой.
    const now = Date.now();
    const record = await roundTrip({ outcome: 'NOT_RUN' });

    expect(evaluateDevnetProof(record, expectation(now)).code).toBe('NOT_RUN');
  });

  it('неудачная проверка пишется без срока годности', async () => {
    /*
     * И это не мелочь: успех без срока не истекает никогда.
     * Колонки обязаны допускать NULL, иначе отказ пришлось бы
     * записывать с выдуманным сроком.
     */
    const now = Date.now();
    const record = await roundTrip({
      outcome: 'FAILED',
      failureCode: 'SOLANA_RPC_TIMEOUT',
      failureKind: 'TIMEOUT',
    });

    expect(record.verifiedAtMs).toBeNull();
    expect(record.expiresAtMs).toBeNull();
    expect(evaluateDevnetProof(record, expectation(now)).code).toBe('CHECK_FAILED');
  });

  it('смена endpoint обесценивает запись', async () => {
    const now = Date.now();
    const record = await roundTrip(verified(now));

    const verdict = evaluateDevnetProof(record, {
      ...expectation(now),
      endpointFingerprint: endpointFingerprint('https://other.invalid/devnet'),
    });
    expect(verdict.code).toBe('ENDPOINT_CHANGED');
  });

  it('mainnet вместо devnet — отдельная причина отказа', async () => {
    const now = Date.now();
    const record = await roundTrip(
      verified(now, { genesisHash: KNOWN_GENESIS_HASHES['mainnet-beta'] }),
    );

    expect(evaluateDevnetProof(record, expectation(now)).code).toBe('MAINNET_ENDPOINT_REFUSED');
  });

  it('в таблице нет ни адреса узла, ни ключа', async () => {
    /*
     * Проверяется схема, а не намерение. Колонка под URL однажды
     * была бы заполнена, и строка подключения с API-ключом осела бы
     * в базе до первого дампа.
     */
    const columns = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'SolanaNetworkProof'`,
    );
    const names = columns.map((row) => row.column_name);

    expect(names).toContain('endpointFingerprint');
    for (const name of names) {
      expect(name, name).not.toMatch(/url|uri|secret|apiKey|credential|token/i);
    }
  });
});

describe('проверка сети на выключенном контуре', () => {
  it('адрес узла не задан — состояние честное и в сеть не ходят', async () => {
    /*
     * Стенд намеренно без адреса узла. `NOT_CONFIGURED` — это не
     * отказ и не успех: проверять нечего, и ступень не поднимается.
     */
    const restore = forbidNetwork();
    try {
      const proof = await readDevnetProof();

      expect(env.SOLANA_PREFLIGHT_RPC_URL ?? '').toBe('');
      expect(proof.verified).toBe(false);
      expect(proof.code).toBe('NOT_CONFIGURED');
      expect(proof.state).toBe('NOT_CONFIGURED');
    } finally {
      restore();
    }
  });

  it('запуск проверки без адреса узла ничего не пишет и никуда не ходит', async () => {
    const restore = forbidNetwork();
    try {
      const outcome = await verifyDevnetNetwork({ actorId: null });

      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.reason).toBe('NOT_CONFIGURED');
      expect(await prisma.solanaNetworkProof.count(), 'в базу ничего не записано').toBe(0);
      expect(await prisma.auditLog.count(), 'несостоявшееся действие не журналируется').toBe(0);
    } finally {
      restore();
    }
  });

  it('снимок /agent показывает состояние узла без адреса', async () => {
    const snapshot = await paperAgentSnapshot();
    const rpc = snapshot.phase4?.live?.rpc ?? null;

    expect(rpc, 'состояние узла присутствует в ответе').not.toBeNull();
    expect(rpc.state).toBe('NOT_CONFIGURED');
    expect(JSON.stringify(snapshot)).not.toMatch(/SOLANA_PREFLIGHT_RPC_URL|api-key|endpointFingerprint/);
  });

  it('сеть не считается проверенной, и ступень это учитывает', async () => {
    const signing = await readSigningState();

    expect(signing.facts.networkVerified).toBe(false);
    expect(signing.devnetProof?.code).toBe('NOT_CONFIGURED');
  });
});

describe('выводы недоступны', () => {
  it('ни одной записи о выводе не появляется', async () => {
    expect(await prisma.withdrawal.count()).toBe(0);
    expect(await prisma.withdrawalOperation.count()).toBe(0);
  });
});

/**
 * Граница внешних зависимостей.
 *
 * Эти проверки невозможны без ключа KMS, учётных данных провайдера и
 * доступного узла devnet. Стенд их не подменяет и не объявляет
 * пройденными: ниже перечислено ровно то, что останется непроверенным,
 * пока владелец не предоставит доступ.
 */
describe('BLOCKED_EXTERNAL: без внешних доступов не проверяется', () => {
  const blocked = [
    'подпись настоящего намерения через KMS (нужен ключ Ed25519 и права Sign)',
    'сверка отпечатка ключа с ожидаемым (нужен AWS_KMS_EXPECTED_PUBLIC_KEY)',
    'health и genesis узла devnet (нужен настоящий SOLANA_PREFLIGHT_RPC_URL)',
    'запись доказательства по живому ответу узла (нужен тот же узел): хранение и старение проверены, сетевой вызов — нет',
    'симуляция транзакции без отправки (нужен тот же узел)',
    'сверка зачислений на настоящих подтверждениях сети',
  ];

  it('список того, что осталось за границей, не пуст и назван', () => {
    /*
     * Тест существует ради отчёта: он делает список видимым в
     * выводе прогона, чтобы «проверено всё» нельзя было прочитать
     * там, где проверено не всё.
     */
    expect(blocked.length).toBeGreaterThan(0);
    for (const item of blocked) expect(item).toMatch(/нужен|настоящ/);
  });

  it('контур подписи выключен, поэтому недостающее ничего не блокирует сейчас', async () => {
    // Пока подпись выключена, отсутствие ключа не мешает PAPER
    // работать — и именно это делает границу приемлемой.
    const signing = await readSigningState();

    expect(signing.facts.signingEnabled).toBe(false);
    expect(env.SOLANA_PREFLIGHT_RPC_URL ?? '').toBe('');
  });
});
