import { createHash } from 'node:crypto';
import {
  DEVNET_PROOF_FORMAT_VERSION,
  DEVNET_PROOF_LEASE_MS,
  DEVNET_PROOF_TTL_MS,
  DEVNET_REQUIRED_RPC_METHODS,
  devnetRpcState,
  evaluateDevnetProof,
  leaseHeld,
  type DevnetProofCode,
  type DevnetProofRecord,
  type DevnetRpcState,
} from '@memex/core';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import { FetchSolanaRpcClient, type SolanaRpcClient } from './solana-rpc-deposit-source.js';
import {
  KNOWN_GENESIS_HASHES,
  runSolanaPreflight,
  type PreflightCheckName,
  type PreflightReport,
} from './solana-preflight.js';

/**
 * Доказательство того, что узел devnet проверен.
 *
 * Заменяет одну строку, которая была здесь раньше:
 *
 *     networkVerified: Boolean(env.SOLANA_PREFLIGHT_RPC_URL)
 *
 * Она отвечала на вопрос «задана ли переменная», а читалась как
 * «сеть проверена». Разница видна в тот день, когда узел отключат,
 * заменят на боевой или упрут в предел частоты: переменная останется
 * на месте, и лестница готовности продолжит показывать пройденную
 * ступень.
 *
 * Что здесь есть и чего нет.
 *
 *   • Читается только сеть. Ни одной подписи, ни одной отправки:
 *     используется тот же `runSolanaPreflight`, что и перед приёмом
 *     депозитов, и другого клиента RPC не заводится — второй клиент
 *     с другой семантикой рано или поздно разойдётся с первым.
 *   • Адрес узла берётся исключительно с сервера. Функции ниже не
 *     принимают URL параметром — принять его значило бы разрешить
 *     проверку чужого узла и записать её как свою.
 *   • В базу не попадает ни URL, ни query, ни заголовки, ни учётные
 *     данные, ни идентификатор ключа KMS, ни тела ответов. Endpoint
 *     представлен односторонним отпечатком.
 */

/** Назначение проверки. Идентификатор строки, а не адрес. */
export const DEVNET_PROOF_ID = 'solana-signing';

/**
 * Отпечаток настройки endpoint.
 *
 * Хешируется строка целиком, вместе с query. Так и задумано: смена
 * API-ключа — это смена доступа, и доказательство, пережившее её,
 * доказывало бы работу того, чего больше нет.
 *
 * Значение односторонее и наружу не выходит ни в одном ответе API.
 * Разделитель домена нужен, чтобы этот хеш нельзя было сопоставить
 * с хешем той же строки, посчитанным где-то ещё.
 */
export function endpointFingerprint(endpoint: string): string {
  return createHash('sha256').update(`memex:solana-endpoint:v1\n${endpoint}`).digest('hex');
}

/** Отпечаток текущей настройки. `null` — endpoint не задан. */
function currentFingerprint(): string | null {
  const endpoint = env.SOLANA_PREFLIGHT_RPC_URL?.trim();
  return endpoint ? endpointFingerprint(endpoint) : null;
}

/** Ожидаемый genesis выбранной сети с учётом ручного переопределения. */
function expectedGenesisHash(): string {
  return env.SOLANA_EXPECTED_GENESIS_HASH?.trim() || KNOWN_GENESIS_HASHES[env.SOLANA_NETWORK];
}

export interface DevnetProofSnapshot {
  /** Годится ли доказательство прямо сейчас. */
  verified: boolean;
  /** Машинный код для администратора. */
  code: DevnetProofCode;
  /** Состояние для человека. */
  state: DevnetRpcState;
  /** Проверка идёт прямо сейчас. */
  checkInProgress: boolean;
  /** Устаревшее доказательство: было успешным, но просрочено. */
  stale: boolean;
  /** Время последней успешной проверки. */
  verifiedAt: string | null;
  /** Когда доказательство перестанет действовать. */
  expiresAt: string | null;
  /** Время последней попытки — успешной или нет. */
  checkedAt: string | null;
  /** Безопасный код отказа последней попытки. */
  failureCode: string | null;
  /** Подтверждённые методы RPC. Имена методов, не адреса. */
  methods: string[];
  /** Наибольшая наблюдённая задержка. */
  maxLatencyMs: number | null;
  /** Версия формата записи. */
  formatVersion: number | null;
}

/** Пустой снимок: строки в базе нет либо endpoint не настроен. */
function snapshotOf(
  row: {
    formatVersion: number;
    network: string;
    outcome: string;
    genesisHash: string | null;
    endpointFingerprint: string;
    methods: string[];
    failureCode: string | null;
    maxLatencyMs: number | null;
    verifiedAt: Date | null;
    expiresAt: Date | null;
    checkedAt: Date;
    leaseExpiresAt: Date | null;
  } | null,
  nowMs: number,
): DevnetProofSnapshot {
  const record: DevnetProofRecord | null = row
    ? {
        formatVersion: row.formatVersion,
        network: row.network,
        genesisHash: row.genesisHash,
        endpointFingerprint: row.endpointFingerprint,
        outcome: row.outcome,
        failureCode: row.failureCode,
        methods: row.methods,
        verifiedAtMs: row.verifiedAt?.getTime() ?? null,
        expiresAtMs: row.expiresAt?.getTime() ?? null,
      }
    : null;

  const verdict = evaluateDevnetProof(record, {
    network: env.SOLANA_NETWORK,
    genesisHash: expectedGenesisHash(),
    mainnetGenesisHash: KNOWN_GENESIS_HASHES['mainnet-beta'],
    endpointFingerprint: currentFingerprint(),
    requiredMethods: DEVNET_REQUIRED_RPC_METHODS,
    nowMs,
  });

  const checkInProgress = leaseHeld(row?.leaseExpiresAt?.getTime() ?? null, nowMs);

  return {
    verified: verdict.verified,
    code: verdict.code,
    state: devnetRpcState(verdict.code, checkInProgress),
    checkInProgress,
    stale: verdict.stale,
    verifiedAt: row?.verifiedAt?.toISOString() ?? null,
    expiresAt: row?.expiresAt?.toISOString() ?? null,
    checkedAt: row?.checkedAt?.toISOString() ?? null,
    failureCode: row?.failureCode ?? null,
    methods: row?.methods ?? [],
    maxLatencyMs: row?.maxLatencyMs ?? null,
    formatVersion: row?.formatVersion ?? null,
  };
}

/**
 * Текущее состояние доказательства. Только чтение, без сети.
 *
 * Вызывается на каждом чтении `/agent`, поэтому не делает ни одного
 * исходящего запроса: проверка сети — отдельное действие оператора,
 * а не побочный эффект открытия экрана.
 */
export async function readDevnetProof(nowMs = Date.now()): Promise<DevnetProofSnapshot> {
  /*
   * Не настроенный endpoint не повод идти в базу.
   *
   * Ответ известен заранее, и лишний запрос из функции, которая
   * заведомо вернёт `NOT_CONFIGURED`, — это шум в журнале запросов
   * ровно там, где его труднее всего объяснить.
   */
  if (!currentFingerprint()) return snapshotOf(null, nowMs);

  const row = await prisma.solanaNetworkProof.findUnique({ where: { id: DEVNET_PROOF_ID } });
  return snapshotOf(row, nowMs);
}

/**
 * Итог попытки проверки.
 *
 * Отчёт preflight возвращается наружу намеренно. Без него командная
 * строка, которой нужен подробный список проверок, вынуждена была бы
 * запустить preflight второй раз — а это второй поход к узлу и вторая
 * трата чужого лимита частоты ради тех же самых цифр.
 *
 * Отчёт безопасен: в нём имя сети, публичный genesis hash, коды и
 * задержки. Ни URL, ни ключа, ни тел ответов.
 */
export type DevnetCheckOutcome =
  | { ok: true; snapshot: DevnetProofSnapshot; report: PreflightReport }
  | { ok: false; reason: DevnetCheckRefusal; snapshot: DevnetProofSnapshot; report: PreflightReport | null };

export type DevnetCheckRefusal =
  /** Адрес узла не задан на сервере. Сетевого вызова не было. */
  | 'NOT_CONFIGURED'
  /** Контур настроен на основную сеть. Проверка не запускается. */
  | 'MAINNET_REFUSED'
  /** Проверку уже выполняет кто-то другой. */
  | 'IN_PROGRESS'
  /** Узел не прошёл проверку. Подробности — в снимке. */
  | 'CHECK_FAILED';

export interface DevnetCheckRequest {
  /**
   * Кто запустил.
   *
   * Идентификатор администратора, не роль и не токен. `null` —
   * запуск из командной строки: в журнале это отличимо от действия
   * человека, а подставлять выдуманный идентификатор нельзя, он не
   * соответствовал бы ни одному пользователю.
   */
  actorId: string | null;
  ip?: string;
  /**
   * Клиент RPC.
   *
   * По умолчанию служба строит его сама из серверной настройки, и
   * HTTP-маршрут ничего сюда не передаёт — иначе клиент мог бы
   * подсунуть чужой узел. Передавать имеет смысл только тому, кто
   * построил клиента из той же серверной настройки: командной строке
   * (чтобы проверка выполнилась ровно один раз) и тестам.
   */
  rpc?: SolanaRpcClient;
  now?: () => number;
}

/**
 * Запустить проверку узла и записать её итог.
 *
 * Операция только читает сеть. `sendTransaction` и любая другая
 * отправка здесь невозможны не потому, что запрещены флагом, а
 * потому, что вызывается `runSolanaPreflight`, который их не умеет.
 */
export async function verifyDevnetNetwork(
  request: DevnetCheckRequest,
): Promise<DevnetCheckOutcome> {
  const now = request.now ?? (() => Date.now());
  const fingerprint = currentFingerprint();
  /*
   * Держатель аренды — не то же самое, что автор действия.
   *
   * Автора может не быть (запуск из командной строки), а аренда
   * должна кому-то принадлежать: по ней снимающий оператор находит
   * свою же строку. Отсюда отдельное непустое значение.
   */
  const holder = request.actorId ?? 'cli';

  if (!fingerprint) {
    // Ни базы, ни сети: проверять нечего, и запись об этом была бы
    // записью о несостоявшемся событии.
    return { ok: false, reason: 'NOT_CONFIGURED', snapshot: snapshotOf(null, now()), report: null };
  }

  /*
   * Основная сеть — отказ до всякого вызова.
   *
   * `runSolanaPreflight` только читает, но «только чтение mainnet»
   * — это всё равно запрос к боевой сети из контура, которому туда
   * нельзя. Отказ раньше вызова делает границу проверяемой.
   */
  if (env.SOLANA_NETWORK === 'mainnet-beta') {
    return {
      ok: false,
      reason: 'MAINNET_REFUSED',
      snapshot: await readDevnetProof(now()),
      report: null,
    };
  }

  const startedAt = new Date(now());
  const leaseUntil = new Date(startedAt.getTime() + DEVNET_PROOF_LEASE_MS);

  /*
   * Строка заводится до аренды и с честным `NOT_RUN`.
   *
   * `createMany({ skipDuplicates })` — это `ON CONFLICT DO NOTHING`:
   * конфликт разрешает база одним оператором, исключения не
   * возникает. Записывать здесь `FAILED` было бы неправдой: ничего
   * ещё не проверялось и ничего не падало.
   */
  await prisma.solanaNetworkProof.createMany({
    data: [
      {
        id: DEVNET_PROOF_ID,
        formatVersion: DEVNET_PROOF_FORMAT_VERSION,
        network: env.SOLANA_NETWORK,
        outcome: 'NOT_RUN',
        endpointFingerprint: fingerprint,
        checkedAt: startedAt,
      },
    ],
    skipDuplicates: true,
  });

  /*
   * Аренда берётся одним `UPDATE ... WHERE`.
   *
   * Условие на срок аренды входит в тот же оператор, поэтому две
   * параллельные проверки не могут обе получить `count: 1`:
   * PostgreSQL сериализует их на блокировке строки. Проверка
   * «свободна ли аренда» отдельным запросом оставляла бы окно между
   * чтением и записью — ровно то, ради чего аренда и заводилась.
   */
  const claimed = await prisma.solanaNetworkProof.updateMany({
    where: {
      id: DEVNET_PROOF_ID,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: startedAt } }],
    },
    data: { leaseHolder: holder, leaseExpiresAt: leaseUntil },
  });

  if (claimed.count === 0) {
    // Проверку уже ведёт кто-то другой. Второй запрос к узлу ничего
    // не добавил бы, а предел частоты у провайдера — общий.
    return {
      ok: false,
      reason: 'IN_PROGRESS',
      snapshot: await readDevnetProof(now()),
      report: null,
    };
  }

  let report: PreflightReport | null = null;
  let transportFailure: string | null = null;

  try {
    const rpc =
      request.rpc ?? new FetchSolanaRpcClient(env.SOLANA_PREFLIGHT_RPC_URL as string, 10_000);
    report = await runSolanaPreflight(rpc, {
      network: env.SOLANA_NETWORK,
      expectedGenesisHash: env.SOLANA_EXPECTED_GENESIS_HASH ?? null,
      /*
       * История здесь не требуется.
       *
       * Она нужна приёму депозитов, а не подписи: blockhash берётся
       * из текущего состояния цепочки. Требовать её значило бы
       * запрещать подпись на узле, которого для подписи достаточно.
       */
      requireHistory: false,
      now,
    });
  } catch (error: unknown) {
    /*
     * Наружу и в базу идёт только имя ошибки.
     *
     * Сообщение исключения `fetch` содержит адрес узла целиком,
     * вместе с query-строкой и ключом в ней.
     */
    transportFailure = error instanceof Error ? error.name : 'DEVNET_CHECK_FAILED';
  }

  const finishedAt = new Date(now());
  const verified = report?.ok === true;

  const failure = verified
    ? null
    : transportFailure ?? firstFailureCode(report) ?? 'DEVNET_CHECK_FAILED';
  const failureKind = verified ? null : firstFailureKind(report);

  /*
   * Неудача стирает прежний успех.
   *
   * `verifiedAt`, `expiresAt`, `genesisHash` и список методов
   * обнуляются вместе с записью отказа. Оставить их значило бы
   * держать активным доказательство, которое только что не
   * подтвердилось: экран показывал бы «готово» рядом с ошибкой.
   */
  await prisma.solanaNetworkProof.updateMany({
    where: { id: DEVNET_PROOF_ID, leaseHolder: holder },
    data: {
      formatVersion: DEVNET_PROOF_FORMAT_VERSION,
      network: env.SOLANA_NETWORK,
      endpointFingerprint: fingerprint,
      outcome: verified ? 'VERIFIED' : 'FAILED',
      genesisHash: verified ? report?.observedGenesisHash ?? null : null,
      methods: verified ? observedMethods(report) : [],
      failureCode: failure,
      failureKind,
      maxLatencyMs: maxLatency(report),
      commitmentLagSlots: report?.commitmentLagSlots ?? null,
      verifiedAt: verified ? finishedAt : null,
      expiresAt: verified ? new Date(finishedAt.getTime() + DEVNET_PROOF_TTL_MS) : null,
      checkedAt: finishedAt,
      checkedBy: holder,
      // Аренда снимается тем же оператором: отдельный запрос мог бы
      // не выполниться и оставить проверку «идущей» навсегда.
      leaseHolder: null,
      leaseExpiresAt: null,
    },
  });

  /*
   * Журнал. Ни адреса узла, ни отпечатка, ни тел ответов.
   *
   * Отпечаток не пишется намеренно: журнал читают шире, чем таблицу
   * доказательств, а сопоставив отпечаток с моментом смены настройки,
   * можно восстановить историю конфигурации.
   */
  await prisma.auditLog.create({
    data: {
      actorId: request.actorId,
      action: 'live.devnet_network_check',
      entity: 'SolanaNetworkProof',
      entityId: DEVNET_PROOF_ID,
      after: {
        network: env.SOLANA_NETWORK,
        outcome: verified ? 'VERIFIED' : 'FAILED',
        failureCode: failure,
        methods: verified ? observedMethods(report) : [],
        maxLatencyMs: maxLatency(report),
      },
      ip: request.ip ?? null,
    },
  });

  const snapshot = await readDevnetProof(now());
  return verified && report
    ? { ok: true, snapshot, report }
    : { ok: false, reason: 'CHECK_FAILED', snapshot, report };
}

/**
 * Какие методы RPC подтверждены ответом узла.
 *
 * Только пройденные проверки. Пропущенная проверка методом не
 * считается: «не спрашивали» и «ответил» — разные факты, и первое,
 * записанное как второе, однажды разрешит подпись на узле, который
 * нужного метода не умеет.
 */
const METHOD_OF: Partial<Record<PreflightCheckName, string>> = {
  HEALTH: 'getHealth',
  GENESIS: 'getGenesisHash',
  SLOT_CONFIRMED: 'getSlot',
  SLOT_FINALIZED: 'getSlot',
  SIGNATURES_FOR_ADDRESS: 'getSignaturesForAddress',
  SIGNATURE_STATUSES: 'getSignatureStatuses',
  GET_TRANSACTION: 'getTransaction',
};

function observedMethods(report: PreflightReport | null): string[] {
  if (!report) return [];
  const methods = new Set<string>();
  for (const check of report.checks) {
    if (check.outcome !== 'PASS') continue;
    const method = METHOD_OF[check.name];
    if (method) methods.add(method);
  }
  return [...methods].sort();
}

function firstFailureCode(report: PreflightReport | null): string | null {
  return report?.checks.find((check) => check.outcome === 'FAIL')?.code ?? null;
}

function firstFailureKind(report: PreflightReport | null): string | null {
  return report?.checks.find((check) => check.outcome === 'FAIL')?.kind ?? null;
}

function maxLatency(report: PreflightReport | null): number | null {
  const values = (report?.checks ?? [])
    .map((check) => check.latencyMs)
    .filter((value): value is number => value != null);
  return values.length === 0 ? null : Math.max(...values);
}
