/**
 * Работа воркера пересчёта с базой.
 *
 * Вынесено за узкий интерфейс не ради абстракции как таковой,
 * а потому что иначе воркер непроверяем. Гонки, падения между
 * шагами, перехват просроченной аренды и повторный захват — всё
 * это состояния базы, и воспроизвести их без подставной реализации
 * можно только удачей.
 *
 * Интерфейс намеренно узкий: шесть операций, каждая — законченное
 * действие, а не обёртка над Prisma. Копировать сюда Prisma целиком
 * значило бы получить подделку, которая проверяет саму себя.
 *
 * Две вещи, которые решаются именно здесь.
 *
 * Атомарность приёма. Событие и постановка в очередь должны
 * записаться одним действием: процесс, упавший между ними, оставил бы
 * сделку навсегда неучтённой — она есть в ленте, но пересчёта
 * не дождётся никогда.
 *
 * Поколение задачи. Пока воркер ходит за историей, приходит новое
 * событие и повышает поколение. Завершившийся воркер обязан снять
 * задачу только если поколение не изменилось — иначе он сотрёт
 * работу, о которой не знал.
 */

import { Prisma as P } from '@prisma/client';
import {
  STATS_RECONCILIATION_STATES,
  WALLET_PNL_VERSION,
  type CanonicalTrade,
  type ChainKey,
} from '@memex/core';
import { prisma } from '../lib/prisma.js';

export interface SyncJob {
  id: string;
  chain: string;
  walletAddress: string;
  /** Поколение на момент захвата. Растёт с каждым новым событием. */
  generation: number;
  attempts: number;
  /** Кто держит задачу. Своя аренда отличается от чужой. */
  leaseToken: string;
}

export interface PersistResult {
  created: number;
  duplicates: number;
}

/**
 * Операции воркера.
 *
 * Каждая — законченное действие с понятным исходом, а не набор
 * запросов. Подделка реализует их полностью, включая ограничения
 * уникальности и откат.
 */
export interface WalletLedgerRepository {
  /** Пометить кошелёк изменившимся. Поднимает поколение. */
  markDirty(chain: string, wallet: string, dueAt: Date): Promise<void>;

  /**
   * Записать событие и поставить в очередь одним действием.
   * Возвращает false, если событие уже было.
   */
  ingestAtomically(
    activity: ActivityInput,
    dueAt: Date,
  ): Promise<{ created: boolean }>;

  /** Захватить следующую задачу. Возвращает null, если свободных нет. */
  claimNext(now: Date, leaseMs: number, owner: string): Promise<SyncJob | null>;

  /** Продлить аренду при долгой выгрузке. false — аренду перехватили. */
  extendLease(job: SyncJob, until: Date): Promise<boolean>;

  /**
   * Завершить задачу.
   *
   * Снимается только при совпадении поколения: иначе за время работы
   * пришло новое событие, и задача должна повториться.
   */
  finish(job: SyncJob, outcome: FinishOutcome): Promise<'cleared' | 'requeued'>;

  /** Записать канонические сделки идемпотентно. */
  persistCanonicalTrades(trades: CanonicalTrade[]): Promise<PersistResult>;

  /** Все известные сделки кошелька в устойчивом порядке. */
  loadCanonicalTrades(chain: string, wallet: string): Promise<CanonicalTrade[]>;

  /** Время последней известной сделки — для дозагрузки с перекрытием. */
  lastTradeTime(chain: string, wallet: string): Promise<number | null>;

  /** Отметить события, для которых нашлась точная сделка. */
  applyActivityStates(updates: ActivityStateUpdate[]): Promise<void>;

  /** События кошелька, ещё не перенесённые в позиции. */
  pendingActivities(chain: string, wallet: string, limit: number): Promise<PendingActivity[]>;

  /**
   * Точные сделки, уже занятые другими событиями ленты.
   *
   * Локальный Set внутри одного прохода не защищает от дубликата,
   * пришедшего в следующем проходе. Это чтение и уникальный индекс
   * в базе вместе держат правило «одна сделка — одно событие».
   */
  assignedCanonicalTradeKeys(
    chain: string,
    wallet: string,
    excludeActivityIds: string[],
  ): Promise<Set<string>>;
}

export interface ActivityInput {
  id: string;
  chain: string;
  walletAddress: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  side: string;
  quoteSymbol: string | null;
  quoteAmount: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  realizedPnlUsd: number | null;
  txHash: string | null;
  trackerType: number | null;
  source: string;
  parsingConfidence: number;
  tradedAt: Date;
}

export interface FinishOutcome {
  ok: boolean;
  errorCode?: string | null;
  /** Когда повторить при неудаче. */
  retryAt?: Date;
}

export interface PendingActivity {
  id: string;
  tokenAddress: string;
  side: string;
  tradedAt: number;
  canonicalTradeKey: string | null;
}

export interface ActivityStateUpdate {
  id: string;
  /**
   * `ambiguous` — подходящих сделок несколько, выбрать нельзя.
   *
   * Отдельно от `deferred` намеренно. Отложенное разрешится само,
   * когда история догонит ленту; неоднозначное само не разрешится
   * и требует разбора. Прежде оба случая молча становились
   * «подтверждено» по первой попавшейся сделке.
   */
  state: 'applied' | 'deferred' | 'ambiguous' | 'failed' | 'ignored';
  applied: boolean;
  errorCode?: string | null;
  canonicalTradeKey?: string | null;
  localRealizedPnlUsd?: string | null;
  localCostBasisUsd?: string | null;
  localPnlState?: 'available' | 'open_position' | 'pending' | 'incomplete_history' | 'ambiguous';
  pnlVersion?: number | null;
  pnlComputedAt?: number | null;
}

// ────────────────────────── Реализация на Prisma ────────────────────────────

export class PrismaWalletLedgerRepository implements WalletLedgerRepository {
  async markDirty(chain: string, wallet: string, dueAt: Date): Promise<void> {
    const id = `${chain}:${wallet}`;

    await prisma.walletSyncQueue.upsert({
      where: { id },
      create: { id, chain: chain as never, walletAddress: wallet, dueAt, generation: 1 },
      // Поколение растёт при каждом событии: по нему воркер поймёт,
      // что за время его работы появилась новая работа.
      update: { dueAt, generation: { increment: 1 } },
    });
  }

  /**
   * Приём события и постановка в очередь одной транзакцией.
   *
   * Раздельно делать нельзя: падение между ними оставляет событие
   * в ленте навсегда неучтённым. Повторное событие тоже поднимает
   * поколение — если предыдущий пересчёт его пропустил, задача
   * появится снова.
   */
  async ingestAtomically(a: ActivityInput, dueAt: Date): Promise<{ created: boolean }> {
    return prisma.$transaction(async (tx) => {
      /*
       * Повторы ожидаемы: OKX присылает одно событие по нескольким
       * подпискам, а REST-страховка может увидеть его после WebSocket.
       * `create` превращал штатную дедупликацию в P2002, и Prisma
       * печатала её как красную ошибку ещё до нашего catch.
       *
       * `createMany(skipDuplicates)` решает конфликт в самой базе:
       * это остаётся атомарной вставкой, но ожидаемый повтор больше
       * не проходит через исключение и не засоряет журнал Render.
       */
      const inserted = await tx.walletActivity.createMany({
        data: {
          id: a.id,
          chain: a.chain as never,
          walletAddress: a.walletAddress,
          tokenAddress: a.tokenAddress,
          tokenSymbol: a.tokenSymbol,
          side: a.side,
          quoteSymbol: a.quoteSymbol,
          quoteAmount: a.quoteAmount != null ? new P.Decimal(a.quoteAmount) : null,
          priceUsd: a.priceUsd != null ? new P.Decimal(a.priceUsd) : null,
          marketCapUsd: a.marketCapUsd != null ? new P.Decimal(a.marketCapUsd) : null,
          realizedPnlUsd: a.realizedPnlUsd != null ? new P.Decimal(a.realizedPnlUsd) : null,
          txHash: a.txHash,
          trackerType: a.trackerType,
          source: a.source,
          parsingConfidence: new P.Decimal(a.parsingConfidence),
          tradedAt: a.tradedAt,
        },
        skipDuplicates: true,
      });

      const created = inserted.count === 1;

      if (!created) {
        const existing = await tx.walletActivity.findUnique({
          where: { id: a.id },
          select: { appliedToLedger: true },
        });

        // Уже учтённое событие не требует ещё одного пересчёта.
        if (existing?.appliedToLedger !== false) return { created: false };
      }

      const id = `${a.chain}:${a.walletAddress}`;
      await tx.walletSyncQueue.upsert({
        where: { id },
        create: {
          id,
          chain: a.chain as never,
          walletAddress: a.walletAddress,
          dueAt,
          generation: 1,
        },
        update: { dueAt, generation: { increment: 1 } },
      });

      return { created };
    });
  }

  /**
   * Захват задачи одним условным обновлением.
   *
   * Через updateMany с условием, а не findFirst + update: два
   * экземпляра API увидели бы одну строку и оба сочли бы, что
   * захватили её. Условие в самом обновлении делает захват
   * атомарным на стороне базы.
   */
  async claimNext(now: Date, leaseMs: number, owner: string): Promise<SyncJob | null> {
    const leaseToken = `${owner}:${now.getTime()}:${Math.random().toString(36).slice(2, 8)}`;

    const candidates = await prisma.walletSyncQueue.findMany({
      where: {
        dueAt: { lte: now },
        // Свободна либо аренда просрочена: процесс, упавший
        // с захваченной задачей, не должен блокировать её навсегда.
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
      orderBy: { dueAt: 'asc' },
      take: 10,
      select: { id: true, chain: true, walletAddress: true, generation: true, attempts: true },
    });

    for (const c of candidates) {
      const claimed = await prisma.walletSyncQueue.updateMany({
        where: {
          id: c.id,
          // Повторная проверка внутри обновления: между выборкой
          // и захватом задачу мог забрать другой процесс.
          OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
        },
        data: {
          lockedBy: owner,
          leaseToken,
          lockedUntil: new Date(now.getTime() + leaseMs),
          lastSyncAt: now,
        },
      });

      if (claimed.count === 1) {
        return {
          id: c.id,
          chain: c.chain,
          walletAddress: c.walletAddress,
          generation: c.generation,
          attempts: c.attempts,
          leaseToken,
        };
      }
    }

    return null;
  }

  async extendLease(job: SyncJob, until: Date): Promise<boolean> {
    const r = await prisma.walletSyncQueue.updateMany({
      // Продлить можно только свою аренду: чужую перехватывать нельзя.
      where: { id: job.id, leaseToken: job.leaseToken },
      data: { lockedUntil: until },
    });
    return r.count === 1;
  }

  async finish(job: SyncJob, outcome: FinishOutcome): Promise<'cleared' | 'requeued'> {
    if (!outcome.ok) {
      await prisma.walletSyncQueue.updateMany({
        where: { id: job.id, leaseToken: job.leaseToken },
        data: {
          lockedBy: null,
          leaseToken: null,
          lockedUntil: null,
          attempts: { increment: 1 },
          lastErrorCode: outcome.errorCode ?? 'unknown',
          dueAt: outcome.retryAt ?? new Date(Date.now() + 60_000),
        },
      });
      return 'requeued';
    }

    // Снимаем задачу только при совпадении поколения. За время
    // выгрузки могло прийти новое событие — стереть его работу
    // значило бы потерять сделку.
    const cleared = await prisma.walletSyncQueue.updateMany({
      where: { id: job.id, leaseToken: job.leaseToken, generation: job.generation },
      data: {
        lockedBy: null,
        leaseToken: null,
        lockedUntil: null,
        attempts: 0,
        lastErrorCode: null,
        lastSuccessAt: new Date(),
        // Далеко вперёд: следующий пересчёт — только по новому событию.
        dueAt: new Date(Date.now() + 864e5),
      },
    });

    if (cleared.count === 1) return 'cleared';

    // Поколение выросло — задача остаётся и пойдёт заново.
    await prisma.walletSyncQueue.updateMany({
      where: { id: job.id, leaseToken: job.leaseToken },
      data: {
        lockedBy: null,
        leaseToken: null,
        lockedUntil: null,
        lastSuccessAt: new Date(),
        // Немедленно: за время выгрузки пришло новое событие,
        // и его работа ещё не сделана.
        dueAt: new Date(0),
      },
    });

    return 'requeued';
  }

  async persistCanonicalTrades(trades: CanonicalTrade[]): Promise<PersistResult> {
    let created = 0;
    let duplicates = 0;

    for (const t of trades) {
      const existing = await prisma.walletEconomicTrade.findUnique({
        where: { key: t.key },
        select: { key: true },
      });

      if (existing) {
        duplicates++;
        continue;
      }

      await prisma.walletEconomicTrade
        .create({
          data: {
            key: t.key,
            // Происхождение и состав сделки пишутся явно: по строке
            // должно быть видно, откуда она и из скольких переводов
            // сложена. Без этого «сумма больше, чем в любой строке
            // провайдера» выглядит ошибкой расчёта.
            source: t.source ?? 'okx_dex_history',
            fillCount: t.fillCount ?? 1,
            firstFillAt: t.firstFillAt != null ? new Date(t.firstFillAt) : null,
            lastFillAt: t.lastFillAt != null ? new Date(t.lastFillAt) : null,
            // Неоднозначная группа сохраняется, но в статистику
            // не идёт: исключить её честнее, чем подменить
            // правдоподобным числом.
            reconciliation: t.ambiguous === true ? 'ambiguous' : 'canonical',
            chain: t.chain as never,
            walletAddress: t.wallet,
            tokenAddress: t.tokenAddress,
            tokenSymbol: t.tokenSymbol,
            side: t.side,
            amount: new P.Decimal(t.amount),
            valueUsd: new P.Decimal(t.valueUsd),
            price: new P.Decimal(t.price),
            marketCapUsd: t.marketCapUsd ? new P.Decimal(t.marketCapUsd) : null,
            providerPnlUsd: t.providerPnlUsd ? new P.Decimal(t.providerPnlUsd) : null,
            tradedAt: new Date(t.tradedAt),
          },
        })
        .then(() => {
          created++;
        })
        .catch((e: any) => {
          if (e?.code === 'P2002') duplicates++;
          else throw e;
        });
    }

    return { created, duplicates };
  }

  async loadCanonicalTrades(chain: string, wallet: string): Promise<CanonicalTrade[]> {
    const rows = await prisma.walletEconomicTrade.findMany({
      where: {
        chain: chain as never,
        walletAddress: wallet,
        // Свёрнутые и неоднозначные записи в расчёт не идут.
        //
        // `superseded` уже учтена в канонической — считать её второй
        // раз значит вернуть ровно те дубли, ради устранения которых
        // всё это и делалось. `ambiguous` не учтена нигде, и это
        // честнее, чем подставить в позицию число, в котором мы
        // сами не уверены.
        reconciliation: { in: [...STATS_RECONCILIATION_STATES] },
      },
      orderBy: [{ tradedAt: 'asc' }, { key: 'asc' }],
    });

    return rows.map((r: (typeof rows)[number]) => ({
      key: r.key,
      chain: r.chain as ChainKey,
      wallet: r.walletAddress,
      tokenAddress: r.tokenAddress,
      tokenSymbol: r.tokenSymbol,
      side: r.side as 'BUY' | 'SELL',
      amount: r.amount.toString(),
      valueUsd: r.valueUsd.toString(),
      price: r.price.toString(),
      marketCapUsd: r.marketCapUsd?.toString() ?? null,
      providerPnlUsd: r.providerPnlUsd?.toString() ?? null,
      tradedAt: r.tradedAt.getTime(),
    }));
  }

  async lastTradeTime(chain: string, wallet: string): Promise<number | null> {
    const last = await prisma.walletEconomicTrade.findFirst({
      where: { chain: chain as never, walletAddress: wallet },
      orderBy: { tradedAt: 'desc' },
      select: { tradedAt: true },
    });
    return last?.tradedAt.getTime() ?? null;
  }

  async pendingActivities(
    chain: string,
    wallet: string,
    limit: number,
  ): Promise<PendingActivity[]> {
    const rows = await prisma.walletActivity.findMany({
      where: {
        chain: chain as never,
        walletAddress: wallet,
        // После смены правил уже сопоставленное событие тоже должно
        // получить новый локальный PnL. Иначе миграция оставила бы
        // всю прежнюю ленту в вечном pending до ручного backfill.
        OR: [
          { appliedToLedger: false },
          { pnlVersion: null },
          { pnlVersion: { lt: WALLET_PNL_VERSION } },
        ],
      },
      take: limit,
      orderBy: [{ tradedAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        tokenAddress: true,
        side: true,
        tradedAt: true,
        canonicalTradeKey: true,
      },
    });

    return rows.map((r: (typeof rows)[number]) => ({
      id: r.id,
      tokenAddress: r.tokenAddress,
      side: r.side,
      tradedAt: r.tradedAt.getTime(),
      canonicalTradeKey: r.canonicalTradeKey,
    }));
  }

  async assignedCanonicalTradeKeys(
    chain: string,
    wallet: string,
    excludeActivityIds: string[],
  ): Promise<Set<string>> {
    const rows = await prisma.walletActivity.findMany({
      where: {
        chain: chain as never,
        walletAddress: wallet,
        canonicalTradeKey: { not: null },
        ...(excludeActivityIds.length > 0 ? { id: { notIn: excludeActivityIds } } : {}),
      },
      select: { canonicalTradeKey: true },
    });

    return new Set(
      rows.flatMap((row: (typeof rows)[number]) =>
        row.canonicalTradeKey == null ? [] : [row.canonicalTradeKey],
      ),
    );
  }

  async applyActivityStates(updates: ActivityStateUpdate[]): Promise<void> {
    for (const u of updates) {
      await prisma.walletActivity
        .update({
          where: { id: u.id },
          data: {
            appliedToLedger: u.applied,
            ledgerState: u.state,
            ledgerAppliedAt: u.applied ? new Date() : null,
            ledgerErrorCode: u.errorCode ?? null,
            canonicalTradeKey: u.canonicalTradeKey ?? null,
            localRealizedPnlUsd:
              u.localRealizedPnlUsd != null ? new P.Decimal(u.localRealizedPnlUsd) : null,
            localCostBasisUsd:
              u.localCostBasisUsd != null ? new P.Decimal(u.localCostBasisUsd) : null,
            localPnlState: u.localPnlState ?? null,
            pnlVersion: u.pnlVersion ?? null,
            pnlComputedAt:
              u.pnlComputedAt != null ? new Date(u.pnlComputedAt) : null,
            ...(u.applied ? {} : { ledgerAttempts: { increment: 1 } }),
          },
        })
        .catch(() => undefined);
    }
  }
}

export const walletLedgerRepo: WalletLedgerRepository = new PrismaWalletLedgerRepository();
