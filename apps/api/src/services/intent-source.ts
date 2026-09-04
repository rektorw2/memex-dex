import crypto from 'node:crypto';
import { Prisma as P } from '@prisma/client';
import {
  checkApprovalPreconditions,
  intentExpiryAt,
  presentationIsComplete,
  type ApprovalRefusal,
  type IntentOrigin,
  type ProposalPresentation,
  type ProposalState,
} from '@memex/core';
import { prisma, serializable } from '../lib/prisma.js';
import { readFundingSafetyState } from './prisma-solana-reconciliation-repository.js';
import { buildIntentMessage, POLICY_VERSION } from './transaction-intent-builder.js';
import { recordAudit } from './intent-audit.js';

/**
 * Откуда берётся денежное намерение.
 *
 * Ровно из двух мест: предложение агента и служебная проверочная
 * запись администратора. Браузер в этом списке отсутствует и
 * появиться не может — от человека приходит только согласие.
 *
 * Разница не в удобстве, а в том, что именно подписывается. Сумма,
 * получатель, кошелёк, программы и blockhash определяются здесь, на
 * сервере, из записей, которые сервер же и создал. Любая из этих
 * величин, пришедшая снаружи, — это способ получить подпись под тем,
 * чего человеку не показывали.
 */

export interface ApprovalResult {
  status: 'created' | 'rejected' | 'refused' | 'idempotent';
  intentId?: string;
  refusal?: ApprovalRefusal;
  /** Ответ, сохранённый по ключу идемпотентности. */
  cached?: unknown;
}

/**
 * Отпечаток денежной части предложения.
 *
 * Снимается в момент показа и сверяется при подтверждении. Любое
 * расхождение означает, что человек соглашался на другое, даже если
 * идентификатор предложения тот же.
 */
export function proposalFingerprint(proposal: {
  assetAddress: string;
  assetSymbol: string;
  amountUsd: P.Decimal | string;
  estimatedNetworkFeeUsd: P.Decimal | string | null;
  estimatedPlatformFeeUsd: P.Decimal | string | null;
  network: string;
  expiresAt: Date;
}): string {
  /*
   * В отпечаток входит всё, что влияет на деньги, и время
   * истечения. Продление срока — это тоже изменение условий:
   * человек соглашался действовать сейчас, а не когда-нибудь.
   */
  const parts = [
    proposal.network,
    proposal.assetAddress,
    proposal.assetSymbol,
    String(proposal.amountUsd),
    String(proposal.estimatedNetworkFeeUsd ?? ''),
    String(proposal.estimatedPlatformFeeUsd ?? ''),
    proposal.expiresAt.toISOString(),
    POLICY_VERSION,
  ];
    /*
   * Разделитель — NUL, записанный escape-последовательностью.
   *
   * NUL выбран потому, что не встречается ни в одном из полей:
   * с пробелом отпечаток `a b` + `c` совпал бы с `a` + `b c`.
   * Записан именно escape'ом: буквальный байт делает файл
   * бинарным для grep и diff и невидимым в редакторе, а однажды
   * его молча съест форматтер вместе с отпечатком.
   */
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

/** Что показать человеку. Неизвестная оценка честнее выдуманной. */
export function presentProposal(proposal: {
  assetSymbol: string;
  network: string;
  amountUsd: P.Decimal | string;
  estimatedNetworkFeeUsd: P.Decimal | string | null;
  estimatedPlatformFeeUsd: P.Decimal | string | null;
  priceImpactBps: number | null;
  riskSnapshot: unknown;
  expiresAt: Date;
}): ProposalPresentation {
  const risk = (proposal.riskSnapshot ?? {}) as Record<string, unknown>;
  return {
    asset: proposal.assetSymbol,
    network: proposal.network,
    direction: 'BUY',
    amountUsd: String(proposal.amountUsd),
    estimatedFeeUsd: proposal.estimatedNetworkFeeUsd == null
      ? null
      : String(proposal.estimatedNetworkFeeUsd),
    maxFeeUsd: String(proposal.estimatedPlatformFeeUsd ?? '0'),
    slippageBps: proposal.priceImpactBps ?? 0,
    riskLevel: typeof risk.level === 'string' ? risk.level : 'UNKNOWN',
    strategy: typeof risk.strategy === 'string' ? risk.strategy : 'baseline',
    reason: typeof risk.reason === 'string' ? risk.reason : 'нет пояснения',
    expiresAt: proposal.expiresAt.getTime(),
  };
}

export interface DecideInput {
  proposalId: string;
  actorId: string;
  decision: 'CONFIRM' | 'REJECT';
  /** Отпечаток, показанный человеку. Присылается клиентом как эхо. */
  shownFingerprint: string;
  hasEntitlement: boolean;
  liveAllowed: boolean;
  now?: Date;
  /**
   * Откуда взять blockhash.
   *
   * Функция, а не значение: значение пришлось бы кому-то передать, а
   * единственный, кто держит его в руках между сервером и этим
   * вызовом, — браузер. Из браузера blockhash не принимается.
   *
   * Отсутствие источника — не «подставим заглушку», а отказ.
   */
  blockhashSource?: BlockhashSource | null;
}

/** Читатель цепочки. Совместим с `SolanaBlockhashProvider.fetch`. */
export type BlockhashSource = () => Promise<{
  blockhash: string;
  lastValidBlockHeight: string;
  network: string;
}>;

/**
 * Решение человека по предложению.
 *
 * Всё — одной сериализуемой транзакцией: состояние предложения,
 * создание намерения и запись в журнал. Иначе между ними помещается
 * второй запрос, и одно предложение порождает два намерения.
 */
export async function decideProposal(input: DecideInput): Promise<ApprovalResult> {
  const now = input.now ?? new Date();
  const safety = await readFundingSafetyState();

  /*
   * Blockhash берётся до открытия транзакции.
   *
   * Внутри `serializable` это был бы сетевой вызов при удерживаемых
   * блокировках: чужой узел, отвечающий десять секунд, держал бы
   * строки предложения всё это время, а сериализуемый уровень
   * изоляции превратил бы это в отказы у всех остальных.
   *
   * При отказе выше по стеку ничего не менялось: состояние
   * предложения ещё не тронуто, и повторить попытку можно.
   */
  let blockhash: Awaited<ReturnType<BlockhashSource>> | null = null;
  if (input.decision === 'CONFIRM') {
    if (!input.blockhashSource) {
      return { status: 'refused', refusal: 'BLOCKHASH_UNAVAILABLE' };
    }
    try {
      blockhash = await input.blockhashSource();
    } catch {
      // Код ошибки сети наружу не идёт: в нём бывает адрес узла.
      return { status: 'refused', refusal: 'BLOCKHASH_UNAVAILABLE' };
    }
    if (blockhash.network !== 'devnet') {
      return { status: 'refused', refusal: 'BLOCKHASH_UNAVAILABLE' };
    }
  }

  return serializable(async (tx) => {
    const proposal = await tx.liveAgentProposal.findUnique({
      where: { id: input.proposalId },
    });

    /*
     * Чужое и несуществующее отвечают одинаково.
     *
     * Разные коды на «не ваше» и «нет такого» позволяют по одному
     * запросу выяснить, есть ли у соседа предложение с таким
     * идентификатором.
     */
    if (!proposal) return { status: 'refused', refusal: 'NOT_FOUND' } as const;

    const verdict = checkApprovalPreconditions({
      state: proposal.status as ProposalState,
      ownerId: proposal.userId,
      actorId: input.actorId,
      expiresAt: proposal.expiresAt.getTime(),
      now: now.getTime(),
      shownFingerprint: input.shownFingerprint,
      currentFingerprint: proposalFingerprint(proposal),
      shownPolicyVersion: POLICY_VERSION,
      currentPolicyVersion: POLICY_VERSION,
      hasEntitlement: input.hasEntitlement,
      safetyLatchHealthy: safety === 'HEALTHY' || safety === 'DEGRADED',
      liveAllowed: input.liveAllowed,
    });

    if (!verdict.allowed) {
      return { status: 'refused', refusal: verdict.refusal! } as const;
    }

    if (input.decision === 'REJECT') {
      /*
       * Состояние входит в условие обновления.
       *
       * Параллельные «подтвердить» и «отклонить» иначе оба увидели
       * бы `CREATED` и оба записали бы своё.
       */
      const changed = await tx.liveAgentProposal.updateMany({
        where: { id: proposal.id, status: { in: ['CREATED', 'AWAITING_CONFIRMATION'] } },
        data: { status: 'REJECTED', rejectedAt: now },
      });
      if (changed.count !== 1) return { status: 'refused', refusal: 'ALREADY_DECIDED' } as const;

      await recordAudit(tx, {
        action: 'PROPOSAL_REJECTED',
        actorId: input.actorId,
        userId: proposal.userId,
        proposalId: proposal.id,
        intentId: null,
        network: proposal.network,
        purpose: null,
        fromState: proposal.status,
        toState: 'REJECTED',
        policyVersion: POLICY_VERSION,
        keyFingerprint: null,
        keyVersion: null,
        reasonCode: null,
      });
      return { status: 'rejected' } as const;
    }

    const changed = await tx.liveAgentProposal.updateMany({
      where: { id: proposal.id, status: { in: ['CREATED', 'AWAITING_CONFIRMATION'] } },
      data: { status: 'CONFIRMED', confirmedAt: now },
    });
    if (changed.count !== 1) return { status: 'refused', refusal: 'ALREADY_DECIDED' } as const;

    const intentId = await createIntentFromProposal(tx, {
      proposal,
      actorId: input.actorId,
      shownFingerprint: input.shownFingerprint,
      now,
      blockhash: blockhash!,
    });

    return { status: 'created', intentId } as const;
  });
}

/**
 * Создание намерения из предложения.
 *
 * Сообщение собирается здесь же и сразу: намерение без собранного
 * сообщения — это обещание собрать позже, а «позже» происходит уже
 * после того, как человек согласился.
 */
async function createIntentFromProposal(
  tx: P.TransactionClient,
  input: {
    proposal: { id: string; userId: string; network: string; expiresAt: Date; status: string };
    actorId: string;
    shownFingerprint: string;
    now: Date;
    /** Уже прочитан из цепочки — до открытия транзакции. */
    blockhash: { blockhash: string; lastValidBlockHeight: string };
  },
): Promise<string> {
  const wallet = await tx.wallet.findFirst({
    where: {
      userId: input.proposal.userId,
      chain: 'SOLANA',
      kind: 'HOT_DEPOSIT',
      isActive: true,
    },
    select: { id: true, address: true },
  });
  if (!wallet) throw new IntentSourceError('WALLET_NOT_FOUND');

  /*
   * Проверочное намерение: перевод самому себе на минимальную сумму.
   *
   * Пока контур не проверен целиком, единственный безопасный
   * получатель — тот же кошелёк, а единственная безопасная сумма —
   * такая, потеря которой ничего не значит.
   */
  const request = {
    purpose: 'DEVNET_SELF_TRANSFER',
    network: 'devnet',
    ownerAddress: wallet.address,
    destinationAddress: wallet.address,
    rawAmount: '1',
    mint: null,
    feeLimitLamports: '5000',
    slippageBps: 0,
    /*
     * Настоящий blockhash из devnet.
     *
     * Прочитан сервером до открытия транзакции и сюда попадает уже
     * значением. Путь из браузера отсутствует: подпись под чужим
     * blockhash — это подпись под транзакцией, которую соберут
     * не здесь.
     */
    recentBlockhash: input.blockhash.blockhash,
    lastValidBlockHeight: input.blockhash.lastValidBlockHeight,
  };

  const built = buildIntentMessage(request);
  const expiresAt = new Date(intentExpiryAt(input.now.getTime()));

  const intent = await tx.transactionIntent.create({
    data: {
      userId: input.proposal.userId,
      walletId: wallet.id,
      network: built.facts.network,
      purpose: built.facts.purpose,
      mint: built.facts.mint,
      rawAmount: built.facts.rawAmount,
      sourceAddress: built.facts.sourceAddress,
      destinationAddress: built.facts.destinationAddress,
      feeLimitLamports: built.facts.feeLimitLamports,
      slippageBps: built.facts.slippageBps,
      allowedProgramIds: [...built.facts.allowedProgramIds],
      recentBlockhash: request.recentBlockhash,
      lastValidBlockHeight: request.lastValidBlockHeight,
      messageHash: built.messageHash,
      policyVersion: built.facts.policyVersion,
      // Одобрено человеком в тот же момент: подтверждение
      // предложения и есть одобрение намерения.
      state: 'APPROVED',
      approvedAt: input.now,
      approvedBy: input.actorId,
      origin: 'AGENT_PROPOSAL' satisfies IntentOrigin,
      proposalId: input.proposal.id,
      shownFingerprint: input.shownFingerprint,
      expiresAt,
    },
    select: { id: true },
  });

  for (const [action, toState] of [
    ['PROPOSAL_CONFIRMED', 'CONFIRMED'],
    ['INTENT_CREATED', 'DRAFT'],
    ['INTENT_VALIDATED', 'VALIDATED'],
    ['INTENT_APPROVED', 'APPROVED'],
  ] as const) {
    await recordAudit(tx, {
      action,
      actorId: input.actorId,
      userId: input.proposal.userId,
      proposalId: input.proposal.id,
      intentId: intent.id,
      network: built.facts.network,
      purpose: built.facts.purpose,
      fromState: null,
      toState,
      policyVersion: built.facts.policyVersion,
      keyFingerprint: null,
      keyVersion: null,
      reasonCode: null,
    });
  }

  return intent.id;
}

export class IntentSourceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'IntentSourceError';
  }
}

/**
 * Служебная проверочная запись администратора.
 *
 * Только вне production, только ADMIN, только перевод самому себе.
 * Транзакцию не отправляет: этот путь существует, чтобы проверить
 * сборку и подпись, а не чтобы что-то двигать.
 */
export async function createDevnetFixtureIntent(input: {
  actorId: string;
  userId: string;
  nodeEnv: string;
  network: string;
  now?: Date;
  blockhashSource?: BlockhashSource | null;
}): Promise<{ intentId: string } | { refusal: string }> {
  if (input.nodeEnv === 'production') return { refusal: 'FIXTURE_FORBIDDEN_IN_PRODUCTION' };
  if (input.network !== 'devnet') return { refusal: 'FIXTURE_REQUIRES_DEVNET' };

  const now = input.now ?? new Date();

  /*
   * Служебная запись собирается по тем же правилам, что и обычная.
   *
   * Отдельный путь «для проверки» с ослабленными требованиями — это
   * и есть тот путь, которым однажды создадут настоящее намерение.
   */
  if (!input.blockhashSource) return { refusal: 'BLOCKHASH_UNAVAILABLE' };
  let blockhash: Awaited<ReturnType<BlockhashSource>>;
  try {
    blockhash = await input.blockhashSource();
  } catch {
    return { refusal: 'BLOCKHASH_UNAVAILABLE' };
  }
  if (blockhash.network !== 'devnet') return { refusal: 'BLOCKHASH_UNAVAILABLE' };

  return serializable(async (tx) => {
    const wallet = await tx.wallet.findFirst({
      where: { userId: input.userId, chain: 'SOLANA', kind: 'HOT_DEPOSIT', isActive: true },
      select: { id: true, address: true },
    });
    if (!wallet) return { refusal: 'WALLET_NOT_FOUND' };

    const built = buildIntentMessage({
      purpose: 'DEVNET_SELF_TRANSFER',
      network: 'devnet',
      ownerAddress: wallet.address,
      destinationAddress: wallet.address,
      rawAmount: '1',
      mint: null,
      feeLimitLamports: '5000',
      slippageBps: 0,
      recentBlockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    });

    const intent = await tx.transactionIntent.create({
      data: {
        userId: input.userId,
        walletId: wallet.id,
        network: built.facts.network,
        purpose: built.facts.purpose,
        mint: built.facts.mint,
        rawAmount: built.facts.rawAmount,
        sourceAddress: built.facts.sourceAddress,
        destinationAddress: built.facts.destinationAddress,
        feeLimitLamports: built.facts.feeLimitLamports,
        slippageBps: built.facts.slippageBps,
        allowedProgramIds: [...built.facts.allowedProgramIds],
        recentBlockhash: blockhash.blockhash,
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
        messageHash: built.messageHash,
        policyVersion: built.facts.policyVersion,
        // Фикстура остаётся черновиком: одобрение — действие
        // человека, и подделывать его служебным путём нельзя.
        state: 'DRAFT',
        origin: 'ADMIN_DEVNET_FIXTURE' satisfies IntentOrigin,
        expiresAt: new Date(intentExpiryAt(now.getTime())),
      },
      select: { id: true },
    });

    await recordAudit(tx, {
      action: 'ADMIN_ACTION',
      actorId: input.actorId,
      userId: input.userId,
      proposalId: null,
      intentId: intent.id,
      network: 'devnet',
      purpose: built.facts.purpose,
      fromState: null,
      toState: 'DRAFT',
      policyVersion: built.facts.policyVersion,
      keyFingerprint: null,
      keyVersion: null,
      reasonCode: 'DEVNET_FIXTURE_CREATED',
    });

    return { intentId: intent.id };
  });
}

export { presentationIsComplete };
