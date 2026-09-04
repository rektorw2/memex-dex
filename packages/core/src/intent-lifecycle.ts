/**
 * Жизненный цикл предложения и намерения.
 *
 * Отвечает на два вопроса, которые нельзя решать в обработчике
 * запроса: что человек вправе прислать и что должно случиться
 * с записью после его действия.
 *
 * Первый вопрос важнее. Денежное намерение не может родиться из
 * данных браузера — ни целиком, ни по частям. Сумму, получателя,
 * кошелёк, программы, blockhash и хеш сообщения определяет сервер,
 * а от человека приходит ровно одно: согласие или отказ. Всё
 * остальное, что он мог бы прислать, — это способ подписать не то,
 * что ему показали.
 */

/** Что клиенту разрешено прислать при подтверждении. */
export interface ApprovalSubmission {
  proposalId: string;
  /** Ключ идемпотентности. Повтор не создаёт второе решение. */
  idempotencyKey: string;
  decision: 'CONFIRM' | 'REJECT';
}

/**
 * Поля, которые клиент не вправе прислать никогда.
 *
 * Список записан явно и проверяется. Молчаливое игнорирование
 * лишнего поля хуже отказа: отправитель считает, что его учли,
 * а спустя месяц кто-нибудь добавит его чтение «раз уж присылают».
 */
export const CLIENT_FORBIDDEN_FIELDS = [
  'transaction',
  'serializedTransaction',
  'message',
  'messageHash',
  'instructions',
  'programIds',
  'allowedProgramIds',
  'payer',
  'payerKey',
  'sourceAddress',
  'sourceWallet',
  'walletId',
  'destinationAddress',
  'destination',
  'rawAmount',
  'amount',
  'mint',
  'feeLimitLamports',
  'slippageBps',
  'recentBlockhash',
  'lastValidBlockHeight',
  'keyId',
  'keyVersion',
  'policyVersion',
  'network',
  'userId',
  'state',
] as const;

export type ForbiddenField = (typeof CLIENT_FORBIDDEN_FIELDS)[number];

/**
 * Что из присланного клиент присылать не имел права.
 *
 * Возвращается список, а не «да/нет»: в отказе полезно назвать поле,
 * а в журнале — сохранить, что именно пытались передать.
 */
export function forbiddenClientFields(payload: Record<string, unknown>): ForbiddenField[] {
  return CLIENT_FORBIDDEN_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(payload, field),
  );
}

/** Откуда взялось намерение. Клиента в этом списке нет. */
export type IntentOrigin =
  /** Из предложения агента. Основной путь. */
  | 'AGENT_PROPOSAL'
  /** Служебная проверочная запись. Только вне production и только ADMIN. */
  | 'ADMIN_DEVNET_FIXTURE'
  /** Будущий вывод средств. Пока не подключается. */
  | 'WITHDRAWAL_REQUEST';

export const ALLOWED_INTENT_ORIGINS: readonly IntentOrigin[] = [
  'AGENT_PROPOSAL',
  'ADMIN_DEVNET_FIXTURE',
];

export function isAllowedOrigin(value: string): value is IntentOrigin {
  return (ALLOWED_INTENT_ORIGINS as readonly string[]).includes(value);
}

export type ProposalState = 'CREATED' | 'AWAITING_CONFIRMATION' | 'CONFIRMED' | 'REJECTED' | 'EXPIRED';

export type ApprovalRefusal =
  | 'NOT_FOUND'
  | 'PROPOSAL_EXPIRED'
  | 'ALREADY_DECIDED'
  | 'WRONG_STATE'
  | 'PROPOSAL_CHANGED'
  | 'POLICY_VERSION_CHANGED'
  | 'ENTITLEMENT_MISSING'
  | 'SAFETY_LATCH_RAISED'
  | 'LIVE_BLOCKED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'FORBIDDEN_FIELDS'
  /**
   * Сеть не дала blockhash.
   *
   * Раньше на этом месте стояла заглушка из тридцати двух единиц, и
   * намерение создавалось всегда. Заглушка была неподписываемой —
   * и потому безопасной, — но она превращала «сети нет» в «всё
   * хорошо». Теперь отсутствие сети означает отказ: намерение без
   * настоящего blockhash не собирается вовсе.
   */
  | 'BLOCKHASH_UNAVAILABLE';

export interface ApprovalPreconditions {
  state: ProposalState;
  /** Владелец предложения по данным сервера. */
  ownerId: string;
  actorId: string;
  expiresAt: number;
  now: number;
  /** Отпечаток денежной части, зафиксированный при показе человеку. */
  shownFingerprint: string;
  /** Отпечаток той же части сейчас. */
  currentFingerprint: string;
  shownPolicyVersion: string;
  currentPolicyVersion: string;
  hasEntitlement: boolean;
  safetyLatchHealthy: boolean;
  /** Разрешён ли LIVE-контур вообще. */
  liveAllowed: boolean;
}

export interface ApprovalVerdict {
  allowed: boolean;
  refusal: ApprovalRefusal | null;
}

/**
 * Можно ли принять решение человека.
 *
 * Чужое предложение и несуществующее отвечают одинаково. Разные
 * коды на «не ваше» и «нет такого» — это способ по одному запросу
 * узнать, есть ли у соседа предложение на такую-то сумму.
 */
export function checkApprovalPreconditions(input: ApprovalPreconditions): ApprovalVerdict {
  const deny = (refusal: ApprovalRefusal): ApprovalVerdict => ({ allowed: false, refusal });

  if (input.ownerId !== input.actorId) return deny('NOT_FOUND');
  if (input.state === 'CONFIRMED' || input.state === 'REJECTED') return deny('ALREADY_DECIDED');
  if (input.state === 'EXPIRED') return deny('PROPOSAL_EXPIRED');
  if (input.now >= input.expiresAt) return deny('PROPOSAL_EXPIRED');
  if (input.state !== 'CREATED' && input.state !== 'AWAITING_CONFIRMATION') {
    return deny('WRONG_STATE');
  }

  /*
   * Человек соглашался на то, что видел.
   *
   * Отпечаток снимается с денежной части в момент показа. Любое
   * расхождение означает, что подтверждение относится к другому
   * предложению, даже если идентификатор тот же.
   */
  if (input.shownFingerprint !== input.currentFingerprint) return deny('PROPOSAL_CHANGED');
  if (input.shownPolicyVersion !== input.currentPolicyVersion) {
    return deny('POLICY_VERSION_CHANGED');
  }

  if (!input.hasEntitlement) return deny('ENTITLEMENT_MISSING');
  if (!input.safetyLatchHealthy) return deny('SAFETY_LATCH_RAISED');
  if (!input.liveAllowed) return deny('LIVE_BLOCKED');

  return { allowed: true, refusal: null };
}

/**
 * Что показывается человеку перед подтверждением.
 *
 * Набор закрытый. Показать меньше — значит просить согласия
 * вслепую; показать внутренние подробности — значит утопить
 * важное в шуме.
 */
export interface ProposalPresentation {
  asset: string;
  network: string;
  direction: 'BUY' | 'SELL';
  amountUsd: string;
  estimatedFeeUsd: string | null;
  maxFeeUsd: string;
  slippageBps: number;
  riskLevel: string;
  strategy: string;
  reason: string;
  expiresAt: number;
}

export const APPROVAL_WARNING =
  'Подтверждение не отправляет транзакцию: она будет только подготовлена и подписана.';

/** Хватает ли данных, чтобы просить согласия. */
export function presentationIsComplete(value: Partial<ProposalPresentation>): boolean {
  const required: Array<keyof ProposalPresentation> = [
    'asset', 'network', 'direction', 'amountUsd', 'maxFeeUsd',
    'slippageBps', 'riskLevel', 'strategy', 'reason', 'expiresAt',
  ];
  // `estimatedFeeUsd` не обязателен: неизвестная оценка честнее
  // выдуманной. Остальное — обязательно.
  return required.every((field) => value[field] != null && value[field] !== '');
}

// ─────────────────────────────── Аудит ───────────────────────────────────────

/**
 * Каталог событий.
 *
 * Перечислены явно, чтобы новое событие нельзя было добавить
 * произвольной строкой: журнал, в котором действия называются
 * по-разному в разных местах, нельзя ни отфильтровать, ни сверить.
 */
export const AUDIT_ACTIONS = [
  'PROPOSAL_CREATED',
  'PROPOSAL_PRESENTED',
  'PROPOSAL_CONFIRMED',
  'PROPOSAL_REJECTED',
  'PROPOSAL_EXPIRED',
  'INTENT_CREATED',
  'INTENT_VALIDATED',
  'INTENT_APPROVED',
  'INTENT_SIGNING_CLAIMED',
  'INTENT_KMS_REQUESTED',
  'INTENT_KMS_SUCCEEDED',
  'INTENT_KMS_AMBIGUOUS',
  'INTENT_SIGNATURE_VERIFIED',
  'INTENT_SIGNATURE_REJECTED',
  'INTENT_REJECTED',
  'INTENT_FAILED',
  'INTENT_EXPIRED',
  'ADMIN_ACTION',

  /*
   * События Phase 4F: ключ, сеть и работа подписывающего контура.
   *
   * Отдельные имена, а не один `ADMIN_ACTION` с пояснением в тексте.
   * Разбирая инцидент, спрашивают «когда сменился ключ» и «когда
   * blockhash перестал приходить» — на такие вопросы отвечает
   * фильтр по действию, а не чтение свободного текста подряд.
   */
  'SIGNING_KEY_DISCOVERED',
  'SIGNING_KEY_REGISTERED',
  'SIGNING_KEY_MISMATCH',
  'SIGNING_KEY_ROTATED',
  'SIGNING_KEY_REVOKED',
  'SIGNING_READINESS_PAUSED',
  'SIGNING_READINESS_RESUMED',
  'KMS_PREFLIGHT_STARTED',
  'KMS_PREFLIGHT_COMPLETED',
  'KMS_PREFLIGHT_FAILED',
  'BLOCKHASH_REFUSED',
  'SIGNING_WORKER_STATE_CHANGED',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Поля, которых в журнале быть не должно.
 *
 * Журнал живёт дольше инцидента и читается шире, чем база. Секрет,
 * попавший туда однажды, считается утёкшим навсегда.
 */
export const AUDIT_FORBIDDEN_KEYS = [
  'credentials',
  'authorization',
  'headers',
  'privateKey',
  'secretKey',
  'rpcUrl',
  'endpoint',
  'message',
  'serializedTransaction',
  'transaction',
  'signature',
  'apiKey',
  'token',

  /*
   * Phase 4F. Каждое из этих полей однажды кто-то захочет записать
   * «для удобства расследования».
   *
   * Имя ресурса KMS выдаёт аккаунт и регион; сырой публичный ключ и
   * сообщение вместе позволяют восстановить, что именно
   * подписывалось; байты подписи и собранная транзакция — готовый
   * к отправке объект в журнале, который читает половина компании.
   * Отпечаток и адрес Solana разрешены: по ним нельзя ничего
   * собрать, а сверить ключ глазами — можно.
   */
  'keyArn',
  'keyId',
  'keyResourceName',
  'keyVersionName',
  'publicKey',
  'publicKeyDer',
  'messageBytes',
  'signatureBytes',
  'signedTransaction',
  'rawTransaction',
  'accessKeyId',
  'secretAccessKey',
  'sessionToken',
  'blockhash',
] as const;

export interface AuditEntry {
  action: AuditAction;
  actorId: string | null;
  userId: string | null;
  proposalId: string | null;
  intentId: string | null;
  network: string | null;
  purpose: string | null;
  fromState: string | null;
  toState: string | null;
  policyVersion: string | null;
  keyFingerprint: string | null;
  keyVersion: string | null;
  reasonCode: string | null;
}

/**
 * Что из записи журнала запрещено.
 *
 * Проверяется поимённо, а не «на глаз при код-ревью»: ключ
 * `headers`, добавленный однажды для отладки, переживёт и отладку,
 * и того, кто его добавил.
 */
export function forbiddenAuditKeys(entry: Record<string, unknown>): string[] {
  return AUDIT_FORBIDDEN_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(entry, key),
  );
}

// ────────────────────────────── Истечение ────────────────────────────────────

/** Сколько строк берёт один проход воркера истечения. */
export const EXPIRY_BATCH_SIZE = 200;

export interface ExpiryCandidate {
  id: string;
  expiresAt: number;
  state: string;
}

/**
 * Что подлежит истечению.
 *
 * Только незакрытые записи и только по времени. Истечение — это
 * закрытие забытого, а не способ отменить то, что уже случилось:
 * подписанное намерение остаётся подписанным.
 */
export function isExpirable(state: string, expiresAt: number, now: number): boolean {
  const open = ['CREATED', 'AWAITING_CONFIRMATION', 'DRAFT', 'VALIDATED', 'APPROVED'];
  return open.includes(state) && now >= expiresAt;
}
